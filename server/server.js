const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, '..', 'web');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'nova-default-secret-change-me';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb(){
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (_) { return { users: {}, favorites: {}, history: {} }; }
}
function saveDb(d){
  try { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }
  catch (e) { console.error('[db]', e.message); }
}
let db = loadDb();
if (!db.users) db.users = {};
if (!db.favorites) db.favorites = {};
if (!db.history) db.history = {};

const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';

// === КЭШИ ===
const streamCache = new Map();     // videoId -> {url, time}
const resolveCache = new Map();    // query -> {streamUrl, provider, title, artist, time}
const searchCache = new Map();

const STREAM_TTL = 30 * 60 * 1000;   // 30 минут
const RESOLVE_TTL = 30 * 60 * 1000;  // 30 минут

let ytModule = null;
async function getYT(){
  if (ytModule) return ytModule;
  try {
    ytModule = require('@distube/ytdl-core');
    console.log('[yt] ytdl-core loaded');
  } catch (e){ console.error('[yt] load error:', e.message); }
  return ytModule;
}

let searchModule = null;
async function getSearch(){
  if (searchModule) return searchModule;
  try {
    searchModule = require('youtube-sr').default || require('youtube-sr');
    console.log('[yt] youtube-sr loaded');
  } catch (e){ console.error('[yt] search load error:', e.message); }
  return searchModule;
}

const api = express();
api.disable('x-powered-by');
api.use(cors());
api.use(express.json({ limit: '2mb' }));

function trackKey(t){ return [String(t.source || ''), String(t.id || ''), String(t.title || ''), String(t.artist || '')].join('|'); }

function authMiddleware(req, res, next){
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch (_) { res.status(401).json({ error: 'invalid token' }); }
}

function isNoiseTrack(item){
  if (!item) return true;
  const title = String(item.title || '').toLowerCase();
  const noise = ['instrumental version', 'karaoke version', 'cover version', 'tribute', 'made famous by', 'in the style of', 'backing track', 'ringtone'];
  for (const w of noise) if (title.includes(w)) return true;
  if (!title || title === 'untitled') return true;
  return false;
}

// ============================================================
// LOCAL AUTH
// ============================================================
function hashPassword(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }

api.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Логин от 3 символов' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль от 4 символов' });
  if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/u.test(username)) return res.status(400).json({ error: 'Логин без пробелов' });

  const lower = String(username).toLowerCase();
  const existing = Object.values(db.users).find(u => (u.username || '').toLowerCase() === lower);
  if (existing) return res.status(409).json({ error: 'Логин занят' });

  const id = 'local_' + crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);

  db.users[id] = { id, username, avatar: '', discriminator: '0', provider: 'local', passwordHash: hash, passwordSalt: salt, createdAt: Date.now() };
  if (!db.favorites[id]) db.favorites[id] = [];
  if (!db.history[id]) db.history[id] = [];
  saveDb(db);

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username, avatar: '', provider: 'local' } });
});

api.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  const lower = String(username).toLowerCase();
  const user = Object.values(db.users).find(u => (u.username || '').toLowerCase() === lower);
  if (!user || user.provider !== 'local' || !user.passwordHash) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const hash = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || '', provider: 'local' } });
});

// ============================================================
// DISCORD AUTH
// ============================================================
api.get('/api/auth/discord', (req, res) => {
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify' });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

api.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const tokenParams = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI });
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', body: tokenParams, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('Token error');

    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tokenData.access_token } });
    const user = await userRes.json();

    const userId = user.id;
    if (!db.users[userId]){
      db.users[userId] = { id: userId, username: user.username, avatar: user.avatar || '', discriminator: user.discriminator || '0', provider: 'discord', createdAt: Date.now() };
    } else {
      db.users[userId].username = user.username;
      db.users[userId].avatar = user.avatar || '';
    }
    if (!db.favorites[userId]) db.favorites[userId] = [];
    if (!db.history[userId]) db.history[userId] = [];
    saveDb(db);

    const token = jwt.sign({ id: userId, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect('/?login=success&token=' + encodeURIComponent(token));
  } catch (e){ console.error('[Discord]', e.message); res.status(500).send('Auth error'); }
});

// ============================================================
// USER API
// ============================================================
api.get('/api/me', authMiddleware, (req, res) => {
  const user = db.users[req.user.id];
  if (!user) return res.status(404).json({ error: 'user not found' });
  const { passwordHash, passwordSalt, ...pub } = user;
  res.json(pub);
});

api.get('/api/favorites', authMiddleware, (req, res) => res.json(db.favorites[req.user.id] || []));
api.post('/api/favorites', authMiddleware, (req, res) => {
  const track = req.body;
  if (!track || !track.title) return res.status(400).json({ error: 'invalid' });
  const list = db.favorites[req.user.id] || [];
  const key = trackKey(track);
  if (!list.some(t => trackKey(t) === key)){
    list.unshift(track);
    db.favorites[req.user.id] = list.slice(0, 500);
    saveDb(db);
  }
  res.json({ ok: true });
});
api.delete('/api/favorites/:key', authMiddleware, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const list = db.favorites[req.user.id] || [];
  db.favorites[req.user.id] = list.filter(t => trackKey(t) !== key);
  saveDb(db);
  res.json({ ok: true });
});
api.get('/api/history', authMiddleware, (req, res) => res.json(db.history[req.user.id] || []));
api.post('/api/history', authMiddleware, (req, res) => {
  const track = req.body;
  if (!track || !track.title) return res.status(400).json({ error: 'invalid' });
  const list = db.history[req.user.id] || [];
  const key = trackKey(track);
  const filtered = list.filter(t => trackKey(t) !== key);
  filtered.unshift(track);
  db.history[req.user.id] = filtered.slice(0, 300);
  saveDb(db);
  res.json({ ok: true });
});

// ============================================================
// HELPERS
// ============================================================
function jsonFetch(url, options = {}, timeoutMs = 12000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json', 'User-Agent': 'NOVA/2.0', ...(options.headers || {}) };
  return fetch(url, { ...options, headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function readJson(res){
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { throw new Error('bad json'); }
}
function firstImage(o){
  if (!o) return '';
  if (typeof o === 'string') return o;
  for (const k of ['1000x1000', '480x480', '600x600', '640x640', '320x320', '150x150']) if (o[k]) return o[k];
  for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].startsWith('http')) return o[k];
  return '';
}
function normalizeSearchText(v){ return String(v || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// ============================================================
// ITUNES
// ============================================================
async function searchItunes(q, opts = {}){
  try {
    const params = new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: opts.limit || '50' });
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const results = items.map((tr, idx) => {
      const rankBoost = Math.max(0, 100 - idx);
      return {
        id: 'itunes_' + String(tr.trackId || ''),
        title: tr.trackName || 'Untitled',
        artist: tr.artistName || '',
        artistId: '',
        cover: (tr.artworkUrl100 || '').replace('100x100', '600x600'),
        album: tr.collectionName || '',
        albumId: '',
        preview: '',
        source: 'CATALOG',
        sourceUrl: tr.trackViewUrl || '',
        downloadable: false,
        duration: Number(tr.trackTimeMillis || 0) / 1000,
        popularity: 50000 + rankBoost * 500,
        releaseDate: tr.releaseDate || '',
        provider: 'itunes'
      };
    });
    return { results, count: results.length };
  } catch (e){ console.error('[iTunes]', e.message); return { results: [], count: 0 }; }
}

// ============================================================
// AUDIUS
// ============================================================
async function searchAudius(q){
  try {
    const params = new URLSearchParams({ query: q, limit: '30', sort_method: 'popular' });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const r = await jsonFetch('https://api.audius.co/v1/tracks/search?' + params.toString(), { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} }, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    const results = items.filter(t => { const dur = Number(t.duration || 0); return !(dur > 0 && dur < 60) && !t.is_unlisted; })
      .map(t => {
        const id = t.id || '';
        return {
          id, title: t.title || 'Untitled',
          artist: t.user?.name || 'Unknown', artistId: t.user?.id || '',
          cover: firstImage(t.artwork),
          preview: '',
          source: 'FULL',
          sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : '',
          downloadable: Boolean(t.downloadable),
          downloadUrl: t.downloadable ? '/api/download/audius/' + encodeURIComponent(id) : '',
          duration: Number(t.duration || 0),
          bitrate: Number(t.bitrate || 0),
          popularity: Number(t.play_count || 0) + Number(t.favorite_count || 0) * 5,
          releaseDate: t.release_date || t.created_at || '',
          provider: 'audius'
        };
      });
    return { results, count: results.length };
  } catch (e){ console.error('[Audius]', e.message); return { results: [], count: 0 }; }
}

// ============================================================
// MERGE + SCORE
// ============================================================
function scoreProviderTrack(item, query){
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(item.title);
  const artist = normalizeSearchText(item.artist);
  if (!q) return 0;
  let score = 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const combined = title + ' ' + artist;

  if (title === q) score += 1000000;
  else if (title.startsWith(q)) score += 500000;
  else if (title.includes(q)) score += 200000;

  if (artist === q) score += 800000;
  else if (artist.startsWith(q)) score += 400000;
  else if (artist.includes(q)) score += 150000;

  let hits = 0;
  for (const t of tokens){
    if (title.split(/\s+/).includes(t)) hits += 3;
    else if (artist.split(/\s+/).includes(t)) hits += 2;
    else if (combined.includes(t)) hits += 1;
  }
  score += hits * 1500;

  const pop = Number(item.popularity || 0);
  if (pop > 0) score += Math.log10(pop + 1) * 5000;

  if (item.provider === 'itunes') score += 30000;
  if (item.source === 'FULL') score += 500;
  return score;
}

function mergeProviderResults(providers, query){
  const out = [];
  const seen = new Set();
  for (const p of providers){
    for (const item of p.results || []){
      const key = normalizeSearchText(item.artist) + '|' + normalizeSearchText(item.title);
      if (isNoiseTrack(item)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, _score: scoreProviderTrack(item, query) });
    }
  }
  out.sort((a, b) => b._score - a._score);
  return out.slice(0, 80).map(({ _score, ...rest }) => rest);
}

// ============================================================
// ROUTES
// ============================================================
api.get('/api/health', (req, res) => res.json({ ok: true, service: 'NOVA', version: '2.2.0' }));

api.get('/api/popular', async (req, res) => {
  const cacheKey = 'popular:v5';
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 600000) return res.json(cached.data);

  const feeds = [
    'https://itunes.apple.com/us/rss/topsongs/limit=50/json',
    'https://itunes.apple.com/gb/rss/topsongs/limit=50/json',
    'https://itunes.apple.com/de/rss/topsongs/limit=50/json'
  ];
  const results = [], seen = new Set();

  await Promise.allSettled(feeds.map(async url => {
    try {
      const r = await jsonFetch(url, {}, 6000);
      const d = await readJson(r);
      const entries = d?.feed?.entry || [];
      for (const e of entries){
        const title = e['im:name']?.label || '';
        const artist = e['im:artist']?.label || '';
        const key = normalizeSearchText(artist) + '|' + normalizeSearchText(title);
        if (seen.has(key)) continue;
        seen.add(key);
        const cover = e['im:image']?.[2]?.label || e['im:image']?.[1]?.label || '';
        const id = e.id?.attributes?.['im:id'] || ('itunes_' + Math.random());
        results.push({
          id: 'itunes_' + id, title, artist, artistId: '',
          cover: cover.replace('170x170', '600x600').replace('100x100', '600x600'),
          album: e['im:collection']?.['im:name']?.label || '',
          albumId: '', preview: '', source: 'CATALOG', sourceUrl: e.id?.label || '',
          downloadable: false, duration: 0, popularity: 100000, provider: 'itunes'
        });
      }
    } catch (e){ console.warn('[popular]', e.message); }
  }));

  const payload = { results: results.slice(0, 60) };
  searchCache.set(cacheKey, { time: Date.now(), data: payload });
  res.json(payload);
});

api.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], counts: {} });
  const cacheKey = 'search:' + normalizeSearchText(q);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 120000) return res.json(cached.data);

  const wrap = (fn, ms) => Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), ms))]);
  const settled = await Promise.allSettled([
    wrap(() => searchItunes(q, { limit: '80' }), 5000),
    wrap(() => searchAudius(q), 4500)
  ]);

  const results = mergeProviderResults(settled.map(x => x.status === 'fulfilled' ? x.value : { results: [], count: 0 }), q);

  const payload = {
    results,
    counts: {
      itunes: settled[0].value?.count || 0,
      audius: settled[1].value?.count || 0
    }
  };
  searchCache.set(cacheKey, { time: Date.now(), data: payload });
  res.json(payload);
});

// ==== RESOLVE (главный — используется для моментального старта) ====
api.get('/api/audio/resolve', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'empty' });

  const ck = normalizeSearchText(q);
  const cached = resolveCache.get(ck);
  if (cached && Date.now() - cached.time < RESOLVE_TTL){
    return res.json({ ok: true, ...cached.data, cached: true });
  }

  try {
    const r = await findPlayableAudio(q);
    resolveCache.set(ck, { time: Date.now(), data: r });
    res.json({ ok: true, ...r });
  } catch (e){
    console.error('[resolve]', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ==== PREFETCH — батч резолв первых N треков ====
api.post('/api/audio/prefetch', async (req, res) => {
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 6) : [];
  res.json({ ok: true, count: tracks.length });

  (async () => {
    for (const t of tracks){
      try {
        const q = [t.title, t.artist].filter(Boolean).join(' ');
        if (!q) continue;
        const ck = normalizeSearchText(q);
        if (resolveCache.has(ck) && Date.now() - resolveCache.get(ck).time < RESOLVE_TTL) continue;
        const r = await findPlayableAudio(q);
        resolveCache.set(ck, { time: Date.now(), data: r });
      } catch (e){ console.warn('[prefetch]', t.title, e.message); }
    }
    console.log('[prefetch] done, cache size =', resolveCache.size);
  })();
});

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  try {
    const url = await getYtStreamUrl(vid);
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(url, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).end();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']){
      const v = upstream.headers.get(h);
      if (v) res.setHeader({ 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'content-range': 'Content-Range', 'accept-ranges': 'Accept-Ranges' }[h], v);
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);
    if (upstream.body?.pipe) upstream.body.pipe(res);
    else res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e){
    console.error('[stream] yt:', e.message);
    if (!res.headersSent) res.status(502).end(); else res.end();
  }
});

api.get('/api/audio/audius/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const url = 'https://api.audius.co/v1/tracks/' + encodeURIComponent(id) + '/stream' + (params.toString() ? '?' + params.toString() : '');
    const headers = {};
    if (AUDIUS_API_KEY) headers['X-API-Key'] = AUDIUS_API_KEY;
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await jsonFetch(url, { headers, redirect: 'follow' }, 30000);
    if (!upstream.ok || !upstream.body) return res.status(502).send('err');
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']){
      const v = upstream.headers.get(h);
      if (v) res.setHeader({ 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'accept-ranges': 'Accept-Ranges', 'content-range': 'Content-Range' }[h], v);
    }
    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (e){ if (!res.headersSent) res.status(502).send('err'); }
});

api.get('/api/download/audius/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const tr = await jsonFetch('https://api.audius.co/v1/tracks/' + encodeURIComponent(id) + '?' + params.toString(), { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} }, 10000);
    const td = await readJson(tr);
    if (!td.data?.downloadable) return res.status(403).send('not downloadable');
    const stream = await jsonFetch('https://api.audius.co/v1/tracks/' + encodeURIComponent(id) + '/stream' + (AUDIUS_API_KEY ? '?api_key=' + AUDIUS_API_KEY : ''), { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} }, 30000);
    if (!stream.ok || !stream.body) return res.status(502).send('err');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="' + String(td.data.title || 'track').replace(/[<>:"/\\|?*]+/g, '_') + '.mp3"');
    stream.body.pipe(res);
  } catch (e){ if (!res.headersSent) res.status(502).send('err'); }
});

api.get('/api/artist/:id', async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  try {
    const [a, t, al] = await Promise.all([
      jsonFetch('https://api.deezer.com/artist/' + id, {}, 7000),
      jsonFetch('https://api.deezer.com/artist/' + id + '/top?limit=30', {}, 7000),
      jsonFetch('https://api.deezer.com/artist/' + id + '/albums?limit=100', {}, 7000)
    ]);
    const artist = await readJson(a);
    const top = await readJson(t);
    const albums = await readJson(al);
    const all = Array.isArray(albums.data) ? albums.data : [];
    res.json({ artist, top_tracks: top.data || [], albums: all.filter(x => x.record_type !== 'single'), singles: all.filter(x => x.record_type === 'single') });
  } catch (e){ res.status(502).json({ error: e.message }); }
});

api.get('/api/album/:id', async (req, res) => {
  try {
    const r = await jsonFetch('https://api.deezer.com/album/' + encodeURIComponent(req.params.id), {}, 7000);
    const d = await readJson(r);
    if (!d?.id) return res.status(404).json({ error: 'not found' });
    res.json(d);
  } catch (e){ res.status(502).json({ error: e.message }); }
});

api.get('/api/lyrics', async (req, res) => {
  const track = String(req.query.track_name || '').trim();
  const artist = String(req.query.artist_name || '').trim();
  const album = String(req.query.album_name || '').trim();
  const dur = Number(req.query.duration || 0);
  if (!track || !artist) return res.status(400).json({ found: false });
  try {
    const params = new URLSearchParams({ track_name: track, artist_name: artist });
    if (album) params.set('album_name', album);
    if (dur > 0) params.set('duration', String(Math.round(dur)));
    const r = await jsonFetch('https://lrclib.net/api/get?' + params.toString(), { headers: { 'User-Agent': 'NOVA/2.0' } }, 10000);
    if (r.ok){
      const d = await readJson(r);
      if (d.plainLyrics || d.syncedLyrics) return res.json({ found: true, plainLyrics: d.plainLyrics || '', syncedLyrics: d.syncedLyrics || '', source: 'LRCLIB' });
    }
    res.status(404).json({ found: false });
  } catch (e){ res.status(502).json({ found: false }); }
});

// ============================================================
// YOUTUBE RESOLVER
// ============================================================
async function searchYouTube(q){
  const ytsr = await getSearch();
  if (!ytsr) return [];
  try {
    const videos = await ytsr.search(q, { limit: 5, type: 'video' });
    return videos.map(v => ({
      videoId: v.id,
      title: v.title,
      duration: v.duration ? Math.round(v.duration / 1000) : 0,
      url: v.url
    }));
  } catch (e){
    console.error('[yt search]', e.message);
    return [];
  }
}

async function getYtStreamUrl(videoId){
  const cacheKey = 's:' + videoId;
  const c = streamCache.get(cacheKey);
  if (c && Date.now() - c.time < STREAM_TTL) return c.url;

  const ytdl = await getYT();
  if (!ytdl) throw new Error('ytdl not loaded');

  const info = await ytdl.getInfo('https://www.youtube.com/watch?v=' + videoId);
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('no audio format');
  streamCache.set(cacheKey, { time: Date.now(), url: format.url });
  return format.url;
}

async function findPlayableAudio(query){
  const aq = normalizeSearchText(query);

  const audiusPromise = searchAudius(aq).then(r => {
    const best = (r.results || []).filter(x => x.source === 'FULL').sort((a, b) => scoreProviderTrack(b, aq) - scoreProviderTrack(a, aq))[0];
    if (best?.id) return { provider: 'audius', streamUrl: '/api/audio/audius/' + encodeURIComponent(best.id), title: best.title, artist: best.artist };
    throw new Error('no audius');
  });

  const ytPromise = (async () => {
    const ys = await searchYouTube(query);
    if (!ys.length) throw new Error('no yt results');
    for (const c of ys){
      try {
        await getYtStreamUrl(c.videoId);
        return { provider: 'youtube', streamUrl: '/api/audio/youtube/' + encodeURIComponent(c.videoId), videoId: c.videoId, title: c.title, duration: c.duration };
      } catch (e){ /* next */ }
    }
    throw new Error('no yt stream');
  })();

  try {
    return await Promise.any([audiusPromise, ytPromise]);
  } catch (e){
    throw new Error('no playable source');
  }
}

// ============================================================
// STATIC
// ============================================================
api.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
api.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

api.use((err, req, res, next) => {
  console.error('[NOVA]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false });
});

function startServer(options = {}){
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  return new Promise((resolve, reject) => {
    const server = api.listen(port, host, () => {
      console.log('[NOVA] listening on http://' + host + ':' + port);
      console.log('[NOVA] DB at ' + DB_PATH);
      console.log('[NOVA] users: ' + Object.keys(db.users).length);
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (require.main === module){
  startServer().catch(e => { console.error('Failed:', e); process.exit(1); });
}
module.exports = { api, startServer };
