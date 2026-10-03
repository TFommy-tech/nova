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

const resolveCache = new Map();
const searchCache = new Map();
const RESOLVE_TTL = 30 * 60 * 1000;

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
// ФИЛЬТР МУСОРНЫХ ТРЕКОВ Deezer — ОСЛАБЛЕН
// ============================================================
const NOISE_PATTERNS = [
  /\bspeed\s*up\b/i,
  /\bsped\s*up\b/i,
  /\bslowed\s*\+?\s*reverb\b/i,
  /\bnightcore\s*version\b/i,
  /\bkaraoke\s*version\b/i,
  /\binstrumental\s*version\b/i,
  /\b8\s*d\s*audio\b/i,
  /\btype\s*beat\b/i,
  /\bmade\s*famous\s*by\b/i,
  /\bin\s*the\s*style\s*of\b/i,
  /\btribute\s*to\b/i,
];

function isNoiseDeezerTrack(t, artistId){
  if (!t) return true;
  const title = String(t.title_short || t.title || '');
  const version = String(t.title_version || '');
  const combined = title + ' ' + version;
  for (const p of NOISE_PATTERNS){ if (p.test(combined)) return true; }
  if (!title.trim()) return true;
  return false;
}

// ============================================================
// ФИЛЬТР АЛЬБОМОВ Deezer
// ============================================================
function isOwnedAlbum(album, artistId, artistName){
  if (!album) return false;
  if (album.artist && album.artist.id){
    if (String(album.artist.id) === String(artistId)) return true;
  }
  if (album.artist && album.artist.name && artistName){
    const a = String(album.artist.name).toLowerCase().trim();
    const w = String(artistName).toLowerCase().trim();
    if (a === w) return true;
  }
  return false;
}

const BAD_ALBUM_WORDS = [
  'maple story', 'maplestory', 'ost', 'original soundtrack', 'game soundtrack',
  'soundtrack', 'tribute', 'karaoke', 'various artists', 'compilation',
];

function isBadAlbumTitle(title){
  const t = String(title || '').toLowerCase();
  for (const w of BAD_ALBUM_WORDS) if (t.includes(w)) return true;
  return false;
}

const BAD_YT_WORDS = [
  'разбор', 'реакция', 'reaction', 'review', 'обзор', 'интервью', 'interview',
  'подкаст', 'podcast', 'премьера клипа', 'премьера', 'premiere', 'тизер', 'teaser',
  'трейлер', 'trailer', 'full album', 'full ep', 'full mixtape', 'полный альбом',
  'микс ', 'микс2', 'megamix', 'сборник', 'compilation', 'playlist', 'плейлист',
  'топ 10', 'топ 20', 'top 10', 'top 20', 'top10', 'top20', 'best of',
  'лучшие песни', 'все песни', 'all songs', 'дисс', 'diss track',
  'making of', 'как создавался', 'making beat', 'fl studio', 'flp',
  'history of', 'история группы', 'биография', 'biography',
  'бит', 'type beat', 'beat prod', 'инструментал', 'кавер', 'cover',
  'пародия', 'parody', 'tribute', 'ремикс', 'remix', 'mashup',
  'speed up', 'slowed', 'nightcore', 'sped up', 'караоке', 'karaoke',
  'backing track', 'минус', 'минусовка', '8d audio', '8d',
  'дайджест', 'итоги', 'новости', 'news', 'лекция', 'вебинар',
];

function isBadYoutubeTitle(title){
  const t = String(title || '').toLowerCase();
  const head = t.slice(0, 120);
  for (const w of BAD_YT_WORDS){ if (head.includes(w)) return true; }
  return false;
}

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
  } catch (e){ res.status(500).send('Auth error'); }
});

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
  if (!list.some(t => trackKey(t) === key)){ list.unshift(track); db.favorites[req.user.id] = list.slice(0, 500); saveDb(db); }
  res.json({ ok: true });
});
api.delete('/api/favorites/:key', authMiddleware, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const list = db.favorites[req.user.id] || [];
  db.favorites[req.user.id] = list.filter(t => trackKey(t) !== key);
  saveDb(db); res.json({ ok: true });
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
  saveDb(db); res.json({ ok: true });
});

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

async function searchItunes(q, opts = {}){
  try {
    const params = new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: opts.limit || '50' });
    if (opts.attribute) params.set('attribute', opts.attribute);
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const results = items.map((tr, idx) => {
      const rankBoost = Math.max(0, 100 - idx);
      return {
        id: 'itunes_' + String(tr.trackId || ''), title: tr.trackName || 'Untitled',
        artist: tr.artistName || '', artistId: '',
        cover: (tr.artworkUrl100 || '').replace('100x100', '600x600'),
        album: tr.collectionName || '', albumId: '',
        preview: '',
        source: 'CATALOG', sourceUrl: tr.trackViewUrl || '', downloadable: false,
        duration: Number(tr.trackTimeMillis || 0) / 1000,
        popularity: 50000 + rankBoost * 500, releaseDate: tr.releaseDate || '', provider: 'itunes'
      };
    });
    return { results, count: results.length };
  } catch (e){ return { results: [], count: 0 }; }
}

// iTunes albums — с фильтром по имени артиста
async function searchItunesAlbums(artistName){
  try {
    const params = new URLSearchParams({ term: artistName, media: 'music', entity: 'album', attribute: 'artistTerm', limit: '100' });
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const norm = normalizeSearchText(artistName);
    return items.filter(x => {
      const a = normalizeSearchText(x.artistName);
      return a === norm || a.startsWith(norm + ' ') || norm.startsWith(a + ' ');
    });
  } catch (e){ return []; }
}

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
          cover: firstImage(t.artwork), preview: '', source: 'FULL',
          sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : '',
          downloadable: Boolean(t.downloadable),
          downloadUrl: t.downloadable ? '/api/download/audius/' + encodeURIComponent(id) : '',
          duration: Number(t.duration || 0), bitrate: Number(t.bitrate || 0),
          popularity: Number(t.play_count || 0) + Number(t.favorite_count || 0) * 5,
          releaseDate: t.release_date || t.created_at || '', provider: 'audius'
        };
      });
    return { results, count: results.length };
  } catch (e){ return { results: [], count: 0 }; }
}

async function searchYouTubeMeta(q){
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/);
    if (!match) return { results: [], count: 0 };
    const data = JSON.parse(match[1]);
    const items = [];
    function walk(obj){
      if (!obj || typeof obj !== 'object' || items.length >= 30) return;
      if (obj.videoRenderer){
        const v = obj.videoRenderer;
        const vid = v.videoId;
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
        const author = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || 'YouTube';
        const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';
        const durationText = v.lengthText?.simpleText || '';
        let duration = 0;
        if (durationText){
          const parts = durationText.split(':').map(Number);
          if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) duration = parts[0] * 60 + parts[1];
        }
        if (vid && title){
          items.push({ id: 'yt_' + vid, title, artist: author, channel: author, artistId: '', cover: thumb, album: '', albumId: '', preview: '', source: 'FULL', sourceUrl: 'https://www.youtube.com/watch?v=' + vid, downloadable: false, duration, popularity: 10000, provider: 'youtube' });
        }
      }
      for (const k in obj){ if (Array.isArray(obj[k])) obj[k].forEach(walk); else if (typeof obj[k] === 'object') walk(obj[k]); }
    }
    walk(data);
    return { results: items, count: items.length };
  } catch (e){ return { results: [], count: 0 }; }
}

function scoreProviderTrack(item, query){
  const q = normalizeSearchText(query), title = normalizeSearchText(item.title), artist = normalizeSearchText(item.artist);
  if (!q) return 0;
  let score = 0; const tokens = q.split(/\s+/).filter(Boolean); const combined = title + ' ' + artist;
  if (title === q) score += 1000000; else if (title.startsWith(q)) score += 500000; else if (title.includes(q)) score += 200000;
  if (artist === q) score += 800000; else if (artist.startsWith(q)) score += 400000; else if (artist.includes(q)) score += 150000;
  let hits = 0;
  for (const t of tokens){ if (title.split(/\s+/).includes(t)) hits += 3; else if (artist.split(/\s+/).includes(t)) hits += 2; else if (combined.includes(t)) hits += 1; }
  score += hits * 1500;
  const pop = Number(item.popularity || 0);
  if (pop > 0) score += Math.log10(pop + 1) * 5000;
  if (item.provider === 'itunes') score += 30000;
  if (item.source === 'FULL') score += 500;
  return score;
}

function mergeProviderResults(providers, query){
  const out = []; const seen = new Set();
  for (const p of providers){
    if (!p) continue;
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

api.get('/api/health', (req, res) => res.json({ ok: true, service: 'NOVA', version: '3.0.0' }));

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
        results.push({ id: 'itunes_' + id, title, artist, artistId: '', cover: cover.replace('170x170', '600x600').replace('100x100', '600x600'), album: e['im:collection']?.['im:name']?.label || '', albumId: '', preview: '', source: 'CATALOG', sourceUrl: e.id?.label || '', downloadable: false, duration: 0, popularity: 100000, provider: 'itunes' });
      }
    } catch (e){}
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
  const safeFetch = async (fn, name, ms) => {
    try { return await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error(name + ' timeout')), ms))]); }
    catch (e){ return { results: [], count: 0 }; }
  };
  const [itunes, audius, yt] = await Promise.all([
    safeFetch(() => searchItunes(q, { limit: '80' }), 'itunes', 3500),
    safeFetch(() => searchAudius(q), 'audius', 3000),
    safeFetch(() => searchYouTubeMeta(q), 'youtube', 5000)
  ]);
  const providers = [];
  if (itunes) providers.push(itunes);
  if (audius) providers.push(audius);
  if (yt) providers.push(yt);
  let results = [];
  try { results = mergeProviderResults(providers, q); } catch (e){ results = []; }
  const payload = { results, counts: { itunes: itunes?.count || 0, audius: audius?.count || 0, youtube: yt?.count || 0 } };
  searchCache.set(cacheKey, { time: Date.now(), data: payload });
  res.json(payload);
});

api.get('/api/audio/resolve', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const duration = Number(req.query.duration || 0);
  const legacyQ = String(req.query.q || '').trim();
  const q = legacyQ || [title, artist].filter(Boolean).join(' ');
  if (!q && !title && !artist) return res.status(400).json({ ok: false, error: 'empty' });
  const ck = normalizeSearchText(q) + (duration > 0 ? '|d' + Math.round(duration) : '');
  const cached = resolveCache.get(ck);
  if (cached && Date.now() - cached.time < RESOLVE_TTL) return res.json({ ok: true, ...cached.data, cached: true });
  try {
    const r = await findPlayableAudio({ title, artist, duration, full: q });
    resolveCache.set(ck, { time: Date.now(), data: r });
    res.json({ ok: true, ...r });
  } catch (e){
    res.status(502).json({ ok: false, error: e.message });
  }
});

api.post('/api/audio/prefetch', async (req, res) => {
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 6) : [];
  res.json({ ok: true, count: tracks.length });
  (async () => {
    for (const t of tracks){
      try {
        const title = String(t.title || '').trim(); const artist = String(t.artist || '').trim();
        const duration = Number(t.duration || 0);
        const q = [title, artist].filter(Boolean).join(' ');
        if (!q) continue;
        const ck = normalizeSearchText(q) + (duration > 0 ? '|d' + Math.round(duration) : '');
        if (resolveCache.has(ck) && Date.now() - resolveCache.get(ck).time < RESOLVE_TTL) continue;
        const r = await findPlayableAudio({ title, artist, duration, full: q });
        resolveCache.set(ck, { time: Date.now(), data: r });
      } catch (e){}
    }
  })();
});

const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si', 'https://inv.nadeko.net', 'https://yewtu.be',
  'https://invidious.nerdvpn.de', 'https://iv.melmac.space',
  'https://invidious.privacyredirect.com', 'https://vid.puffyan.us',
  'https://invidious.projectsegfau.lt', 'https://inv.tux.pizza',
  'https://invidious.reallyaweso.me'
];
const PIPED_INSTANCES = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.yt'];

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  const range = req.headers.range || '';
  for (const base of INVIDIOUS_INSTANCES){
    try {
      const url = base + '/latest_version?id=' + vid + '&itag=140&local=true';
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' };
      if (range) headers.Range = range;
      const upstream = await fetch(url, { headers, redirect: 'follow', timeout: 15000 });
      if (!upstream.ok && upstream.status !== 206){ try { upstream.body?.destroy(); } catch (_){} continue; }
      const ct = String(upstream.headers.get('content-type') || '').toLowerCase();
      const cl = Number(upstream.headers.get('content-length') || 0);
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')){ try { upstream.body?.destroy(); } catch (_){} continue; }
      if (cl > 0 && cl < 50000){ try { upstream.body?.destroy(); } catch (_){} continue; }
      res.setHeader('Content-Type', ct.startsWith('audio/') || ct.startsWith('video/') ? ct : 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (cl > 0) res.setHeader('Content-Length', String(cl));
      const cr = upstream.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.status(upstream.status === 206 ? 206 : 200);
      upstream.body.pipe(res);
      req.on('close', () => { try { upstream.body?.destroy(); } catch (_){} });
      return;
    } catch (e){}
  }
  for (const base of PIPED_INSTANCES){
    try {
      const r = await fetch(base + '/streams/' + vid, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      if (!r.ok) continue;
      const d = await r.json();
      const streams = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
      const best = streams.filter(s => s.url && s.mimeType && s.mimeType.includes('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best?.url) continue;
      const proxyUrl = best.proxyUrl || best.url;
      const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
      if (range) headers.Range = range;
      const upstream = await fetch(proxyUrl, { headers, redirect: 'follow', timeout: 15000 });
      if (!upstream.ok && upstream.status !== 206) continue;
      const ct = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')){ try { upstream.body?.destroy(); } catch (_){} continue; }
      res.setHeader('Content-Type', best.mimeType || 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.status(upstream.status === 206 ? 206 : 200);
      upstream.body.pipe(res);
      req.on('close', () => { try { upstream.body?.destroy(); } catch (_){} });
      return;
    } catch (e){}
  }
  res.status(502).end();
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
    res.setHeader('Access-Control-Allow-Origin', '*');
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

api.get('/api/artist-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'empty' });
  try {
    const url = 'https://api.deezer.com/search/artist?q=' + encodeURIComponent(q) + '&limit=15';
    const r = await jsonFetch(url, {}, 7000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    if (!items.length) return res.status(404).json({ error: 'not found' });
    const norm = normalizeSearchText(q);
    const exact = items.filter(a => normalizeSearchText(a.name) === norm);
    if (!exact.length) return res.status(404).json({ error: 'no exact match' });
    exact.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
    const best = exact[0];
    res.json({ id: String(best.id), name: best.name, picture: best.picture_xl || best.picture_big || best.picture_medium || '', nb_fan: best.nb_fan || 0 });
  } catch (e){ res.status(502).json({ error: e.message }); }
});

// ============================================================
// ARTIST
// Deezer /top и /albums блокирует запросы с облачных IP (Render).
// Фолбэк на iTunes со СТРОГИМ фильтром по имени артиста.
// Воспроизведение всё равно идёт через YouTube (Invidious/Piped) —
// полноценные треки, а не 30-сек превью.
// ============================================================
api.get('/api/artist/:id', async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  try {
    // 1. Профиль артиста — всегда из Deezer (этот эндпоинт работает с облачных IP)
    const a = await jsonFetch('https://api.deezer.com/artist/' + id, {}, 7000);
    const artist = await readJson(a);
    if (!artist || !artist.id) return res.status(404).json({ error: 'not found' });
    const artistName = artist.name || '';
    const normArtist = normalizeSearchText(artistName);

    // 2. Топ-треки: сначала Deezer
    let top_tracks = [];
    try {
      const t = await jsonFetch('https://api.deezer.com/artist/' + id + '/top?limit=100', {}, 7000);
      const top = await readJson(t);
      const rawTracks = Array.isArray(top.data) ? top.data : [];
      top_tracks = rawTracks.filter(tr => !isNoiseDeezerTrack(tr, id));
      top_tracks.sort((a, b) => (b.rank || 0) - (a.rank || 0));
      console.log('[artist]', id, 'deezer raw tracks:', rawTracks.length, '→ filtered:', top_tracks.length);
    } catch (e){ console.log('[artist]', id, 'deezer top failed:', e.message); }

    // 3. Фолбэк: iTunes с attribute=artistTerm и строгой проверкой имени артиста
    if (!top_tracks.length && artistName){
      try {
        const params = new URLSearchParams({
          term: artistName,
          media: 'music',
          entity: 'song',
          attribute: 'artistTerm',
          limit: '100'
        });
        const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 9000);
        const d = await readJson(r);
        const raw = Array.isArray(d?.results) ? d.results : [];

        // Строгое совпадение: artistName из iTunes должен ТОЧНО совпасть после нормализации
        const strict = raw.filter(x => normalizeSearchText(x.artistName) === normArtist);

        // Мягкий фолбэк: имя совпадает по границе слова
        const soft = strict.length ? strict : raw.filter(x => {
          const an = normalizeSearchText(x.artistName);
          if (!an) return false;
          return an === normArtist || an.startsWith(normArtist + ' ') || normArtist.startsWith(an + ' ');
        });

        top_tracks = soft.map((x, idx) => ({
          id: 'itunes_' + String(x.trackId || ''),
          title: x.trackName || 'Untitled',
          title_short: x.trackName || 'Untitled',
          duration: Number(x.trackTimeMillis || 0) / 1000,
          rank: Math.max(0, 100000 - idx * 100),
          preview: '',
          artist: { id: artist.id, name: x.artistName || artistName },
          album: {
            title: x.collectionName || '',
            cover_medium: (x.artworkUrl100 || '').replace('100x100', '500x500')
          },
          provider: 'itunes'
        }));
        console.log('[artist]', id, 'itunes fallback tracks: raw=' + raw.length + ' strict=' + strict.length + ' final=' + top_tracks.length);
      } catch (e){ console.log('[artist]', id, 'itunes tracks failed:', e.message); }
    }

    // 4. Альбомы: сначала Deezer
    let owned = [];
    try {
      const al = await jsonFetch('https://api.deezer.com/artist/' + id + '/albums?limit=200', {}, 7000);
      const albums = await readJson(al);
      const all = Array.isArray(albums.data) ? albums.data : [];
      owned = all.filter(x => isOwnedAlbum(x, id, artistName) && !isBadAlbumTitle(x.title));
      console.log('[artist]', id, 'deezer raw albums:', all.length, '→ owned:', owned.length);
    } catch (e){ console.log('[artist]', id, 'deezer albums failed:', e.message); }

    // 5. Фолбэк альбомов на iTunes
    if (!owned.length && artistName){
      try {
        const items = await searchItunesAlbums(artistName);
        owned = items
          .filter(x => !isBadAlbumTitle(x.collectionName))
          .map(x => ({
            id: 'itunes_album_' + x.collectionId,
            title: x.collectionName,
            cover_medium: (x.artworkUrl100 || '').replace('100x100', '500x500'),
            cover_big: (x.artworkUrl100 || '').replace('100x100', '1000x1000'),
            cover_xl: (x.artworkUrl100 || '').replace('100x100', '1000x1000'),
            record_type: Number(x.trackCount || 0) <= 3 ? 'single' : 'album',
            nb_tracks: Number(x.trackCount || 0),
            release_date: x.releaseDate || '',
            artist: { id: artist.id, name: artistName },
            provider: 'itunes'
          }));
        console.log('[artist]', id, 'itunes fallback albums:', owned.length);
      } catch (e){ console.log('[artist]', id, 'itunes albums failed:', e.message); }
    }

    res.json({
      artist,
      top_tracks,
      albums: owned.filter(x => x.record_type !== 'single'),
      singles: owned.filter(x => x.record_type === 'single')
    });
  } catch (e){
    res.status(502).json({ error: e.message });
  }
});

api.get('/api/album/:id', async (req, res) => {
  try {
    const rawId = String(req.params.id);

    // iTunes-альбом
    if (rawId.startsWith('itunes_album_')){
      const collectionId = rawId.replace('itunes_album_', '');
      const r = await jsonFetch('https://itunes.apple.com/lookup?id=' + encodeURIComponent(collectionId) + '&entity=song&limit=200', {}, 9000);
      const d = await readJson(r);
      const items = Array.isArray(d?.results) ? d.results : [];
      const albumMeta = items.find(x => x.wrapperType === 'collection') || {};
      const tracks = items.filter(x => x.wrapperType === 'track').map(tr => ({
        id: 'itunes_' + String(tr.trackId || ''),
        title: tr.trackName || 'Untitled',
        title_short: tr.trackName || 'Untitled',
        duration: Number(tr.trackTimeMillis || 0) / 1000,
        rank: 0,
        preview: '',
        artist: { id: '', name: tr.artistName || '' },
        album: { id: rawId, title: tr.collectionName || '', cover_medium: (tr.artworkUrl100 || '').replace('100x100', '500x500') },
        provider: 'itunes'
      }));
      return res.json({
        id: rawId,
        title: albumMeta.collectionName || '',
        cover_medium: (albumMeta.artworkUrl100 || '').replace('100x100', '500x500'),
        cover_big: (albumMeta.artworkUrl100 || '').replace('100x100', '1000x1000'),
        cover_xl: (albumMeta.artworkUrl100 || '').replace('100x100', '1000x1000'),
        artist: { id: '', name: albumMeta.artistName || '' },
        release_date: albumMeta.releaseDate || '',
        nb_tracks: tracks.length,
        tracks: { data: tracks },
        provider: 'itunes'
      });
    }

    // Обычный Deezer-альбом
    const r = await jsonFetch('https://api.deezer.com/album/' + encodeURIComponent(rawId), {}, 7000);
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
  if (!track && !artist) return res.status(400).json({ found: false });
  const cleanTrack = track.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\b(official|audio|video|lyric|lyrics|visualizer|hd|hq|explicit)\b/gi, '').replace(/\s+/g, ' ').trim();

  try {
    const params = new URLSearchParams({ track_name: cleanTrack });
    if (artist) params.set('artist_name', artist);
    if (album) params.set('album_name', album);
    if (dur > 0) params.set('duration', String(Math.round(dur)));
    const r = await jsonFetch('https://lrclib.net/api/get?' + params.toString(), { headers: { 'User-Agent': 'NOVA/2.0' } }, 10000);
    if (r.ok){
      const d = await readJson(r);
      if (d.plainLyrics || d.syncedLyrics) return res.json({ found: true, plainLyrics: d.plainLyrics || '', syncedLyrics: d.syncedLyrics || '', source: 'LRCLIB' });
    }
  } catch (e){}

  try {
    const q = [cleanTrack, artist].filter(Boolean).join(' ');
    const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q }).toString(), { headers: { 'User-Agent': 'NOVA/2.0' } }, 10000);
    if (r.ok){
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length){
        const normArt = normalizeSearchText(artist);
        let best = arr[0];
        if (normArt){ for (const item of arr){ if (normalizeSearchText(item.artistName || '') === normArt){ best = item; break; } } }
        if (best.plainLyrics || best.syncedLyrics) return res.json({ found: true, plainLyrics: best.plainLyrics || '', syncedLyrics: best.syncedLyrics || '', source: 'LRCLIB' });
      }
    }
  } catch (e){}

  try {
    const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: cleanTrack }).toString(), { headers: { 'User-Agent': 'NOVA/2.0' } }, 10000);
    if (r.ok){
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length){
        const best = arr[0];
        if (best.plainLyrics || best.syncedLyrics) return res.json({ found: true, plainLyrics: best.plainLyrics || '', syncedLyrics: best.syncedLyrics || '', source: 'LRCLIB' });
      }
    }
  } catch (e){}

  res.status(404).json({ found: false });
});

function titleSimilarity(wantTitle, gotTitle){
  const w = normalizeSearchText(wantTitle), g = normalizeSearchText(gotTitle);
  if (!w) return 1; if (!g) return 0;
  const noise = /\b(feat|ft|featuring|prod|official|audio|video|lyrics|remix|version|edit|extended|original)\b/g;
  const wClean = w.replace(noise, ' ').replace(/\s+/g, ' ').trim();
  const gClean = g.replace(noise, ' ').replace(/\s+/g, ' ').trim();
  if (wClean === gClean) return 1;
  if (gClean.startsWith(wClean) || wClean.startsWith(gClean)) return 0.95;
  if (gClean.includes(wClean) || wClean.includes(gClean)) return 0.9;
  const wWords = wClean.split(/\s+/).filter(x => x.length > 1);
  const gWords = gClean.split(/\s+/).filter(x => x.length > 1);
  if (!wWords.length) return 0;
  let hits = 0;
  for (const ww of wWords){ if (gWords.includes(ww)) hits += 1; else if (gClean.includes(ww)) hits += 0.7; }
  return hits / wWords.length;
}
function artistSimilarity(wantArtist, gotArtist){
  const w = normalizeSearchText(wantArtist), g = normalizeSearchText(gotArtist);
  if (!w) return 1; if (!g) return 0;
  if (w === g) return 1;
  if (g.includes(w) || w.includes(g)) return 0.9;
  const wWords = w.split(/\s+/).filter(x => x.length > 2);
  if (!wWords.length) return 0;
  let best = 0;
  for (const ww of wWords){ if (g.includes(ww)) best = Math.max(best, 0.7); }
  return best;
}
function isChannelOfficialForArtist(channel, artist){
  if (!channel || !artist) return false;
  const c = String(channel).toLowerCase().trim(), a = String(artist).toLowerCase().trim();
  if (!c || !a) return false;
  if (c === a) return true;
  if (c === a + ' - topic') return true;
  if (c.endsWith(' - topic')){ const prefix = c.slice(0, -8).trim(); if (prefix === a) return true; }
  if (c.startsWith(a + ' ') || c.startsWith(a + '-') || c.startsWith(a + '–') || c.startsWith(a + '—')) return true;
  if (c.startsWith(a)){ const tail = c.slice(a.length).trim(); if (/^(vevo|official|records|music|musics|rec)$/i.test(tail)) return true; }
  return false;
}
function checkMatch(candidate, wantTitle, wantArtist, wantDuration){
  const aSim = artistSimilarity(wantArtist, candidate.artist); if (aSim < 0.5) return 0;
  const tSim = titleSimilarity(wantTitle, candidate.title); if (tSim < 0.6) return 0;
  if (candidate.provider === 'youtube'){
    if (isBadYoutubeTitle(candidate.title)) return 0;
    const dur = Number(candidate.duration || 0);
    if (dur > 0){
      if (dur > 480) return 0;
      if (dur < 45 && wantDuration < 45) return 0;
      if (wantDuration > 30){ const ratio = dur / wantDuration; if (ratio < 0.6 || ratio > 1.7) return 0; }
      else { if (dur > 420 || dur < 40) return 0; }
    }
    const channel = String(candidate.channel || '');
    if (!isChannelOfficialForArtist(channel, wantArtist)){
      const t = String(candidate.title || '').toLowerCase();
      const a = String(wantArtist || '').toLowerCase();
      if (!t.includes(a)) return 0;
      if (!/\b(official|vevo|lyric|audio|visualizer)\b/i.test(t)) return 0;
      if (titleSimilarity(wantTitle, candidate.title) < 0.85) return 0;
    }
  }
  return aSim * 0.4 + tSim * 0.6;
}

async function findPlayableAudio({ title, artist, duration, full }){
  const wantTitle = String(title || '').trim();
  const wantArtist = String(artist || '').trim();
  const wantDuration = Number(duration || 0);
  const fullQuery = String(full || '').trim();
  if (!wantTitle && !wantArtist && !fullQuery) throw new Error('empty query');
  const searchQuery = [wantTitle, wantArtist].filter(Boolean).join(' ').trim() || fullQuery;

  // 1. Audius — полноценные треки без прокси
  try {
    const r = await searchAudius(searchQuery);
    const list = (r.results || []).filter(x => x.source === 'FULL' && x.id);
    if (list.length){
      const scored = list.map(c => ({ c, s: checkMatch(c, wantTitle, wantArtist, 0) + scoreProviderTrack(c, searchQuery) * 0.00001 })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      if (scored.length){ const best = scored[0].c; return { provider: 'audius', streamUrl: '/api/audio/audius/' + encodeURIComponent(best.id), title: best.title, artist: best.artist }; }
    }
  } catch (e){}

  // 2. YouTube — полный стрим через Invidious/Piped
  try {
    const meta = await searchYouTubeMeta(searchQuery);
    const list = (meta.results || []);
    const scored = list.map(c => ({ c, s: checkMatch(c, wantTitle, wantArtist, wantDuration) + scoreProviderTrack(c, searchQuery) * 0.00001 })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length){
      const best = scored[0].c; const vid = String(best.id).replace('yt_', '');
      if (/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return { provider: 'youtube', streamUrl: '/api/audio/youtube/' + encodeURIComponent(vid), videoId: vid, title: best.title, duration: best.duration };
    }
  } catch (e){}

  throw new Error('no matching track');
}

api.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
api.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});
api.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(500).json({ ok: false }); });

function startServer(options = {}){
  const port = Number(options.port || PORT), host = options.host || HOST;
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
if (require.main === module){ startServer().catch(e => { process.exit(1); }); }
module.exports = { api, startServer };
