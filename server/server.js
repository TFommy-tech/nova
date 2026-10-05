// ============================================================================
// server/server.js — NOVA v5.2.0
// youtubei.js как primary резолвер, категории в мастерской
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

const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const DEBUG_RESOLVE = process.env.DEBUG_RESOLVE === '1';
const WEB_DIR = path.join(__dirname, '..', 'web');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const WORKSHOP_PATH = path.join(DATA_DIR, 'workshop.json');
// B2: статичного секрета по умолчанию больше нет — env либо случайный, сохранённый в data/jwt-secret
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(DATA_DIR, 'jwt-secret');
  try { const s = fs.readFileSync(p, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(p, s, { mode: 0o600 });
    console.warn('[auth] JWT_SECRET не задан — сгенерирован случайный (сохранён в data/jwt-secret)');
  } catch (e) {
    console.warn('[auth] JWT_SECRET не задан — случайный до перезапуска:', e.message);
  }
  return s;
})();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI ||
  (PUBLIC_URL ? PUBLIC_URL + '/api/auth/discord/callback' : '');
const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';
// SoundCloud client_id периодически ротируется — на Render добавить в Environment (fallback в коде есть)
const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID || 'dkevB9EsY4jIoSm8RfddPNUKyn6hurXF';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dbg(...a) { if (DEBUG_RESOLVE) console.log('[resolve]', ...a); }

// ---------- DB ----------
function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJson(p, d) { try { fs.writeFileSync(p, JSON.stringify(d, null, 2)); } catch (e) { console.error('[db]', e.message); } }
let db = loadJson(DB_PATH, {});
for (const k of ['users', 'favorites', 'history', 'plays', 'playlists']) if (!db[k]) db[k] = {};
const saveDb = () => saveJson(DB_PATH, db);
let workshop = loadJson(WORKSHOP_PATH, { items: [] });
if (!Array.isArray(workshop.items)) workshop.items = [];
const saveWorkshop = () => saveJson(WORKSHOP_PATH, workshop);

// ---------- CACHES ----------
const searchCache = new Map();
const resolveCache = new Map();
const lyricsCache = new Map();
const artistCache = new Map();
const SEARCH_TTL = 60 * 1000;
const RESOLVE_TTL = 25 * 60 * 1000;
const LYRICS_TTL = 24 * 60 * 60 * 1000;
const LYRICS_NEG_TTL = 5 * 60 * 1000; // B14: «не найдено» кэшируем на минуты, не на сутки
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
// B5: не отражаем произвольные origin'ы — только loopback (Electron: 127.0.0.1:3000, dev) и CORS_ORIGINS из env.
// Same-origin запросы (фронт с этого же сервера) CORS-заголовки не требуют — деплой не ломается.
const EXTRA_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
api.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false);
    let u; try { u = new URL(origin); } catch { return cb(null, false); }
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
    cb(null, loopback || EXTRA_ORIGINS.includes(origin));
  },
  credentials: true
}));
api.use(express.json({ limit: '4mb' }));
api.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const t = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t;
    if (res.statusCode >= 400 || ms > 1500) console.log(`[${res.statusCode}] ${req.method} ${req.path} ${ms}ms`);
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
    .replace(/[’'`´]/g, '').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function cleanTitle(v) {
  return String(v || '')
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/#\S+/g, ' ')
    .replace(/\b(official|lyric|lyrics|video|audio|visualizer|hd|hq|4k|mv|m\/v)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
function splitArtists(raw) {
  if (!raw) return [];
  return String(raw).split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i)
    .map(s => s.trim()).filter(Boolean);
}
function extractFeat(title, titleVersion) {
  const combined = String(title || '') + ' ' + String(titleVersion || '');
  const m = combined.match(/\b(?:feat\.?|ft\.?|with)\s+([^(\[\]\-]+?)(?=[(\[\]\-]|$)/i);
  if (!m) return '';
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 100);
}
function trackKey(t) {
  return [String(t.provider || ''), String(t.providerId || t.id || ''), String(t.title || ''), String(t.artist || '')].join('|');
}
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function hashEquals(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8'), bb = Buffer.from(String(b || ''), 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function makeErr(code, message) { const e = new Error(message); e.code = code; e.structured = true; return e; }
function firstImage(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  for (const k of ['1000x1000', '480x480', '600x600', '640x640', '320x320', '150x150'])
    if (o[k]) return o[k];
  return '';
}
async function jsonFetch(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const headers = { Accept: 'application/json', 'User-Agent': 'NOVA/5.2', ...(opts.headers || {}) };
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
  // B3: срок действия обязателен (без ignoreExpiration), алгоритм закреплён
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: false }); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}
function req_onclose(res, upstream) {
  try { res.req.on('close', () => { try { upstream.body?.destroy(); } catch {} }); } catch {}
}

// ============================================================================
// YOUTUBE via youtubei.js — primary
// ============================================================================
let ytClient = null, ytInitFailed = false;

async function getYtClient() {
  if (ytClient) return ytClient;
  if (ytInitFailed) return null;
  try {
    const mod = require('youtubei.js');
    const Innertube = mod.Innertube;
    if (!Innertube) throw new Error('no Innertube export');
    dbg('initializing youtubei.js...');
    ytClient = await Innertube.create({
      retrieve_player: true,
      generate_session_locally: true,
      enable_safety_mode: false,
      lang: 'en',
      location: 'US'
    });
    console.log('[youtubei] initialized');
    return ytClient;
  } catch (e) {
    ytInitFailed = true;
    console.error('[youtubei] init failed:', e.message);
    return null;
  }
}

async function youtubeSearchIjs(q, limit = 20) {
  try {
    const yt = await getYtClient();
    if (!yt) return [];
    const res = await yt.search(q, { type: 'video' });
    const videos = res.videos || [];
    const out = [];
    for (const v of videos) {
      if (out.length >= limit) break;
      const vid = v.video_id;
      const title = v.title?.text || v.title?.toString?.() || String(v.title || '');
      const author = v.author?.name || v.author?.toString?.() || '';
      const thumb = v.thumbnails?.[0]?.url || v.thumbnail?.url || '';
      const dur = v.duration?.seconds || v.duration?.text ? (v.duration.seconds || 0) : 0;
      if (!vid || !title) continue;
      if (isNoise(title)) continue;
      out.push({
        provider: 'youtube', providerId: 'yt_' + vid, id: 'yt_' + vid, videoId: vid,
        title, artist: author, channel: author, cover: thumb, duration: dur,
        sourceUrl: 'https://www.youtube.com/watch?v=' + vid
      });
    }
    dbg('ijs search:', out.length);
    return out;
  } catch (e) {
    dbg('ijs search err:', e.message);
    return [];
  }
}

async function youtubeSearchHtml(q, limit = 20) {
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'SOCS=CAI; CONSENT=YES+cb'
      },
      timeout: 8000
    });
    if (!r.ok) return [];
    const html = await r.text();
    const marker = 'var ytInitialData = ';
    const idx = html.indexOf(marker);
    if (idx < 0) return [];
    const scriptEnd = html.indexOf(';</script>', idx);
    if (scriptEnd < 0) return [];
    const jsonStr = html.slice(idx + marker.length, scriptEnd);
    const data = JSON.parse(jsonStr);
    const items = [];
    (function walk(o) {
      if (!o || typeof o !== 'object' || items.length >= limit) return;
      if (o.videoRenderer) {
        const v = o.videoRenderer;
        const vid = v.videoId;
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
        const author = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '';
        const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';
        const durText = v.lengthText?.simpleText || '';
        let dur = 0;
        if (durText) {
          const parts = durText.split(':').map(Number);
          if (parts.length === 3) dur = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) dur = parts[0] * 60 + parts[1];
        }
        if (vid && title && !isNoise(title)) {
          items.push({
            provider: 'youtube', providerId: 'yt_' + vid, id: 'yt_' + vid, videoId: vid,
            title, artist: author, channel: author, cover: thumb, duration: dur,
            sourceUrl: 'https://www.youtube.com/watch?v=' + vid
          });
        }
      }
      for (const k in o) {
        if (Array.isArray(o[k])) o[k].forEach(walk);
        else if (typeof o[k] === 'object') walk(o[k]);
      }
    })(data);
    return items;
  } catch (e) { dbg('html err:', e.message); return []; }
}

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de',
  'https://api.piped.yt', 'https://pipedapi.reallyaweso.me'
];
const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si', 'https://inv.nadeko.net', 'https://yewtu.be',
  'https://invidious.nerdvpn.de', 'https://iv.melmac.space',
  'https://invidious.privacyredirect.com', 'https://vid.puffyan.us',
  'https://invidious.projectsegfau.lt', 'https://inv.tux.pizza'
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
          title: x.title || '', artist: x.uploaderName || '', channel: x.uploaderName || '',
          cover: x.thumbnail || '', duration: Number(x.duration || 0),
          sourceUrl: 'https://www.youtube.com/watch?v=' + vid
        };
      })
      .filter(x => x.videoId && x.title && !isNoise(x.title))
      .slice(0, limit);
  });
  try { return await Promise.any(jobs); } catch { return []; }
}

async function youtubeSearch(q, limit = 20) {
  const [ijs, html, piped] = await Promise.allSettled([
    youtubeSearchIjs(q, limit),
    youtubeSearchHtml(q, limit),
    youtubeSearchPiped(q, limit)
  ]);
  const out = [];
  const seen = new Set();
  for (const res of [ijs, html, piped]) {
    if (res.status !== 'fulfilled') continue;
    for (const t of res.value || []) {
      if (!t.videoId || seen.has(t.videoId)) continue;
      seen.add(t.videoId);
      out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ============================================================================
// DEEZER
// ============================================================================
function deezerToNorm(t) {
  if (!t?.id) return null;
  const feat = extractFeat(t.title_short || t.title, t.title_version);
  const baseArtist = t.artist?.name || '';
  const artist = feat && !normalize(baseArtist).includes(normalize(feat))
    ? `${baseArtist}, ${feat}` : baseArtist;
  const title = String(t.title_short || t.title || '')
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|with)\s+[^\)\]]+[\)\]]\s*/gi, '')
    .trim();
  return {
    provider: 'deezer', providerId: String(t.id), id: String(t.id),
    title: title || t.title_short || t.title || '',
    artist, artistId: t.artist?.id ? String(t.artist.id) : '',
    album: t.album?.title || '', albumId: t.album?.id ? String(t.album.id) : '',
    cover: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    duration: Number(t.duration || 0),
    popularity: Number(t.rank || 0),
    explicit: !!t.explicit_lyrics,
    sourceUrl: t.link || ''
  };
}
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
      name: a.name, picture: a.picture_xl || a.picture_big || a.picture_medium || '',
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
      name: d.name || '', picture: d.picture_xl || d.picture_big || d.picture_medium || '',
      nbFan: d.nb_fan || 0
    };
  } catch { return null; }
}
async function deezerArtistTop(id) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/artist/${encodeURIComponent(id)}/top?limit=60`, {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    return items
      .filter(t => !isNoise(t.title_short || t.title || ''))
      .filter(t => t.artist?.id && String(t.artist.id) === String(id))
      .map(deezerToNorm).filter(Boolean);
  } catch { return []; }
}
async function deezerArtistAlbums(id) {
  try {
    const r = await jsonFetch(`https://api.deezer.com/artist/${encodeURIComponent(id)}/albums?limit=100`, {}, 8000);
    const d = await readJson(r);
    return (d?.data || [])
      .filter(a => a.artist?.id && String(a.artist.id) === String(id))
      .map(a => ({
        provider: 'deezer', providerId: String(a.id), id: String(a.id),
        title: a.title || '', cover: a.cover_xl || a.cover_big || a.cover_medium || '',
        recordType: a.record_type || 'album', nbTracks: a.nb_tracks || 0,
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
      title: d.title || '', cover: d.cover_xl || d.cover_big || d.cover_medium || '',
      releaseDate: d.release_date || '', recordType: d.record_type || 'album',
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

// ============================================================================
// AUDIUS
// ============================================================================
function audiusNorm(t) {
  return {
    provider: 'audius', providerId: String(t.id), id: String(t.id),
    title: t.title || '', artist: t.user?.name || '',
    artistId: t.user?.id ? String(t.user.id) : '',
    album: '', albumId: '', cover: firstImage(t.artwork),
    duration: Number(t.duration || 0),
    popularity: Number(t.play_count || 0) + Number(t.favorite_count || 0) * 5,
    sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : ''
  };
}
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
      .map(audiusNorm);
  } catch { return []; }
}
async function audiusTrending(limit = 50) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const headers = AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {};
    const r = await jsonFetch(`https://api.audius.co/v1/tracks/trending?${params}`, { headers }, 7000);
    const d = await readJson(r);
    return (d?.data || []).filter(t => !t.is_unlisted).map(audiusNorm);
  } catch { return []; }
}

// ============================================================================
// SOUNDCLOUD
// ============================================================================
const scStreamCache = new Map(); // <trackId> → { url, time }; TTL 10 мин (см. /api/audio/soundcloud/:id)
function soundcloudNorm(t) {
  if (!t?.id) return null;
  return {
    provider: 'soundcloud', providerId: String(t.id), id: String(t.id),
    title: t.title || '', artist: t.user?.username || '',
    artistId: t.user?.id ? String(t.user.id) : '',
    album: '', albumId: '',
    cover: String(t.artwork_url || '').replace(/-large\./, '-t500x500.'),
    duration: Math.round(Number(t.duration || 0) / 1000), // SoundCloud отдаёт мс
    popularity: Number(t.playback_count || 0),
    sourceUrl: t.permalink_url || ''
  };
}
async function soundcloudSearch(q, limit = 30) {
  try {
    const params = new URLSearchParams({
      q, client_id: SOUNDCLOUD_CLIENT_ID,
      limit: String(limit), linked_partitioning: '1'
    });
    const r = await jsonFetch(`https://api-v2.soundcloud.com/search/tracks?${params}`, {}, 7000);
    const d = await readJson(r);
    return (Array.isArray(d?.collection) ? d.collection : [])
      .map(soundcloudNorm)
      .filter(Boolean);
  } catch { return []; }
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
  else if (t.startsWith(q + ' ')) s += 2_000_000;
  else if (t.startsWith(q)) s += 1_800_000;
  else if (t.includes(q)) s += 1_000_000;
  else if (a.startsWith(q)) s += 900_000;
  else if (a.includes(q)) s += 700_000;
  else {
    let hits = 0;
    for (const tok of tokens) {
      if (t.split(/\s+/).includes(tok)) hits += 5;
      else if (a.split(/\s+/).includes(tok)) hits += 3;
      else if (combined.includes(tok)) hits += 1;
    }
    if (hits === 0) return 0;
    s += hits * 50_000;
  }
  if (item.popularity) s += Math.min(60_000, Math.log10(Number(item.popularity) + 1) * 8000);
  if (item.explicit) s += 5000;
  if (item.provider === 'audius') s += 8000;
  if (item.provider === 'soundcloud') s += 8000;
  if (item.provider === 'youtube' && / - topic$/i.test(item.channel || '')) s += 10000;
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
  if (/^(unknown|unknown artist|various artists|no name|без названия|null|undefined|va|release)$/.test(artLow))
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
  if (!track) throw makeErr('empty_track', 'No track');
  if (track.source === 'LOCAL' && track.localUrl)
    return { provider: 'local', kind: 'local', url: track.localUrl };
  if (track.provider === 'soundcloud' && track.providerId)
    return { provider: 'soundcloud', kind: 'soundcloud', url: '/api/audio/soundcloud/' + encodeURIComponent(track.providerId) };
  if (track.provider === 'audius' && track.providerId)
    return { provider: 'audius', kind: 'audius', url: '/api/audio/audius/' + encodeURIComponent(track.providerId) };
  if (track.provider === 'youtube' && track.videoId)
    return { provider: 'youtube', kind: 'youtube', videoId: track.videoId, url: '/api/audio/youtube/' + encodeURIComponent(track.videoId) };

  const title = cleanTitle(track.title);
  const artist = splitArtists(track.artist)[0] || track.artist || '';
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) throw makeErr('no_query', 'Nothing to search');

  const ck = normalize(query) + '|' + Math.round(track.duration || 0);
  const hit = resolveCache.get(ck);
  if (hit && Date.now() - hit.time < RESOLVE_TTL) return hit.data;

  dbg('query:', query, 'dur:', track.duration);

  // 1. Audius (прямой mp3)
  const audiusRes = await audiusSearch(query, 10);
  dbg('audius:', audiusRes.length);
  const bestA = pickBest(audiusRes, track);
  if (bestA) {
    const data = {
      provider: 'audius', kind: 'audius',
      url: '/api/audio/audius/' + encodeURIComponent(bestA.providerId),
      matchedTitle: bestA.title, matchedArtist: bestA.artist
    };
    resolveCache.set(ck, { time: Date.now(), data });
    dbg('→ audius', bestA.title);
    return data;
  }

  // 2. YouTube
  const ytRes = await youtubeSearch(query, 20);
  dbg('youtube:', ytRes.length);
  const bestY = pickBest(ytRes, track);
  if (bestY) {
    const data = {
      provider: 'youtube', kind: 'youtube', videoId: bestY.videoId,
      url: '/api/audio/youtube/' + encodeURIComponent(bestY.videoId),
      matchedTitle: bestY.title, matchedArtist: bestY.channel || bestY.artist
    };
    resolveCache.set(ck, { time: Date.now(), data });
    dbg('→ youtube', bestY.title, bestY.videoId);
    return data;
  }

  dbg('→ no match');
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
    const a = normalize(it.artist || it.channel || '');
    let s = 0;
    if (t === wT) s += 1;
    else if (t.startsWith(wT)) s += 0.85;
    else if (t.includes(wT)) s += 0.65;
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
      if (ratio > 0.85 && ratio < 1.15) s += 0.3;
      else if (ratio > 0.7 && ratio < 1.4) s += 0.15;
      else if (ratio < 0.5 || ratio > 2) s -= 0.5;
    }
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return bestScore >= 0.55 ? best : null;
}

// B4: rate-limit на auth-ручки (in-memory, без новых зависимостей)
const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  let e = authAttempts.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + 15 * 60 * 1000 }; authAttempts.set(ip, e); }
  if (++e.count > 10) return res.status(429).json({ error: 'Слишком много попыток. Повтори через 15 минут.' });
  next();
}

// B15: rate-limit на поисковые ручки — поиск дергает 4 внешних провайдера,
// на публичном деплое их квоты можно сжечь без авторизации
const searchAttempts = new Map();
function searchRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  if (searchAttempts.size > 5000) for (const [k, v] of searchAttempts) if (now >= v.resetAt) searchAttempts.delete(k);
  let e = searchAttempts.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + 60 * 1000 }; searchAttempts.set(ip, e); }
  if (++e.count > 60) return res.status(429).json({ error: 'Слишком много запросов. Подожди минуту.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authAttempts) if (now >= v.resetAt) authAttempts.delete(k);
}, 60 * 1000);

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
    passwordHash: hashPassword(password, salt), passwordSalt: salt, createdAt: Date.now()
  };
  db.favorites[id] = []; db.history[id] = []; db.plays[id] = {}; db.playlists[id] = [];
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
  if (!user.passwordSalt || !hashEquals(hashPassword(password, user.passwordSalt), user.passwordHash))
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || '', provider: 'local' } });
}
api.post('/api/auth/register', authRateLimit, registerHandler);
api.post('/api/register', authRateLimit, registerHandler);
api.post('/api/auth/login', authRateLimit, loginHandler);
api.post('/api/login', authRateLimit, loginHandler);

api.get('/api/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI)
    return res.status(503).send('Discord OAuth not configured');
  const p = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code', scope: 'identify'
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
      client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI
    });
    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const td = await tr.json();
    if (!td.access_token) return res.status(400).send('Token error');
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + td.access_token } });
    const user = await ur.json();
    const id = user.id;
    db.users[id] = db.users[id] || { id, createdAt: Date.now(), provider: 'discord' };
    db.users[id].username = user.username;
    db.users[id].avatar = user.avatar || '';
    db.favorites[id] = db.favorites[id] || []; db.history[id] = db.history[id] || [];
    db.plays[id] = db.plays[id] || {}; db.playlists[id] = db.playlists[id] || [];
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
  const t = req.body; if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const list = db.favorites[req.user.id] || [];
  const k = trackKey(t);
  if (!list.some(x => trackKey(x) === k)) { list.unshift(t); db.favorites[req.user.id] = list.slice(0, 1000); saveDb(); }
  res.json({ ok: true });
});
api.delete('/api/favorites/:key', authMiddleware, (req, res) => {
  const key = String(req.params.key || '');
  const list = db.favorites[req.user.id] || [];
  db.favorites[req.user.id] = list.filter(x => trackKey(x) !== key);
  saveDb(); res.json({ ok: true });
});
api.delete('/api/favorites', authMiddleware, (req, res) => {
  db.favorites[req.user.id] = []; saveDb(); res.json({ ok: true });
});
api.get('/api/history', authMiddleware, (req, res) => res.json(db.history[req.user.id] || []));
api.post('/api/history', authMiddleware, (req, res) => {
  const t = req.body; if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const list = db.history[req.user.id] || [];
  const k = trackKey(t);
  const filtered = list.filter(x => trackKey(x) !== k);
  filtered.unshift({ ...t, playedAt: Date.now() });
  db.history[req.user.id] = filtered.slice(0, 500); saveDb(); res.json({ ok: true });
});
api.delete('/api/history', authMiddleware, (req, res) => {
  db.history[req.user.id] = []; saveDb(); res.json({ ok: true });
});
api.post('/api/track-play', authMiddleware, (req, res) => {
  const t = req.body; if (!t?.title) return res.status(400).json({ error: 'invalid' });
  const uid = req.user.id;
  db.plays[uid] = db.plays[uid] || {};
  const k = trackKey(t);
  const cur = db.plays[uid][k] || { count: 0, last: 0, track: t };
  cur.count += 1; cur.last = Date.now(); cur.track = t;
  db.plays[uid][k] = cur; saveDb(); res.json({ ok: true, count: cur.count });
});
api.get('/api/stats', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const hist = db.history[uid] || [];
  const favs = db.favorites[uid] || [];
  const plays = db.plays[uid] || {};
  const tSet = new Set(), aSet = new Set();
  for (const t of [...hist, ...favs]) {
    if (!t) continue; tSet.add(trackKey(t));
    const a = splitArtists(t.artist)[0]; if (a) aSet.add(a.toLowerCase());
  }
  for (const p of Object.values(plays)) {
    if (!p?.track) continue; tSet.add(trackKey(p.track));
    const a = splitArtists(p.track.artist)[0]; if (a) aSet.add(a.toLowerCase());
  }
  const artistPlays = new Map();
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    const a = splitArtists(p.track.artist)[0]; if (!a) continue;
    artistPlays.set(a, (artistPlays.get(a) || 0) + (p.count || 1));
  }
  const topArtists = [...artistPlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
  const topTracksMap = new Map();
  for (const p of Object.values(plays)) {
    if (!p?.track) continue;
    const k = trackKey(p.track);
    const cur = topTracksMap.get(k) || { track: p.track, count: 0 };
    cur.count += p.count || 1; topTracksMap.set(k, cur);
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
// PLAYLISTS
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
    cover: String(cover || ''), tracks: [],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  db.playlists[uid].unshift(pl); saveDb(); res.json(pl);
});
api.patch('/api/playlists/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const { name, description, cover } = req.body || {};
  if (name !== undefined) pl.name = String(name).trim().slice(0, 80);
  if (description !== undefined) pl.description = String(description).slice(0, 300);
  if (cover !== undefined) pl.cover = String(cover);
  pl.updatedAt = Date.now(); saveDb(); res.json(pl);
});
api.delete('/api/playlists/:id', authMiddleware, (req, res) => {
  const uid = req.user.id;
  db.playlists[uid] = (db.playlists[uid] || []).filter(p => p.id !== req.params.id);
  saveDb(); res.json({ ok: true });
});
api.post('/api/playlists/:id/tracks', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const t = req.body; if (!t?.title) return res.status(400).json({ error: 'invalid track' });
  const k = trackKey(t);
  if (!pl.tracks.some(x => trackKey(x) === k)) { pl.tracks.push(t); pl.updatedAt = Date.now(); saveDb(); }
  res.json({ ok: true, tracks: pl.tracks });
});
api.delete('/api/playlists/:id/tracks/:key', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const key = String(req.params.key || '');
  pl.tracks = pl.tracks.filter(x => trackKey(x) !== key);
  pl.updatedAt = Date.now(); saveDb(); res.json({ ok: true, tracks: pl.tracks });
});
api.post('/api/playlists/:id/reorder', authMiddleware, (req, res) => {
  const uid = req.user.id;
  const pl = (db.playlists[uid] || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'not found' });
  const { from, to } = req.body || {};
  if (!Number.isInteger(from) || !Number.isInteger(to)) return res.status(400).json({ error: 'invalid' });
  if (from < 0 || from >= pl.tracks.length || to < 0 || to >= pl.tracks.length)
    return res.status(400).json({ error: 'out of range' });
  const [m] = pl.tracks.splice(from, 1); pl.tracks.splice(to, 0, m);
  pl.updatedAt = Date.now(); saveDb(); res.json({ ok: true, tracks: pl.tracks });
});

// ============================================================================
// WORKSHOP — с категориями
// ============================================================================
// Сид системных элементов (чтобы мастерская не была пустой при первом открытии)
function seedWorkshop() {
  if (workshop.items.some(x => x.system)) return;
  const seeds = [
    { id: 'sys_cosmos', name: 'Космос', author: 'NOVA', tag: 'background', category: 'background', kind: 'css',
      value: 'radial-gradient(ellipse at top,#0b0b1e 0%,#000 60%)', system: true },
    { id: 'sys_sunset', name: 'Закат', author: 'NOVA', tag: 'background', category: 'background', kind: 'css',
      value: 'linear-gradient(135deg,#2a0a14 0%,#0a0408 60%,#000 100%)', system: true },
    { id: 'sys_ocean', name: 'Океан', author: 'NOVA', tag: 'background', category: 'background', kind: 'css',
      value: 'linear-gradient(180deg,#001018 0%,#000 100%)', system: true },
    { id: 'sys_graphite', name: 'Графит', author: 'NOVA', tag: 'background', category: 'background', kind: 'css',
      value: 'linear-gradient(180deg,#101010 0%,#000 100%)', system: true },
    { id: 'sys_purple_glow', name: 'Пурпурное свечение', author: 'NOVA', tag: 'gradient', category: 'background', kind: 'css',
      value: 'radial-gradient(circle at bottom right,#3a0a3a 0%,#000 60%)', system: true },
    { id: 'sys_pulse', name: 'Пульс', author: 'NOVA', tag: 'animation', category: 'animation', kind: 'css',
      value: 'linear-gradient(90deg, #0a0a0a, #1a1a2e, #0a0a0a)', system: true },
    { id: 'sys_star', name: 'Звезда', author: 'NOVA', tag: 'icon', category: 'icon', kind: 'svg',
      value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 4 L17.5 14.5 L28 16 L17.5 17.5 L16 28 L14.5 17.5 L4 16 L14.5 14.5 Z" fill="#fff"/></svg>', system: true }
  ];
  workshop.items.push(...seeds.map(s => ({ ...s, downloads: 0, createdAt: Date.now(), authorId: 'system' })));
  saveWorkshop();
}
seedWorkshop();

api.get('/api/workshop/items', (req, res) => {
  const sort = String(req.query.sort || 'popular');
  const category = String(req.query.category || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  let items = workshop.items.slice();
  if (category && category !== 'all') items = items.filter(x => (x.category || 'background') === category);
  if (q) items = items.filter(x =>
    String(x.name || '').toLowerCase().includes(q) ||
    String(x.author || '').toLowerCase().includes(q) ||
    String(x.tag || '').toLowerCase().includes(q));
  if (sort === 'new') items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (sort === 'az') items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else items.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  res.json({ items: items.slice(0, 100) });
});
const WORKSHOP_KINDS = new Set(['css', 'svg', 'image', 'url']);
function sanitizeSvgSource(src) {
  const s = String(src)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
  return /<svg[\s>]/i.test(s) ? s : '';
}
api.post('/api/workshop/publish', authMiddleware, (req, res) => {
  const { name, value, kind, tag, category } = req.body || {};
  if (!name || !value) return res.status(400).json({ error: 'name and value required' });
  if (String(name).length > 60) return res.status(400).json({ error: 'name too long' });
  if (String(value).length > 800000) return res.status(400).json({ error: 'value too large (max 800KB)' });
  const k = WORKSHOP_KINDS.has(String(kind || '')) ? String(kind) : 'css';
  const v = k === 'svg' ? sanitizeSvgSource(value) : String(value);
  if (!v) return res.status(400).json({ error: 'invalid value' });
  const user = db.users[req.user.id];
  const item = {
    id: 'wp_' + crypto.randomBytes(6).toString('hex'),
    name: String(name), author: (user && user.username) || 'Anonymous',
    authorId: req.user.id,
    tag: String(tag || (k === 'image' ? 'image' : (k === 'svg' ? 'icon' : (k === 'url' ? 'gif' : 'gradient')))).slice(0, 40),
    category: String(category || 'background').slice(0, 40),
    kind: k,
    value: v, downloads: 0, createdAt: Date.now(), system: false
  };
  workshop.items.unshift(item);
  if (workshop.items.length > 1000) workshop.items = workshop.items.slice(0, 1000);
  saveWorkshop();
  res.json({ ok: true, item });
});
api.post('/api/workshop/:id/download', (req, res) => {
  const it = workshop.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  it.downloads = (it.downloads || 0) + 1;
  saveWorkshop();
  res.json({ ok: true, downloads: it.downloads });
});
api.delete('/api/workshop/:id', authMiddleware, (req, res) => {
  const it = workshop.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  if (it.authorId !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  workshop.items = workshop.items.filter(x => x.id !== req.params.id);
  saveWorkshop();
  res.json({ ok: true });
});

// ============================================================================
// SEARCH
// ============================================================================
api.get('/api/search', searchRateLimit, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200); // B15: глубина запроса тоже режется
  if (!q) return res.json({ results: [], artists: [], counts: {} });
  const ck = 'search:' + normalize(q);
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.time < SEARCH_TTL) return res.json(hit.data);

  const safe = async (p, ms) => {
    try { return await Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms))]); }
    catch { return []; }
  };

  const [scTracks, deezerTracks, deezerArtists, audiusTracks, ytTracks] = await Promise.all([
    safe(soundcloudSearch(q, 30), 6000),
    safe(deezerSearchTracks(q, 40), 4500),
    safe(deezerSearchArtists(q, 8), 3500),
    safe(audiusSearch(q, 25), 4000),
    safe(youtubeSearch(q, 20), 9000)
  ]);
  console.log('[search] soundcloud:', scTracks.length, 'audius:', audiusTracks.length, 'deezer:', deezerTracks.length, 'youtube:', ytTracks.length);

  const candidates = [...scTracks, ...audiusTracks, ...deezerTracks, ...ytTracks];
  const deduped = dedupeTracks(candidates);
  const scored = deduped
    .map(t => ({ t, s: scoreTrack(t, q) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map(x => x.t);

  const payload = {
    query: q, results: scored, artists: deezerArtists,
    counts: { tracks: scored.length, artists: deezerArtists.length }
  };
  searchCache.set(ck, { time: Date.now(), data: payload });
  res.json(payload);
});

// ============================================================================
// ARTIST / ALBUM
// ============================================================================
api.get('/api/artist-search', searchRateLimit, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200); // B15: глубина запроса тоже режется
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
  const ck = 'artist:v3:' + id;
  const hit = artistCache.get(ck);
  if (hit && Date.now() - hit.time < (hit.ttl || ARTIST_TTL)) return res.json(hit.data);
  const artist = await deezerGetArtist(id);
  if (!artist) return res.status(404).json({ error: 'not found' });
  const [top, albums] = await Promise.all([deezerArtistTop(id), deezerArtistAlbums(id)]);
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
  const ck = 'popular:v3';
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.time < 10 * 60 * 1000) return res.json(hit.data);
  const [audius, deezer] = await Promise.all([
    audiusTrending(50).catch(() => []),
    deezerChart(50).catch(() => [])
  ]);
  const merged = dedupeTracks([...deezer, ...audius]).slice(0, 60);
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
    const popular = searchCache.get('popular:v3');
    if (popular?.data?.results?.length) {
      return res.json({ results: popular.data.results.slice(0, 30).sort(() => Math.random() - 0.5), based_on: [] });
    }
    return res.json({ results: [], based_on: [] });
  }
  const collected = [], seen = new Set();
  for (const artist of topArtists) {
    try {
      const [dz, au] = await Promise.all([deezerSearchTracks(artist, 8), audiusSearch(artist, 8)]);
      for (const t of [...dz, ...au]) {
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
// B12: yt.search/yt.getInfo у youtubei.js идут без своего таймаута —
// общий лимит, чтобы resolve зависал максимум на 12 с
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rj) => { t = setTimeout(() => rj(new Error(msg || 'timeout')), ms); })
  ]).finally(() => clearTimeout(t));
}
api.post('/api/playback/resolve', async (req, res) => {
  const track = req.body || {};
  if (!track.title && !track.providerId && !track.videoId)
    return res.status(400).json({ error: { code: 'invalid_track', message: 'No track info' } });
  try {
    const data = await withTimeout(resolvePlayback(track), 12000, 'resolve_timeout');
    res.json(data);
  } catch (e) {
    if (e.message === 'resolve_timeout')
      return res.status(504).json({ error: { code: 'resolve_timeout', message: 'Источник не ответил вовремя' } });
    if (e.structured) return res.status(502).json({ error: { code: e.code, message: e.message } });
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
    const data = await withTimeout(resolvePlayback({ title, artist, duration }), 12000, 'resolve_timeout');
    resolveCache.set(ck, { time: Date.now(), data });
    res.json({ ok: true, ...data });
  } catch (e) { res.status(e.message === 'resolve_timeout' ? 504 : 502).json({ ok: false, error: e.message }); }
});

// Audius stream
api.get('/api/audio/audius/:id', async (req, res) => {
  const id = String(req.params.id);
  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const url = `https://api.audius.co/v1/tracks/${encodeURIComponent(id)}/stream` + (params.toString() ? '?' + params : '');
    const headers = {};
    if (AUDIUS_API_KEY) headers['X-API-Key'] = AUDIUS_API_KEY;
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, redirect: 'follow', timeout: 30000 });
    if (!up.ok || !up.body) return res.status(502).end();
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = up.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(up.status);
    up.body.pipe(res);
    req_onclose(res, up);
  } catch { if (!res.headersSent) res.status(502).end(); }
});

// SoundCloud stream (mp3, с поддержкой Range, кэш URL 10 мин)
api.get('/api/audio/soundcloud/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^\d{1,20}$/.test(id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const CK = 10 * 60 * 1000;
    let hit = scStreamCache.get(id);
    if (hit && Date.now() - hit.time > CK) { scStreamCache.delete(id); hit = null; }
    let url = hit ? hit.url : '';
    if (!url) {
      const cid = encodeURIComponent(SOUNDCLOUD_CLIENT_ID);
      // Шаг 1: данные трека — media.transcodings + track_authorization
      const rt = await jsonFetch(`https://api-v2.soundcloud.com/tracks/${id}?client_id=${cid}`, {}, 7000);
      const t = await readJson(rt);
      const trs = Array.isArray(t?.media?.transcodings) ? t.media.transcodings : [];
      const auth = t?.track_authorization || '';
      const prog = trs.find(x => x?.format?.protocol === 'progressive' && x.url);
      if (!prog) {
        console.log('[soundcloud] no progressive, id=', id, 'protocols=', trs.map(x => x?.format?.protocol).join(','));
        return res.status(404).json({
          error: 'hls_only',
          message: 'Трек доступен только через HLS, требуется hls.js на клиенте'
        });
      }
      if (!auth) {
        console.log('[soundcloud] no track_authorization, id=', id);
        return res.status(404).json({ error: 'no_track_authorization', message: 'SoundCloud не вернул track_authorization' });
      }
      // Шаг 2: transcoding → финальный CDN-URL
      const rq = await jsonFetch(`${prog.url}?client_id=${cid}&track_authorization=${encodeURIComponent(auth)}`, {}, 7000);
      const q = await readJson(rq);
      url = q?.url || '';
      if (!url) {
        console.log('[soundcloud] no cdn url, id=', id);
        return res.status(502).json({ error: 'no_cdn_url', message: 'SoundCloud не вернул CDN-URL' });
      }
      scStreamCache.set(id, { url, time: Date.now() }); // кэшируем ФИНАЛЬНЫЙ CDN-URL, не промежуточный
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, redirect: 'follow', timeout: 20000 });
    if (!up.ok || !up.body) {
      if (scStreamCache.has(id)) scStreamCache.delete(id); // закэшированный URL протух — сброс
      return res.status(502).end();
    }
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = up.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(up.status);
    up.body.pipe(res);
    req_onclose(res, up);
  } catch { if (!res.headersSent) res.status(502).end(); }
});

// ---------- YouTube stream: Invidious → Piped → youtubei.js ----------
async function streamViaYoutubei(vid, range, res) {
  // Подготовка до отправки заголовков в res — чтобы таймаут не оборвал начатый стрим
  const prep = (async () => {
    const yt = await getYtClient();
    if (!yt) return false;
    const info = await yt.getInfo(vid);
    let format = null;
    try { format = info.chooseFormat({ type: 'audio', quality: 'best' }); } catch {}
    if (!format) {
      try {
        const formats = info.streaming_data?.adaptive_formats || [];
        const audioFmts = formats.filter(f => f.has_audio && !f.has_video);
        format = audioFmts.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      } catch {}
    }
    if (!format) { dbg('ijs no format'); return false; }
    let url = format.url;
    if (!url || !/googlevideo\.com/.test(url)) {
      try { url = format.decipher(yt.session.player); } catch (e) { dbg('ijs decipher err', e.message); }
    }
    if (!url) { dbg('ijs no url'); return false; }
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (range) headers.Range = range;
    const up = await fetch(url, { headers, redirect: 'follow', timeout: 20000 });
    return { up, format };
  })();
  try {
    const r = await withTimeout(prep, 10000, 'ijs_stream_timeout');
    if (!r) return false;
    const { up, format } = r;
    if (!up.ok && up.status !== 206) { dbg('ijs upstream', up.status); return false; }
    const ct = up.headers.get('content-type') || format.mime_type || 'audio/mp4';
    const cl = up.headers.get('content-length');
    const cr = up.headers.get('content-range');
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    res.status(up.status === 206 ? 206 : 200);
    up.body.pipe(res);
    req_onclose(res, up);
    dbg('→ youtubei stream ok');
    return true;
  } catch (e) {
    // Таймаут или ошибка: поздний ответ придушиваем, чтобы он не писал в res
    prep.then(r => { try { r?.up?.body?.destroy(); } catch {} }).catch(() => {});
    dbg('ijs stream err:', e.message);
    return false;
  }
}

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
      res.setHeader('Content-Type', ct.startsWith('audio/') || ct.startsWith('video/') ? ct : (itag === '251' ? 'audio/webm' : 'audio/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (cl > 0) res.setHeader('Content-Length', String(cl));
      const cr = up.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.status(up.status === 206 ? 206 : 200);
      up.body.pipe(res);
      req_onclose(res, up);
      dbg('→ invidious stream ok', base);
      return true;
    } catch {}
  }
  return false;
}

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  const range = req.headers.range || '';

  // 1. Invidious
  for (const itag of ['251', '140']) {
    if (await tryInvidious(vid, itag, range, res)) return;
  }

  // 2. Piped
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(`${base}/streams/${vid}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      if (!r.ok) continue;
      const d = await r.json();
      const streams = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
      const best = streams.filter(s => s.url && s.mimeType?.includes('audio')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
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
      const cl = up.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
      const cr = up.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
      res.status(up.status === 206 ? 206 : 200);
      up.body.pipe(res);
      req_onclose(res, up);
      return;
    } catch {}
  }

  // 3. youtubei.js — fallback, жёсткий лимит 10 с
  if (await streamViaYoutubei(vid, range, res)) return;

  res.status(502).end();
});

api.get('/api/download/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  const name = String(req.query.name || 'track').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  try {
    const yt = await getYtClient();
    if (yt) {
      const info = await yt.getInfo(vid);
      let format = info.chooseFormat({ type: 'audio', quality: 'best' });
      let url = format?.url;
      if (!url || !/googlevideo\.com/.test(url)) {
        try { url = format?.decipher(yt.session.player); } catch {}
      }
      if (url) {
        const up = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, timeout: 20000 });
        if (up.ok || up.status === 206) {
          res.setHeader('Content-Type', format.mime_type || 'audio/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.m4a"`);
          res.setHeader('Access-Control-Allow-Origin', '*');
          const cl = up.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
          up.body.pipe(res); req_onclose(res, up); return;
        }
      }
    }
  } catch {}
  for (const itag of ['140', '251']) {
    for (const base of INVIDIOUS_INSTANCES) {
      try {
        const url = `${base}/latest_version?id=${vid}&itag=${itag}&local=true`;
        const up = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, redirect: 'follow', timeout: 15000 });
        if (!up.ok) { try { up.body?.destroy(); } catch {} continue; }
        const ct = String(up.headers.get('content-type') || '').toLowerCase();
        if (!ct.startsWith('audio/') && !ct.includes('octet-stream')) { try { up.body?.destroy(); } catch {} continue; }
        res.setHeader('Content-Type', itag === '140' ? 'audio/mp4' : 'audio/webm');
        res.setHeader('Content-Disposition', `attachment; filename="${name}${itag === '140' ? '.m4a' : '.webm'}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        const cl = up.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
        res.status(200); up.body.pipe(res); req_onclose(res, up); return;
      } catch {}
    }
  }
  res.status(502).end();
});

// ============================================================================
// LYRICS
// ============================================================================
api.get('/api/lyrics', async (req, res) => {
  const track = String(req.query.track_name || '').trim();
  const artist = String(req.query.artist_name || '').trim();
  const dur = Number(req.query.duration || 0);
  if (!track && !artist) return res.status(400).json({ found: false });
  const ck = 'lyr:' + normalize(track + '|' + artist) + '|' + Math.round(dur);
  const hit = lyricsCache.get(ck);
  if (hit && Date.now() - hit.time < (hit.neg ? LYRICS_NEG_TTL : LYRICS_TTL)) return res.json(hit.data);
  const clean = String(track)
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(official|audio|video|lyric|lyrics|visualizer|hd|hq|explicit|mv|m\/v)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const send = p => { lyricsCache.set(ck, { time: Date.now(), data: p, neg: !p.found }); res.json(p); };
  try {
    const params = new URLSearchParams({ track_name: clean });
    if (artist) params.set('artist_name', artist);
    if (dur > 0) params.set('duration', String(Math.round(dur)));
    const r = await jsonFetch('https://lrclib.net/api/get?' + params, { headers: { 'User-Agent': 'NOVA/5.2' } }, 8000);
    if (r.ok) {
      const d = await readJson(r);
      if (d.plainLyrics || d.syncedLyrics)
        return send({ found: true, plainLyrics: d.plainLyrics || '', syncedLyrics: d.syncedLyrics || '', source: 'LRCLIB' });
    }
  } catch {}
  try {
    const q = [clean, artist].filter(Boolean).join(' ');
    const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q }), { headers: { 'User-Agent': 'NOVA/5.2' } }, 8000);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const synced = arr.filter(x => x.syncedLyrics);
        const pool = synced.length ? synced : arr;
        const nA = normalize(artist);
        let best = pool[0];
        if (nA) for (const it of pool) if (normalize(it.artistName || '') === nA) { best = it; break; }
        if (best.plainLyrics || best.syncedLyrics)
          return send({ found: true, plainLyrics: best.plainLyrics || '', syncedLyrics: best.syncedLyrics || '', source: 'LRCLIB' });
      }
    }
  } catch {}
  try {
    const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: clean }), { headers: { 'User-Agent': 'NOVA/5.2' } }, 8000);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const synced = arr.filter(x => x.syncedLyrics);
        const best = synced[0] || arr[0];
        if (best.plainLyrics || best.syncedLyrics)
          return send({ found: true, plainLyrics: best.plainLyrics || '', syncedLyrics: best.syncedLyrics || '', source: 'LRCLIB' });
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
    test('youtube', 'https://www.youtube.com/generate_204'),
    test('lrclib', 'https://lrclib.net/api/get?track_name=test&artist_name=test')
  ]);
  const allOk = Object.values(checks).every(c => c.ok);
  res.status(allOk ? 200 : 207).json({
    ok: allOk, service: 'NOVA', version: '5.2.0', env: NODE_ENV,
    uptime: Math.round(process.uptime()),
    users: Object.keys(db.users).length,
    youtubei: ytClient ? 'ready' : (ytInitFailed ? 'failed' : 'lazy'),
    caches: { search: searchCache.size, resolve: resolveCache.size, lyrics: lyricsCache.size, artist: artistCache.size },
    upstream: checks
  });
});

// ============================================================================
// STATIC + START
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

function startServer(options = {}) {
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  return new Promise((resolve, reject) => {
    const server = api.listen(port, host, () => {
      console.log('============================================================');
      console.log(`[NOVA] v5.2.0 env=${NODE_ENV}`);
      console.log(`[NOVA] listening on http://${host}:${port}`);
      console.log(`[NOVA] DB at ${DB_PATH}`);
      console.log(`[NOVA] resolve debug: ${DEBUG_RESOLVE ? 'ON' : 'off'}`);
      console.log(`[NOVA] users: ${Object.keys(db.users).length}`);
      if (IS_PROD && !process.env.DATA_DIR) console.warn('[NOVA] WARNING: DATA_DIR not set');
      console.log('============================================================');
      // Прогреваем youtubei.js в фоне
      getYtClient().catch(() => {});
      resolve(server);
    });
    server.once('error', reject);
  });
}
if (require.main === module) startServer().catch(e => { console.error('[fatal]', e); process.exit(1); });
module.exports = { api, startServer };
