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

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';

let ytModule = null, yt = null, ytReady = false, ytInitPromise = null;
const ytStreamCache = new Map();
const searchCache = new Map();
const YT_STREAM_TTL = 4 * 60 * 1000;

const api = express();
api.disable('x-powered-by');
api.use(cors());
api.use(express.json({ limit: '2mb' }));

function trackKey(t){
  return [String(t.source || ''), String(t.id || ''), String(t.title || ''), String(t.artist || '')].join('|');
}

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
function hashPassword(password, salt){
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

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

  db.users[id] = {
    id, username, avatar: '', discriminator: '0', provider: 'local',
    passwordHash: hash, passwordSalt: salt, createdAt: Date.now()
  };
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
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

api.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const tokenParams = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code, redirect_uri: DISCORD_REDIRECT_URI
    });
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', body: tokenParams,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('Token error');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const user = await userRes.json();

    const userId = user.id;
    if (!db.users[userId]){
      db.users[userId] = {
        id: userId, username: user.username, avatar: user.avatar || '',
        discriminator: user.discriminator || '0', provider: 'discord',
        createdAt: Date.now()
      };
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
  for (const k of ['1000x1000', '480x480', '600x600', '640x640', '320x320', '150x150'])
    if (o[k]) return o[k];
  for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].startsWith('http')) return o[k];
  return '';
}

function normalizeSearchText(v){
  return String(v || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ============================================================
// SPOTIFY
// ============================================================
let spotifyTokenCache = { accessToken: '', expiresAt: 0 };

async function getSpotifyToken(){
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return '';
  if (spotifyTokenCache.accessToken && Date.now() < spotifyTokenCache.expiresAt - 30000)
    return spotifyTokenCache.accessToken;
  const cred = Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
  const r = await jsonFetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + cred, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  }, 10000);
  const d = await readJson(r);
  if (!d.access_token) throw new Error('no spotify token');
  spotifyTokenCache.accessToken = d.access_token;
  spotifyTokenCache.expiresAt = Date.now() + Number(d.expires_in || 3600) * 1000;
  return spotifyTokenCache.accessToken;
}

async function searchSpotify(q){
  try {
    const t = await getSpotifyToken();
    if (!t) return { results: [], count: 0 };
    const url = 'https://api.spotify.com/v1/search?' + new URLSearchParams({ q, type: 'track', limit: '30', market: 'US' });
    const r = await jsonFetch(url, { headers: { Authorization: 'Bearer ' + t } }, 8000);
    const d = await readJson(r);
    const items = d?.tracks?.items || [];
    const results = items.map(tr => ({
      id: tr.id,
      title: tr.name,
      artist: tr.artists?.[0]?.name || '',
      artistId: tr.artists?.[0]?.id || '',
      cover: tr.album?.images?.[0]?.url || '',
      album: tr.album?.name || '',
      albumId: tr.album?.id || '',
      preview: tr.preview_url || '',
      source: 'CATALOG',
      sourceUrl: tr.external_urls?.spotify || '',
      downloadable: false,
      duration: Number(tr.duration_ms || 0) / 1000,
      popularity: Number(tr.popularity || 0),
      provider: 'spotify'
    }));
    return { results, count: results.length };
  } catch (e){ console.error('[Spotify]', e.message); return { results: [], count: 0 }; }
}

// ============================================================
// ITUNES — главный источник популярных
// ============================================================
async function searchItunes(q, opts = {}){
  try {
    const params = new URLSearchParams({
      term: q,
      media: 'music',
      entity: 'song',
      limit: opts.limit || '50'
    });
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const results = items.map((tr, idx) => {
      // Чем выше в результатах iTunes — тем популярнее
      const rankBoost = Math.max(0, 100 - idx);
      return {
        id: 'itunes_' + String(tr.trackId || ''),
        title: tr.trackName || 'Untitled',
        artist: tr.artistName || '',
        artistId: '',
        cover: (tr.artworkUrl100 || '').replace('100x100', '600x600'),
        album: tr.collectionName || '',
        albumId: '',
        preview: tr.previewUrl || '',
        source: 'CATALOG',
        sourceUrl: tr.trackViewUrl || '',
        downloadable: false,
        duration: Number(tr.trackTimeMillis || 0) / 1000,
        popularity: 50000 + rankBoost * 500,  // Реальная популярность по позиции в iTunes
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
    const r = await jsonFetch('https://api.audius.co/v1/tracks/search?' + params.toString(),
      { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} }, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    const results = items
      .filter(t => { const dur = Number(t.duration || 0); return !(dur > 0 && dur < 60) && !t.is_unlisted; })
      .map(t => {
        const id = t.id || '';
        return {
          id, title: t.title || 'Untitled',
          artist: t.user?.name || 'Unknown', artistId: t.user?.id || '',
          cover: firstImage(t.artwork),
          preview: '/api/audio/audius/' + encodeURIComponent(id),
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

  // iTunes = известные артисты — приоритет выше
  if (item.provider === 'itunes') score += 30000;
  if (item.provider === 'spotify') score += 20000;
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
api.get('/api/health', (req, res) => res.json({ ok: true, service: 'NOVA', version: '2.1.0' }));

api.get('/api/popular', async (req, res) => {
  // Отдельный запрос для главной — популярные хиты
  const cacheKey = 'popular';
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 300000) return res.json(cached.data);

  const wrap = (fn, ms) => Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), ms))]);
  const settled = await Promise.allSettled([
    wrap(() => searchItunes('top hits 2024', { limit: '30' }), 4000),
    wrap(() => searchItunes('popular music', { limit: '30' }), 4000)
  ]);

  const all = [];
  const seen = new Set();
  for (const s of settled){
    if (s.status !== 'fulfilled') continue;
    for (const t of s.value.results || []){
      const key = normalizeSearchText(t.artist) + '|' + normalizeSearchText(t.title);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(t);
    }
  }
  const payload = { results: all.slice(0, 40) };
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
    wrap(() => searchItunes(q), 4500),
    wrap(() => searchAudius(q), 4500),
    wrap(() => searchSpotify(q), 4500)
  ]);

  const results = mergeProviderResults(
    settled.map(x => x.status === 'fulfilled' ? x.value : { results: [], count: 0 }),
    q
  );

  const payload = {
    results,
    counts: {
      itunes: settled[0].value?.count || 0,
      audius: settled[1].value?.count || 0,
      spotify: settled[2].value?.count || 0
    }
  };
  searchCache.set(cacheKey, { time: Date.now(), data: payload });
  res.json(payload);
});

api.get('/api/audio/resolve', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'empty' });
  try { const r = await findPlayableAudio(q); res.json({ ok: true, ...r }); }
  catch (e){ res.status(502).json({ ok: false, error: e.message }); }
});

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  try {
    const direct = await getYtStreamUrl(vid);
    const headers = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(direct, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).end();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']){
      const v = upstream.headers.get(h);
      if (v) res.setHeader({ 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'content-range': 'Content-Range', 'accept-ranges': 'Accept-Ranges' }[h], v);
    }
    res.status(upstream.status);
    if (upstream.body?.pipe) upstream.body.pipe(res);
    else res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e){ if (!res.headersSent) res.status(502).end(); else res.end(); }
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
// YOUTUBE
// ============================================================
async function initYT(){
  if (ytInitPromise) return ytInitPromise;
  ytInitPromise = (async () => {
    try {
      ytModule = await import('youtubei.js');
      const { Innertube } = ytModule;
      yt = await Innertube.create({ lang: 'en', location: 'US', retrieve_player: true, generate_session_locally: true });
      ytReady = true;
      console.log('[audio] youtubei ready');
    } catch (e){ console.error('[yt]', e.message); }
  })();
  return ytInitPromise;
}
function ytText(v){ return typeof v === 'string' ? v : String(v?.text || ''); }
function scoreYt(v, q){
  const t = ytText(v.title).toLowerCase(), c = ytText(v.author).toLowerCase(), qq = normalizeSearchText(q);
  let s = 0;
  for (const w of qq.split(/\s+/).filter(Boolean)){ if (t.includes(w)) s += 18; if (c.includes(w)) s += 12; }
  if (/(topic|vevo|official)/i.test(c)) s += 50;
  if (/\b(cover|remix|live|reaction|instrumental|karaoke|8d|sped up|slowed|nightcore)\b/i.test(t)) s -= 100;
  const dur = Number(v.duration?.seconds || 0);
  if (dur >= 120 && dur <= 420) s += 25;
  else if (dur > 0 && (dur < 45 || dur > 1200)) s -= 80;
  return s;
}
async function searchYouTube(q){
  if (!ytReady) await initYT();
  if (!ytReady) return [];
  try {
    const search = await yt.search(q, { type: 'video' });
    return (search.videos || []).filter(v => v?.video_id).slice(0, 15).map(v => ({ v, score: scoreYt(v, q) })).sort((a, b) => b.score - a.score).slice(0, 7).map(x => ({ videoId: x.v.video_id, title: ytText(x.v.title), duration: Number(x.v.duration?.seconds || 0) }));
  } catch (_) { return []; }
}
async function getYtStreamUrl(id){
  if (!ytReady) await initYT();
  if (!ytReady) throw new Error('yt not ready');
  const ck = 's:' + id;
  const c = ytStreamCache.get(ck);
  if (c && Date.now() - c.time < 120000) return c.url;
  const info = await yt.getBasicInfo(id);
  const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
  if (!fmt) throw new Error('no fmt');
  const url = await fmt.decipher(yt.session.player);
  ytStreamCache.set(ck, { time: Date.now(), url });
  return url;
}
async function findPlayableAudio(query){
  const aq = normalizeSearchText(query);
  const [ar, yr] = await Promise.allSettled([
    Promise.race([searchAudius(aq), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), 3500))]),
    searchYouTube(aq)
  ]);
  if (ar.status === 'fulfilled'){
    const best = (ar.value.results || []).filter(x => x.source === 'FULL').sort((a, b) => scoreProviderTrack(b, aq) - scoreProviderTrack(a, aq))[0];
    if (best?.id) return { provider: 'audius', streamUrl: '/api/audio/audius/' + encodeURIComponent(best.id), title: best.title, artist: best.artist };
  }
  const ys = yr.status === 'fulfilled' ? yr.value : [];
  for (const c of ys){
    try { await getYtStreamUrl(c.videoId); return { provider: 'youtube', streamUrl: '/api/audio/youtube/' + encodeURIComponent(c.videoId), videoId: c.videoId, title: c.title, duration: c.duration }; }
    catch (_) {}
  }
  throw new Error('no playable');
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
