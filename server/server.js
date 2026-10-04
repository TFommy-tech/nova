// ============================================================
// server/server.js — NOVA (v4.1.0)
// Сортировка альбомов, explicit-приоритет, фильтр slowed, download
// ============================================================
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
const IS_PROD = process.env.NODE_ENV === 'production';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDb(){ try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) { return { users:{}, favorites:{}, history:{}, plays:{} }; } }
function saveDb(d){ try { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); } catch (e) { console.error('[db]', e.message); } }
let db = loadDb();
if (!db.users) db.users = {};
if (!db.favorites) db.favorites = {};
if (!db.history) db.history = {};
if (!db.plays) db.plays = {};

const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';

const resolveCache = new Map();
const searchCache = new Map();
const lyricsCache = new Map();
const artistCache = new Map();
const RESOLVE_TTL = 30 * 60 * 1000;
const SEARCH_TTL = 2 * 60 * 1000;
const LYRICS_TTL = 24 * 60 * 60 * 1000;
const ARTIST_TTL = 10 * 60 * 1000;
const ARTIST_EMPTY_TTL = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of searchCache) if (now - v.time > SEARCH_TTL) { searchCache.delete(k); cleaned++; }
  for (const [k, v] of resolveCache) if (now - v.time > RESOLVE_TTL) { resolveCache.delete(k); cleaned++; }
  for (const [k, v] of lyricsCache) if (now - v.time > LYRICS_TTL) { lyricsCache.delete(k); cleaned++; }
  for (const [k, v] of artistCache) if (now - v.time > (v.ttl || ARTIST_TTL)) { artistCache.delete(k); cleaned++; }
  if (cleaned) console.log('[cache] cleaned ' + cleaned);
}, 5 * 60 * 1000);

const rateLimitMap = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 240;
function rateLimit(req, res, next){
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset){ entry = { count: 0, reset: now + RATE_WINDOW }; rateLimitMap.set(ip, entry); }
  entry.count++;
  if (entry.count > RATE_MAX) return res.status(429).json({ error: 'too many requests' });
  next();
}

const api = express();
api.disable('x-powered-by');
api.use(cors());
api.use(express.json({ limit: '4mb' }));
api.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 400 || ms > 1500) console.log('[req]', req.method, req.path, res.statusCode, ms + 'ms');
  });
  next();
});

function trackKey(t){ return [String(t.source||''), String(t.id||''), String(t.title||''), String(t.artist||'')].join('|'); }
function authMiddleware(req, res, next){
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'no token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch (_) { res.status(401).json({ error: 'invalid token' }); }
}
function shuffle(arr){ const a=arr.slice(); for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function hashPassword(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }

// ============================================================
// ФИЛЬТРЫ — усиленные (убираем slowed/sped/nightcore/8D и мусор)
// ============================================================
const NOISE_PATTERNS = [
  /\bspeed\s*up\b/i, /\bsped\s*up\b/i, /\bspedup\b/i,
  /\bslowed\b/i, /\bslowed\s*\+?\s*reverb\b/i, /\bslowed\s*down\b/i,
  /\breverb\s*(version|remix|edit)?\b/i,
  /\bnightcore\b/i, /\bnight\s*core\b/i,
  /\b8\s*d\s*audio\b/i, /\b8d\b/i,
  /\bkaraoke\b/i, /\binstrumental\b/i, /\bmade\s*famous\s*by\b/i,
  /\bin\s*the\s*style\s*of\b/i, /\btribute\s*to\b/i,
  /\btype\s*beat\b/i, /\bbeat\s*prod\b/i,
  /\bminecraft\b/i, /\bwaterfall\b/i,
  /\bdaycore\b/i, /\bnightcore\b/i,
  /\bslowed\s*n\s*reverb\b/i,
  /\bchopped\s*(and|&|n)\s*screwed\b/i,
];

function isNoiseDeezerTrack(t){
  if (!t) return true;
  const title = String(t.title_short || t.title || '');
  const version = String(t.title_version || '');
  const combined = title + ' ' + version;
  for (const p of NOISE_PATTERNS){ if (p.test(combined)) return true; }
  if (!title.trim()) return true;
  return false;
}

function isOwnedAlbum(album, artistId, artistName){
  if (!album) return false;
  if (album.artist && album.artist.id && String(album.artist.id) === String(artistId)) return true;
  if (album.artist && album.artist.name && artistName){
    const a = String(album.artist.name).toLowerCase().trim();
    const w = String(artistName).toLowerCase().trim();
    if (a === w) return true;
  }
  return false;
}
const BAD_ALBUM_WORDS = ['maple story','maplestory','ost','original soundtrack','game soundtrack','soundtrack','tribute','karaoke','various artists','compilation','slowed','sped up','nightcore'];
function isBadAlbumTitle(title){
  const t = String(title || '').toLowerCase();
  for (const w of BAD_ALBUM_WORDS) if (t.includes(w)) return true;
  return false;
}

const BAD_YT_WORDS = [
  'разбор','реакция','reaction','review','обзор','интервью','interview','подкаст','podcast',
  'премьера клипа','премьера','premiere','тизер','teaser','трейлер','trailer',
  'full album','full ep','full mixtape','полный альбом','микс ','микс2','megamix',
  'сборник','compilation','playlist','плейлист','топ 10','топ 20','top 10','top 20',
  'top10','top20','best of','лучшие песни','все песни','all songs','дисс','diss track',
  'making of','как создавался','making beat','fl studio','flp','history of',
  'история группы','биография','biography','бит','type beat','beat prod','инструментал',
  'кавер','cover','пародия','parody','tribute','ремикс','remix','mashup',
  'speed up','sped up','slowed','nightcore','daycore','spedup',
  'reverb','slowed + reverb','slowed and reverb','slowed n reverb',
  'караоке','karaoke','backing track','минус','минусовка',
  '8d audio','8d','8 d audio',
  'дайджест','итоги','новости','news','лекция','вебинар',
  'npc music','minecraft','waterfall',
];
function isBadYoutubeTitle(title){
  const t = String(title || '').toLowerCase();
  const head = t.slice(0, 140);
  for (const w of BAD_YT_WORDS){ if (head.includes(w)) return true; }
  // Одиночное слово "slowed" как отдельное
  if (/\bslowed\b/i.test(head)) return true;
  if (/\bsped\s*up\b/i.test(head)) return true;
  if (/\bnightcore\b/i.test(head)) return true;
  if (/\b8d\s*audio\b/i.test(head)) return true;
  if (/\breverb\b/i.test(head)) return true;
  return false;
}

// ============================================================
// AUTH
// ============================================================
api.post('/api/register', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Логин от 3 символов' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Пароль от 4 символов' });
  if (!/^[a-zA-Zа-яА-Я0-9_\-]+$/u.test(username)) return res.status(400).json({ error: 'Логин без пробелов' });
  const lower = String(username).toLowerCase();
  if (Object.values(db.users).some(u => (u.username || '').toLowerCase() === lower)) return res.status(409).json({ error: 'Логин занят' });
  const id = 'local_' + crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[id] = { id, username, avatar:'', discriminator:'0', provider:'local', passwordHash: hashPassword(password, salt), passwordSalt: salt, createdAt: Date.now() };
  if (!db.favorites[id]) db.favorites[id] = [];
  if (!db.history[id]) db.history[id] = [];
  if (!db.plays[id]) db.plays[id] = {};
  saveDb(db);
  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username, avatar:'', provider:'local' } });
});

api.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Заполни оба поля' });
  const lower = String(username).toLowerCase();
  const user = Object.values(db.users).find(u => (u.username || '').toLowerCase() === lower);
  if (!user || user.provider !== 'local' || !user.passwordHash) return res.status(401).json({ error: 'Неверный логин или пароль' });
  if (hashPassword(password, user.passwordSalt) !== user.passwordHash) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar || '', provider: 'local' } });
});

api.get('/api/auth/discord', (req, res) => {
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type:'code', scope:'identify' });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

api.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');
  try {
    const tokenParams = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type:'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI });
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { method:'POST', body: tokenParams, headers:{ 'Content-Type':'application/x-www-form-urlencoded' } });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('Token error');
    const userRes = await fetch('https://discord.com/api/users/@me', { headers:{ Authorization:'Bearer ' + tokenData.access_token } });
    const user = await userRes.json();
    const userId = user.id;
    if (!db.users[userId]) db.users[userId] = { id:userId, username:user.username, avatar:user.avatar||'', discriminator:user.discriminator||'0', provider:'discord', createdAt: Date.now() };
    else { db.users[userId].username = user.username; db.users[userId].avatar = user.avatar || ''; }
    if (!db.favorites[userId]) db.favorites[userId] = [];
    if (!db.history[userId]) db.history[userId] = [];
    if (!db.plays[userId]) db.plays[userId] = {};
    saveDb(db);
    const token = jwt.sign({ id:userId, username:user.username }, JWT_SECRET, { expiresIn:'30d' });
    res.redirect('/?login=success&token=' + encodeURIComponent(token));
  } catch (e){ res.status(500).send('Auth error'); }
});

api.get('/api/me', authMiddleware, (req, res) => {
  const user = db.users[req.user.id];
  if (!user) return res.status(404).json({ error:'user not found' });
  const { passwordHash, passwordSalt, ...pub } = user;
  res.json(pub);
});

api.get('/api/favorites', authMiddleware, (req, res) => res.json(db.favorites[req.user.id] || []));
api.post('/api/favorites', authMiddleware, (req, res) => {
  const track = req.body;
  if (!track || !track.title) return res.status(400).json({ error:'invalid' });
  const list = db.favorites[req.user.id] || [];
  const key = trackKey(track);
  if (!list.some(t => trackKey(t) === key)){ list.unshift(track); db.favorites[req.user.id] = list.slice(0,500); saveDb(db); }
  res.json({ ok:true });
});
api.delete('/api/favorites/:key', authMiddleware, (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const list = db.favorites[req.user.id] || [];
  db.favorites[req.user.id] = list.filter(t => trackKey(t) !== key);
  saveDb(db); res.json({ ok:true });
});

api.get('/api/history', authMiddleware, (req, res) => res.json(db.history[req.user.id] || []));
api.post('/api/history', authMiddleware, (req, res) => {
  const track = req.body;
  if (!track || !track.title) return res.status(400).json({ error:'invalid' });
  const list = db.history[req.user.id] || [];
  const key = trackKey(track);
  const filtered = list.filter(t => trackKey(t) !== key);
  filtered.unshift(track);
  db.history[req.user.id] = filtered.slice(0,300);
  saveDb(db); res.json({ ok:true });
});

api.post('/api/track-play', authMiddleware, (req, res) => {
  const track = req.body;
  if (!track || !track.title) return res.status(400).json({ error:'invalid' });
  const userId = req.user.id;
  if (!db.plays[userId]) db.plays[userId] = {};
  const key = trackKey(track);
  const existing = db.plays[userId][key] || { count:0, last:0, track };
  existing.count += 1;
  existing.last = Date.now();
  existing.track = track;
  db.plays[userId][key] = existing;
  saveDb(db); res.json({ ok:true, count: existing.count });
});

api.get('/api/recently-played', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const plays = db.plays[userId] || {};
  const sorted = Object.values(plays).sort((a,b) => (b.last||0) - (a.last||0)).slice(0,30);
  res.json(sorted.map(p => p.track).filter(Boolean));
});

api.get('/api/stats', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const hist = db.history[userId] || [];
  const favs = db.favorites[userId] || [];
  const plays = db.plays[userId] || {};
  const uniqueArtists = new Set(); const uniqueTracks = new Set();
  for (const t of [...hist, ...favs]){
    if (!t) continue;
    uniqueTracks.add(trackKey(t));
    const a = String(t.artist||'').split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b)\s*/i)[0].trim();
    if (a) uniqueArtists.add(a.toLowerCase());
  }
  for (const p of Object.values(plays)){
    if (p && p.track){
      uniqueTracks.add(trackKey(p.track));
      const a = String(p.track.artist||'').split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b)\s*/i)[0].trim();
      if (a) uniqueArtists.add(a.toLowerCase());
    }
  }
  const artistPlay = new Map();
  for (const p of Object.values(plays)){
    if (!p || !p.track) continue;
    const a = String(p.track.artist||'').split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b)\s*/i)[0].trim();
    if (!a) continue;
    artistPlay.set(a, (artistPlay.get(a)||0) + (p.count||1));
  }
  const topArtists = [...artistPlay.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}));
  const topTracksMap = new Map();
  for (const p of Object.values(plays)){
    if (!p || !p.track) continue;
    const k = trackKey(p.track);
    const cur = topTracksMap.get(k) || { track:p.track, count:0 };
    cur.count += (p.count||1);
    topTracksMap.set(k, cur);
  }
  const topTracks = [...topTracksMap.values()].sort((a,b)=>b.count-a.count).slice(0,8);
  res.json({ tracks:uniqueTracks.size, artists:uniqueArtists.size, playlists:0, favorites:favs.length, history:hist.length, totalPlays: Object.values(plays).reduce((s,p)=>s+(p.count||0),0), topArtists, topTracks });
});

// ============================================================
// WORKSHOP
// ============================================================
const WORKSHOP_FILE = path.join(DATA_DIR, 'workshop.json');
function loadWorkshop(){ try { return JSON.parse(fs.readFileSync(WORKSHOP_FILE, 'utf8')); } catch (_) { return { items:[] }; } }
function saveWorkshop(w){ try { fs.writeFileSync(WORKSHOP_FILE, JSON.stringify(w, null, 2)); } catch (e) { console.error('[workshop]', e.message); } }
let workshop = loadWorkshop();
if (!workshop.items) workshop.items = [];

api.get('/api/workshop/items', (req, res) => {
  const sort = String(req.query.sort || 'popular');
  const q = String(req.query.q || '').trim().toLowerCase();
  let items = workshop.items.filter(x => !x.system);
  if (q) items = items.filter(x => String(x.name||'').toLowerCase().includes(q) || String(x.author||'').toLowerCase().includes(q) || String(x.tag||'').toLowerCase().includes(q));
  if (sort === 'new') items.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  else if (sort === 'az') items.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  else items.sort((a,b)=>(b.downloads||0)-(a.downloads||0));
  res.json({ items: items.slice(0,60) });
});

api.post('/api/workshop/publish', authMiddleware, (req, res) => {
  const { name, value, kind } = req.body || {};
  if (!name || !value) return res.status(400).json({ error:'name and value required' });
  if (String(name).length > 60) return res.status(400).json({ error:'name too long' });
  if (String(value).length > 300000) return res.status(400).json({ error:'value too large (max 300 KB)' });
  const user = db.users[req.user.id];
  const item = { id:'wp_'+crypto.randomBytes(6).toString('hex'), name:String(name), author:(user&&user.username)||'Anonymous', authorId:req.user.id, tag: kind==='image'?'image':'gradient', kind: kind==='image'?'image':'css', value:String(value), downloads:0, createdAt:Date.now(), system:false };
  workshop.items.unshift(item);
  if (workshop.items.length > 500) workshop.items = workshop.items.slice(0,500);
  saveWorkshop(workshop);
  res.json({ ok:true, item });
});

api.post('/api/workshop/:id/download', (req, res) => {
  const it = workshop.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error:'not found' });
  it.downloads = (it.downloads || 0) + 1;
  saveWorkshop(workshop);
  res.json({ ok:true, downloads: it.downloads });
});

// ============================================================
// HELPERS
// ============================================================
function jsonFetch(url, options = {}, timeoutMs = 12000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept:'application/json', 'User-Agent':'NOVA/4.0', ...(options.headers || {}) };
  return fetch(url, { ...options, headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function readJson(res){
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { throw new Error('bad json'); }
}
function firstImage(o){ if (!o) return ''; if (typeof o === 'string') return o; for (const k of ['1000x1000','480x480','600x600','640x640','320x320','150x150']) if (o[k]) return o[k]; for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].startsWith('http')) return o[k]; return ''; }
function normalizeSearchText(v){ return String(v||'').toLowerCase().replace(/[’'`]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim(); }
function cleanTitleForSearch(title){
  if (!title) return '';
  let t = String(title);
  t = t.replace(/\([^)]*\)/g,' ').replace(/\[[^\]]*\]/g,' ').replace(/#\S+/g,' ');
  t = t.replace(/\b(official|lyric|lyrics|video|audio|visualizer|hd|hq|4k|prod\.?|explicit|clean|mv|m\/v)\b/gi,' ');
  t = t.replace(/\s+/g,' ').trim();
  return t;
}
function splitArtists(raw){
  if (!raw) return [];
  return String(raw).split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i).map(s => s.trim()).filter(Boolean);
}

// ============================================================
// ПОИСКИ
// ============================================================
async function searchItunes(q, opts = {}){
  try {
    const params = new URLSearchParams({ term: q, media:'music', entity:'song', limit: opts.limit || '50' });
    if (opts.attribute) params.set('attribute', opts.attribute);
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    // Приоритет explicit над cleaned
    const ranked = items.slice().sort((a, b) => {
      const ea = a.trackExplicitness === 'explicit' ? 0 : (a.trackExplicitness === 'cleaned' ? 2 : 1);
      const eb = b.trackExplicitness === 'explicit' ? 0 : (b.trackExplicitness === 'cleaned' ? 2 : 1);
      return ea - eb;
    });
    const results = ranked.map((tr, idx) => {
      const rankBoost = Math.max(0, 100 - idx);
      return {
        id: 'itunes_' + String(tr.trackId || ''),
        title: tr.trackName || 'Untitled',
        artist: tr.artistName || '',
        artistId: String(tr.artistId || ''),
        cover: (tr.artworkUrl100 || '').replace('100x100','600x600'),
        album: tr.collectionName || '',
        albumId: '',
        preview: '',
        source: 'CATALOG',
        sourceUrl: tr.trackViewUrl || '',
        downloadable: false,
        duration: Number(tr.trackTimeMillis || 0) / 1000,
        popularity: 50000 + rankBoost * 500,
        releaseDate: tr.releaseDate || '',
        explicit: tr.trackExplicitness === 'explicit',
        provider: 'itunes'
      };
    });
    return { results, count: results.length };
  } catch (e){ return { results: [], count: 0 }; }
}

async function searchAudius(q){
  try {
    const params = new URLSearchParams({ query: q, limit:'30', sort_method:'popular' });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);
    const r = await jsonFetch('https://api.audius.co/v1/tracks/search?' + params.toString(), { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} }, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    const results = items
      .filter(t => { const dur = Number(t.duration||0); return !(dur>0 && dur<60) && !t.is_unlisted; })
      .filter(t => !isNoiseDeezerTrack({ title_short: t.title }))
      .map(t => {
        const id = t.id || '';
        return {
          id, title: t.title || 'Untitled',
          artist: t.user?.name || 'Unknown', artistId: t.user?.id || '',
          cover: firstImage(t.artwork), preview:'', source:'FULL',
          sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : '',
          downloadable: Boolean(t.downloadable),
          downloadUrl: t.downloadable ? '/api/download/audius/' + encodeURIComponent(id) : '',
          duration: Number(t.duration||0), bitrate: Number(t.bitrate||0),
          popularity: Number(t.play_count||0) + Number(t.favorite_count||0)*5,
          releaseDate: t.release_date || t.created_at || '',
          provider: 'audius'
        };
      });
    return { results, count: results.length };
  } catch (e){ return { results: [], count: 0 }; }
}

async function searchYouTubeMeta(q){
  try {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D';
    const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36', 'Accept-Language':'en-US,en;q=0.9' }, timeout: 7000 });
    if (!r.ok) return { results: [], count: 0 };
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
          if (parts.length === 3) duration = parts[0]*3600 + parts[1]*60 + parts[2];
          else if (parts.length === 2) duration = parts[0]*60 + parts[1];
        }
        if (vid && title){
          items.push({ id:'yt_'+vid, title, artist:author, channel:author, artistId:'', cover:thumb, album:'', albumId:'', preview:'', source:'FULL', sourceUrl:'https://www.youtube.com/watch?v=' + vid, downloadable:false, duration, popularity:10000, provider:'youtube' });
        }
      }
      for (const k in obj){ if (Array.isArray(obj[k])) obj[k].forEach(walk); else if (typeof obj[k] === 'object') walk(obj[k]); }
    }
    walk(data);
    return { results: items, count: items.length };
  } catch (e){ return { results: [], count: 0 }; }
}

async function searchYouTubeViaPiped(q){
  const bases = ['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://api.piped.yt','https://pipedapi.reallyaweso.me'];
  const attempts = bases.map(base => (async () => {
    const r = await fetch(base + '/search?q=' + encodeURIComponent(q) + '&filter=videos', { headers:{ 'User-Agent':'Mozilla/5.0' }, timeout: 5500 });
    if (!r.ok) throw new Error('not ok');
    const d = await r.json();
    const items = Array.isArray(d?.items) ? d.items : [];
    const results = items
      .filter(x => x && x.type === 'stream' && x.url && x.url.includes('watch?v='))
      .map(x => {
        const vid = String(x.url).split('watch?v=')[1]?.split('&')[0] || '';
        return { id:'yt_'+vid, title:x.title||'', artist:x.uploaderName||'YouTube', channel:x.uploaderName||'YouTube', artistId:'', cover:x.thumbnail||'', album:'', albumId:'', preview:'', source:'FULL', sourceUrl:'https://www.youtube.com/watch?v=' + vid, downloadable:false, duration:Number(x.duration||0), popularity:10000, provider:'youtube' };
      })
      .filter(x => x.id !== 'yt_' && x.title);
    if (!results.length) throw new Error('empty');
    return { results, count: results.length };
  })());
  try { return await Promise.any(attempts); } catch (_){ return { results: [], count: 0 }; }
}

async function searchYouTube(q){
  const results = await Promise.allSettled([ searchYouTubeViaPiped(q), searchYouTubeMeta(q) ]);
  for (const r of results){
    if (r.status === 'fulfilled' && r.value && r.value.results && r.value.results.length){ return r.value; }
  }
  return { results: [], count: 0 };
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
  const pop = Number(item.popularity||0);
  if (pop > 0) score += Math.log10(pop+1) * 5000;
  if (item.provider === 'itunes') score += 30000;
  if (item.explicit) score += 5000;
  if (item.source === 'FULL') score += 500;
  return score;
}

function mergeProviderResults(providers, query){
  const out = []; const seen = new Set();
  for (const p of providers){
    if (!p) continue;
    for (const item of p.results || []){
      const key = normalizeSearchText(item.artist) + '|' + normalizeSearchText(item.title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, _score: scoreProviderTrack(item, query) });
    }
  }
  out.sort((a,b) => b._score - a._score);
  return out.slice(0,80).map(({ _score, ...rest }) => rest);
}

// ============================================================
// HEALTH
// ============================================================
api.get('/api/health', async (req, res) => {
  const checks = {};
  const check = async (name, url, ms) => {
    const start = Date.now();
    try { const r = await jsonFetch(url, {}, ms); checks[name] = { ok: r.ok || r.status<500, status:r.status, ms:Date.now()-start }; }
    catch (e){ checks[name] = { ok:false, error:e.message, ms:Date.now()-start }; }
  };
  await Promise.all([ check('deezer','https://api.deezer.com/artist/1',4000), check('itunes','https://itunes.apple.com/search?term=test&limit=1',4000), check('youtube','https://www.youtube.com/generate_204',4000) ]);
  const allOk = Object.values(checks).every(c => c.ok);
  res.status(allOk ? 200 : 207).json({ ok:allOk, service:'NOVA', version:'4.1.0', uptime:Math.round(process.uptime()), users:Object.keys(db.users).length, caches:{ search:searchCache.size, resolve:resolveCache.size, lyrics:lyricsCache.size, artist:artistCache.size }, upstream:checks });
});

// ============================================================
// POPULAR
// ============================================================
api.get('/api/popular', async (req, res) => {
  const cacheKey = 'popular:v9';
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 10*60*1000) return res.json(cached.data);
  const feeds = ['https://itunes.apple.com/us/rss/topsongs/limit=50/json','https://itunes.apple.com/gb/rss/topsongs/limit=50/json','https://itunes.apple.com/de/rss/topsongs/limit=50/json'];
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
        const id = e.id?.attributes?.['im:id'] || ('itunes_'+Math.random());
        results.push({ id:'itunes_'+id, title, artist, artistId:'', cover: cover.replace('170x170','600x600').replace('100x100','600x600'), album:e['im:collection']?.['im:name']?.label||'', albumId:'', preview:'', source:'CATALOG', sourceUrl: e.id?.label || '', downloadable:false, duration:0, popularity:100000, provider:'itunes' });
      }
    } catch (e){}
  }));
  const payload = { results: results.slice(0,60) };
  searchCache.set(cacheKey, { time:Date.now(), data:payload });
  res.json(payload);
});

// ============================================================
// SEARCH
// ============================================================
api.get('/api/search', rateLimit, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], counts: {} });
  const cacheKey = 'search:' + normalizeSearchText(q);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_TTL) return res.json(cached.data);
  const safeFetch = async (fn, name, ms) => { try { return await Promise.race([fn(), new Promise((_,r)=>setTimeout(()=>r(new Error(name+' timeout')), ms))]); } catch (e){ return { results:[], count:0 }; } };
  const [itunes, audius, yt] = await Promise.all([
    safeFetch(()=>searchItunes(q,{limit:'80'}),'itunes',4000),
    safeFetch(()=>searchAudius(q),'audius',3500),
    safeFetch(()=>searchYouTube(q),'youtube',6500)
  ]);
  const providers = [];
  if (itunes) providers.push(itunes);
  if (audius) providers.push(audius);
  if (yt) providers.push(yt);
  let results = [];
  try { results = mergeProviderResults(providers, q); } catch (e){ results = []; }
  const payload = { results, counts:{ itunes:itunes?.count||0, audius:audius?.count||0, youtube:yt?.count||0 } };
  searchCache.set(cacheKey, { time:Date.now(), data:payload });
  res.json(payload);
});

// ============================================================
// RECOMMENDATIONS
// ============================================================
api.get('/api/recommendations', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const history = db.history[userId] || [];
  const favorites = db.favorites[userId] || [];
  const plays = db.plays[userId] || {};
  const artistCounts = new Map();
  const playedKeys = new Set(Object.keys(plays));
  const bump = (a) => { if (!a) return; const key = String(a).toLowerCase().trim(); if (!key) return; artistCounts.set(key, (artistCounts.get(key)||0)+1); };
  history.slice(0,30).forEach(t => bump(t.artist));
  favorites.slice(0,30).forEach(t => bump(t.artist));
  for (const p of Object.values(plays)){ if (p && p.track && p.track.artist){ const w = Math.min(5, Math.ceil((p.count||1)/2)); for (let i=0;i<w;i++) bump(p.track.artist); } }
  const topArtists = [...artistCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([a])=>a);
  if (!topArtists.length){
    const cached = searchCache.get('popular:v9');
    if (cached && cached.data?.results?.length) return res.json({ results: shuffle(cached.data.results).slice(0,30), based_on:[] });
    return res.json({ results: [], based_on: [] });
  }
  const collected = []; const seenTitles = new Set();
  for (const artist of topArtists){
    try {
      const params = new URLSearchParams({ term: artist, media:'music', entity:'song', attribute:'artistTerm', limit:'15' });
      const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 6000);
      const d = await readJson(r);
      const items = Array.isArray(d?.results) ? d.results : [];
      const strict = items.filter(x => normalizeSearchText(x.artistName) === artist);
      for (const x of strict){
        const t = { id:'itunes_'+String(x.trackId||''), title:x.trackName||'Untitled', artist:x.artistName||'', artistId:String(x.artistId||''), cover:(x.artworkUrl100||'').replace('100x100','600x600'), album:x.collectionName||'', albumId:'', preview:'', source:'CATALOG', sourceUrl:x.trackViewUrl||'', downloadable:false, duration:Number(x.trackTimeMillis||0)/1000, popularity:50000, provider:'itunes' };
        const key = normalizeSearchText(t.artist) + '|' + normalizeSearchText(t.title);
        if (seenTitles.has(key)) continue;
        if (playedKeys.includes(trackKey(t))) continue;
        seenTitles.add(key);
        collected.push(t);
      }
    } catch (e){}
  }
  res.json({ results: shuffle(collected).slice(0,30), based_on: topArtists });
});

// ============================================================
// RESOLVE
// ============================================================
api.get('/api/audio/resolve', rateLimit, async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const duration = Number(req.query.duration || 0);
  const legacyQ = String(req.query.q || '').trim();
  const q = legacyQ || [title, artist].filter(Boolean).join(' ');
  if (!q && !title && !artist) return res.status(400).json({ ok:false, error:'empty' });
  const ck = normalizeSearchText(q) + (duration > 0 ? '|d' + Math.round(duration) : '');
  const cached = resolveCache.get(ck);
  if (cached && Date.now() - cached.time < RESOLVE_TTL) return res.json({ ok:true, ...cached.data, cached:true });
  try {
    const r = await findPlayableAudio({ title, artist, duration, full: q });
    resolveCache.set(ck, { time:Date.now(), data:r });
    res.json({ ok:true, ...r });
  } catch (e){
    console.log('[resolve] failed', JSON.stringify({ title, artist }), '→', e.message);
    res.status(502).json({ ok:false, error:e.message });
  }
});

api.post('/api/audio/prefetch', async (req, res) => {
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0,8) : [];
  res.json({ ok:true, count:tracks.length });
  (async () => {
    for (const t of tracks){
      try {
        const title = String(t.title||'').trim();
        const artist = String(t.artist||'').trim();
        const q = [title, artist].filter(Boolean).join(' ');
        if (!q) continue;
        const ck = normalizeSearchText(q);
        if (resolveCache.has(ck) && Date.now() - resolveCache.get(ck).time < RESOLVE_TTL) continue;
        const r = await findPlayableAudio({ title, artist, duration: Number(t.duration||0), full: q });
        resolveCache.set(ck, { time:Date.now(), data:r });
      } catch (e){}
    }
  })();
});

// ============================================================
// STREAM YouTube — пробуем максимальное качество (251 opus → 140 m4a)
// ============================================================
const INVIDIOUS_INSTANCES = [
  'https://invidious.f5.si','https://inv.nadeko.net','https://yewtu.be',
  'https://invidious.nerdvpn.de','https://iv.melmac.space',
  'https://invidious.privacyredirect.com','https://vid.puffyan.us',
  'https://invidious.projectsegfau.lt','https://inv.tux.pizza',
  'https://invidious.reallyaweso.me'
];
const PIPED_STREAM_INSTANCES = ['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://api.piped.yt'];

async function streamInvidious(vid, itag, range, res){
  for (const base of INVIDIOUS_INSTANCES){
    try {
      const url = base + '/latest_version?id=' + vid + '&itag=' + itag + '&local=true';
      const headers = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept':'*/*', 'Accept-Language':'en-US,en;q=0.9' };
      if (range) headers.Range = range;
      const upstream = await fetch(url, { headers, redirect:'follow', timeout: 12000 });
      if (!upstream.ok && upstream.status !== 206){ try { upstream.body?.destroy(); } catch (_){} continue; }
      const ct = String(upstream.headers.get('content-type')||'').toLowerCase();
      const cl = Number(upstream.headers.get('content-length')||0);
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')){ try { upstream.body?.destroy(); } catch (_){} continue; }
      if (cl > 0 && cl < 50000){ try { upstream.body?.destroy(); } catch (_){} continue; }
      res.setHeader('Content-Type', ct.startsWith('audio/') || ct.startsWith('video/') ? ct : (itag === '251' ? 'audio/webm' : 'audio/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (cl > 0) res.setHeader('Content-Length', String(cl));
      const cr = upstream.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.status(upstream.status === 206 ? 206 : 200);
      upstream.body.pipe(res);
      req_onclose(res, upstream);
      return true;
    } catch (e){}
  }
  return false;
}

function req_onclose(res, upstream){
  try { res.req.on('close', () => { try { upstream.body?.destroy(); } catch (_){} }); } catch (_){}
}

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  const range = req.headers.range || '';
  // Сначала opus 251 (лучшее качество), потом m4a 140
  for (const itag of ['251', '140']){
    const ok = await streamInvidious(vid, itag, range, res);
    if (ok) return;
  }
  // Piped как fallback
  for (const base of PIPED_STREAM_INSTANCES){
    try {
      const r = await fetch(base + '/streams/' + vid, { headers:{ 'User-Agent':'Mozilla/5.0' }, timeout: 8000 });
      if (!r.ok) continue;
      const d = await r.json();
      const streams = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
      const best = streams.filter(s => s.url && s.mimeType && s.mimeType.includes('audio')).sort((a,b) => (b.bitrate||0) - (a.bitrate||0))[0];
      if (!best?.url) continue;
      const proxyUrl = best.proxyUrl || best.url;
      const headers = { 'User-Agent':'Mozilla/5.0', 'Accept':'*/*' };
      if (range) headers.Range = range;
      const upstream = await fetch(proxyUrl, { headers, redirect:'follow', timeout: 15000 });
      if (!upstream.ok && upstream.status !== 206) continue;
      const ct = String(upstream.headers.get('content-type')||'').toLowerCase();
      if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')){ try { upstream.body?.destroy(); } catch (_){} continue; }
      res.setHeader('Content-Type', best.mimeType || 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.status(upstream.status === 206 ? 206 : 200);
      upstream.body.pipe(res);
      req_onclose(res, upstream);
      return;
    } catch (e){}
  }
  res.status(502).end();
});

// ============================================================
// DOWNLOAD — скачать трек с YouTube
// ============================================================
api.get('/api/download/youtube/:videoId', async (req, res) => {
  const vid = String(req.params.videoId || '');
  const name = String(req.query.name || 'track').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).end();
  for (const itag of ['140', '251']){
    for (const base of INVIDIOUS_INSTANCES){
      try {
        const url = base + '/latest_version?id=' + vid + '&itag=' + itag + '&local=true';
        const upstream = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0', 'Accept':'*/*' }, redirect:'follow', timeout: 15000 });
        if (!upstream.ok) { try { upstream.body?.destroy(); } catch (_){} continue; }
        const ct = String(upstream.headers.get('content-type')||'').toLowerCase();
        if (!ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')){ try { upstream.body?.destroy(); } catch (_){} continue; }
        res.setHeader('Content-Type', itag === '140' ? 'audio/mp4' : 'audio/webm');
        res.setHeader('Content-Disposition', 'attachment; filename="' + name + (itag === '140' ? '.m4a' : '.webm') + '"');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const cl = upstream.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);
        res.status(200);
        upstream.body.pipe(res);
        req_onclose(res, upstream);
        return;
      } catch (e){}
    }
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
    const upstream = await jsonFetch(url, { headers, redirect:'follow' }, 30000);
    if (!upstream.ok || !upstream.body) return res.status(502).send('err');
    for (const h of ['content-type','content-length','accept-ranges','content-range']){
      const v = upstream.headers.get(h);
      if (v) res.setHeader({ 'content-type':'Content-Type','content-length':'Content-Length','accept-ranges':'Accept-Ranges','content-range':'Content-Range' }[h], v);
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
    res.setHeader('Content-Disposition', 'attachment; filename="' + String(td.data.title||'track').replace(/[<>:"/\\|?*]+/g,'_') + '.mp3"');
    stream.body.pipe(res);
  } catch (e){ if (!res.headersSent) res.status(502).send('err'); }
});

// ============================================================
// iTunes ARTIST LOOKUP
// ============================================================
async function findItunesArtistId(name){
  try {
    const params = new URLSearchParams({ term:name, media:'music', entity:'musicArtist', limit:'5' });
    const r = await jsonFetch('https://itunes.apple.com/search?' + params.toString(), {}, 8000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    if (!items.length) return null;
    const norm = normalizeSearchText(name);
    const exact = items.find(x => normalizeSearchText(x.artistName) === norm);
    const best = exact || items[0];
    return best ? String(best.artistId) : null;
  } catch (e){ return null; }
}

async function itunesArtistTracks(itunesArtistId, limit = 50){
  try {
    const params = new URLSearchParams({ id:itunesArtistId, entity:'song', limit:String(limit) });
    const r = await jsonFetch('https://itunes.apple.com/lookup?' + params.toString(), {}, 9000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const tracks = items.filter(x => x.wrapperType === 'track' || x.kind === 'song');
    return tracks.map(tr => ({
      id:'itunes_'+String(tr.trackId||''), title:tr.trackName||'Untitled', title_short:tr.trackName||'Untitled',
      duration:Number(tr.trackTimeMillis||0)/1000, rank:0, preview:'',
      artist:{ id:'', name:tr.artistName||'' },
      album:{ id:'itunes_album_'+(tr.collectionId||''), title:tr.collectionName||'', cover_medium:(tr.artworkUrl100||'').replace('100x100','500x500') },
      provider:'itunes', source:'CATALOG', explicit: tr.trackExplicitness === 'explicit'
    }));
  } catch (e){ return []; }
}

async function itunesArtistAlbums(itunesArtistId, limit = 100){
  try {
    const params = new URLSearchParams({ id:itunesArtistId, entity:'album', limit:String(limit) });
    const r = await jsonFetch('https://itunes.apple.com/lookup?' + params.toString(), {}, 9000);
    const d = await readJson(r);
    const items = Array.isArray(d?.results) ? d.results : [];
    const albums = items.filter(x => x.wrapperType === 'collection' && x.collectionType !== 'TV Season');
    return albums
      .filter(x => !isBadAlbumTitle(x.collectionName))
      .map(x => ({
        id:'itunes_album_'+x.collectionId, title:x.collectionName,
        cover_medium:(x.artworkUrl100||'').replace('100x100','500x500'),
        cover_big:(x.artworkUrl100||'').replace('100x100','1000x1000'),
        cover_xl:(x.artworkUrl100||'').replace('100x100','1000x1000'),
        record_type: Number(x.trackCount||0) <= 3 ? 'single' : 'album',
        nb_tracks:Number(x.trackCount||0),
        release_date: x.releaseDate || '',
        artist:{ id:'', name:x.artistName||'' },
        provider:'itunes'
      }));
  } catch (e){ return []; }
}

// ============================================================
// ARTIST
// ============================================================
api.get('/api/artist-search', rateLimit, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error:'empty' });
  try {
    const url = 'https://api.deezer.com/search/artist?q=' + encodeURIComponent(q) + '&limit=15';
    const r = await jsonFetch(url, {}, 7000);
    const d = await readJson(r);
    const items = Array.isArray(d?.data) ? d.data : [];
    if (!items.length) return res.status(404).json({ error:'not found' });
    const norm = normalizeSearchText(q);
    const exact = items.filter(a => normalizeSearchText(a.name) === norm);
    if (!exact.length) return res.status(404).json({ error:'no exact match' });
    exact.sort((a,b) => (b.nb_fan||0) - (a.nb_fan||0));
    const best = exact[0];
    res.json({ id:String(best.id), name:best.name, picture: best.picture_xl || best.picture_big || best.picture_medium || '', nb_fan: best.nb_fan || 0 });
  } catch (e){ res.status(502).json({ error: e.message }); }
});

api.get('/api/artist/:id', rateLimit, async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  const cacheKey = 'artist:v6:' + id;
  const cached = artistCache.get(cacheKey);
  if (cached && Date.now() - cached.time < (cached.ttl || ARTIST_TTL)) return res.json(cached.data);

  try {
    const a = await jsonFetch('https://api.deezer.com/artist/' + id, {}, 8000);
    const artist = await readJson(a);
    if (!artist || !artist.id) return res.status(404).json({ error:'not found' });
    const artistName = artist.name || '';
    const artistIdStr = String(artist.id);

    let top_tracks = [];
    let tracksSource = 'none';
    const seenTrackIds = new Set();
    const pushStrict = (arr, src) => {
      if (!Array.isArray(arr)) return 0;
      let added = 0;
      for (const tr of arr){
        if (!tr || !tr.id) continue;
        if (seenTrackIds.has(String(tr.id))) continue;
        if (tr.artist && tr.artist.id && String(tr.artist.id) !== artistIdStr) continue;
        if (isNoiseDeezerTrack(tr)) continue;
        seenTrackIds.add(String(tr.id));
        top_tracks.push(tr);
        added++;
      }
      if (added) tracksSource = src;
      return added;
    };

    try { const t = await jsonFetch('https://api.deezer.com/artist/' + id + '/top?limit=100', {}, 8000); const top = await readJson(t); const raw = Array.isArray(top.data) ? top.data : []; pushStrict(raw, 'deezer-top'); } catch (e){}
    if (!top_tracks.length && artistName){
      try { const params = new URLSearchParams({ q:'artist:"' + artistName + '"', limit:'100' }); const r = await jsonFetch('https://api.deezer.com/search/track?' + params.toString(), {}, 9000); const d = await readJson(r); pushStrict(Array.isArray(d?.data)?d.data:[], 'deezer-search'); } catch (e){}
    }
    if (!top_tracks.length){
      try {
        const al = await jsonFetch('https://api.deezer.com/artist/' + id + '/albums?limit=100', {}, 9000);
        const albums = await readJson(al);
        const all = Array.isArray(albums.data) ? albums.data : [];
        const owned = all.filter(x => isOwnedAlbum(x, artistIdStr, artistName) && !isBadAlbumTitle(x.title));
        const top10 = owned.slice(0,10);
        await Promise.allSettled(top10.map(async alb => {
          try { const rr = await jsonFetch('https://api.deezer.com/album/' + encodeURIComponent(alb.id) + '/tracks?limit=100', {}, 8000); const dd = await readJson(rr); pushStrict(Array.isArray(dd?.data)?dd.data:[], 'deezer-albums'); } catch (e){}
        }));
      } catch (e){}
    }
    if (!top_tracks.length && artistName){
      try {
        const itunesArtistId = await findItunesArtistId(artistName);
        if (itunesArtistId){
          const itunesTracks = await itunesArtistTracks(itunesArtistId, 50);
          if (itunesTracks.length){ top_tracks = itunesTracks; tracksSource = 'itunes-lookup'; }
        }
      } catch (e){}
    }

    top_tracks = top_tracks.sort((a,b) => (b.rank || b.popularity || 0) - (a.rank || a.popularity || 0)).slice(0,60);

    let owned = [];
    try {
      const al = await jsonFetch('https://api.deezer.com/artist/' + id + '/albums?limit=200', {}, 8000);
      const albums = await readJson(al);
      const all = Array.isArray(albums.data) ? albums.data : [];
      owned = all.filter(x => isOwnedAlbum(x, artistIdStr, artistName) && !isBadAlbumTitle(x.title));
    } catch (e){}

    if (!owned.length && artistName){
      try {
        const itunesArtistId = await findItunesArtistId(artistName);
        if (itunesArtistId){ owned = await itunesArtistAlbums(itunesArtistId, 100); }
      } catch (e){}
    }

    // Сортируем альбомы и синглы по дате выпуска (свежие сверху)
    const sortByDate = (arr) => arr.slice().sort((a,b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));

    const albumsAll = sortByDate(owned.filter(x => x.record_type !== 'single'));
    const singlesAll = sortByDate(owned.filter(x => x.record_type === 'single'));

    const payload = { artist, top_tracks, tracks_source: tracksSource, albums: albumsAll, singles: singlesAll };
    const isEmpty = top_tracks.length === 0 && owned.length === 0;
    artistCache.set(cacheKey, { time:Date.now(), data:payload, ttl: isEmpty ? ARTIST_EMPTY_TTL : ARTIST_TTL });
    res.json(payload);
  } catch (e){
    res.status(502).json({ error: e.message });
  }
});

// ============================================================
// ALBUM
// ============================================================
api.get('/api/album/:id', async (req, res) => {
  try {
    const rawId = String(req.params.id);
    if (rawId.startsWith('itunes_album_')){
      const collectionId = rawId.replace('itunes_album_','');
      const r = await jsonFetch('https://itunes.apple.com/lookup?id=' + encodeURIComponent(collectionId) + '&entity=song&limit=200', {}, 9000);
      const d = await readJson(r);
      const items = Array.isArray(d?.results) ? d.results : [];
      const albumMeta = items.find(x => x.wrapperType === 'collection') || {};
      const tracks = items.filter(x => x.wrapperType === 'track')
        .sort((a,b) => (a.trackNumber||0) - (b.trackNumber||0))
        .map(tr => ({
          id:'itunes_'+String(tr.trackId||''), title:tr.trackName||'Untitled', title_short:tr.trackName||'Untitled',
          duration:Number(tr.trackTimeMillis||0)/1000, rank:0, preview:'',
          artist:{ id:'', name:tr.artistName||'' },
          album:{ id:rawId, title:tr.collectionName||'', cover_medium:(tr.artworkUrl100||'').replace('100x100','500x500') },
          provider:'itunes', explicit: tr.trackExplicitness === 'explicit'
        }));
      return res.json({
        id:rawId, title: albumMeta.collectionName||'',
        cover_medium:(albumMeta.artworkUrl100||'').replace('100x100','500x500'),
        cover_big:(albumMeta.artworkUrl100||'').replace('100x100','1000x1000'),
        cover_xl:(albumMeta.artworkUrl100||'').replace('100x100','1000x1000'),
        artist:{ id:'', name: albumMeta.artistName||'' },
        release_date: albumMeta.releaseDate || '',
        nb_tracks: tracks.length,
        tracks:{ data: tracks },
        provider:'itunes'
      });
    }
    const r = await jsonFetch('https://api.deezer.com/album/' + encodeURIComponent(rawId), {}, 7000);
    const d = await readJson(r);
    if (!d?.id) return res.status(404).json({ error:'not found' });
    res.json(d);
  } catch (e){ res.status(502).json({ error: e.message }); }
});

// ============================================================
// LYRICS
// ============================================================
api.get('/api/lyrics', async (req, res) => {
  const track = String(req.query.track_name || '').trim();
  const artist = String(req.query.artist_name || '').trim();
  const album = String(req.query.album_name || '').trim();
  const dur = Number(req.query.duration || 0);
  const fbTitle = String(req.query.fb_title || '').trim();
  const fbArtist = String(req.query.fb_artist || '').trim();
  if (!track && !artist && !fbTitle && !fbArtist) return res.status(400).json({ found:false });
  const cacheKey = 'lyr:' + normalizeSearchText(track+'|'+artist+'|'+fbTitle+'|'+fbArtist) + '|' + Math.round(dur);
  const cached = lyricsCache.get(cacheKey);
  if (cached && Date.now() - cached.time < LYRICS_TTL) return res.json(cached.data);
  const send = (payload) => { lyricsCache.set(cacheKey, { time:Date.now(), data:payload }); res.json(payload); };
  const clean = (s) => String(s||'').replace(/\([^)]*\)/g,'').replace(/\[[^\]]*\]/g,'').replace(/#\S+/g,' ').replace(/\b(official|audio|video|lyric|lyrics|visualizer|hd|hq|explicit|video\s*clip|mv|m\/v)\b/gi,'').replace(/\s+/g,' ').trim();
  const pairs = [];
  if (track || artist) pairs.push({ t: clean(track), a: clean(artist), from:'catalog' });
  if (fbTitle || fbArtist) pairs.push({ t: clean(fbTitle), a: clean(fbArtist), from:'youtube' });
  if (fbArtist){ const fbClean = clean(fbArtist).replace(/\s*-\s*topic$/i,'').trim(); if (fbClean && fbClean !== clean(fbArtist)) pairs.push({ t: clean(fbTitle), a: fbClean, from:'youtube-topic' }); }

  for (const p of pairs){
    if (!p.t && !p.a) continue;
    try {
      const params = new URLSearchParams({ track_name: p.t || '' });
      if (p.a) params.set('artist_name', p.a);
      if (album && p.from === 'catalog') params.set('album_name', album);
      if (dur > 0 && p.from === 'catalog') params.set('duration', String(Math.round(dur)));
      const r = await jsonFetch('https://lrclib.net/api/get?' + params.toString(), { headers:{ 'User-Agent':'NOVA/4.0' } }, 10000);
      if (r.ok){
        const d = await readJson(r);
        if (d.plainLyrics || d.syncedLyrics) return send({ found:true, plainLyrics:d.plainLyrics||'', syncedLyrics:d.syncedLyrics||'', source:'LRCLIB', matched:p.from, synced: !!d.syncedLyrics });
      }
    } catch (e){}
    try {
      const q = [p.t, p.a].filter(Boolean).join(' ');
      const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q }).toString(), { headers:{ 'User-Agent':'NOVA/4.0' } }, 10000);
      if (r.ok){
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length){
          const normArt = normalizeSearchText(p.a);
          const synced = arr.filter(x => x.syncedLyrics);
          const pool = synced.length ? synced : arr;
          let best = pool[0];
          if (normArt){ for (const item of pool){ if (normalizeSearchText(item.artistName||'') === normArt){ best = item; break; } } }
          if (best.plainLyrics || best.syncedLyrics) return send({ found:true, plainLyrics:best.plainLyrics||'', syncedLyrics:best.syncedLyrics||'', source:'LRCLIB', matched:p.from, synced: !!best.syncedLyrics });
        }
      }
    } catch (e){}
    if (p.t){
      try {
        const r = await jsonFetch('https://lrclib.net/api/search?' + new URLSearchParams({ q: p.t }).toString(), { headers:{ 'User-Agent':'NOVA/4.0' } }, 10000);
        if (r.ok){
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length){
            const synced = arr.filter(x => x.syncedLyrics);
            const best = (synced[0] || arr[0]);
            if (best.plainLyrics || best.syncedLyrics) return send({ found:true, plainLyrics:best.plainLyrics||'', syncedLyrics:best.syncedLyrics||'', source:'LRCLIB', matched:p.from+'-title-only', synced: !!best.syncedLyrics });
          }
        }
      } catch (e){}
    }
  }
  send({ found:false });
});

// ============================================================
// MATCHING
// ============================================================
function titleSimilarity(wantTitle, gotTitle){
  const w = normalizeSearchText(wantTitle), g = normalizeSearchText(gotTitle);
  if (!w) return 1; if (!g) return 0;
  const noise = /\b(feat|ft|featuring|prod|official|audio|video|lyrics|remix|version|edit|extended|original)\b/g;
  const wClean = w.replace(noise,' ').replace(/\s+/g,' ').trim();
  const gClean = g.replace(noise,' ').replace(/\s+/g,' ').trim();
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
function checkMatch(candidate, wantTitle, wantArtist, wantDuration, { strict = true } = {}){
  const aSim = artistSimilarity(wantArtist, candidate.artist);
  const tSim = titleSimilarity(wantTitle, candidate.title);
  const wantArtistStr = String(wantArtist || '').trim();
  if (tSim < 0.6) return 0;
  if (candidate.provider === 'youtube'){
    if (isBadYoutubeTitle(candidate.title)) return 0;
    const dur = Number(candidate.duration || 0);
    if (dur > 0){
      if (dur > 600) return 0;
      if (wantDuration > 30){ const ratio = dur / wantDuration; if (ratio < 0.5 || ratio > 1.8) return 0; }
      else if (dur < 30) return 0;
    }
    if (strict){
      if (wantArtistStr){
        const ch = String(candidate.channel||'').toLowerCase();
        const ti = String(candidate.title||'').toLowerCase();
        const ar = wantArtistStr.toLowerCase();
        const artistInChannel = ch.includes(ar) || ar.includes(ch.split(' - ')[0]);
        const artistInTitle = ti.includes(ar);
        if (aSim < 0.4 && !artistInChannel && !artistInTitle) return 0;
      }
      if (tSim < 0.65) return 0;
    }
    return (wantArtistStr ? aSim*0.4 : 0.4) + tSim*0.6;
  }
  if (candidate.provider === 'audius'){
    if (!wantArtistStr) return 0;
    if (aSim < 0.65) return 0;
    if (tSim < 0.75) return 0;
    const dur = Number(candidate.duration || 0);
    if (dur > 0 && wantDuration > 30){ const ratio = dur / wantDuration; if (ratio < 0.55 || ratio > 1.7) return 0; }
    return aSim*0.5 + tSim*0.5;
  }
  return aSim*0.4 + tSim*0.6;
}

async function findPlayableAudio({ title, artist, duration, full }){
  const cleanTitle = cleanTitleForSearch(title);
  const cleanArtist = cleanTitleForSearch(artist);
  const wantTitle = cleanTitle || String(title || '').trim();
  const wantArtist = cleanArtist || String(artist || '').trim();
  const wantDuration = Number(duration || 0);
  const fullQuery = String(full || '').trim();
  const artistParts = splitArtists(wantArtist);
  const primaryArtist = artistParts[0] || wantArtist;
  const queries = [];
  if (wantTitle && primaryArtist){
    const tl = wantTitle.toLowerCase(), al = primaryArtist.toLowerCase();
    if (tl.includes(al)) queries.push(wantTitle); else queries.push(wantTitle + ' ' + primaryArtist);
  }
  if (wantTitle) queries.push(wantTitle);
  if (wantTitle && artistParts.length > 1) queries.push(wantTitle + ' ' + artistParts.slice(0,2).join(' '));
  if (fullQuery) queries.push(fullQuery);
  const uniqueQueries = [...new Set(queries.map(q => q.trim()).filter(Boolean))];

  for (const strict of [true, false]){
    for (const q of uniqueQueries){
      try {
        const meta = await searchYouTube(q);
        const list = meta.results || [];
        if (!list.length) continue;
        const scored = list.map(c => ({ c, s: checkMatch(c, wantTitle, primaryArtist, wantDuration, { strict }) + scoreProviderTrack(c, q) * 0.00001 })).filter(x => x.s > 0).sort((a,b) => b.s - a.s);
        if (scored.length){
          const best = scored[0].c;
          const vid = String(best.id).replace('yt_','');
          if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) continue;
          return { provider:'youtube', streamUrl:'/api/audio/youtube/' + encodeURIComponent(vid), videoId:vid, title:best.title, artist:best.channel, videoTitle:best.title, videoChannel:best.channel, duration:best.duration };
        }
      } catch (e){}
    }
  }

  if (primaryArtist){
    for (const q of uniqueQueries){
      try {
        const r = await searchAudius(q);
        const list = (r.results || []).filter(x => x.source === 'FULL' && x.id);
        if (!list.length) continue;
        const scored = list.map(c => ({ c, s: checkMatch(c, wantTitle, primaryArtist, wantDuration, { strict:true }) })).filter(x => x.s > 0).sort((a,b) => b.s - a.s);
        if (scored.length){
          const best = scored[0].c;
          return { provider:'audius', streamUrl:'/api/audio/audius/' + encodeURIComponent(best.id), title:best.title, artist:best.artist, videoTitle:best.title, videoChannel:best.artist, duration:best.duration };
        }
      } catch (e){}
    }
  }
  throw new Error('no matching track');
}

// ============================================================
// STATIC + START
// ============================================================
api.use(express.static(WEB_DIR, { extensions:['html'], maxAge: IS_PROD ? '1h' : 0 }));
api.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});
api.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok:false, error: err.message || 'internal' });
});
function startServer(options = {}){
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  return new Promise((resolve, reject) => {
    const server = api.listen(port, host, () => {
      console.log('============================================================');
      console.log('[NOVA] listening on http://' + host + ':' + port);
      console.log('[NOVA] DB at ' + DB_PATH);
      console.log('[NOVA] users: ' + Object.keys(db.users).length);
      if (IS_PROD && !process.env.DATA_DIR) console.warn('[NOVA] WARNING: DATA_DIR not set — DB reset on restart!');
      console.log('============================================================');
      resolve(server);
    });
    server.once('error', reject);
  });
}
if (require.main === module){ startServer().catch(e => { console.error('[fatal]', e); process.exit(1); }); }
module.exports = { api, startServer };
