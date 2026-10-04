// ============================================================================
// server/server.js — NOVA v5.0.0
// Provider-based backend. No iTunes. Production-ready (Render/Suga).
// ============================================================================
'use strict';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const WEB_DIR = path.join(__dirname, '..', 'web');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'nova-dev-secret-change-me';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ||
  (PUBLIC_URL ? PUBLIC_URL + '/api/auth/discord/callback' : '');
const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- DB ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveDb() { try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (e) { console.error('[db]', e.message); } }
let db = loadDb();
for (const k of ['users', 'favorites', 'history', 'plays', 'playlists']) if (!db[k]) db[k] = {};

// ---------- CACHES ----------
const searchCache = new Map();
const resolveCache = new Map();
const lyricsCache = new Map();
const artistCache = new Map();
const SEARCH_TTL = 60 * 1000;
const RESOLVE_TTL = 25 * 60 * 1000;
const LYRICS_TTL = 24 * 60 * 60 * 1000;
const ARTIST_TTL = 10 * 60 * 1000;
const ARTIST_EMPTY_TTL = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.time > SEARCH_TTL) searchCache.delete(k);
  for (const [k, v] of resolveCache) if (now - v.time > RESOLVE_TTL) resolveCache.delete(k);
  for (const [k, v] of lyricsCache) if (now - v.time > LYRICS_TTL) lyricsCache.delete(k);
  for (const [k, v] of artistCache) if (now - v.time > (v.ttl || ARTIST_TTL)) artistCache.delete(k);
}, 5 * 60 * 1000);

// ---------- EXPRESS ----------
const api = express();
api.disable('x-powered-by');
api.use(cors({ origin: true, credentials: true }));
api.use(express.json({ limit: '2mb' }));
api.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const t = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t;
    if (res.statusCode >= 400 || ms > 1500)
      console.log(`[${res.statusCode}] ${req.method} ${req.path} ${ms}ms`);
  });
  next();
});

// ---------- UTILS ----------
const NOISE = [
  /\bspeed\s*up\b/i, /\bsped\s*up\b/i, /\bspedup\b/i,
  /\bslowed\b/i, /\bslowed\s*\+?\s*reverb\b/i, /\bslowed\s*down\b/i,
  /\bnightcore\b/i, /\bdaycore\b/i, /\b8\s*d\s*audio\b/i, /\b8d\b/i,
  /\breverb\b/i, /\bkaraoke\b/i, /\binstrumental\b/i,
  /\btype\s*beat\b/i, /\bbeat\s*prod\b/i,
  /\bchopped\s*(and|&|n)\s*screwed\b/i,
];
function isNoise(t) { const s = String(t || ''); return NOISE.some(r => r.test(s)); }
function normalize(v) {
  return String(v || '').toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function cleanTitle(v) {
  return String(v || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\b(official|lyric|lyrics|video|audio|visualizer|hd|hq|4k|mv|m\/v)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function splitArtists(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i)
    .map(s => s.trim()).filter(Boolean);
}
function trackKey(t) {
  return [String(t.provider || ''), String(t.providerId || t.id || ''), String(t.title || ''), String(t.artist || '')].join('|');
}
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function makeErr(code, message) { const e = new Error(message); e.code = code; e.structured = true; return e; }

async function jsonFetch(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const headers = { Accept: 'application/json', 'User-Agent': 'NOVA/5.0', ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
async function readJson(res) {
  const txt = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { throw new Error('bad json'); }
}
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}
function req_onclose(res, upstream) {
  try { res.req.on('close', () => { try { upstream.body?.destroy(); } catch {} }); } catch {}
}

// ============================================================================
// PROVIDERS
// ============================================================================
// Normalized track shape:
// { provider, providerId, id, title, artist, artistId, album, albumId, cover,
//   duration, popularity, explicit, sourceUrl, videoId?, downloadable? }

// ---------- Deezer (metadata only) ----------
async function deezerSearchTracks(q, limit = 40) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`, {}, 6000);
    const d = await readJson(r);
    return (d?.data || []).map(deezerToNorm).filter(Boolean);
  } catch { return []; }
}
async function deezerSearchArtists(q, limit = 10) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=${limit}`, {}, 6000);
    const d = await readJson(r);
    return (d?.data || []).map(a => ({
      provider: 'deezer', providerId: String(a.id),
      name: a.name,
      picture: a.picture_xl || a.picture_big || a.picture_medium || '',
      nbFan: a.nb_fan || 0
    }));
  } catch { return []; }
}
async function deezerGetArtist(id) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/artist/${encodeURIComponent(id)}`, {}, 7000);
    const d = await readJson(r);
    if (!d?.id) return null;
    return {
      provider: 'deezer', providerId: String(d.id),
      name: d.name || '',
      picture: d.picture_xl || d.picture_big || d.picture_medium || '',
      nbFan: d.nb_fan || 0
    };
  } catch { return null; }
}
async function deezerArtistTop(id, limit = 60) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/artist/${encodeURIComponent(id)}/top?limit=${limit}`, {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    return items
      .filter(t => !isNoise(t.title_short || t.title || ''))
      .filter(t => !(t.artist?.id && String(t.artist.id) !== String(id)))
      .map(deezerToNorm).filter(Boolean);
  } catch { return []; }
}
async function deezerArtistAlbums(id, limit = 100) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/artist/${encodeURIComponent(id)}/albums?limit=${limit}`, {}, 8000);
    const d = await readJson(r);
    return (d?.data || [])
      .filter(a => !a.artist?.id || String(a.artist.id) === String(id))
      .map(a => ({
        provider: 'deezer', providerId: String(a.id), id: String(a.id),
        title: a.title || '',
        cover: a.cover_xl || a.cover_big || a.cover_medium || '',
        recordType: a.record_type || 'album',
        nbTracks: a.nb_tracks || 0,
        releaseDate: a.release_date || '',
        artist: a.artist ? { id: String(a.artist.id), name: a.artist.name } : null
      }));
  } catch { return []; }
}
async function deezerGetAlbum(id) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/album/${encodeURIComponent(id)}`, {}, 7000);
    const d = await readJson(r);
    if (!d?.id) return null;
    return {
      provider: 'deezer', providerId: String(d.id), id: String(d.id),
      title: d.title || '',
      cover: d.cover_xl || d.cover_big || d.cover_medium || '',
      releaseDate: d.release_date || '',
      recordType: d.record_type || 'album',
      artist: d.artist ? { id: String(d.artist.id), name: d.artist.name } : null,
      tracks: (d.tracks?.data || []).map(deezerToNorm).filter(Boolean)
    };
  } catch { return null; }
}
async function deezerChart(limit = 50) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/chart/0/tracks?limit=${limit}`, {}, 6000);
    const d = await readJson(r);
    return (d?.data || []).map(deezerToNorm).filter(Boolean);
  } catch { return []; }
}
function deezerToNorm(t) {
  if (!t?.id) return null;
  return {
    provider: 'deezer', providerId: String(t.id), id: String(t.id),
    title: t.title_short || t.title || '',
    artist: t.artist?.name || '',
    artistId: t.artist?.id ? String(t.artist.id) : '',
    album: t.album?.title || '',
    albumId: t.album?.id ? String(t.album.id) : '',
    cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    duration: Number(t.duration || 0),
    popularity: Number(t.rank || 0),
    explicit: !!t.explicit_lyrics,
    sourceUrl: t.link || ''
  };
}

// ---------- Audius (real playback) ----------
async function audiusSearch(q, limit = 30) {
  try {
    const params = new URLSearchParams({ query: q, limit: String(limit), sort_method: 'popular' });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const headers = AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {};
    const r = await jsonFetch(`https://api.audius.co/v1/tracks/search?${params}`, { headers }, 7000);
    const d = await readJson(r);
    return (d?.data || [])
      .filter(t => !t.is_unlisted && !(Number(t.duration || 0) > 0 && Number(t.duration) < 45))
      .filter(t => !isNoise(t.title || ''))
      .map(t => ({
        provider: 'audius', providerId: String(t.id), id: String(t.id),
        title: t.title || '',
        artist: t.user?.name || '',
        artistId: t.user?.id ? String(t.user.id) : '',
        album: '', albumId: '',
        cover: firstImage(t.artwork),
        duration: Number(t.duration || 0),
        popularity: Number(t.play_count || 0) + Number(t.favorite_count || 0) * 5,
        downloadable: !!t.downloadable,
        sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : ''
      }));
  } catch { return []; }
}
async function audiusTrending(limit = 50) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const headers = AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {};
    const r = await jsonFetch(`https://api.audius.co/v1/tracks/trending?${params}`, { headers }, 7000);
    const d = await readJson(r);
    return (d?.data || [])
      .filter(t => !t.is_unlisted)
      .map(t => ({
        provider: 'audius', providerId: String(t.id), id: String(t.id),
        title: t.title || '',
        artist: t.user?.name || '',
        artistId: t.user?.id ? String(t.user.id) : '',
        album: '', albumId: '',
        cover: firstImage(t.artwork),
        duration: Number(t.duration || 0),
        popularity: Number(t.play_count || 0) + Number(t.favorite_count || 0) * 5,
        sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : ''
      }));
  } catch { return []; }
}
function firstImage(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  for (const k of ['1000x1000', '480x480', '600x600', '640x640', '320x320', '150x150'])
    if (o[k]) return o[k];
  return '';
}

// ---------- YouTube (search via Piped, stream via Invidious/Piped) ----------
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
];
const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si', 'https://inv.nadeko.net', 'https://yewtu.be',
  'https://invidious.nerdvpn.de', 'https://iv.melmac.space',
  'https://invidious.privacyredirect.com', 'https://vid.puffyan.us',
  'https://invidious.projectsegfau.lt', 'https://inv.tux.pizza',
];

async function youtubeSearchPiped(q, limit = 15) {
  const jobs = PIPED_INSTANCES.map(async base => {
    const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5500 });
    if (!r.ok) throw new Error('piped ' + r.status);
    const d = await r.json();
    return (d?.items || [])
      .filter(x => x?.type === 'stream' && typeof x.url === 'string')
      .map(x => {
        const vid = x.url.split('watch?v=')[1]?.split('&')[0] || '';
        return {
          provider: 'youtube', providerId: 'yt_' + vid, id: 'yt_' + vid, videoId: vid,
          title: x.title || '',
          artist: x.uploaderName || '',
          channel: x.uploaderName || '',
          cover: x.thumbnail || '',
          duration: Number(x.duration || 0),
          sourceUrl: 'https://www.youtube.com/watch?v=' + vid
        };
      })
      .filter(x => x.videoId && x.title && !isNoise(x.title))
      .slice(0, limit);
  });
  try { return await Promise.any(jobs); } catch { return []; }
}

// ============================================================================
// RANKING
// ============================================================================
function scoreTrack(item, query) {
  const q = normalize(query);
  if (!q) return 0;
  const t = normalize(item.title);
  const a = normalize(item.artist);
  const tokens = q.split(/\s+/).filter(Boolean);
  const combined = t + ' ' + a;
  let s = 0;

  if (t === q && a === q) s += 10_000_000;
  else if (t === q) s += 5_000_000;
  else if (a === q) s += 4_000_000;
  else if (t.startsWith(q + ' ') || t.startsWith(q)) s += 2_000_000;
  else if (t.includes(q)) s += 1_000_000;
  else if (a.startsWith(q) || a.includes(q)) s += 700_000;
  else {
    let hits = 0;
    for (const tok of tokens) {
      if (t.split(/\s+/).includes(tok)) hits += 5;
      else if (a.split(/\s+/).includes(tok)) hits += 3;
      else if (combined.includes(tok)) hits += 1;
    }
    s += hits * 50_000;
  }

  if (item.popularity) s += Math.log10(Number(item.popularity) + 1) * 3000;
  if (item.explicit) s += 5000;
  if (item.provider === 'audius') s += 20000;
  if (item.provider === 'youtube') s += 5000;

  const low = (item.title + ' ' + item.artist).toLowerCase();
  const userWants = /\b(remix|live|instrumental|cover|karaoke|slowed|sped|nightcore)\b/i.test(q);
  if (!userWants) {
    if (/\bremix\b/.test(low)) s -= 300_000;
    if (/\blive\b/.test(low)) s -= 250_000;
    if (/\bcover\b/.test(low)) s -= 400_000;
    if (/\bcompilation\b/.test(low)) s -= 500_000;
    if (isNoise(low)) s -= 3_000_000;
  }

  const artLow = a.trim();
  if (/^(unknown|unknown artist|various artists|no name|без названия|null|undefined|va)$/.test(artLow))
    s -= 2_000_000;

  return s;
}
function dedupeTracks(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const k = normalize(it.title) + '|' + normalize(it.artist);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ============================================================================
// PLAYBACK RESOLVER
// ============================================================================
async function resolvePlayback(track) {
  if (!track) throw makeErr('empty_track', 'No track provided');

  if (track.source === 'LOCAL' && track.localUrl)
    return { provider: 'local', kind: 'local', url: track.localUrl };

  if (track.provider === 'audius' && track.providerId)
    return { provider: 'audius', kind: 'audius',
      url: '/api/audio/audius/' + encodeURIComponent(track.providerId) };

  if (track.provider === 'youtube' && track.videoId)
    return { provider: 'youtube', kind: 'youtube', videoId: track.videoId,
      url: '/api/audio/youtube/' + encodeURIComponent(track.videoId) };

  const title = cleanTitle(track.title);
  const artist = splitArtists(track.artist)[0] || track.artist || '';
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) throw makeErr('no_query', 'Nothing to search');

  const ck = normalize(query) + '|' + Math.round(track.duration || 0);
  const hit = resolveCache.get(ck);
  if (hit && Date.now() - hit.time < RESOLVE_TTL) return hit.data;

  const audiusRes = await audiusSearch(query, 10);
  const bestA = pickBest(audiusRes, track);
  if (bestA) {
    const data = { provider: 'audius', kind: 'audius',
      url: '/api/audio/audius/' + encodeURIComponent(bestA.providerId),
      matchedTitle: bestA.title, matchedArtist: bestA.artist };
    resolveCache.set(ck, { time: Date.now(), data });
    return data;
  }

  const ytRes = await youtubeSearchPiped(query, 15);
  const bestY = pickBest(ytRes, track);
  if (bestY) {
    const data = { provider: 'youtube', kind: 'youtube',
      videoId: bestY.videoId,
      url: '/api/audio/youtube/' + encodeURIComponent(bestY.videoId),
      matchedTitle: bestY.title, matchedArtist: bestY.artist };
    resolveCache.set(ck, { time: Date.now(), data });
    return data;
  }

  throw makeErr('no_match', 'No playable source found');
}
function pickBest(list, want) {
  if (!list?.length) return null;
  const wT = normalize(cleanTitle(want.title));
  const wA = normalize(splitArtists(want.artist)[0] || want.artist || '');
  const wD = Number(want.duration || 0);
  let best = null, bestScore = 0;
  for (const it of list) {
    if (isNoise(it.title || '')) continue;
    const t = normalize(it.title);
    const a = normalize(it.artist);
    let s = 0;
    if (t === wT) s += 1;
    else if (t.startsWith(wT)) s += 0.8;
    else if (t.includes(wT)) s += 0.6;
    else {
      const ww = wT.split(/\s+/).filter(Boolean);
      const gw = t.split(/\s+/).filter(Boolean);
      if (ww.length) {
        let h = 0;
        for (const x of ww) if (gw.includes(x)) h++;
        s += (h / ww.length) * 0.5;
      }
    }
    if (wA) {
      if (a === wA) s += 0.6;
      else if (a.includes(wA) || wA.includes(a)) s += 0.4;
    }
    if (wD && it.duration) {
      const ratio = it.duration / wD;
      if (ratio > 0.7 && ratio < 1.4) s += 0.2;
      else if (ratio < 0.5 || ratio > 2) s -= 0.4;
    }
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return bestScore >= 0.55 ? best : null;
}

// ============================================================================
// AUTH
// ============================================================================
function registerHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Логин от 3 символов' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль от 4 символов' });
  if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/u.test(username)) return res.status(400).json({ error: 'Логин без пробелов' });
  const lower = String(username).toLowerCase();
  if (Object.values(db.users).some(u => (u.username || '').toLowerCase() === lower))
    return res.status(409).json({ error: 'Логин занят' });

  const id = 'local_' + crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[id] = {
    id, username, avatar: '', provider: 'local',
    passwordHash: hashPassword(password, salt),
    passwordSalt: salt, createdAt: Date.now()
  };
  db.favorites[id] = db.favorites[id] || [];
  db.history[id] = db.history[id] || [];
  db.plays[id] = db.plays[id] || {};
  db.playlists[id] = db.playlists[id] || [];
  saveDb();

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username, avatar: '', provider: 'local' } });
}
function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  const lower = String(username).toLowerCase();
  const user = Object.values(db.users).find(u => (u.username || '').toLowerCase() === lower);
  if (!user || user.provider !== 'local' || !user.passwordHash)
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  if (hashPassword(password, user.passwordSalt) !== user.passwordHash)
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || '', provider: 'local' } });
}
api.post('/api/auth/register', registerHandler);
api.post('/api/register', registerHandler);
api.post('/api/auth/login', loginHandler);
api.post('/api/login', loginHandler);

api.get('/api/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI)
    return res.status(503).send('Discord OAuth not configured');
  const p = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + p);
});
api.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI)
    return res.status(503).send('Discord OAuth not configured');
  try {
    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code, redirect_uri: DISCORD_REDIRECT_URI
    });
    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const td = await tr.json();
    if (!td.access_token) return res.status(400).send('Token error');
    const ur = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + td.access_token }
    });
    const user = await ur.json();
    const id = user.id;
    db.users[id] = db.users[id] || { id, createdAt: Date.now(), provider: 'discord' };
    db.users[id].username = user.username;
    db.users[id].avatar = user.avatar || '';
    db.favorites[id] = db.favorites[id] || [];
    db.history[id] = db.history[id] || [];
    db.plays[id] = db.plays[id] || {};
    db.playlists[id] = db.playlists[id] || [];
    saveDb();
    const token = jwt.sign({ id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.redirect('/?login=success&token=' + encodeURIComponent(token));
  } catch { res.status(500).send('Auth error'); }
});
api.get('/api/me', authMiddleware, (req, res) => {
  const user = db.users[req.user.id];
  if (!user) return res.status(404).json({ error: 'not found' });
  const { passwordHash, passwordSalt, ...pub } = user;
  res.json(pub);
});

// ============================================================================
// FAVORITES / HISTORY / PLAYS
// ============================================================================
api.get('/api/favorites', authMiddleware, (req, res) => res.json(db.favorites[req.user.id] || []));
api.post('/api/favorites', authMiddleware, (req, res) => {
  const t = req.body;
  if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const list = db.favorites[req.user.id] || [];
  const k = trackKey(t);
  if (!list.some(x => trackKey(x) === k)) {
    list.unshift(t);
    db.favorites[req.user.id] = list.slice(0, 1000);
    saveDb();
  }
  res.json({ ok: true });
});
api.delete('/api/favorites/:key', authMiddleware, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const list = db.favorites[req.user.id] || [];
  db.favorites[req.user.id] = list.filter(x => trackKey(x) !== key);
  saveDb();
  res.json({ ok: true });
});

api.get('/api/history', authMiddleware, (req, res) => res.json(db.history[req.user.id] || []));
api.post('/api/history', authMiddleware, (req, res) => {
  const t = req.body;
  if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const list = db.history[req.user.id] || [];
  const k = trackKey(t);
  const filtered = list.filter(x => trackKey(x) !== k);
  filtered.unshift({ ...t, playedAt: Date.now() });
  db.history[req.user.id] = filtered.slice(0, 500);
  saveDb();
  res.json({ ok: true });
});
api.delete('/api/history', authMiddleware, (req, res) => {
  db.history[req.user.id] = [];
  saveDb();
  res.json({ ok: true });
});

api.post('/api/track-play', authMiddleware, (req, res) => {
  const t = req.body;
  if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const uid = req.user.id;
  db.plays[uid] = db.plays[uid] || {};
  const k = trackKey(t);
  const cur = db.plays[uid][k] || { count: 0, last: 0, track: t };
  cur.count += 1;
  cur.last = Date.now();
  cur.track = t;
  db.plays[uid][k] = cur;
  saveDb();
  res.json({ ok: true, count: cur.count });
});
api.get('/api/recently-played', authMiddleware, (req, res) => {
  const plays = db.plays[req.user.id] || {};
  const sorted = Object.values(plays).sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 30);
  res.json(sorted.map(p => p.track).filter(Boolean));
});
api.get('/api/stats', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const hist = db.history[uid] || [];
  const favs = db.favorites[uid] || [];
  const plays = db.plays[uid] || {};
  const tSet = new Set(), aSet = new Set();
  for (const t of [...hist, ...favs]) {
    if (!t) continue;
    tSet.add(trackKey(t));
    const a = splitArtists(t.artist)[0];
    if (a) aSet.add(a.toLowerCase());
  }
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    tSet.add(trackKey(p.track));
    const a = splitArtists(p.track.artist)[0];
    if (a) aSet.add(a.toLowerCase());
  }
  const artistPlays = new Map();
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    const a = splitArtists(p.track.artist)[0];
    if (!a) continue;
    artistPlays.set(a, (artistPlays.get(a) || 0) + (p.count || 1));
  }
  const topArtists = [...artistPlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  const topTracksMap = new Map();
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    const k = trackKey(p.track);
    const cur = topTracksMap.get(k) || { track: p.track, count: 0 };
    cur.count += p.count || 1;
    topTracksMap.set(k, cur);
  }
  const topTracks = [...topTracksMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  res.json({
    tracks: tSet.size, artists: aSet.size,
    favorites: favs.length, history: hist.length,
    playlists: (db.playlists[uid] || []).length,
    totalPlays: Object.values(plays).reduce((s, p) => s + (p.count || 0), 0),
    topArtists, topTracks
  });
});

// ============================================================================
// PLAYLISTS CRUD
// ============================================================================
api.get('/api/playlists', authMiddleware, (req, res) => res.json(db.playlists[req.user.id] || []));
api.post('/api/playlists', authMiddleware, (req, res) => {
  const { name, description, cover } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const uid = req.user.id;
  db.playlists[uid] = db.playlists[uid] || [];
  const pl = {
    id: 'pl_' + crypto.randomBytes(6).toString('hex'),
    name: String(name).trim().slice(0, 80),
    description: String(description || '').slice(0, 300),
    cover: String(cover || ''),
    tracks: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.playlists[uid].unshift(pl);
  saveDb();
  res.json(pl);
});
api.patch('/api/playlists/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const { name, description, cover } = req.body || {};
  if (name !== undefined) pl.name = String(name).trim().slice(0, 80);
  if (description !== undefined) pl.description = String(description).slice(0, 300);
  if (cover !== undefined) pl.cover = String(cover);
  pl.updatedAt = Date.now();
  saveDb();
  res.json(pl);
});
api.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  db.playlists[uid] = (db.playlists[uid] || []).filter(p => p.id !== req.params.id);
  saveDb();
  res.json({ ok: true });
});
api.post('/api/playlists/:id/tracks', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const t = req.body;
  if (!t?.title) return res.status(400).json({ error: 'invalid track' });
  const k = trackKey(t);
  if (!pl.tracks.some(x => trackKey(x) === k)) {
    pl.tracks.push(t);
    pl.updatedAt = Date.now();
    saveDb();
  }
  res.json({ ok: true, tracks: pl.tracks });
});
api.delete('/api/playlists/:id/tracks/:key', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const key = decodeURIComponent(req.params.key);
  pl.tracks = pl.tracks.filter(x => trackKey(x) !== key);
  pl.updatedAt = Date.now();
  saveDb();
  res.json({ ok: true, tracks: pl.tracks });
});
api.post('/api/playlists/:id/reorder', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const { from, to } = req.body || {};
  if (!Number.isInteger(from) || !Number.isInteger(to)) return res.status(400).json({ error: 'invalid' });
  if (from < 0 || from >= pl.tracks.length || to < 0 || to >= pl.tracks.length)
    return res.status(400).json({ error: 'out of range' });
  const [m] = pl.tracks.splice(from, 1);
  pl.tracks.splice(to, 0, m);
  pl.updatedAt = Date.now();
  saveDb();
  res.json({ ok: true, tracks: pl.tracks });
});

// ============================================================================
// SEARCH
// ============================================================================
api.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], artists: [], counts: {} });
  const ck = 'search:' + normalize(q);
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.time < SEARCH_TTL) return res.json(hit.data);

  const safe = async (p, ms) => {
    try {
      return await Promise.race([
        p,
        new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))
      ]);
    } catch { return []; }
  };

  const [deezerTracks, deezerArtists, audiusTracks, ytTracks] = await Promise.all([
    safe(deezerSearchTracks(q, 40), 4000),
    safe(deezerSearchArtists(q, 8), 3500),
    safe(audiusSearch(q, 25), 4000),
    safe(youtubeSearchPiped(q, 15), 6000)
  ]);

  const candidates = [...deezerTracks, ...audiusTracks, ...ytTracks];
  const deduped = dedupeTracks(candidates);
  const scored = deduped
    .map(t => ({ t, s: scoreTrack(t, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map(x => x.t);

  const payload = {
    query: q,
    results: scored,
    artists: deezerArtists,
    counts: { tracks: scored.length, artists: deezerArtists.length }
  };
  searchCache.set(ck, { time: Date.now(), data: payload });
  res.json(payload);
});

// ============================================================================
// ARTIST / ALBUM
// ============================================================================
api.get('/api/artist-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'empty' });
  const list = await deezerSearchArtists(q, 10);
  if (!list.length) return res.status(404).json({ error: 'not found' });
  const norm = normalize(q);
  const exact = list.filter(a => normalize(a.name) === norm);
  if (!exact.length) return res.status(404).json({ error: 'no exact match' });
  exact.sort((a, b) => (b.nbFan || 0) - (a.nbFan || 0));
  const best = exact[0];
  res.json({ id: best.providerId, name: best.name, picture: best.picture, nb_fan: best.nbFan });
});
api.get('/api/artist/:id', async (req, res) => {
  const id = String(req.params.id);
  const ck = 'artist:' + id;
  const hit = artistCache.get(ck);
  if (hit && Date.now() - hit.time < (hit.ttl || ARTIST_TTL)) return res.json(hit.data);

  const artist = await deezerGetArtist(id);
  if (!artist) return res.status(404).json({ error: 'not found' });

  const [top, albums] = await Promise.all([
    deezerArtistTop(id),
    deezerArtistAlbums(id)
  ]);

  const sortByDate = arr => arr.slice().sort((a, b) =>
    String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));

  const payload = {
    artist,
    top_tracks: top.slice(0, 60),
    albums: sortByDate(albums.filter(a => a.recordType !== 'single')),
    singles: sortByDate(albums.filter(a => a.recordType === 'single'))
  };
  const isEmpty = !payload.top_tracks.length && !payload.albums.length && !payload.singles.length;
  artistCache.set(ck, { time: Date.now(), data: payload, ttl: isEmpty ? ARTIST_EMPTY_TTL : ARTIST_TTL });
  res.json(payload);
});
api.get('/api/album/:id', async (req, res) => {
  const d = await deezerGetAlbum(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
});

// ============================================================================
// POPULAR / RECOMMENDATIONS
// ============================================================================
api.get('/api/popular', async (req, res) => {
  const ck = 'popular:v1';
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.time < 10 * 60 * 1000) return res.json(hit.data);

  const [audius, deezer] = await Promise.all([
    audiusTrending(50).catch(() => []),
    deezerChart(50).catch(() => [])
  ]);
  const merged = dedupeTracks([...audius, ...deezer]).slice(0, 60);
  const payload = { results: merged };
  searchCache.set(ck, { time: Date.now(), data: payload });
  res.json(payload);
});
api.get('/api/recommendations', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const hist = db.history[uid] || [];
  const favs = db.favorites[uid] || [];
  const plays = db.plays[uid] || {};
  const counts = new Map();
  const bump = a => { if (!a) return; const k = normalize(a); if (k) counts.set(k, (counts.get(k) || 0) + 1); };
  hist.slice(0, 30).forEach(t => bump(splitArtists(t.artist)[0]));
  favs.slice(0, 30).forEach(t => bump(splitArtists(t.artist)[0]));
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    const w = Math.min(5, Math.ceil((p.count || 1) / 2));
    for (let i = 0; i < w; i++) bump(splitArtists(p.track.artist)[0]);
  }
  const topArtists = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
  if (!topArtists.length) {
    const popular = searchCache.get('popular:v1');
    if (popular?.data?.results?.length) {
      const shuffled = popular.data.results.slice().sort(() => Math.random() - 0.5).slice(0, 30);
      return res.json({ results: shuffled, based_on: [] });
    }
    return res.json({ results: [], based_on: [] });
  }
  const collected = [];
  const seen = new Set();
  for (const artist of topArtists) {
    try {
      const r = await audiusSearch(artist, 10);
      for (const t of r) {
        const k = normalize(t.title) + '|' + normalize(t.artist);
        if (seen.has(k)) continue;
        seen.add(k);
        collected.push(t);
      }
    } catch {}
  }
  res.json({ results: collected.slice(0, 30).sort(() => Math.random() - 0.5), based_on: topArtists });
});

// ============================================================================
// PLAYBACK ROUTES
// ============================================================================
api.post('/api/playback/resolve', async (req, res) => {
  const track = req.body || {};
  if (!track.title && !track.providerId && !track.videoId)
    return res.status(400).json({ error: { code: 'invalid_track', message: 'No track info' } });
  try {
    const data = await resolvePlayback(track);
    res.json(data);
  } catch (e) {
    if (e.structured)
      return res.status(502).json({ error: { code: e.code, message: e.message } });
    res.status(502).json({ error: { code: 'resolve_failed', message: e.message } });
  }
});
api.get('/api/audio/resolve', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const duration = Number(req.query.duration || 0);
  const q = String(req.query.q || '').trim();
  if (!title && !artist && !q) return res.status(400).json({ ok: false, error: 'empty' });
  const ck = normalize(q || (title + ' ' + artist)) + '|' + Math.round(duration);
  const hit = resolveCache.get(ck);
  if (hit && Date.now() - hit.time < RESOLVE_TTL)
    return res.json({ ok: true, ...hit.data, cached: true });
  try {
    const data = await resolvePlayback({ title, artist, duration });
    resolveCache.set(ck, { time: Date.now(), data });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

api.get('/api/audio/audius/:id', async (req, res) => {
  const id = String(req.params.id);
  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const url = `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream` +
      (params.toString() ? '?' + params : '');
    const headers = {};
    if (AUDIUS_API_KEY) headers['X-API-Key'] = AUDIUS_API_KEY;
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, redirect: 'follow', timeout: 30000 });
    if (!up.ok || !up.body) return res.status(502).end();
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(up.status);
    up.body.pipe(res);
    req_onclose(res, up);
  } catch { if (!res.headersSent) res.status(502).end(); }
});

async function tryInvidious(vid, itag, range, res) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const url = `${base}/latest_version?id=${vid}&itag=${itag}&local=true`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': '*/*'
      };
      if (range) headers.Range = range;
      const up = await fetch(url, { headers, redirect: 'follow', timeout: 12000 });
      if (!up.ok && up.status !== 206) { try { up.body?.destroy(); } catch {} continue; }
      const ct = String(up.headers.get('content-type') || '').toLowerCase();
      const cl = Number(up.headers.get('content-length') || 0);
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')) {
        try { up.body?.destroy(); } catch {} continue;
      }
      if (cl > 0 && cl < 50000) { try { up.body?.destroy(); } catch {} continue; }
      res.setHeader('Content-Type',
        ct.startsWith('audio/') || ct.startsWith('video/') ? ct :
        (itag === '251' ? 'audio/webm' : 'audio/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (cl > 0) res.setHeader('Content-Length', String(cl));
      const cr = up.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.status(up.status === 206 ? 206 : 200);
      up.body.pipe(res);
      req_onclose(res, up);
      return true;
    } catch {}
  }
  return false;
}
api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  const range = req.headers.range || '';
  for (const itag of ['251', '140']) {
    if (await tryInvidious(vid, itag, range, res)) return;
  }
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(`${base}/streams/${vid}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      if (!r.ok) continue;
      const d = await r.json();
      const streams = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
      const best = streams.filter(s => s.url && s.mimeType?.includes('audio'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best?.url) continue;
      const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
      if (range) headers.Range = range;
      const up = await fetch(best.proxyUrl || best.url, { headers, redirect: 'follow', timeout: 15000 });
      if (!up.ok && up.status !== 206) continue;
      const ct = String(up.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')) {
        try { up.body?.destroy(); } catch {} continue;
      }
      res.setHeader('Content-Type', best.mimeType || 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const cl = up.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.status(up.status === 206 ? 206 : 200);
      up.body.pipe(res);
      req_onclose(res, up);
      return;
    } catch {}
  }
  res.status(502).end();
});

// downloads (kept for compat)
api.get('/api/download/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  const name = String(req.query.name || 'track').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  for (const itag of ['140', '251']) {
    for (const base of INVIDIOUS_INSTANCES) {
      try {
        const url = `${base}/latest_version?id=${vid}&itag=${itag}&local=true`;
        const up = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
          redirect: 'follow', timeout: 15000
        });
        if (!up.ok) { try { up.body?.destroy(); } catch {} continue; }
        const ct = String(up.headers.get('content-type') || '').toLowerCase();
        if (!ct.startsWith('audio/') && !ct.includes('octet-stream')) {
          try { up.body?.destroy(); } catch {} continue;
        }
        res.setHeader('Content-Type', itag === '140' ? 'audio/mp4' : 'audio/webm');
        res.setHeader('Content-Disposition',
          `attachment; filename="${name}${itag === '140' ? '.m4a' : '.webm'}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        const cl = up.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);
        res.status(200);
        up.body.pipe(res);
        req_onclose(res, up);
        return;
      } catch {}
    }
  }
  res.status(502).end();
});
api.get('/api/download/audius/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const headers = AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {};
    const tr = await jsonFetch(
      `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}?${params}`,
      { headers }, 10000);
    const td = await readJson(tr);
    if (!td.data?.downloadable) return res.status(403).end();
    const stream = await fetch(
      `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream${AUDIUS_API_KEY ? '?api_key=' + AUDIUS_API_KEY : ''}`,
      { headers, timeout: 30000 });
    if (!stream.ok || !stream.body) return res.status(502).end();
    const name = String(td.data.title || 'track').replace(/[<>:"/\\|?*]+/g, '_');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.mp3"`);
    stream.body.pipe(res);
  } catch { if (!res.headersSent) res.status(502).end(); }
});

// ============================================================================
// LYRICS (LRCLIB)
// ============================================================================
api.get('/api/lyrics', async (req, res) => {
  const track = String(req.query.track_name || '').trim();
  const artist = String(req.query.artist_name || '').trim();
  const dur = Number(req.query.duration || 0);
  if (!track && !artist) return res.status(400).json({ found: false });
  const ck = 'lyr:' + normalize(track + '|' + artist) + '|' + Math.round(dur);
  const hit = lyricsCache.get(ck);
  if (hit && Date.now() - hit.time < LYRICS_TTL) return res.json(hit.data);

  const clean = String(track)
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(official|audio|video|lyric|lyrics|visualizer|hd|hq|explicit|mv|m\/v)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const send = p => { lyricsCache.set(ck, { time: Date.now(), data: p }); res.json(p); };

  try {
    const params = new URLSearchParams({ track_name: clean });
    if (artist) params.set('artist_name', artist);
    if (dur > 0) params.set('duration', String(Math.round(dur)));
    const r = await jsonFetch('https://lrclib.net/api/get?' + params,
      { headers: { 'User-Agent': 'NOVA/5.0' } }, 8000);
    if (r.ok) {
      const d = await readJson(r);
      if (d.plainLyrics || d.syncedLyrics)
        return send({ found: true, plainLyrics: d.plainLyrics || '',
          syncedLyrics: d.syncedLyrics || '', source: 'LRCLIB' });
    }
  } catch {}

  try {
    const q = [clean, artist].filter(Boolean).join(' ');
    const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q }),
      { headers: { 'User-Agent': 'NOVA/5.0' } }, 8000);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const synced = arr.filter(x => x.syncedLyrics);
        const pool = synced.length ? synced : arr;
        const nA = normalize(artist);
        let best = pool[0];
        if (nA) for (const it of pool) if (normalize(it.artistName || '') === nA) { best = it; break; }
        if (best.plainLyrics || best.syncedLyrics)
          return send({ found: true, plainLyrics: best.plainLyrics || '',
            syncedLyrics: best.syncedLyrics || '', source: 'LRCLIB' });
      }
    }
  } catch {}

  send({ found: false });
});

// ============================================================================
// HEALTH
// ============================================================================
api.get('/api/health', async (req, res) => {
  const checks = {};
  const test = async (name, url, ms = 4000) => {
    const t = Date.now();
    try {
      const r = await jsonFetch(url, {}, ms);
      checks[name] = { ok: r.ok || r.status < 500, status: r.status, ms: Date.now() - t };
    } catch (e) { checks[name] = { ok: false, error: e.message, ms: Date.now() - t }; }
  };
  await Promise.all([
    test('deezer', 'https://api.deezer.com/artist/1'),
    test('audius', 'https://api.audius.co/v1/tracks/trending'),
    test('youtube', 'https://www.youtube.com/generate_204')
  ]);
  const allOk = Object.values(checks).every(c => c.ok);
  res.status(allOk ? 200 : 207).json({
    ok: allOk, service: 'NOVA', version: '5.0.0', env: NODE_ENV,
    uptime: Math.round(process.uptime()),
    users: Object.keys(db.users).length,
    caches: {
      search: searchCache.size, resolve: resolveCache.size,
      lyrics: lyricsCache.size, artist: artistCache.size
    },
    upstream: checks
  });
});

// ============================================================================
// STATIC + SPA
// ============================================================================
api.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: IS_PROD ? '1h' : 0 }));
api.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});
api.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: { code: 'internal', message: err.message } });
});

// ============================================================================
// START
// ============================================================================
function startServer(options = {}) {
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  return new Promise((resolve, reject) => {
    const server = api.listen(port, host, () => {
      console.log('============================================================');
      console.log(`[NOVA] v5.0.0 env=${NODE_ENV}`);
      console.log(`[NOVA] listening on http://${host}:${port}`);
      console.log(`[NOVA] DB at ${DB_PATH}`);
      console.log(`[NOVA] users: ${Object.keys(db.users).length}`);
      if (IS_PROD && !process.env.DATA_DIR)
        console.warn('[NOVA] WARNING: DATA_DIR not set — DB resets on restart');
      console.log('============================================================');
      resolve(server);
    });
    server.once('error', reject);
  });
}
if (require.main === module)
  startServer().catch(e => { console.error('[fatal]', e); process.exit(1); });
module.exports = { api, startServer };
