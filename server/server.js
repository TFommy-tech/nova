const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();
const path = require('path');

const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, '..', 'web');

let ytModule = null;
let yt = null;
let ytReady = false;
let ytInitPromise = null;
const ytStreamCache = new Map();
const searchCache = new Map();
const YT_STREAM_TTL = 4 * 60 * 1000;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || '';

const api = express();
api.disable('x-powered-by');
api.use(cors());
api.use(express.json({ limit: '1mb' }));

// ============================================================
// NOISE TRACK FILTER
// ============================================================
function isNoiseTrack(item) {
  if (!item) return true;
  const title = String(item.title || '').toLowerCase();
  const artist = String(item.artist || '').toLowerCase();

  const noiseWords = [
    'instrumental', 'karaoke', 'cover version', 'tribute',
    'made famous by', 'originally performed', 'in the style of',
    'backing track', 'ringtone', 'slowed', 'nightcore', '8d audio',
    'sped up', 'spedup', 'reverb', 'mashup'
  ];
  for (const word of noiseWords) {
    if (title.includes(word) && !artist) return true;
  }

  if (!title || title === 'untitled') return true;
  return false;
}

// ============================================================
// DISCORD AUTH
// ============================================================
api.get('/api/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email'
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

api.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code not received');

  try {
    const tokenParams = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: tokenParams,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return res.status(400).send('Discord token error');

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const userData = await userResponse.json();

    res.redirect(
      '/?login=success&id=' + encodeURIComponent(userData.id) +
      '&username=' + encodeURIComponent(userData.username) +
      '&avatar=' + encodeURIComponent(userData.avatar || '')
    );
  } catch (error) {
    console.error('[Discord Auth]', error.message);
    res.status(500).send('Authorization error');
  }
});

// ============================================================
// HELPERS
// ============================================================
function jsonFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'NOVA/2.0',
    ...(options.headers || {})
  };

  return fetch(url, { ...options, headers, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (error) { throw new Error('Invalid JSON response'); }
}

function firstImage(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj['1000x1000']) return obj['1000x1000'];
  if (obj['480x480']) return obj['480x480'];
  if (obj['600x600']) return obj['600x600'];
  if (obj['3000x3000']) return obj['3000x3000'];
  if (obj['640x640']) return obj['640x640'];
  if (obj['320x320']) return obj['320x320'];
  if (obj['150x150']) return obj['150x150'];
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
  }
  return '';
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ============================================================
// SPOTIFY
// ============================================================
let spotifyTokenCache = { accessToken: '', expiresAt: 0 };

async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return '';
  if (spotifyTokenCache.accessToken && Date.now() < spotifyTokenCache.expiresAt - 30_000) {
    return spotifyTokenCache.accessToken;
  }

  const credentials = Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');

  const response = await jsonFetch(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    },
    10000
  );

  const data = await readJson(response);
  if (!data.access_token) throw new Error('Spotify token was not returned');

  spotifyTokenCache.accessToken = data.access_token;
  spotifyTokenCache.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return spotifyTokenCache.accessToken;
}

async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken();
    if (!token) return { results: [], count: 0 };

    const url = 'https://api.spotify.com/v1/search?' + new URLSearchParams({
      q: query, type: 'track', limit: '30', market: 'US'
    }).toString();

    const response = await jsonFetch(url, { headers: { Authorization: 'Bearer ' + token } }, 8000);
    const data = await readJson(response);
    const items = data?.tracks?.items || [];

    const results = items.map(track => ({
      id: track.id,
      title: track.name,
      artist: track.artists?.[0]?.name || '',
      artistId: track.artists?.[0]?.id || '',
      cover: track.album?.images?.[0]?.url || '',
      album: track.album?.name || '',
      albumId: track.album?.id || '',
      preview: track.preview_url || '',
      source: 'CATALOG',
      sourceUrl: track.external_urls?.spotify || '',
      downloadable: false,
      duration: Number(track.duration_ms || 0) / 1000,
      popularity: Number(track.popularity || 0)
    }));

    return { results, count: results.length };
  } catch (error) {
    console.error('[Spotify]', error.message);
    return { results: [], count: 0, error: error.message };
  }
}

// ============================================================
// AUDIUS
// ============================================================
async function searchAudius(query) {
  try {
    const params = new URLSearchParams({
      query,
      limit: '30',
      sort_method: 'popular'
    });
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);

    const response = await jsonFetch(
      'https://api.audius.co/v1/tracks/search?' + params.toString(),
      { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} },
      8000
    );

    const data = await readJson(response);
    const items = Array.isArray(data?.data) ? data.data : [];

    const results = items
      .filter(track => {
        const dur = Number(track.duration || 0);
        if (dur > 0 && dur < 60) return false;   // отсеиваем превью
        if (track.is_unlisted) return false;      // только релизнутое
        return true;
      })
      .map(track => {
        const trackId = track.id || '';
        return {
          id: trackId,
          title: track.title || 'Untitled',
          artist: track.user?.name || 'Unknown Artist',
          artistId: track.user?.id || '',
          cover: firstImage(track.artwork),
          preview: '/api/audio/audius/' + encodeURIComponent(trackId),
          source: 'FULL',
          sourceUrl: track.permalink ? 'https://audius.co' + track.permalink : '',
          downloadable: Boolean(track.downloadable),
          downloadUrl: track.downloadable ? '/api/download/audius/' + encodeURIComponent(trackId) : '',
          duration: Number(track.duration || 0),
          bitrate: Number(track.bitrate || 0),
          popularity: Number(track.play_count || 0) + Number(track.favorite_count || 0) * 5,
          releaseDate: track.release_date || track.created_at || ''
        };
      });

    return { results, count: results.length };
  } catch (error) {
    console.error('[Audius]', error.message);
    return { results: [], count: 0, error: error.message };
  }
}

// ============================================================
// MERGE + SCORE
// ============================================================
function scoreProviderTrack(item, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(item.title);
  const artist = normalizeSearchText(item.artist);
  if (!q) return 0;

  let score = 0;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const combined = title + ' ' + artist;

  if (title === q) score += 10000;
  else if (title.startsWith(q)) score += 7000;
  else if (title.includes(q)) score += 4500;

  if (artist === q) score += 8500;
  else if (artist.startsWith(q)) score += 5500;
  else if (artist.includes(q)) score += 3000;

  let hits = 0;
  for (const token of qTokens) {
    if (title.split(/\s+/).includes(token)) hits += 3;
    else if (artist.split(/\s+/).includes(token)) hits += 2;
    else if (combined.includes(token)) hits += 1;
  }
  score += hits * 500;

  // Популярность сильно влияет на порядок
  const pop = Number(item.popularity || 0);
  score += Math.min(pop, 200000) * 0.1;

  if (item.source === 'FULL') score += 200;
  return score;
}

function mergeProviderResults(providerResults, query) {
  const output = [];
  const seen = new Set();

  for (const provider of providerResults) {
    for (const item of provider.results || []) {
      const key = normalizeSearchText(item.artist) + '|' + normalizeSearchText(item.title);
      if (isNoiseTrack(item)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ ...item, _score: scoreProviderTrack(item, query) });
    }
  }

  output.sort((a, b) => b._score - a._score);
  return output.slice(0, 60).map(({ _score, ...item }) => item);
}

// ============================================================
// ROUTES
// ============================================================
api.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'NOVA', version: '2.1.0' });
});

api.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ results: [], counts: {} });

  const cacheKey = 'search:' + normalizeSearchText(query);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 120000) return res.json(cached.data);

  const wrap = (fn, ms) => Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);

  const settled = await Promise.allSettled([
    wrap(() => searchAudius(query), 4500),
    wrap(() => searchSpotify(query), 4500)
  ]);

  let results = mergeProviderResults(
    settled.map(x => x.status === 'fulfilled' ? x.value : { results: [], count: 0 }),
    query
  );

  // Убираем превью, если полноценных треков достаточно
  const fullOnly = results.filter(t => t.source === 'FULL');
  if (fullOnly.length >= 5) results = fullOnly;

  const payload = {
    results,
    counts: {
      audius: settled[0].status === 'fulfilled' ? settled[0].value.count : 0,
      spotify: settled[1].status === 'fulfilled' ? settled[1].value.count : 0
    }
  };

  searchCache.set(cacheKey, { time: Date.now(), data: payload });
  res.json(payload);
});

api.get('/api/audio/resolve', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'empty query' });
  try {
    const r = await findPlayableAudio(q);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[audio] resolve:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

api.get('/api/audio/youtube/:videoId', async (req, res) => {
  const videoId = String(req.params.videoId || '');
  try {
    const direct = await getYtStreamUrl(videoId);
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(direct, { headers, redirect: 'follow' });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).end();

    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader({
        'content-type': 'Content-Type',
        'content-length': 'Content-Length',
        'content-range': 'Content-Range',
        'accept-ranges': 'Accept-Ranges'
      }[h], v);
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);

    if (upstream.body?.pipe) upstream.body.pipe(res);
    else res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    console.error('[stream] youtube:', e.message);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  }
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
    const allAlbums = Array.isArray(albums.data) ? albums.data : [];

    res.json({
      artist,
      top_tracks: top.data || [],
      albums: allAlbums.filter(x => x.record_type !== 'single'),
      singles: allAlbums.filter(x => x.record_type === 'single')
    });
  } catch (e) {
    console.error('[Artist API]', e.message);
    res.status(502).json({ error: e.message });
  }
});

api.get('/api/album/:id', async (req, res) => {
  try {
    const r = await jsonFetch('https://api.deezer.com/album/' + encodeURIComponent(req.params.id), {}, 7000);
    const d = await readJson(r);
    if (!d?.id) return res.status(404).json({ error: 'album not found' });
    res.json(d);
  } catch (e) {
    console.error('[Album API]', e.message);
    res.status(502).json({ error: e.message });
  }
});

api.get('/api/lyrics', async (req, res) => {
  const trackName = String(req.query.track_name || '').trim();
  const artistName = String(req.query.artist_name || '').trim();
  const albumName = String(req.query.album_name || '').trim();
  const duration = Number(req.query.duration || 0);

  if (!trackName || !artistName) {
    return res.status(400).json({ found: false, message: 'Missing track/artist' });
  }

  try {
    const params = new URLSearchParams({ track_name: trackName, artist_name: artistName });
    if (albumName) params.set('album_name', albumName);
    if (duration > 0) params.set('duration', String(Math.round(duration)));

    const exactResponse = await jsonFetch(
      'https://lrclib.net/api/get?' + params.toString(),
      { headers: { 'User-Agent': 'NOVA/2.0' } },
      10000
    );

    if (exactResponse.ok) {
      const exact = await readJson(exactResponse);
      if (exact?.plainLyrics || exact?.syncedLyrics) {
        return res.json({
          found: true,
          plainLyrics: exact.plainLyrics || '',
          syncedLyrics: exact.syncedLyrics || '',
          source: 'LRCLIB'
        });
      }
    }

    const searchParams = new URLSearchParams({ track_name: trackName, artist_name: artistName });
    const searchResponse = await jsonFetch(
      'https://lrclib.net/api/search?' + searchParams.toString(),
      { headers: { 'User-Agent': 'NOVA/2.0' } },
      10000
    );

    if (searchResponse.ok) {
      const items = await readJson(searchResponse);
      if (Array.isArray(items) && items.length) {
        const normalizedArtist = normalizeSearchText(artistName);
        const normalizedTitle = normalizeSearchText(trackName);
        const best = items
          .map(item => ({
            item,
            score:
              (normalizeSearchText(item.trackName) === normalizedTitle ? 1000 : 0) +
              (normalizeSearchText(item.artistName) === normalizedArtist ? 900 : 0) +
              (item.syncedLyrics ? 30 : 0)
          }))
          .sort((a, b) => b.score - a.score)[0]?.item;

        if (best?.plainLyrics || best?.syncedLyrics) {
          return res.json({
            found: true,
            plainLyrics: best.plainLyrics || '',
            syncedLyrics: best.syncedLyrics || '',
            source: 'LRCLIB'
          });
        }
      }
    }

    return res.status(404).json({ found: false, message: 'Lyrics not found' });
  } catch (error) {
    console.error('[Lyrics]', error.message);
    return res.status(502).json({ found: false, message: 'Lyrics service unavailable' });
  }
});

// ============================================================
// YOUTUBE RESOLVER
// ============================================================
async function initYT() {
  if (ytInitPromise) return ytInitPromise;
  ytInitPromise = (async () => {
    try {
      ytModule = await import('youtubei.js');
      const { Innertube } = ytModule;
      yt = await Innertube.create({
        lang: 'en', location: 'US',
        retrieve_player: true,
        generate_session_locally: true
      });
      ytReady = true;
      console.log('[audio] youtubei.js ready');
    } catch (e) {
      ytReady = false;
      console.error('[audio] youtubei.js error:', e.message);
    }
  })();
  return ytInitPromise;
}

function ytText(v) { return typeof v === 'string' ? v : String(v?.text || ''); }

function scoreYt(v, q) {
  const t = ytText(v.title).toLowerCase();
  const c = ytText(v.author).toLowerCase();
  const qq = normalizeSearchText(q);
  let s = 0;
  for (const w of qq.split(/\s+/).filter(Boolean)) {
    if (t.includes(w)) s += 18;
    if (c.includes(w)) s += 12;
  }
  if (/(topic|vevo|official)/i.test(c)) s += 50;
  if (/\b(cover|remix|live|reaction|instrumental|karaoke|8d|sped up|slowed|nightcore|tribute|parody|mix|compilation)\b/i.test(t)) s -= 100;
  const dur = Number(v.duration?.seconds || 0);
  if (dur >= 120 && dur <= 420) s += 25;
  else if (dur > 0 && (dur < 45 || dur > 1200)) s -= 80;
  return s;
}

async function searchYouTubeAudio(q) {
  if (!ytReady) await initYT();
  if (!ytReady) return [];

  const key = 'yt:' + normalizeSearchText(q);
  try {
    const cached = ytStreamCache.get(key);
    if (cached && Date.now() - cached.time < YT_STREAM_TTL) return cached.items;

    const search = await yt.search(q, { type: 'video' });
    const videos = (search.videos || [])
      .filter(v => v && v.video_id)
      .slice(0, 15)
      .map(v => ({ v, score: scoreYt(v, q) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .map(x => ({
        videoId: x.v.video_id,
        title: ytText(x.v.title),
        duration: Number(x.v.duration?.seconds || 0),
        url: 'https://www.youtube.com/watch?v=' + x.v.video_id
      }));

    ytStreamCache.set(key, { time: Date.now(), items: videos });
    return videos;
  } catch (e) {
    console.error('[audio] YouTube search:', e.message);
    return [];
  }
}

async function getYtStreamUrl(videoId) {
  if (!ytReady) await initYT();
  if (!ytReady) throw new Error('youtubei.js not ready');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('invalid YouTube videoId');

  const cacheKey = 'stream:' + videoId;
  const cached = ytStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 2 * 60 * 1000) return cached.url;

  const info = await yt.getBasicInfo(videoId);
  const format = info.chooseFormat({ type: 'audio', quality: 'best' });
  if (!format) throw new Error('no audio format');

  const url = await format.decipher(yt.session.player);
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('invalid stream URL');

  ytStreamCache.set(cacheKey, { time: Date.now(), url });
  return url;
}

async function findPlayableAudio(query) {
  const aq = normalizeSearchText(query);
  if (!aq) throw new Error('empty audio query');

  const audiusPromise = Promise.race([
    searchAudius(aq),
    new Promise((_, r) => setTimeout(() => r(new Error('Audius timeout')), 3500))
  ]);
  const youtubePromise = searchYouTubeAudio(aq);

  const [ar, yr] = await Promise.allSettled([audiusPromise, youtubePromise]);

  if (ar.status === 'fulfilled') {
    const best = (ar.value.results || [])
      .filter(x => x.source === 'FULL' && !isNoiseTrack(x))
      .sort((x, y) => scoreProviderTrack(y, aq) - scoreProviderTrack(x, aq))[0];

    if (best?.id) {
      const combined = normalizeSearchText((best.title || '') + ' ' + (best.artist || ''));
      const good = aq.split(/\s+/).filter(Boolean).filter(w => combined.includes(w)).length
        >= Math.max(1, Math.ceil(aq.split(/\s+/).length * 0.7));
      if (good) {
        return {
          provider: 'audius',
          streamUrl: '/api/audio/audius/' + encodeURIComponent(best.id),
          title: best.title, artist: best.artist
        };
      }
    }
  }

  const ys = yr.status === 'fulfilled' ? yr.value : [];
  if (!ys.length) throw new Error('no playable candidates');

  for (const c of ys) {
    try {
      await getYtStreamUrl(c.videoId);
      return {
        provider: 'youtube',
        streamUrl: '/api/audio/youtube/' + encodeURIComponent(c.videoId),
        videoId: c.videoId, title: c.title, duration: c.duration
      };
    } catch (e) { /* next */ }
  }
  throw new Error('no playable YouTube candidate');
}

api.get('/api/audio/audius/:id', async (req, res) => {
  const trackId = req.params.id;
  if (!trackId) return res.status(400).send('Missing track id');

  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);

    const url = 'https://api.audius.co/v1/tracks/' + encodeURIComponent(trackId) + '/stream' +
      (params.toString() ? '?' + params.toString() : '');

    const headers = {};
    if (AUDIUS_API_KEY) headers['X-API-Key'] = AUDIUS_API_KEY;
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await jsonFetch(url, { headers, redirect: 'follow' }, 30000);
    if (!upstream.ok || !upstream.body) return res.status(upstream.status || 502).send('Audius stream unavailable');

    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader({
        'content-type': 'Content-Type',
        'content-length': 'Content-Length',
        'accept-ranges': 'Accept-Ranges',
        'content-range': 'Content-Range'
      }[h], v);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (error) {
    console.error('[Audius stream]', error.message);
    if (!res.headersSent) res.status(502).send('Audius stream unavailable');
    else res.end();
  }
});

api.get('/api/download/audius/:id', async (req, res) => {
  try {
    const trackId = req.params.id;
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);

    const trackResponse = await jsonFetch(
      'https://api.audius.co/v1/tracks/' + encodeURIComponent(trackId) + '?' + params.toString(),
      { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} },
      10000
    );
    const trackData = await readJson(trackResponse);
    const track = trackData?.data;
    if (!track?.downloadable) return res.status(403).send('Track is not downloadable');

    const streamResponse = await jsonFetch(
      'https://api.audius.co/v1/tracks/' + encodeURIComponent(trackId) + '/stream' +
        (AUDIUS_API_KEY ? '?api_key=' + encodeURIComponent(AUDIUS_API_KEY) : ''),
      { headers: AUDIUS_API_KEY ? { 'X-API-Key': AUDIUS_API_KEY } : {} },
      30000
    );
    if (!streamResponse.ok || !streamResponse.body) return res.status(502).send('Audio unavailable');

    const filename = String(track.user?.name || 'NOVA').replace(/[<>:"/\\|?*]+/g, '_') + ' - ' +
      String(track.title || 'track').replace(/[<>:"/\\|?*]+/g, '_') + '.mp3';

    res.setHeader('Content-Disposition', 'attachment; filename="' + filename.slice(0, 180) + '"');
    res.setHeader('Content-Type', 'audio/mpeg');
    streamResponse.body.pipe(res);
  } catch (error) {
    console.error('[Audius download]', error.message);
    if (!res.headersSent) res.status(502).send('Download unavailable');
  }
});

// ============================================================
// STATIC
// ============================================================
api.use(express.static(WEB_DIR, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

api.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

api.use((err, req, res, next) => {
  console.error('[NOVA server]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

function startServer(options = {}) {
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  return new Promise((resolve, reject) => {
    const server = api.listen(port, host, () => {
      console.log('[NOVA] server listening on http://' + host + ':' + port);
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[NOVA] failed to start:', error);
    process.exit(1);
  });
}

module.exports = { api, startServer };
