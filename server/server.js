const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();
const path = require('path');

const PORT = Number(process.env.PORT || 3123);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.join(__dirname, '..', 'web');

// YouTube audio resolver (loaded lazily).
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

  if (!code) {
    return res.status(400).send('Authorization code not received');
  }

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

    if (!tokenData.access_token) {
      return res.status(400).send('Discord token acquisition error');
    }

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });

    const userData = await userResponse.json();

    res.redirect('/?login=success&username=' + encodeURIComponent(userData.username) + '&avatar=' + encodeURIComponent(userData.avatar || ''));
  } catch (error) {
    console.error('[Discord Auth]', error.message);
    res.status(500).send('Authorization error');
  }
});
// ============================================================

function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'NOVA/1.0 (Electron)',
    ...(options.headers || {})
  };

  return fetch(url, {
    ...options,
    headers,
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

async function readJson(response) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''));
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Invalid JSON response');
  }
}

function normalizeSourceText(value) {
  return String(value || '').toUpperCase();
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

  const keys = Object.keys(obj);

  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key].startsWith('http')) {
      return obj[key];
    }
  }

  return '';
}

let spotifyTokenCache = {
  accessToken: '',
  expiresAt: 0
};

async function getSpotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return '';
  }

  if (
    spotifyTokenCache.accessToken &&
    Date.now() < spotifyTokenCache.expiresAt - 30_000
  ) {
    return spotifyTokenCache.accessToken;
  }

  const credentials = Buffer
    .from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET)
    .toString('base64');

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
    15000
  );

  const data = await readJson(response);

  if (!data.access_token) {
    throw new Error('Spotify token was not returned');
  }

  spotifyTokenCache.accessToken = data.access_token;
  spotifyTokenCache.expiresAt =
    Date.now() +
    Number(data.expires_in || 3600) * 1000;

  return spotifyTokenCache.accessToken;
}

async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken();

    if (!token) {
      return {
        results: [],
        count: 0,
        error: 'Spotify credentials are not configured'
      };
    }

    const url =
      'https://api.spotify.com/v1/search?' +
      new URLSearchParams({
        q: query,
        type: 'track',
        limit: '30',
        market: 'US'
      }).toString();

    const response = await jsonFetch(
      url,
      {
        headers: {
          Authorization: 'Bearer ' + token
        }
      },
      15000
    );

    const data = await readJson(response);

    const items =
      data &&
      data.tracks &&
      Array.isArray(data.tracks.items)
        ? data.tracks.items
        : [];

    const results = items.map(track => ({
      id: track.id,
      title: track.name,
      artist:
        Array.isArray(track.artists) && track.artists[0]
          ? track.artists[0].name
          : '',
      artistId:
        Array.isArray(track.artists) && track.artists[0]
          ? track.artists[0].id || ''
          : '',
      cover:
        track.album &&
        Array.isArray(track.album.images) &&
        track.album.images.length
          ? track.album.images[0].url
          : '',
      album: track.album?.name || '',
      albumId: track.album?.id || '',
      preview: track.preview_url || '',
      source: 'CATALOG',
      sourceUrl: track.external_urls?.spotify || '',
      downloadable: false,
      duration: Number(track.duration_ms || 0) / 1000
    }));

    return {
      results,
      count: results.length
    };
  } catch (error) {
    console.error('[Spotify]', error.message);

    return {
      results: [],
      count: 0,
      error: error.message
    };
  }
}

async function searchAudius(query) {
  try {
    const params = new URLSearchParams({
      query,
      limit: '30',
      sort_method: 'relevant'
    });

    if (AUDIUS_API_KEY) {
      params.set('api_key', AUDIUS_API_KEY);
    }

    const response = await jsonFetch(
      'https://api.audius.co/v1/tracks/search?' + params.toString(),
      {
        headers: AUDIUS_API_KEY
          ? { 'X-API-Key': AUDIUS_API_KEY }
          : {}
      },
      15000
    );

    const data = await readJson(response);

    const items =
      data && Array.isArray(data.data)
        ? data.data
        : [];

    const results = items.map(track => {
      const trackId = track.id || '';

      const streamUrl = '/api/audio/audius/' + encodeURIComponent(trackId);

      return {
        id: trackId,
        title: track.title || 'Untitled',
        artist:
          track.user && track.user.name
            ? track.user.name
            : 'Unknown Artist',
        cover: firstImage(track.artwork),
        preview: streamUrl,
        source: 'FULL',
        sourceUrl: track.permalink
          ? 'https://audius.co' + track.permalink
          : '',
        downloadable: Boolean(track.downloadable),
        downloadUrl: track.downloadable ? '/api/download/audius/' + encodeURIComponent(trackId) : '',
        duration: Number(track.duration || 0),
        bitrate: Number(track.bitrate || 0)
      };
    });

    return {
      results,
      count: results.length
    };
  } catch (error) {
    console.error('[Audius]', error.message);

    return {
      results: [],
      count: 0,
      error: error.message
    };
  }
}

async function searchDeezer(query) {
  try {
    const url =
      'https://api.deezer.com/search?' +
      new URLSearchParams({
        q: query,
        limit: '20'
      }).toString();

    const response = await jsonFetch(
      url,
      {},
      15000
    );

    const data = await readJson(response);

    const items =
      data && Array.isArray(data.data)
        ? data.data
        : [];

    const results = items.map(track => ({
      id: String(track.id || ''),
      title: track.title || 'Untitled',
      artist:
        track.artist && track.artist.name
          ? track.artist.name
          : '',
      artistId: String(track.artist?.id || ''),
      cover:
        track.album && track.album.cover_xl
          ? track.album.cover_xl
          : (
            track.album && track.album.cover_big
              ? track.album.cover_big
              : ''
          ),
      album: track.album?.title || '',
      albumId: String(track.album?.id || ''),
      preview: track.preview || '',
      source: 'PREVIEW',
      sourceUrl: track.link || '',
      downloadable: false,
      duration: Number(track.duration || 0)
    }));

    return {
      results,
      count: results.length
    };
  } catch (error) {
    console.error('[Deezer]', error.message);

    return {
      results: [],
      count: 0,
      error: error.message
    };
  }
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

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

  // Prefer playable results only after relevance has been established.
  if (item.source === 'FULL') score += 100;
  else if (item.source === 'PREVIEW') score += 50;

  return score;
}

function mergeProviderResults(providerResults, query) {
  const output = [];
  const seen = new Set();

  for (const provider of providerResults) {
    for (const item of provider.results || []) {
      const key = [
        normalizeSearchText(item.artist),
        normalizeSearchText(item.title)
      ].join('|');

      if(isNoiseTrack(item)) continue;
      if (seen.has(key)) continue;
      seen.add(key);

      output.push({
        ...item,
        _novaScore: scoreProviderTrack(item, query)
      });
    }
  }

  const sourceRank = { FULL: 0, PREVIEW: 1, CATALOG: 2 };

  output.sort((a, b) => {
    if (b._novaScore !== a._novaScore) {
      return b._novaScore - a._novaScore;
    }

    const sourceDiff =
      (sourceRank[a.source] ?? 3) -
      (sourceRank[b.source] ?? 3);

    if (sourceDiff !== 0) return sourceDiff;
    return 0;
  });

  return output
    .slice(0, 60)
    .map(({ _novaScore, ...item }) => item);
}

api.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'NOVA',
    version: '2.1.0'
  });
});

api.get('/api/search', async (req, res) => {
  const query =
    String(req.query.q || '').trim();

  if (!query) {
    return res.json({
      results: [],
      counts: {
        spotify: 0,
        audius: 0,
        deezer: 0,
        itunes: 0
      }
    });
  }

  const cacheKey='search:'+normalizeSearchText(query);
  const cached=searchCache.get(cacheKey);
  if(cached&&Date.now()-cached.time<45000)return res.json(cached.data);
  const wrap=(fn)=>Promise.race([fn(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('provider timeout')),5000))]);
  const settled=await Promise.allSettled([wrap(()=>searchSpotify(query)),wrap(()=>searchAudius(query)),wrap(()=>searchDeezer(query))]);
  const results=mergeProviderResults(settled.map(x=>x.status==='fulfilled'?x.value:{results:[],count:0,error:x.reason?.message||'provider error'}),query);
  const payload={results,counts:{spotify:settled[0].status==='fulfilled'?settled[0].value.count:0,audius:settled[1].status==='fulfilled'?settled[1].value.count:0,deezer:settled[2].status==='fulfilled'?settled[2].value.count:0}};
  searchCache.set(cacheKey,{time:Date.now(),data:payload});
  res.json(payload);
});

// Lyrics are resolved on demand only. This keeps provider search fast and
// avoids making a lyrics request for every card.
api.get('/api/audio/resolve', async (req,res)=>{const q=String(req.query.q||'').trim();if(!q)return res.status(400).json({ok:false,error:'empty query'});try{const r=await findPlayableAudio(q);res.json({ok:true,...r})}catch(e){console.error('[audio] resolve:',e.message);res.status(502).json({ok:false,error:e.message})}});

api.get('/api/audio/youtube/:videoId', async (req,res)=>{const videoId=String(req.params.videoId||'');try{const direct=await getYtStreamUrl(videoId);const headers={'User-Agent':'Mozilla/5.0','Accept':'*/*'};if(req.headers.range)headers.Range=req.headers.range;const upstream=await fetch(direct,{headers,redirect:'follow'});if(!upstream.ok&&upstream.status!==206)return res.status(502).end();for(const h of ['content-type','content-length','content-range','accept-ranges']){const v=upstream.headers.get(h);if(v)res.setHeader({'content-type':'Content-Type','content-length':'Content-Length','content-range':'Content-Range','accept-ranges':'Accept-Ranges'}[h],v)}res.setHeader('Content-Type',upstream.headers.get('content-type')||'audio/webm');res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');res.status(upstream.status);if(upstream.body&&typeof upstream.body.pipe==='function')upstream.body.pipe(res);else{const buf=Buffer.from(await upstream.arrayBuffer());res.end(buf)}}catch(e){console.error('[stream] youtube:',e.message);if(!res.headersSent)res.status(502).end();else res.end()}});

api.get('/api/artist/:id',async(req,res)=>{const id=encodeURIComponent(req.params.id);try{const [a,t,al]=await Promise.all([jsonFetch('https://api.deezer.com/artist/'+id,{},7000),jsonFetch('https://api.deezer.com/artist/'+id+'/top?limit=10',{},7000),jsonFetch('https://api.deezer.com/artist/'+id+'/albums?limit=50',{},7000)]);const artist=await readJson(a),top=await readJson(t),albums=await readJson(al);const allAlbums=Array.isArray(albums.data)?albums.data:[];res.json({artist,top_tracks:top.data||[],albums:allAlbums.filter(x=>x.record_type!=='single'),singles:allAlbums.filter(x=>x.record_type==='single')})}catch(e){console.error('[Artist API]',e.message);res.status(502).json({error:e.message})}});

api.get('/api/album/:id',async(req,res)=>{try{const r=await jsonFetch('https://api.deezer.com/album/'+encodeURIComponent(req.params.id),{},7000);const d=await readJson(r);if(!d||!d.id)return res.status(404).json({error:'album not found'});res.json(d)}catch(e){console.error('[Album API]',e.message);res.status(502).json({error:e.message})}});

api.get('/api/lyrics', async (req, res) => {
  const trackName = String(req.query.track_name || '').trim();
  const artistName = String(req.query.artist_name || '').trim();
  const albumName = String(req.query.album_name || '').trim();
  const duration = Number(req.query.duration || 0);

  if (!trackName || !artistName) {
    return res.status(400).json({
      found: false,
      message: 'Missing track name or artist name'
    });
  }

  try {
    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName
    });

    if (albumName) params.set('album_name', albumName);
    if (duration > 0) params.set('duration', String(Math.round(duration)));

    const exactResponse = await jsonFetch(
      'https://lrclib.net/api/get?' + params.toString(),
      {
        headers: {
          'User-Agent': 'NOVA/1.0 (Electron)'
        }
      },
      12000
    );

    if (exactResponse.ok) {
      const exact = await readJson(exactResponse);

      if (exact && (exact.plainLyrics || exact.syncedLyrics)) {
        return res.json({
          found: true,
          plainLyrics: exact.plainLyrics || '',
          syncedLyrics: exact.syncedLyrics || '',
          source: 'LRCLIB'
        });
      }
    }

    const searchParams = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName
    });

    const searchResponse = await jsonFetch(
      'https://lrclib.net/api/search?' + searchParams.toString(),
      {
        headers: {
          'User-Agent': 'NOVA/1.0 (Electron)'
        }
      },
      12000
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

        if (best && (best.plainLyrics || best.syncedLyrics)) {
          return res.json({
            found: true,
            plainLyrics: best.plainLyrics || '',
            syncedLyrics: best.syncedLyrics || '',
            source: 'LRCLIB'
          });
        }
      }
    }

    return res.status(404).json({
      found: false,
      message: 'Lyrics not found'
    });
  } catch (error) {
    console.error('[Lyrics]', error.message);

    return res.status(502).json({
      found: false,
      message: 'Lyrics service temporarily unavailable'
    });
  }
});

// ============================================================
// YOUTUBE AUDIO RESOLVER
// ============================================================
async function initYT(){
  if(ytInitPromise)return ytInitPromise;
  ytInitPromise=(async()=>{try{ytModule=await import('youtubei.js');const {Innertube}=ytModule;yt=await Innertube.create({lang:'en',location:'US',retrieve_player:true,generate_session_locally:true});ytReady=true;console.log('[audio] youtubei.js ready')}catch(e){ytReady=false;console.error('[audio] youtubei.js error:',e.message)}})();
  return ytInitPromise;
}
function ytText(v){return typeof v==='string'?v:String(v?.text||'')}
function scoreYt(v,q){const t=ytText(v.title).toLowerCase(),c=ytText(v.author).toLowerCase(),qq=normalizeSearchText(q);let s=0;for(const w of qq.split(/\s+/).filter(Boolean)){if(t.includes(w))s+=18;if(c.includes(w))s+=12}if(/(topic|vevo|official)/i.test(c))s+=50;if(/\b(cover|remix|live|reaction|instrumental|karaoke|8d|sped up|slowed|nightcore|tribute|parody|mix|compilation)\b/i.test(t))s-=100;const dur=Number(v.duration?.seconds||0);if(dur>=120&&dur<=420)s+=25;else if(dur>0&&(dur<45||dur>1200))s-=80;return s}
async function searchYouTubeAudio(q){if(!ytReady)await initYT();if(!ytReady)return [];const key='yt:'+normalizeSearchText(q);try{const cached=ytStreamCache.get(key);if(cached&&Date.now()-cached.time<YT_STREAM_TTL)return cached.items;const search=await yt.search(q,{type:'video'});const videos=(search.videos||[]).filter(v=>v&&v.video_id).slice(0,15).map(v=>({v,score:scoreYt(v,q)})).sort((a,b)=>b.score-a.score).slice(0,7).map(x=>({videoId:x.v.video_id,title:ytText(x.v.title),duration:Number(x.v.duration?.seconds||0),url:'https://www.youtube.com/watch?v='+x.v.video_id}));ytStreamCache.set(key,{time:Date.now(),items:videos});console.log('[audio] YouTube found: '+videos.length);return videos}catch(e){console.error('[audio] YouTube search:',e.message);return []}}
async function getYtStreamUrl(videoId){if(!ytReady)await initYT();if(!ytReady)throw new Error('youtubei.js not ready');if(!/^[A-Za-z0-9_-]{6,20}$/.test(videoId))throw new Error('invalid YouTube videoId');const cacheKey='stream:'+videoId;const cached=ytStreamCache.get(cacheKey);if(cached&&Date.now()-cached.time<2*60*1000)return cached.url;const info=await yt.getBasicInfo(videoId);const format=info.chooseFormat({type:'audio',quality:'best'});if(!format)throw new Error('no audio format');const url=await format.decipher(yt.session.player);if(!url||!/^https?:\/\//i.test(url))throw new Error('invalid stream URL');ytStreamCache.set(cacheKey,{time:Date.now(),url});return url}
async function findPlayableAudio(query){
  const aq=normalizeSearchText(query);if(!aq)throw new Error('empty audio query');
  const audiusPromise=Promise.race([searchAudius(aq),new Promise((_,r)=>setTimeout(()=>r(new Error('Audius timeout')),4500))]);
  const youtubePromise=searchYouTubeAudio(aq);
  const [ar,yr]=await Promise.allSettled([audiusPromise,youtubePromise]);
  if(ar.status==='fulfilled'){
    const best=(ar.value.results||[]).filter(x=>x.source==='FULL'&&!isNoiseTrack(x)).sort((x,y)=>scoreProviderTrack(y,aq)-scoreProviderTrack(x,aq))[0];
    if(best&&best.id){const combined=normalizeSearchText((best.title||'')+' '+(best.artist||''));const good=aq.split(/\s+/).filter(Boolean).filter(w=>combined.includes(w)).length>=Math.max(1,Math.ceil(aq.split(/\s+/).length*.7));if(good)return{provider:'audius',streamUrl:'/api/audio/audius/'+encodeURIComponent(best.id),title:best.title,artist:best.artist}}
  }
  const ys=yr.status==='fulfilled'?yr.value:[];if(!ys.length)throw new Error('no playable candidates');
  for(const c of ys){try{await getYtStreamUrl(c.videoId);return{provider:'youtube',streamUrl:'/api/audio/youtube/'+encodeURIComponent(c.videoId),videoId:c.videoId,title:c.title,duration:c.duration}}catch(e){console.error('[audio] candidate '+c.videoId+': '+e.message)}}
  throw new Error('no playable YouTube candidate');
}

async function getAudiusStreamUrl(trackId) {
  const params = new URLSearchParams();

  if (AUDIUS_API_KEY) {
    params.set('api_key', AUDIUS_API_KEY);
  }

  const suffix =
    params.toString()
      ? '?' + params.toString()
      : '';

  const response = await jsonFetch(
    'https://api.audius.co/v1/tracks/' +
    encodeURIComponent(trackId) +
    '/stream' +
    suffix,
    {
      method: 'HEAD',
      headers: AUDIUS_API_KEY
        ? { 'X-API-Key': AUDIUS_API_KEY }
        : {}
    },
    15000
  );

  return response.url || '';
}

// Local redirect for Audius FULL playback.
// The actual audio remains served by Audius.
api.get('/api/audio/audius/:id', async (req, res) => {
  const trackId = req.params.id;

  if (!trackId) {
    return res.status(400).send('Missing track id');
  }

  try {
    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);

    const url =
      'https://api.audius.co/v1/tracks/' +
      encodeURIComponent(trackId) +
      '/stream' +
      (params.toString() ? '?' + params.toString() : '');

    const headers = {};
    if (AUDIUS_API_KEY) headers['X-API-Key'] = AUDIUS_API_KEY;
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await jsonFetch(
      url,
      { headers, redirect: 'follow' },
      30000
    );

    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).send('Audius stream unavailable');
    }

    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const contentRange = upstream.headers.get('content-range');

    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Cache-Control', 'no-store');

    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (error) {
    console.error('[Audius stream]', error.message);

    if (!res.headersSent) {
      res.status(502).send('Audius stream unavailable');
    } else {
      res.end();
    }
  }
});

// Download only for Audius tracks that are explicitly marked downloadable.
api.get('/api/download/audius/:id', async (req, res) => {
  try {
    const trackId = req.params.id;

    if (!trackId) {
      return res.status(400).send('Missing track id');
    }

    const params = new URLSearchParams();
    if (AUDIUS_API_KEY) params.set('api_key', AUDIUS_API_KEY);

    const trackResponse = await jsonFetch(
      'https://api.audius.co/v1/tracks/' +
      encodeURIComponent(trackId) +
      '?' +
      params.toString(),
      {
        headers: AUDIUS_API_KEY
          ? { 'X-API-Key': AUDIUS_API_KEY }
          : {}
      },
      15000
    );

    const trackData = await readJson(trackResponse);
    const track =
      trackData &&
      trackData.data
        ? trackData.data
        : null;

    if (!track || !track.downloadable) {
      return res
        .status(403)
        .send('Track is not marked downloadable');
    }

    const streamResponse = await jsonFetch(
      'https://api.audius.co/v1/tracks/' +
      encodeURIComponent(trackId) +
      '/stream' +
      (
        AUDIUS_API_KEY
          ? '?api_key=' + encodeURIComponent(AUDIUS_API_KEY)
          : ''
      ),
      {
        headers: AUDIUS_API_KEY
          ? { 'X-API-Key': AUDIUS_API_KEY }
          : {}
      },
      30000
    );

    if (!streamResponse.ok || !streamResponse.body) {
      return res.status(502).send('Audio unavailable');
    }

    const filename =
      String(track.user?.name || 'NOVA')
        .replace(/[<>:"/\\\\|?*]+/g, '_') +
      ' - ' +
      String(track.title || 'track')
        .replace(/[<>:"/\\\\|?*]+/g, '_') +
      '.mp3';

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' +
      filename.slice(0, 180) +
      '"'
    );

    res.setHeader(
      'Content-Type',
      'audio/mpeg'
    );

    streamResponse.body.pipe(res);
  } catch (error) {
    console.error('[Audius download]', error.message);
    if (!res.headersSent) {
      res.status(502).send('Download unavailable');
    }
  }
});

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
  res.status(500).json({ ok:false, error:'Internal server error' });
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
