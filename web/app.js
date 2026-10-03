(function(){
  'use strict';

  const memoryStore = Object.create(null);
  const store = {
    get(k, f){ try { const v = localStorage.getItem(k); return v === null ? f : v; } catch (_) { return memoryStore[k] ?? f; } },
    set(k, v){ try { localStorage.setItem(k, String(v)); } catch (_) { memoryStore[k] = String(v); } },
    remove(k){ try { localStorage.removeItem(k); } catch (_) { delete memoryStore[k]; } }
  };

  let savedFavorites = [], savedHistory = [], savedUser = null;
  try { savedFavorites = JSON.parse(store.get('nova_favorites', '[]')); } catch (_) { savedFavorites = []; }
  try { savedHistory = JSON.parse(store.get('nova_history', '[]')); } catch (_) { savedHistory = []; }
  try { savedUser = JSON.parse(store.get('nova_user', 'null')); } catch (_) { savedUser = null; }
  if (!Array.isArray(savedFavorites)) savedFavorites = [];
  if (!Array.isArray(savedHistory)) savedHistory = [];

  const API_TOKEN_KEY = 'nova_token';
  let authToken = store.get(API_TOKEN_KEY, '');
  document.documentElement.setAttribute('data-accent', store.get('nova_accent', 'purple'));

  const localResolveCache = new Map();
  const LOCAL_RESOLVE_TTL = 30 * 60 * 1000;

  const state = {
    tracks: [], popularTracks: [], currentIndex: -1, currentTrack: null,
    sourceFilter: 'ALL', query: '', repeat: false, shuffle: false,
    favorites: savedFavorites, history: savedHistory,
    volume: Number(store.get('nova_volume', '100')) || 100,
    view: 'home', playState: 'idle', searchRequest: 0,
    user: savedUser, background: { src: '' },
    eq: JSON.parse(store.get('nova_eq', '{"on":false,"bands":[0,0,0,0,0]}'))
  };

  let ytPlayer = null;
  let ytPlayerReady = false;
  let ytCurrentVideo = '';
  let ytPendingResolve = null;
  let ytPendingReject = null;

  function $(id){ return document.getElementById(id); }
  function safeEl(id){
    let node = $(id);
    if (!node){ console.warn('[init] element not found:', id); node = document.createElement('div'); node.style.display = 'none'; }
    return node;
  }

  const el = {};
  ['searchInput','searchButton','connection','resultsInfo','homeContinue','homePopular','homeArtists','homeAlbums','homeGreeting',
   'backgroundLayer','backgroundShade','startupScreen','startupStatus','backgroundInput','localAudioInput',
   'backgroundBtn','backgroundResetBtn','settingsOpenFileBtn','openLocalFileBtn',
   'infoDrawer','infoDrawerClose','infoCover','infoTitle','infoArtist','infoMeta','infoFavorite','infoQueue',
   'artistHeroImage','artistHeroName','artistTracks','artistAlbums','artistSingles',
   'albumHeroImage','albumHeroName','albumHeroArtist','albumHeroMeta','albumTracks','albumPlay',
   'trackGrid','miniPlayer','miniCover','miniTitle','miniArtist','miniPlay','miniPlayIcon',
   'largePlayIcon','bigCover','nowTitle','nowArtist','progress','currentTime','duration','queueContent',
   'volumeLarge','volumeMini','libraryList','favoritesList','clearHistory','clearFavorites','settingsVolumeValue',
   'lyricsModal','lyricsClose','lyricsTrackTitle','lyricsTrackArtist','lyricsBody',
   'audio','toast','avatarBtn','userSlot','userMenu','userAvatar','userName','userTag','userLoginBtn','userLogoutBtn',
   'loginModal','loginClose','loginDiscordBtn','loginTabs','tabLogin','tabRegister','localAuthForm',
   'authUsername','authPassword','authError','authSubmit','authSubmitText','continueAsGuest',
   'songInfoModal','songInfoClose','songInfoCover','songInfoTitle','songInfoArtist','songInfoAlbum',
   'songInfoMeta','songInfoSource','songInfoFavorite','songInfoPlay','songInfoDownload',
   'equalizerModal','equalizerClose','equalizerPresets','equalizerBands',
   'logoBtn','miniPlay','largePlayBtn','miniPrev','prevBtn','miniNext','nextBtn',
   'miniRepeat','repeatBtn','miniShuffle','shuffleBtn','downloadBtn','lyricsBtn',
   'equalizerBtn','similarBtn',
   'miniProgress','miniTime','miniFavorite','miniLyrics','miniExpand','miniTrackClick'
  ].forEach(id => { el[id] = safeEl(id); });

  function on(node, event, handler){ if (node && typeof node.addEventListener === 'function') node.addEventListener(event, handler); }
  function apiBase(){ return window.location.origin; }

  let backgroundDbPromise = null;
  let searchAbort = null;
  let authMode = 'login';
  let audioCtx = null, sourceNode = null, eqFilters = null;

  // ============================================================
  // YOUTUBE IFRAME API
  // ============================================================
  window.onYouTubeIframeAPIReady = function(){
    ytPlayerReady = true;
    console.log('[yt] iframe API ready (callback)');
    ensureYtPlayer();
  };

  function ensureYtPlayer(){
    if (ytPlayer) return;
    if (!window.YT || !window.YT.Player) return;
    const container = document.getElementById('youtubePlayer');
    if (!container) return;
    try {
      ytPlayer = new YT.Player('youtubePlayer', {
        height: '100%', width: '100%', videoId: '',
        playerVars: {
          autoplay: 0, controls: 0, disablekb: 1, fs: 0,
          modestbranding: 1, playsinline: 1, iv_load_policy: 3, rel: 0,
          origin: window.location.origin
        },
        events: {
          'onReady': () => { console.log('[yt] player ready'); positionYtPlayer(); },
          'onStateChange': (e) => {
            if (!window.YT) return;
            if (e.data === YT.PlayerState.PLAYING){
              state.playState = 'playing';
              updatePlayButtons();
              positionYtPlayer();
              if (ytPendingResolve){ const r = ytPendingResolve; ytPendingResolve = null; ytPendingReject = null; r(); }
            }
            if (e.data === YT.PlayerState.PAUSED){ state.playState = 'paused'; updatePlayButtons(); }
            if (e.data === YT.PlayerState.ENDED){
              state.playState = 'idle';
              if (state.repeat && ytPlayer){ try { ytPlayer.seekTo(0); ytPlayer.playVideo(); } catch (_){} return; }
              next();
            }
          },
          'onError': (e) => {
            console.warn('[yt] error', e.data);
            if (ytPendingReject){ const r = ytPendingReject; ytPendingResolve = null; ytPendingReject = null; r(new Error('YT error ' + e.data)); }
          }
        }
      });
    } catch (e){ console.error('[yt] ensureYtPlayer failed:', e.message); ytPlayer = null; }
  }

  function positionYtPlayer(){
    const wrap = document.getElementById('youtubePlayerWrap');
    if (!wrap || !wrap.classList.contains('active')) return;
    if (state.view === 'player'){
      const cover = document.querySelector('.big-cover-wrap');
      if (!cover) return;
      const r = cover.getBoundingClientRect();
      wrap.classList.remove('mode-floating');
      wrap.classList.add('mode-large');
      wrap.style.top = r.top + 'px';
      wrap.style.left = r.left + 'px';
      wrap.style.width = r.width + 'px';
      wrap.style.height = r.height + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    } else {
      wrap.classList.remove('mode-large');
      wrap.classList.add('mode-floating');
      wrap.style.top = ''; wrap.style.left = ''; wrap.style.width = ''; wrap.style.height = '';
      wrap.style.right = ''; wrap.style.bottom = '';
    }
  }

  async function playYouTube(videoId){
    if (!videoId) throw new Error('no video id');
    if (!ytPlayerReady && window.YT && window.YT.Player){ ytPlayerReady = true; ensureYtPlayer(); }
    if (!ytPlayer){
      await new Promise((res, rej) => {
        let tries = 0;
        const t = setInterval(() => {
          tries++;
          if (window.YT && window.YT.Player){ if (!ytPlayerReady){ ytPlayerReady = true; } if (!ytPlayer) ensureYtPlayer(); }
          if (ytPlayer){ clearInterval(t); res(); }
          else if (tries > 100){ clearInterval(t); console.error('[yt] timeout. window.YT =', !!window.YT); rej(new Error('YT API timeout — блокировщик рекламы или CSP')); }
        }, 200);
      });
    }
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== 'function') throw new Error('YT player not ready');

    const ytWrap = document.getElementById('youtubePlayerWrap');
    if (ytWrap) ytWrap.classList.add('active');
    try { el.audio.pause(); } catch (_){}
    el.audio.removeAttribute('src'); el.audio.load();

    ytCurrentVideo = videoId;
    setTimeout(positionYtPlayer, 30);

    await new Promise((res, rej) => {
      ytPendingResolve = res; ytPendingReject = rej;
      try {
        ytPlayer.loadVideoById(videoId);
        if (typeof ytPlayer.setVolume === 'function') ytPlayer.setVolume(state.volume);
      } catch (e){ rej(e); return; }
      setTimeout(() => {
        if (ytPendingReject){ const r = ytPendingReject; ytPendingResolve = null; ytPendingReject = null; r(new Error('YouTube не запустил видео')); }
      }, 30000);
    });
  }

  // ============================================================
  // BACKGROUND
  // ============================================================
  function openLocalAudioPicker(){ el.localAudioInput.click(); }
  function openBackgroundPicker(){ el.backgroundInput.click(); }
  function backgroundDb(){
    if (backgroundDbPromise) return backgroundDbPromise;
    backgroundDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('nova-settings', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('settings')) req.result.createObjectStore('settings'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return backgroundDbPromise;
  }
  async function saveBackgroundData(v){ try { const db = await backgroundDb(); await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put(v, 'background'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (_) { try { store.set('nova_background_fallback', v); } catch (_) {} } }
  async function loadBackgroundData(){ try { const db = await backgroundDb(); return await new Promise((res, rej) => { const tx = db.transaction('settings', 'readonly'); const r = tx.objectStore('settings').get('background'); r.onsuccess = () => res(r.result || ''); r.onerror = () => rej(r.error); }); } catch (_) { return store.get('nova_background_fallback', ''); } }
  function applyBackground(src){
    if (!src){ document.body.classList.remove('has-background'); el.backgroundLayer.style.backgroundImage = 'none'; el.backgroundLayer.style.background = '#000'; el.backgroundLayer.style.opacity = '0'; return; }
    document.body.classList.add('has-background');
    if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('/')){ el.backgroundLayer.style.background = '#000 center/cover no-repeat'; el.backgroundLayer.style.backgroundImage = 'url("' + src.replace(/"/g, '\\"') + '")'; }
    else { el.backgroundLayer.style.backgroundImage = 'none'; el.backgroundLayer.style.background = src; }
    el.backgroundLayer.style.opacity = '1';
    el.backgroundShade.style.background = 'rgba(0,0,0,.72)';
  }
  async function loadSavedBackground(){ const src = await loadBackgroundData(); if (src){ state.background.src = src; applyBackground(src); } }
  async function saveSelectedBackground(file){
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return notify('Поддерживаются PNG, JPG, WEBP и GIF');
    const reader = new FileReader();
    reader.onload = async () => { state.background.src = String(reader.result || ''); await saveBackgroundData(state.background.src); applyBackground(state.background.src); notify('Фон изменён'); };
    reader.readAsDataURL(file);
  }
  function resetBackground(){ state.background.src = ''; saveBackgroundData('').catch(() => {}); applyBackground(''); notify('Фон сброшен'); }

  // ============================================================
  // EQUALIZER
  // ============================================================
  const EQ_BANDS = [ {freq:60,type:'lowshelf',label:'60'}, {freq:230,type:'peaking',label:'230'}, {freq:910,type:'peaking',label:'910'}, {freq:3600,type:'peaking',label:'3.6k'}, {freq:14000,type:'highshelf',label:'14k'} ];
  const EQ_PRESETS = { 'Flat':[0,0,0,0,0], 'Bass Boost':[8,6,2,0,0], 'Vocal':[-2,0,3,5,3], 'Rock':[5,3,-1,3,5], 'Pop':[-1,2,4,3,-1], 'Jazz':[3,2,-2,2,4], 'Classical':[4,2,0,2,4], 'Loudness':[6,4,0,3,5] };
  function initAudioGraph(){
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(el.audio);
      eqFilters = EQ_BANDS.map(b => { const f = audioCtx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.freq; if (b.type === 'peaking') f.Q.value = 1.0; f.gain.value = 0; return f; });
      let prev = sourceNode; eqFilters.forEach(f => { prev.connect(f); prev = f; }); prev.connect(audioCtx.destination);
    } catch (e){ console.warn('[eq]', e.message); audioCtx = null; }
  }
  function applyEq(){ if (!eqFilters) return; const on = state.eq.on; state.eq.bands.forEach((g, i) => { if (eqFilters[i]) eqFilters[i].gain.value = on ? Number(g) : 0; }); }
  function setEqBand(i, v){ state.eq.bands[i] = Number(v); store.set('nova_eq', JSON.stringify(state.eq)); applyEq(); }
  function applyEqPreset(n){ const p = EQ_PRESETS[n]; if (!p) return; state.eq.bands = p.slice(); store.set('nova_eq', JSON.stringify(state.eq)); applyEq(); renderEqualizerBands(); }
  function renderEqualizerBands(){
    if (!el.equalizerBands) return;
    el.equalizerBands.innerHTML = '';
    EQ_BANDS.forEach((b, i) => {
      const val = state.eq.bands[i] || 0;
      const w = document.createElement('div'); w.className = 'eq-band';
      w.innerHTML = '<div class="eq-band-value">' + (val > 0 ? '+' : '') + val + '</div><input type="range" class="eq-slider" min="-12" max="12" value="' + val + '" step="1" data-band="' + i + '"><div class="eq-band-label
