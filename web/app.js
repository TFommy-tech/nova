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

  const _v = Number(store.get('nova_volume', '100'));
  const initialVolume = Number.isFinite(_v) && _v >= 0 && _v <= 100 ? Math.round(_v) : 100;

  const localResolveCache = new Map();
  const LOCAL_RESOLVE_TTL = 30 * 60 * 1000;

  const state = {
    tracks: [], popularTracks: [], currentIndex: -1, currentTrack: null,
    sourceFilter: 'ALL', query: '', repeat: false, shuffle: false,
    favorites: savedFavorites, history: savedHistory, volume: initialVolume,
    view: 'home', playState: 'idle', searchRequest: 0,
    user: savedUser, background: { src: '' },
    eq: (() => {
      try {
        const raw = JSON.parse(store.get('nova_eq', '{"on":false,"bands":[0,0,0,0,0]}'));
        if (!raw || !Array.isArray(raw.bands) || raw.bands.length !== 5) return { on:false, bands:[0,0,0,0,0] };
        raw.on = raw.bands.some(x => Number(x) !== 0);
        return raw;
      } catch (_){ return { on:false, bands:[0,0,0,0,0] }; }
    })()
  };

  const settings = {
    theme: store.get('nova_theme', 'dark'),
    notifications: store.get('nova_notifications', '1') === '1',
    hotkeys: store.get('nova_hotkeys', '1') === '1',
    autoplay: store.get('nova_autoplay', '1') === '1',
  };

  let previousView = 'home';
  let ytIframe = null;
  let ytCurrentVideo = '';
  let ytVideoDuration = 0;
  let ytVideoCurrentTime = 0;
  let ytPendingResolve = null;
  let ytPendingReject = null;
  let playRequestId = 0;
  let playAbort = null;

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
   'artistHeroImage','artistHeroName','artistHeroMeta','artistBanner','artistBannerBg','artistShowAllBtn','artistTracks','artistAlbums','artistSingles',
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
   'logoBtn','miniPrev','prevBtn','miniNext','nextBtn','miniRepeat','repeatBtn','miniShuffle','shuffleBtn',
   'downloadBtn','lyricsBtn','equalizerBtn','similarBtn',
   'miniProgress','miniTime','miniFavorite','miniLyrics','miniExpand','miniTrackClick',
   'themeToggle','notificationsToggle','hotkeysToggle','autoplayToggle','playerBack'
  ].forEach(id => { el[id] = safeEl(id); });

  function on(node, event, handler){ if (node && typeof node.addEventListener === 'function') node.addEventListener(event, handler); }
  function apiBase(){ return window.location.origin; }

  let backgroundDbPromise = null;
  let searchAbort = null;
  let authMode = 'login';

  // === AUDIO GRAPH ===
  let audioCtx = null;
  let sourceNode = null;
  let fadeGain = null;
  let volumeGain = null;
  let eqFilters = null;
  let audioGraphReady = false;

  function applyTheme(){
    document.documentElement.setAttribute('data-theme', settings.theme);
    if (el.themeToggle) el.themeToggle.textContent = settings.theme === 'dark' ? 'Тёмная' : 'Светлая';
    store.set('nova_theme', settings.theme);
  }
  function applyToggle(btn, on){
    if (!btn) return;
    btn.textContent = on ? 'Вкл' : 'Выкл';
    btn.classList.toggle('primary', on);
    btn.classList.toggle('off', !on);
  }

  // ============================================================
  // YOUTUBE
  // ============================================================
  function ytSendCommand(func, args){
    if (!ytIframe || !ytIframe.contentWindow) return;
    try { ytIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*'); } catch (_){}
  }

  window.addEventListener('message', (e) => {
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin || '')) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (_){ return; }
    if (!data || !data.event) return;
    if (data.event === 'onStateChange'){
      const s = data.info;
      if (s === 1){ state.playState = 'playing'; updatePlayButtons(); }
      else if (s === 2){ state.playState = 'paused'; updatePlayButtons(); }
      else if (s === 0){
        state.playState = 'idle';
        if (state.repeat){ ytSendCommand('seekTo', [0, true]); ytSendCommand('playVideo'); }
        else { next(); }
      }
      else if (s === -1){
        if (ytPendingReject){ const r = ytPendingReject; ytPendingReject = null; ytPendingResolve = null; r(new Error('запрещено к встраиванию')); }
      }
    }
    if (data.event === 'infoDelivery' && data.info){
      if (typeof data.info.currentTime === 'number') ytVideoCurrentTime = data.info.currentTime;
      if (typeof data.info.duration === 'number' && data.info.duration > 0) ytVideoDuration = data.info.duration;
      updateProgress();
    }
  });

  function playYouTube(videoId, myId){
    return new Promise((resolve, reject) => {
      const wrap = document.getElementById('youtubePlayerWrap');
      if (!wrap) return reject(new Error('no youtube wrap'));
      wrap.innerHTML = '';
      ytIframe = null;
      ytCurrentVideo = videoId;
      ytVideoDuration = 0;
      ytVideoCurrentTime = 0;
      try { el.audio.pause(); } catch (_){}
      el.audio.removeAttribute('src');
      el.audio.load();
      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'autoplay; encrypted-media');
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000;';
      iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?autoplay=1&enablejsapi=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&fs=0&disablekb=1&cc_load_policy=0&hl=en&origin=' + encodeURIComponent(location.origin);
      let resolved = false;
      const finish = (err) => {
        if (resolved) return;
        resolved = true;
        if (myId !== undefined && myId !== playRequestId){ reject(new Error('Aborted')); return; }
        if (err) reject(err); else resolve();
      };
      iframe.addEventListener('load', () => {
        setTimeout(() => {
          ytSendCommand('playVideo');
          ytSendCommand('setVolume', [state.volume]);
          ytSendCommand('addEventListener', ['onStateChange']);
          ytSendCommand('addEventListener', ['infoDelivery']);
        }, 250);
        setTimeout(() => finish(), 800);
      });
      iframe.addEventListener('error', () => finish(new Error('iframe load error')));
      wrap.appendChild(iframe);
      ytIframe = iframe;
      setTimeout(() => finish(), 12000);
      setTimeout(() => { try { iframe.contentWindow.postMessage(JSON.stringify({event:'listening', id:'nova'}), '*'); } catch (_){} }, 600);
      const cancelTick = setInterval(() => {
        if (myId !== undefined && myId !== playRequestId){ clearInterval(cancelTick); finish(new Error('Aborted')); }
      }, 100);
      setTimeout(() => clearInterval(cancelTick), 30000);
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
  // EQUALIZER (FIXED)
  // ============================================================
  const EQ_BANDS = [
    { freq: 60,    type: 'lowshelf',  label: '60' },
    { freq: 230,   type: 'peaking',   label: '230' },
    { freq: 910,   type: 'peaking',   label: '910' },
    { freq: 3600,  type: 'peaking',   label: '3.6k' },
    { freq: 14000, type: 'highshelf', label: '14k' }
  ];
  const EQ_PRESETS = {
    'Flat': [0,0,0,0,0], 'Bass Boost': [8,6,2,0,0], 'Vocal': [-2,0,3,5,3],
    'Rock': [5,3,-1,3,5], 'Pop': [-1,2,4,3,-1], 'Jazz': [3,2,-2,2,4],
    'Classical': [4,2,0,2,4], 'Loudness': [6,4,0,3,5]
  };

  function initAudioGraph(){
    if (audioGraphReady){
      if (audioCtx && audioCtx.state === 'suspended'){
        audioCtx.resume().then(() => applyEq()).catch(() => {});
      } else {
        applyEq();
      }
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      console.log('[eq] audioCtx created, state =', audioCtx.state);

      sourceNode = audioCtx.createMediaElementSource(el.audio);

      fadeGain = audioCtx.createGain();
      fadeGain.gain.value = 1;

      volumeGain = audioCtx.createGain();
      volumeGain.gain.value = state.volume / 100;

      eqFilters = EQ_BANDS.map(b => {
        const f = audioCtx.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.freq;
        if (b.type === 'peaking') f.Q.value = 1.0;
        f.gain.value = 0;
        return f;
      });

      sourceNode.connect(fadeGain);
      fadeGain.connect(volumeGain);
      let prev = volumeGain;
      eqFilters.forEach(f => { prev.connect(f); prev = f; });
      prev.connect(audioCtx.destination);

      audioGraphReady = true;
      console.log('[eq] graph built. bands:', state.eq.bands, 'on:', state.eq.on);
      applyEq();

      if (audioCtx.state === 'suspended'){
        audioCtx.resume().then(() => {
          console.log('[eq] resumed');
          applyEq();
        }).catch(e => console.warn('[eq] resume failed:', e.message));
      }
    } catch (e){
      console.warn('[eq] init failed:', e.message);
      audioCtx = null; audioGraphReady = false; fadeGain = null; volumeGain = null; eqFilters = null;
    }
  }

  function applyEq(){
    if (!eqFilters || !audioGraphReady || !audioCtx){
      console.log('[eq] applyEq skip: ready=' + audioGraphReady);
      return;
    }
    const on = state.eq.on;
    state.eq.bands.forEach((g, i) => {
      if (!eqFilters[i]) return;
      const target = on ? Number(g) : 0;
      eqFilters[i].gain.cancelScheduledValues(audioCtx.currentTime);
      eqFilters[i].gain.setValueAtTime(target, audioCtx.currentTime);
      console.log('[eq] band', i, '(' + EQ_BANDS[i].label + ') =', target);
    });
  }

  function rampFadeTo(target, ms){
    if (!audioGraphReady || !fadeGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    fadeGain.gain.cancelScheduledValues(now);
    fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
    fadeGain.gain.linearRampToValueAtTime(target, now + ms / 1000);
  }
  function fadeOutAndWait(ms){
    if (!audioGraphReady || !fadeGain || !audioCtx) return Promise.resolve();
    rampFadeTo(0, ms);
    return new Promise(res => setTimeout(res, ms + 30));
  }
  function fadeIn(ms){
    if (!audioGraphReady || !fadeGain || !audioCtx) return;
    fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
    fadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
    fadeGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + ms / 1000);
  }

  function setEqBand(i, v){
    state.eq.bands[i] = Number(v);
    state.eq.on = state.eq.bands.some(x => Number(x) !== 0);
    store.set('nova_eq', JSON.stringify(state.eq));
    if (!audioGraphReady) initAudioGraph();
    applyEq();
  }
  function applyEqPreset(n){
    const p = EQ_PRESETS[n]; if (!p) return;
    state.eq.bands = p.slice();
    state.eq.on = p.some(x => Number(x) !== 0);
    store.set('nova_eq', JSON.stringify(state.eq));
    if (!audioGraphReady) initAudioGraph();
    applyEq();
    renderEqualizerBands();
  }
  function renderEqualizerBands(){
    if (!el.equalizerBands) return;
    el.equalizerBands.innerHTML = '';
    EQ_BANDS.forEach((b, i) => {
      const val = state.eq.bands[i] || 0;
      const w = document.createElement('div'); w.className = 'eq-band';
      w.innerHTML = '<div class="eq-band-value">' + (val > 0 ? '+' : '') + val + '</div>' +
                    '<input type="range" class="eq-slider" min="-12" max="12" value="' + val + '" step="1" data-band="' + i + '">' +
                    '<div class="eq-band-label">' + b.label + '</div>';
      el.equalizerBands.appendChild(w);
      const s = w.querySelector('input');
      s.style.setProperty('--progress', ((val + 12) / 24 * 100) + '%');
      s.addEventListener('input', () => {
        const v = Number(s.value);
        w.querySelector('.eq-band-value').textContent = (v > 0 ? '+' : '') + v;
        s.style.setProperty('--progress', ((v + 12) / 24 * 100) + '%');
        setEqBand(i, v);
      });
    });
  }
  function renderEqualizerPresets(){
    if (!el.equalizerPresets) return;
    el.equalizerPresets.innerHTML = '';
    Object.keys(EQ_PRESETS).forEach(n => {
      const b = document.createElement('button'); b.className = 'eq-preset'; b.textContent = n;
      b.addEventListener('click', () => applyEqPreset(n));
      el.equalizerPresets.appendChild(b);
    });
  }
  function openEqualizer(){
    // Всегда при открытии — гарантируем что граф существует и активен
    initAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended'){
      audioCtx.resume().then(() => applyEq()).catch(() => {});
    }
    renderEqualizerBands();
    renderEqualizerPresets();
    el.equalizerModal.classList.add('open');
    el.equalizerModal.setAttribute('aria-hidden', 'false');
  }
  function closeEqualizer(){
    el.equalizerModal.classList.remove('open');
    el.equalizerModal.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // USER
  // ============================================================
  function avatarUrl(u){
    if (!u) return '';
    if (!u.avatar){ const idx = u.id && /^\d+$/.test(u.id) ? Number(BigInt(u.id) >> 22n) % 6 : 0; return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png'; }
    const ext = String(u.avatar).startsWith('a_') ? 'gif' : 'png';
    return 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.' + ext + '?size=128';
  }
  function defaultAvatarSvg(){ return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a1a"/><circle cx="32" cy="24" r="10" fill="#4a4a4a"/><path d="M12 56c3-12 11-17 20-17s17 5 20 17z" fill="#4a4a4a"/></svg>'); }
  function renderUser(){
    const u = state.user;
    if (u){
      el.avatarBtn.classList.add('logged-in');
      const url = u.provider === 'discord' ? avatarUrl(u) : defaultAvatarSvg();
      el.avatarBtn.innerHTML = '<img src="' + url + '" alt="">';
      el.userAvatar.src = url;
      el.userName.textContent = u.username || 'User';
      el.userTag.textContent = u.provider === 'discord' ? 'Discord аккаунт' : 'Локальный аккаунт';
      el.userLoginBtn.style.display = 'none';
      el.userLogoutBtn.style.display = 'flex';
      el.homeGreeting.textContent = 'С возвращением, ' + (u.username || 'User') + '!';
    } else {
      el.avatarBtn.classList.remove('logged-in');
      el.avatarBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c.9-3.7 3.1-5.5 7-5.5s6.1 1.8 7 5.5"/></svg>';
      el.userAvatar.removeAttribute('src');
      el.userName.textContent = 'Гость';
      el.userTag.textContent = 'не авторизован';
      el.userLoginBtn.style.display = 'flex';
      el.userLogoutBtn.style.display = 'none';
      el.homeGreeting.textContent = 'Добро пожаловать в NOVA';
    }
  }
  function openLoginModal(){ el.loginModal.classList.add('open'); el.loginModal.setAttribute('aria-hidden', 'false'); }
  function closeLoginModal(){ el.loginModal.classList.remove('open'); el.loginModal.setAttribute('aria-hidden', 'true'); }
  function toggleUserMenu(f){ const o = f !== undefined ? f : !el.userMenu.classList.contains('open'); el.userMenu.classList.toggle('open', o); }
  async function apiAuth(path, options = {}){
    const opts = { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + authToken } };
    const r = await fetch(apiBase() + path, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function loadUserData(){
    if (!authToken) return;
    try {
      const [me, favs, hist] = await Promise.all([apiAuth('/api/me'), apiAuth('/api/favorites'), apiAuth('/api/history')]);
      state.user = me; state.favorites = Array.isArray(favs) ? favs : []; state.history = Array.isArray(hist) ? hist : [];
      store.set('nova_user', JSON.stringify(me));
      renderUser(); renderFavorites(); renderLibrary();
    } catch (e){ authToken = ''; store.remove(API_TOKEN_KEY); state.user = null; renderUser(); }
  }
  function logout(){ authToken = ''; store.remove(API_TOKEN_KEY); store.remove('nova_user'); state.user = null; state.favorites = []; state.history = []; persist(); renderUser(); renderFavorites(); renderLibrary(); notify('Вы вышли'); toggleUserMenu(false); }
  function loginViaDiscord(){ window.location.href = '/api/auth/discord'; }
  function checkLoginCallback(){ const p = new URLSearchParams(window.location.search); if (p.get('login') !== 'success') return false; const t = p.get('token'); if (!t) return false; authToken = t; store.set(API_TOKEN_KEY, t); window.history.replaceState({}, '', '/'); return true; }
  function setAuthMode(mode){
    authMode = mode;
    el.tabLogin.classList.toggle('active', mode === 'login');
    el.tabRegister.classList.toggle('active', mode === 'register');
    if (el.authSubmitText) el.authSubmitText.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    el.authUsername.value = ''; el.authPassword.value = '';
    el.authError.classList.add('hidden'); el.authError.textContent = '';
  }
  function showAuthError(m){ el.authError.textContent = m; el.authError.classList.remove('hidden'); }
  async function submitLocalAuth(e){
    e.preventDefault();
    const u = el.authUsername.value.trim(), p = el.authPassword.value;
    if (!u || !p){ showAuthError('Заполни оба поля'); return; }
    el.authSubmit.disabled = true;
    if (el.authSubmitText) el.authSubmitText.textContent = 'Загрузка…';
    try {
      const url = authMode === 'register' ? '/api/register' : '/api/login';
      const r = await fetch(apiBase() + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Ошибка');
      authToken = d.token; store.set(API_TOKEN_KEY, d.token);
      state.user = d.user; store.set('nova_user', JSON.stringify(d.user));
      await loadUserData(); closeLoginModal(); renderUser();
    } catch (err){ showAuthError(err.message || 'Ошибка входа'); }
    finally { el.authSubmit.disabled = false; if (el.authSubmitText) el.authSubmitText.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт'; }
  }

  // ============================================================
  // HELPERS
  // ============================================================
  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  function formatTime(s){ if (!Number.isFinite(s) || s < 0) return '0:00'; const sec = Math.floor(s), m = Math.floor(sec / 60), r = String(sec % 60).padStart(2, '0'); return m + ':' + r; }
  function formatNumber(n){
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function trackKey(t){ return [t.source || '', t.id || '', t.title || '', t.artist || ''].join('|'); }
  function coverFor(t){ return t && t.cover ? t.cover : ''; }
  function sourceClass(s){ if (s === 'FULL') return 'full'; if (s === 'PREVIEW') return 'preview'; return 'catalog'; }
  function isBadArtist(n){ const x = normalizeSearch(n); return !x || /^(unknown( artist)?|various artists|no name|без названия|null|undefined)$/i.test(x); }
  function isNoiseTrack(t){ const ti = normalizeSearch(t.title), ar = normalizeSearch(t.artist); if (!ti || isBadArtist(ar) || /^(unknown|без названия|null|undefined)$/i.test(ti)) return true; return /(^| )(karaoke|instrumental|reaction|parody|tribute|8d)( |$)/i.test(ti); }
  function normalizeSearch(v){ return String(v || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  function notify(m){
    if (!settings.notifications) return;
    el.toast.textContent = m;
    el.toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }
  function persist(){
    store.set('nova_favorites', JSON.stringify(state.favorites));
    store.set('nova_history', JSON.stringify(state.history));
    store.set('nova_volume', String(state.volume));
    store.set('nova_eq', JSON.stringify(state.eq));
  }
  function isFavorite(t){ const k = trackKey(t); return state.favorites.some(x => trackKey(x) === k); }
  function toggleFavorite(t){
    const k = trackKey(t);
    if (isFavorite(t)){
      state.favorites = state.favorites.filter(x => trackKey(x) !== k);
      notify('Удалено из избранного');
      if (state.user && authToken) apiAuth('/api/favorites/' + encodeURIComponent(k), { method: 'DELETE' }).catch(() => {});
    } else {
      state.favorites.unshift(t);
      notify('Добавлено в избранное');
      if (state.user && authToken) apiAuth('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
    }
    state.favorites = state.favorites.slice(0, 500);
    persist(); renderFavorites(); updateMiniPlayer();
  }
  function addHistory(t){
    const k = trackKey(t);
    state.history = state.history.filter(x => trackKey(x) !== k);
    state.history.unshift(t); state.history = state.history.slice(0, 300);
    persist(); renderLibrary();
    if (state.user && authToken) apiAuth('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
  }
  function setConnection(ok, msg){ el.connection.textContent = msg; el.connection.className = 'connection ' + (ok ? 'ok' : 'bad'); }
  async function checkApi(silent = false){
    try { const r = await fetch(apiBase() + '/api/health', { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('health'); setConnection(true, 'API: online'); }
    catch (e){ if (!silent) setConnection(false, 'API: offline'); }
  }

  function normalizeTrack(t){
    if (!t) return null;
    const artistObj = (t.artist && typeof t.artist === 'object') ? t.artist : null;
    const albumObj = (t.album && typeof t.album === 'object') ? t.album : null;
    const artistName = artistObj ? (artistObj.name || '') : (t.artistName || t.artist || (t.artists && t.artists[0] && t.artists[0].name) || '');
    const artistId = artistObj ? String(artistObj.id || '') : (t.artistId ? String(t.artistId) : (t.artists && t.artists[0] ? String(t.artists[0].id) : '') || '');
    const albumTitle = albumObj ? (albumObj.title || '') : (t.albumName || t.collectionName || t.album || '');
    const albumId = albumObj ? String(albumObj.id || '') : (t.albumId ? String(t.albumId) : '');
    const cover = t.cover || t.artwork || t.artworkUrl100 || (albumObj && (albumObj.cover_xl || albumObj.cover_big || albumObj.cover_medium)) || '';
    return {
      id: t.id || t.trackId || t.uri || t.link || cryptoLike(t),
      title: t.title || t.trackName || t.name || 'Без названия',
      artist: artistName, artistId, cover,
      preview: t.preview || '',
      source: String(t.source || 'CATALOG').toUpperCase(),
      downloadable: !!t.downloadable, downloadUrl: t.downloadUrl || '',
      album: albumTitle, albumId,
      duration: Number(t.duration || (Number(t.trackTimeMillis || 0) / 1000) || 0),
      bitrate: Number(t.bitrate || t.bitrate_kbps || 0),
      popularity: Number(t.popularity || t.rank || 0),
      provider: t.provider || '',
      sourceUrl: t.sourceUrl || t.link || t.external_url || '',
      releaseDate: t.releaseDate || '', localUrl: t.localUrl || ''
    };
  }
  function cryptoLike(t){ const s = [t.title || '', t.artist || '', t.source || ''].join('|'); let h = 0; for (let i = 0; i < s.length; i++){ h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; } return 't_' + Math.abs(h); }

  function searchScore(track, query){
    const q = normalizeSearch(query), ti = normalizeSearch(track.title), ar = normalizeSearch(track.artist);
    if (!q) return 0;
    const tokens = q.split(/\s+/).filter(Boolean);
    let score = 0; const cb = ti + ' ' + ar;
    if (ti === q) score += 1000000; else if (ti.startsWith(q)) score += 500000; else if (ti.includes(q)) score += 200000;
    if (ar === q) score += 800000; else if (ar.startsWith(q)) score += 400000; else if (ar.includes(q)) score += 150000;
    let hits = 0;
    for (const tk of tokens){ if (ti.split(/\s+/).includes(tk)) hits += 3; else if (ar.split(/\s+/).includes(tk)) hits += 2; else if (cb.includes(tk)) hits += 1; }
    score += hits * 1500;
    const pop = Number(track.popularity || 0);
    if (pop > 0) score += Math.log10(pop + 1) * 5000;
    if (track.provider === 'itunes') score += 30000;
    if (track.source === 'FULL') score += 500;
    return score;
  }
  function sortSearchResults(list, q){ return list.map((t, i) => ({ t, i, s: searchScore(t, q) })).sort((a, b) => b.s !== a.s ? b.s - a.s : a.i - b.i).map(x => x.t); }

  async function search(query, options = {}){
    const q = String(query || '').trim();
    if (!q) return;
    state.query = q;
    if (!options.startup){ try { showView('search'); } catch (e){} }
    const reqId = ++state.searchRequest;
    if (searchAbort) searchAbort.abort();
    const controller = new AbortController();
    searchAbort = controller;
    if (el.searchButton){ el.searchButton.disabled = true; el.searchButton.textContent = '…'; }
    if (el.resultsInfo) el.resultsInfo.textContent = 'Поиск…';
    const safetyTimer = setTimeout(() => { if (el.searchButton && el.searchButton.disabled){ el.searchButton.disabled = false; el.searchButton.textContent = 'Найти'; } }, 20000);
    try {
      const r = await fetch(apiBase() + '/api/search?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (reqId !== state.searchRequest) return;
      let tracks = [];
      try { tracks = Array.isArray(d.results) ? d.results.map(normalizeTrack).filter(Boolean) : []; } catch (e){ tracks = []; }
      state.tracks = sortSearchResults(tracks, q);
      try { renderTracks(); } catch (e){}
      try { renderHome(); } catch (e){}
      setConnection(true, 'API: online');
      if (el.resultsInfo) el.resultsInfo.textContent = state.tracks.length + ' результатов';
      if (!options.startup) showView('search');
      if (state.tracks.length && !options.startup){ notify(state.tracks.length + ' результатов'); prefetchTracks(state.tracks.slice(0, 6)); }
    } catch (e){
      if (reqId !== state.searchRequest || e.name === 'AbortError') return;
      state.tracks = [];
      if (el.trackGrid) el.trackGrid.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div>Ошибка: ' + escapeHtml(e.message) + '</div></div>';
      if (el.resultsInfo) el.resultsInfo.textContent = 'Ошибка';
      setConnection(false, 'API: ошибка');
    } finally {
      clearTimeout(safetyTimer);
      if (reqId === state.searchRequest && el.searchButton){ el.searchButton.disabled = false; el.searchButton.textContent = 'Найти'; }
    }
  }

  function prefetchTracks(tracks){
    tracks.forEach(t => {
      const title = String(t.title || '').trim(); const artist = String(t.artist || '').trim();
      if (!title && !artist) return;
      const ck = normalizeSearch(title + ' ' + artist);
      const cached = localResolveCache.get(ck);
      if (cached && Date.now() - cached.time < LOCAL_RESOLVE_TTL) return;
      const params = new URLSearchParams({ title, artist, duration: String(t.duration || 0) });
      fetch(apiBase() + '/api/audio/resolve?' + params.toString(), { headers: { Accept: 'application/json' } })
        .then(r => r.json()).then(d => { if (d.ok && d.streamUrl){ localResolveCache.set(ck, { time: Date.now(), streamUrl: d.streamUrl, provider: d.provider }); } })
        .catch(() => {});
    });
    try { fetch(apiBase() + '/api/audio/prefetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks }) }).catch(() => {}); } catch (_) {}
  }

  function renderHome(){
    const recent = state.history.slice(0, 8);
    el.homeContinue.innerHTML = '';
    if (!recent.length) el.homeContinue.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Начни слушать музыку</div></div>';
    else recent.forEach(t => el.homeContinue.appendChild(makeHomeTrackCard(t)));
    const popular = state.popularTracks.length ? state.popularTracks : state.tracks.slice(0, 12);
    el.homePopular.innerHTML = '';
    popular.slice(0, 12).forEach(t => el.homePopular.appendChild(makeHomeTrackCard(t)));
    const q = normalizeSearch(state.query || '');
    const wantsArtist = /(artist|исполнитель|певец|группа|band|singer)/i.test(q);
    const artistsSection = document.getElementById('artistsSection');
    if (artistsSection) artistsSection.style.display = wantsArtist ? '' : 'none';
    if (wantsArtist){
      const artists = [], seen = new Set();
      for (const t of state.tracks){ const k = normalizeSearch(t.artist); if (k && !seen.has(k) && !isBadArtist(t.artist)){ seen.add(k); artists.push(t); } if (artists.length >= 10) break; }
      el.homeArtists.innerHTML = '';
      artists.forEach(t => el.homeArtists.appendChild(makeHomeArtistCard(t)));
    }
    const albums = [], seenA = new Set();
    for (const t of state.tracks){ if (!t.albumId) continue; const k = normalizeSearch((t.album || '') + '|' + (t.artist || '')); if (t.album && k && !seenA.has(k)){ seenA.add(k); albums.push(t); } if (albums.length >= 10) break; }
    el.homeAlbums.innerHTML = '';
    albums.forEach(t => el.homeAlbums.appendChild(makeHomeAlbumCard(t)));
  }

  function playByTrackObject(track){
    const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
    if (i >= 0) playTrack(i);
    else { state.tracks = [track]; playTrack(0); }
  }

  function makeHomeTrackCard(track){
    const d = document.createElement('div'); d.className = 'home-mini-card';
    const img = document.createElement('img'); img.className = 'home-mini-cover'; img.alt = '';
    img.src = track.cover || 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#0b0b0b"/><text x="150" y="165" fill="#444" font-size="72" text-anchor="middle">♪</text></svg>');
    const t = document.createElement('div'); t.className = 'home-mini-title'; t.textContent = track.title || 'Без названия';
    const s = document.createElement('div'); s.className = 'home-mini-sub'; s.textContent = track.artist || '—';
    t.addEventListener('click', (e) => { e.stopPropagation(); playByTrackObject(track); });
    s.classList.add('inline-link');
    s.addEventListener('click', (e) => { e.stopPropagation(); showArtist(track.artistId || '', track.artist || ''); });
    img.addEventListener('click', (e) => { e.stopPropagation(); playByTrackObject(track); });
    d.append(img, t, s);
    d.addEventListener('click', () => playByTrackObject(track));
    return d;
  }
  function makeHomeArtistCard(track){ const d = makeHomeTrackCard(track); d.onclick = () => showArtist(track.artistId || '', track.artist || ''); d.querySelector('.home-mini-cover').style.borderRadius = '50%'; return d; }
  function makeHomeAlbumCard(track){
    const d = document.createElement('div'); d.className = 'home-mini-card';
    const img = document.createElement('img'); img.className = 'home-mini-cover'; img.alt = '';
    img.src = track.cover || 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#0b0b0b"/><text x="150" y="165" fill="#444" font-size="72" text-anchor="middle">♪</text></svg>');
    const t = document.createElement('div'); t.className = 'home-mini-title'; t.textContent = track.title || 'Без названия';
    const s = document.createElement('div'); s.className = 'home-mini-sub'; s.textContent = track.artist || '—';
    d.addEventListener('click', () => { if (track.albumId) showAlbum(track.albumId); });
    d.append(img, t, s);
    return d;
  }

  function renderTracks(){
    let grid = document.getElementById('trackGrid');
    if (!grid){
      const searchView = document.getElementById('searchView');
      if (searchView){ searchView.innerHTML = '<div class="search-view"><div class="meta-row"><span id="resultsInfo" class="results-info">Ожидание</span></div><div id="trackGrid" class="track-grid"></div></div>'; grid = document.getElementById('trackGrid'); el.trackGrid = grid; el.resultsInfo = document.getElementById('resultsInfo'); }
    }
    if (!grid) return;
    grid.innerHTML = '';
    if (!state.tracks.length){ grid.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div>Ничего не найдено</div></div>'; if (el.resultsInfo) el.resultsInfo.textContent = '0 результатов'; return; }
    if (el.resultsInfo) el.resultsInfo.textContent = state.tracks.length + ' результатов';
    state.tracks.forEach((track, index) => {
      const card = document.createElement('article'); card.className = 'card'; card.style.animationDelay = (index * 20) + 'ms';
      const coverBox = document.createElement('div'); coverBox.className = 'cover-box';
      if (coverFor(track)){
        const img = document.createElement('img'); img.className = 'cover'; img.alt = ''; img.loading = 'lazy'; img.src = coverFor(track);
        img.onerror = function(){ img.style.display = 'none'; const fb = document.createElement('div'); fb.className = 'cover-fallback'; fb.textContent = '♪'; coverBox.appendChild(fb); };
        coverBox.appendChild(img);
      } else { const fb = document.createElement('div'); fb.className = 'cover-fallback'; fb.textContent = '♪'; coverBox.appendChild(fb); }
      const badge = document.createElement('div'); badge.className = 'source-badge ' + sourceClass(track.source); badge.textContent = track.source || 'CATALOG'; coverBox.appendChild(badge);
      const play = document.createElement('div'); play.className = 'play-card'; play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'; coverBox.appendChild(play);
      const info = document.createElement('button'); info.className = 'info-card'; info.title = 'Информация';
      info.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>';
      info.addEventListener('click', e => { e.stopPropagation(); openSongInfo(track); });
      coverBox.appendChild(info);
      const copy = document.createElement('div'); copy.className = 'card-copy';
      const ti = document.createElement('div'); ti.className = 'card-title'; ti.textContent = track.title || 'Без названия'; ti.title = track.title || '';
      ti.addEventListener('click', e => { e.stopPropagation(); openSongInfo(track); });
      const ar = document.createElement('div'); ar.className = 'card-artist'; ar.textContent = track.artist || 'Неизвестный исполнитель';
      ar.classList.add('inline-link');
      ar.addEventListener('click', e => { e.stopPropagation(); showArtist(track.artistId || '', track.artist || ''); });
      copy.appendChild(ti); copy.appendChild(ar);
      card.appendChild(coverBox); card.appendChild(copy);
      card.addEventListener('click', () => playTrack(index));
      card.addEventListener('contextmenu', e => { e.preventDefault(); toggleFavorite(track); });
      grid.appendChild(card);
    });
  }

  let songInfoCurrent = null;
  function openSongInfo(track){
    if (!track) return;
    songInfoCurrent = track;
    el.songInfoCover.src = track.cover || ''; el.songInfoCover.style.display = track.cover ? 'block' : 'none';
    el.songInfoTitle.textContent = track.title || 'Без названия';
    el.songInfoArtist.textContent = track.artist || 'Неизвестный исполнитель';
    el.songInfoArtist.classList.add('inline-link');
    el.songInfoArtist.onclick = () => { closeSongInfo(); showArtist(track.artistId || '', track.artist || ''); };
    el.songInfoAlbum.textContent = track.album || '—';
    el.songInfoAlbum.classList.toggle('inline-link', !!track.albumId);
    el.songInfoAlbum.onclick = () => { if (track.albumId){ closeSongInfo(); showAlbum(track.albumId); } };
    el.songInfoMeta.textContent = [track.duration ? formatTime(track.duration) : '', track.bitrate ? track.bitrate + ' kbps' : '', track.releaseDate ? track.releaseDate.slice(0, 4) : ''].filter(Boolean).join(' · ') || '—';
    el.songInfoSource.textContent = track.source || 'CATALOG';
    el.songInfoSource.className = 'song-source song-source-' + sourceClass(track.source);
    el.songInfoFavorite.textContent = isFavorite(track) ? '♥ В избранном' : '♡ В избранное';
    el.songInfoModal.classList.add('open'); el.songInfoModal.setAttribute('aria-hidden', 'false');
  }
  function closeSongInfo(){ el.songInfoModal.classList.remove('open'); el.songInfoModal.setAttribute('aria-hidden', 'true'); }

  function resetProgressUI(){
    if (el.progress){ el.progress.value = 0; el.progress.style.setProperty('--progress', '0%'); }
    if (el.miniProgress){ el.miniProgress.value = 0; el.miniProgress.style.setProperty('--progress', '0%'); }
    if (el.currentTime) el.currentTime.textContent = '0:00';
    if (el.duration) el.duration.textContent = '0:00';
    if (el.miniTime) el.miniTime.textContent = '0:00 / 0:00';
  }

  async function playUrl(url, myId){
    if (audioGraphReady && state.currentTrack && state.playState === 'playing'){ await fadeOutAndWait(350); }
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
    el.audio.src = url;
    if (!audioGraphReady) el.audio.volume = state.volume / 100;
    el.audio.load();
    if (audioGraphReady && fadeGain && audioCtx && volumeGain){
      fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
      fadeGain.gain.value = 0;
      volumeGain.gain.cancelScheduledValues(audioCtx.currentTime);
      volumeGain.gain.value = state.volume / 100;
    }
    await new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => { el.audio.removeEventListener('playing', ok); el.audio.removeEventListener('error', bad); clearInterval(cancelTick); };
      const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
      const bad = () => { if (done) return; done = true; cleanup(); reject(new Error('audio error ' + (el.audio.error?.code || ''))); };
      el.audio.addEventListener('playing', ok, { once: true });
      el.audio.addEventListener('error', bad, { once: true });
      setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('timeout')); }, 25000);
      const cancelTick = setInterval(() => {
        if (myId !== undefined && myId !== playRequestId){
          if (done) return; done = true; cleanup();
          try { el.audio.pause(); } catch(_){}
          reject(new Error('Aborted'));
        }
      }, 100);
      el.audio.play().catch(bad);
    });
    if (audioGraphReady && fadeGain){ fadeIn(300); }
  }

  async function playStream(url, myId){
    if (!url) throw new Error('empty url');
    const ytMatch = String(url).match(/\/api\/audio\/youtube\/([A-Za-z0-9_-]{6,20})/);
    if (ytMatch){ await playYouTube(ytMatch[1], myId); return; }
    const wrap = document.getElementById('youtubePlayerWrap');
    if (wrap) wrap.innerHTML = '';
    ytIframe = null; ytCurrentVideo = '';
    await playUrl(url, myId);
  }

  async function playTrack(index, opts = {}){
    if (!Number.isInteger(index) || index < 0 || index >= state.tracks.length) return;
    const track = state.tracks[index];
    const isSame = state.currentTrack && (trackKey(track) === trackKey(state.currentTrack));
    const isPlayingOrPaused = (state.playState === 'playing' || state.playState === 'paused' || state.playState === 'buffering');
    if (isSame && isPlayingOrPaused && !opts.force){ openSongInfo(state.currentTrack); return; }
    const myId = ++playRequestId;
    if (playAbort){ try { playAbort.abort(); } catch (_){} }
    const controller = new AbortController();
    playAbort = controller;
    if (audioGraphReady && state.currentTrack && state.playState === 'playing'){ await fadeOutAndWait(350); }
    try { el.audio.pause(); } catch (_){}
    state.currentIndex = index;
    state.currentTrack = track;
    state.playState = 'loading';
    resetProgressUI();
    updateMiniPlayer(); updatePlayer(); updateInfoDrawer(); updatePlayButtons();

    // === ВАЖНО: init графа при каждом треке, чтобы эквалайзер работал ===
    initAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().then(() => applyEq()).catch(() => {});

    const title = String(track.title || '').trim();
    const artist = String(track.artist || '').trim();
    if (!title && !artist){ state.playState = 'error'; updatePlayButtons(); return; }
    const ck = normalizeSearch(title + ' ' + artist);
    let streamUrl = '';
    const local = localResolveCache.get(ck);
    if (local && Date.now() - local.time < LOCAL_RESOLVE_TTL) streamUrl = local.streamUrl;
    if (!streamUrl){
      try {
        const params = new URLSearchParams({ title, artist, duration: String(track.duration || 0) });
        const r = await fetch(apiBase() + '/api/audio/resolve?' + params.toString(), { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (myId !== playRequestId) return;
        const d = await r.json();
        if (r.ok && d.ok && d.streamUrl){ streamUrl = d.streamUrl; localResolveCache.set(ck, { time: Date.now(), streamUrl: d.streamUrl, provider: d.provider }); }
      } catch (e){ if (e.name === 'AbortError') return; console.warn('[resolve]', e.message); }
    }
    if (myId !== playRequestId) return;
    if (!streamUrl){ state.playState = 'error'; updatePlayButtons(); notify('Не удалось найти аудио'); return; }
    try {
      await playStream(streamUrl, myId);
      if (myId !== playRequestId) return;
      state.playState = 'playing';
      updatePlayButtons();
      addHistory(track); renderHome(); updateInfoDrawer(); updatePlayer();
      setTimeout(updateProgress, 100); setTimeout(updateProgress, 400); setTimeout(updateProgress, 1000);
      setTimeout(applyEq, 200);
    } catch (e){
      if (myId !== playRequestId) return;
      if (e.message === 'Aborted') return;
      console.warn('[play]', e.message);
      state.playState = 'error'; updatePlayButtons(); notify('Не удалось запустить трек');
    }
  }

  function playCurrentOrFirst(){
    initAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().then(() => applyEq()).catch(() => {});
    if (ytIframe && ytCurrentVideo){
      try {
        if (state.playState === 'playing'){ ytSendCommand('pauseVideo'); state.playState = 'paused'; }
        else { ytSendCommand('playVideo'); state.playState = 'playing'; }
        updatePlayButtons();
      } catch (_){}
      return;
    }
    if (state.currentTrack){
      if (state.playState === 'loading') return;
      if (el.audio.paused){
        if (audioGraphReady && fadeGain && audioCtx){
          fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
          fadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
          fadeGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.15);
        }
        el.audio.play().then(() => { state.playState = 'playing'; updatePlayButtons(); }).catch(() => playTrack(state.currentIndex, { force: true }));
      } else { el.audio.pause(); state.playState = 'paused'; updatePlayButtons(); }
      return;
    }
    if (state.tracks.length) playTrack(0);
  }
  function previous(){
    if (!state.tracks.length) return;
    if (el.audio.currentTime > 4){ el.audio.currentTime = 0; return; }
    let i = state.currentIndex - 1; if (i < 0) i = state.tracks.length - 1;
    playTrack(i, { force: true });
  }
  function next(){
    if (!state.tracks.length) return;
    if (state.shuffle){
      let ni = state.currentIndex;
      if (state.tracks.length > 1){ while (ni === state.currentIndex) ni = Math.floor(Math.random() * state.tracks.length); }
      playTrack(ni, { force: true }); return;
    }
    let ni = state.currentIndex + 1; if (ni >= state.tracks.length) ni = 0;
    playTrack(ni, { force: true });
  }
  function seekDelta(delta){
    if (ytIframe && ytCurrentVideo){
      const t = Math.max(0, ytVideoCurrentTime + delta);
      ytSendCommand('seekTo', [t, true]); ytVideoCurrentTime = t; updateProgress(); return;
    }
    if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
    el.audio.currentTime = Math.max(0, Math.min(el.audio.duration, (el.audio.currentTime || 0) + delta));
  }
  function toggleRepeat(){ state.repeat = !state.repeat; updateModeButtons(); notify(state.repeat ? 'Повтор включён' : 'Повтор выключен'); }
  function toggleShuffle(){ state.shuffle = !state.shuffle; updateModeButtons(); notify(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено'); }
  function updateModeButtons(){
    if (el.repeatBtn) el.repeatBtn.style.color = state.repeat ? 'var(--accent)' : '';
    if (el.miniRepeat) el.miniRepeat.classList.toggle('active', state.repeat);
    if (el.shuffleBtn) el.shuffleBtn.style.color = state.shuffle ? 'var(--accent)' : '';
    if (el.miniShuffle) el.miniShuffle.classList.toggle('active', state.shuffle);
  }
  function seekToValue(value0to1000){
    const pct = Number(value0to1000) / 1000;
    if (ytIframe && ytCurrentVideo && ytVideoDuration > 0){
      const t = ytVideoDuration * pct;
      ytSendCommand('seekTo', [t, true]); ytVideoCurrentTime = t; updateProgress(); return;
    }
    if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
    el.audio.currentTime = el.audio.duration * pct;
  }
  function seekFromProgress(){ seekToValue(el.progress.value); }
  function seekFromMiniProgress(){ seekToValue(el.miniProgress.value); }

  function updateProgress(){
    let c = 0, d = 0;
    if (ytIframe && ytCurrentVideo){ c = ytVideoCurrentTime; d = ytVideoDuration; }
    else { d = el.audio.duration; c = el.audio.currentTime || 0; }
    if (!Number.isFinite(d) || d <= 0){
      if (el.currentTime) el.currentTime.textContent = '0:00';
      if (el.duration) el.duration.textContent = '0:00';
      if (el.miniTime) el.miniTime.textContent = '0:00 / 0:00';
      return;
    }
    const p = Math.max(0, Math.min(100, c / d * 100));
    if (el.progress && !el.progress.matches(':active')){ el.progress.value = Math.round(p * 10); el.progress.style.setProperty('--progress', p + '%'); }
    if (el.currentTime) el.currentTime.textContent = formatTime(c);
    if (el.duration) el.duration.textContent = formatTime(d);
    if (el.miniProgress && !el.miniProgress.matches(':active')){ el.miniProgress.value = Math.round(p * 10); el.miniProgress.style.setProperty('--progress', p + '%'); }
    if (el.miniTime) el.miniTime.textContent = formatTime(c) + ' / ' + formatTime(d);
  }

  function setVolume(v){
    state.volume = Math.max(0, Math.min(100, Number(v) || 0));
    if (audioGraphReady && volumeGain && audioCtx){
      volumeGain.gain.setTargetAtTime(state.volume / 100, audioCtx.currentTime, 0.01);
    } else {
      el.audio.volume = state.volume / 100;
    }
    if (el.volumeMini) el.volumeMini.value = state.volume;
    if (el.volumeLarge) el.volumeLarge.value = state.volume;
    if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';
    if (ytIframe && ytCurrentVideo){ ytSendCommand('setVolume', [state.volume]); }
    try { store.set('nova_volume', String(state.volume)); } catch (_){}
  }

  function updateMiniPlayer(){
    const t = state.currentTrack;
    if (!t){ el.miniTitle.textContent = 'Ничего не играет'; el.miniArtist.textContent = '—'; el.miniCover.removeAttribute('src'); el.miniPlayer.classList.remove('visible'); return; }
    el.miniTitle.textContent = t.title || 'Без названия';
    el.miniArtist.textContent = t.artist || '—';
    if (coverFor(t)) el.miniCover.src = coverFor(t); else el.miniCover.removeAttribute('src');
    el.miniPlayer.classList.add('visible');
    if (el.miniFavorite){ if (isFavorite(t)) el.miniFavorite.classList.add('fav-active'); else el.miniFavorite.classList.remove('fav-active'); }
    if (el.miniRepeat) el.miniRepeat.classList.toggle('active', state.repeat);
    if (el.miniShuffle) el.miniShuffle.classList.toggle('active', state.shuffle);
    updatePlayButtons();
  }

  function updatePlayer(){
    const t = state.currentTrack;
    const placeholder = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420"><rect width="420" height="420" fill="#070707"/><text x="210" y="230" fill="#333" font-size="80" text-anchor="middle">♪</text></svg>');
    if (!t){
      el.nowTitle.textContent = 'Ничего не играет'; el.nowArtist.textContent = 'Выбери трек в поиске';
      el.bigCover.src = placeholder;
      el.duration.textContent = '0:00'; el.currentTime.textContent = '0:00';
      el.progress.value = 0; el.progress.style.setProperty('--progress', '0%');
      el.bigCover.style.display = '';
      return;
    }
    el.nowTitle.textContent = t.title || 'Без названия';
    el.nowArtist.textContent = t.artist || '—';
    el.nowArtist.classList.add('inline-link');
    el.nowArtist.onclick = () => showArtist(t.artistId || '', t.artist || '');
    el.nowTitle.classList.add('inline-link');
    el.nowTitle.onclick = () => openSongInfo(t);
    el.bigCover.style.display = '';
    const newCover = coverFor(t);
    if (newCover){
      el.bigCover.src = placeholder;
      const img = new Image();
      img.onload = () => { if (state.currentTrack === t) el.bigCover.src = newCover; };
      img.onerror = () => { if (state.currentTrack === t) el.bigCover.src = placeholder; };
      img.src = newCover;
    } else { el.bigCover.src = placeholder; }
    updateQueue(); updatePlayButtons();
  }
  function updateQueue(){
    if (!state.tracks.length || state.currentIndex < 0){ el.queueContent.textContent = 'Queue is empty'; return; }
    const q = state.tracks.slice(state.currentIndex + 1, state.currentIndex + 5).map(t => t.title);
    if (!q.length){ el.queueContent.textContent = 'Queue is empty'; return; }
    el.queueContent.innerHTML = q.map(t => '<strong>' + escapeHtml(t) + '</strong>').join('<br>');
  }
  function updatePlayButtons(){
    const isYt = !!(ytIframe && ytCurrentVideo);
    let playing;
    if (isYt){ playing = state.playState === 'playing'; }
    else { playing = !!state.currentTrack && state.playState === 'playing' && !el.audio.paused && el.audio.currentTime > 0; }
    const loading = state.playState === 'loading';
    [el.miniPlay, el.largePlayBtn].forEach(b => { if (b) b.classList.toggle('loading', loading); });
    if (!el.miniPlayIcon || !el.largePlayIcon) return;
    if (loading){
      const svg = '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="22 22"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite"/></circle>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg; return;
    }
    if (playing){
      const svg = '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg;
    } else {
      const svg = '<path d="M8 5v14l11-7z"/>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg;
    }
  }
  function updateInfoDrawer(){
    const t = state.currentTrack;
    if (!t){ el.infoTitle.textContent = 'Ничего не играет'; el.infoArtist.textContent = '—'; el.infoMeta.textContent = '—'; return; }
    el.infoTitle.textContent = t.title || 'Без названия';
    el.infoArtist.textContent = t.artist || '—';
    el.infoArtist.classList.add('inline-link');
    el.infoArtist.onclick = () => { closeInfoDrawer(); showArtist(t.artistId || '', t.artist || ''); };
    el.infoMeta.textContent = [t.album, t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · ') || 'Трек';
    if (t.cover) el.infoCover.src = t.cover; else el.infoCover.removeAttribute('src');
    el.infoFavorite.textContent = isFavorite(t) ? 'В избранном' : 'В избранное';
  }
  function openInfoDrawer(){ if (!state.currentTrack) return; updateInfoDrawer(); el.infoDrawer.classList.add('open'); el.infoDrawer.setAttribute('aria-hidden', 'false'); }
  function closeInfoDrawer(){ el.infoDrawer.classList.remove('open'); el.infoDrawer.setAttribute('aria-hidden', 'true'); }

  function showView(view){
    if (state.view && state.view !== view && view === 'player'){ previousView = state.view; }
    state.view = view;
    const views = { home: document.getElementById('homeView'), search: document.getElementById('searchView'), library: document.getElementById('libraryView'), favorites: document.getElementById('favoritesView'), settings: document.getElementById('settingsView'), player: document.getElementById('playerView'), artist: document.getElementById('artistView'), album: document.getElementById('albumView') };
    Object.keys(views).forEach(k => { if (views[k]) views[k].classList.toggle('hidden', k !== view); });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === (view === 'player' ? 'search' : view)));
    if (view === 'home') renderHome();
    if (view === 'library') renderLibrary();
    if (view === 'favorites') renderFavorites();
  }
  function showSearchView(){ showView('search'); }

  async function showArtist(id, name){
    showView('artist');
    el.artistHeroName.textContent = name || 'Исполнитель';
    el.artistHeroImage.removeAttribute('src');
    el.artistHeroMeta.innerHTML = '';
    el.artistBannerBg.style.backgroundImage = 'none';
    el.artistBannerBg.classList.remove('loaded');
    el.artistTracks.innerHTML = '<div class="empty">Загрузка…</div>';
    el.artistAlbums.innerHTML = '';
    el.artistSingles.innerHTML = '';
    el.artistShowAllBtn.classList.add('hidden');
    el.artistHeroImage.onload = () => {
      const src = el.artistHeroImage.src;
      if (!src) return;
      el.artistBannerBg.style.backgroundImage = 'url("' + src.replace(/"/g, '\\"') + '")';
      el.artistBannerBg.classList.add('loaded');
    };
    if (!name && !id){ el.artistTracks.innerHTML = '<div class="empty">Нет данных.</div>'; return; }
    try {
      let artistId = id;
      let artistPicture = '';
      if (!artistId && name){
        try {
          const sr = await fetch(apiBase() + '/api/artist-search?q=' + encodeURIComponent(name));
          const sd = await sr.json().catch(() => ({}));
          if (sr.ok && sd && sd.id){ artistId = sd.id; artistPicture = sd.picture || ''; }
        } catch (e){}
      }
      if (!artistId){
        el.artistHeroName.textContent = name || 'Исполнитель';
        if (artistPicture) el.artistHeroImage.src = artistPicture;
        el.artistTracks.innerHTML = '<div class="empty">Точных совпадений артиста не найдено.</div>';
        return;
      }
      const r = await fetch(apiBase() + '/api/artist/' + encodeURIComponent(artistId));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unavailable');
      const artist = d.artist || {};
      const pic = artist.picture_xl || artist.picture_big || artistPicture || '';
      el.artistHeroName.textContent = artist.name || name || 'Исполнитель';
      if (pic) el.artistHeroImage.src = pic;
      const meta = [];
      if (artist.nb_fan) meta.push('<span>❤ ' + formatNumber(artist.nb_fan) + ' фанатов</span>');
      if (d.top_tracks && d.top_tracks.length) meta.push('<span>♪ ' + d.top_tracks.length + ' треков в топе</span>');
      const totalReleases = (d.albums?.length || 0) + (d.singles?.length || 0);
      if (totalReleases) meta.push('<span>💿 ' + totalReleases + ' релизов</span>');
      el.artistHeroMeta.innerHTML = meta.join('');
      const allTracks = (d.top_tracks || []).map(normalizeTrack).filter(Boolean);
      const INITIAL = 5;
      let expanded = false;
      const renderTopTracks = () => { renderList(el.artistTracks, expanded ? allTracks : allTracks.slice(0, INITIAL)); };
      renderTopTracks();
      if (allTracks.length > INITIAL){
        el.artistShowAllBtn.classList.remove('hidden');
        el.artistShowAllBtn.textContent = 'Показать все (' + allTracks.length + ')';
        el.artistShowAllBtn.onclick = () => {
          expanded = !expanded;
          el.artistShowAllBtn.textContent = expanded ? 'Свернуть' : 'Показать все (' + allTracks.length + ')';
          renderTopTracks();
        };
      }
      const albums = (d.albums || []).filter(x => x.record_type !== 'single');
      el.artistAlbums.innerHTML = '';
      if (!albums.length) el.artistAlbums.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Альбомов нет</div></div>';
      else albums.forEach(a => el.artistAlbums.appendChild(makeHomeAlbumCard({ id: String(a.id), albumId: String(a.id), title: a.title, artist: artist.name || name, cover: a.cover_xl || a.cover_big || a.cover_medium || '' })));
      const singles = (d.singles || []);
      el.artistSingles.innerHTML = '';
      if (!singles.length) el.artistSingles.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Синглов нет</div></div>';
      else singles.forEach(a => el.artistSingles.appendChild(makeHomeAlbumCard({ id: String(a.id), albumId: String(a.id), title: a.title, artist: artist.name || name, cover: a.cover_xl || a.cover_big || a.cover_medium || '' })));
    } catch (e){ el.artistTracks.innerHTML = '<div class="empty">Не удалось загрузить данные артиста.</div>'; }
  }

  async function showAlbum(id){
    showView('album');
    el.albumTracks.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      const r = await fetch(apiBase() + '/api/album/' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unavailable');
      const raw = Array.isArray(d.tracks) ? d.tracks : (d.tracks?.data || []);
      el.albumHeroName.textContent = d.title || 'Альбом';
      el.albumHeroArtist.textContent = d.artist?.name || '—';
      el.albumHeroMeta.textContent = [d.release_date?.slice?.(0, 4), d.record_type, raw.length + ' треков'].filter(Boolean).join(' · ');
      if (d.cover_xl) el.albumHeroImage.src = d.cover_xl;
      const tracks = raw.map(normalizeTrack).filter(Boolean);
      el.albumTracks.innerHTML = '';
      tracks.forEach((t, i) => {
        const row = document.createElement('div'); row.className = 'list-row';
        row.innerHTML = '<div style="color:var(--text-dim);font-size:10px">' + String(i + 1).padStart(2, '0') + '</div><div class="list-main"><strong>' + escapeHtml(t.title) + '</strong><span>' + escapeHtml(t.artist) + '</span></div><div class="row-actions"><button class="small-btn">▶</button></div>';
        row.querySelector('button').onclick = e => { e.stopPropagation(); state.tracks = tracks.slice(); playTrack(i, { force: true }); showView('player'); };
        row.onclick = () => { state.tracks = tracks.slice(); playTrack(i); };
        el.albumTracks.appendChild(row);
      });
      el.albumPlay.onclick = () => { state.tracks = tracks.slice(); if (tracks.length) playTrack(0, { force: true }); };
    } catch (e){ el.albumTracks.innerHTML = '<div class="empty">Не удалось загрузить.</div>'; }
  }
  on(document.getElementById('artistBack'), 'click', () => showView('home'));
  on(document.getElementById('albumBack'), 'click', () => showView('home'));

  function renderList(container, list){
    container.innerHTML = '';
    if (!list.length){ container.innerHTML = '<div class="empty"><div>Здесь пока ничего нет.</div></div>'; return; }
    list.forEach(track => {
      const row = document.createElement('div'); row.className = 'list-row';
      const cover = document.createElement('img'); cover.className = 'list-cover'; cover.alt = '';
      if (track.cover) cover.src = track.cover;
      else { cover.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#111"/><text x="24" y="30" fill="#444" font-size="18" text-anchor="middle">♪</text></svg>'); }
      const main = document.createElement('div'); main.className = 'list-main';
      const t = document.createElement('strong'); t.textContent = track.title || 'Без названия';
      const a = document.createElement('span'); a.textContent = track.artist || '—';
      main.append(t, a);
      const actions = document.createElement('div'); actions.className = 'row-actions';
      const play = document.createElement('button'); play.className = 'small-btn'; play.textContent = '▶';
      const fav = document.createElement('button'); fav.className = 'small-btn'; fav.textContent = isFavorite(track) ? '♥' : '♡';
      play.addEventListener('click', e => { e.stopPropagation(); const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track)); if (i >= 0){ playTrack(i, { force: true }); showView('player'); } else { state.tracks = [track]; playTrack(0, { force: true }); } });
      fav.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(track); renderLibrary(); renderFavorites(); });
      actions.append(play, fav);
      row.append(cover, main, actions);
      row.addEventListener('click', () => { const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track)); if (i >= 0) playTrack(i); else { state.tracks = [track]; playTrack(0); } });
      container.appendChild(row);
    });
  }
  function renderLibrary(){ renderList(el.libraryList, state.history); }
  function renderFavorites(){ renderList(el.favoritesList, state.favorites); }

  async function downloadCurrent(){
    const track = state.currentTrack;
    if (!track){ notify('Нет трека'); return; }
    if (!track.downloadable || !track.downloadUrl){ notify('Скачивание недоступно'); return; }
    try {
      const r = await fetch(track.downloadUrl);
      if (!r.ok) throw new Error('dl');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (track.artist || 'Unknown') + ' - ' + (track.title || 'Track') + '.mp3';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      notify('Загрузка началась');
    } catch (e){ notify('Не удалось скачать'); }
  }
  async function showLyrics(){
    const track = state.currentTrack;
    if (!track){ notify('Сначала включи трек'); return; }
    el.lyricsTrackTitle.textContent = track.title || 'Текст';
    el.lyricsTrackArtist.textContent = track.artist || '—';
    el.lyricsBody.innerHTML = '<div class="lyrics-loading">Ищу текст…</div>';
    el.lyricsModal.classList.add('open'); el.lyricsModal.setAttribute('aria-hidden', 'false');
    try {
      const params = new URLSearchParams({ track_name: track.title || '', artist_name: track.artist || '' });
      if (track.album) params.set('album_name', track.album);
      if (track.duration > 0) params.set('duration', String(Math.round(track.duration)));
      const r = await fetch(apiBase() + '/api/lyrics?' + params.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d || !d.found) throw new Error('Текст не найден');
      const lyr = d.syncedLyrics || d.plainLyrics || '';
      if (!lyr.trim()) throw new Error('Текст не найден');
      el.lyricsBody.textContent = lyr;
    } catch (e){ el.lyricsBody.innerHTML = '<div class="lyrics-loading">' + escapeHtml(e.message || 'Текст не найден') + '</div>'; }
  }
  function closeLyrics(){ el.lyricsModal.classList.remove('open'); el.lyricsModal.setAttribute('aria-hidden', 'true'); }
  function findSimilar(){ if (!state.currentTrack){ notify('Сначала включи трек'); return; } const a = String(state.currentTrack.artist || '').trim(); if (!a) return; el.searchInput.value = a; showView('search'); search(a); }

  on(el.searchButton, 'click', () => search(el.searchInput.value));
  on(el.searchInput, 'keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); search(el.searchInput.value); } });
  document.querySelectorAll('.nav-btn').forEach(btn => { btn.addEventListener('click', () => { const v = btn.dataset.view; if (v === 'search'){ showSearchView(); el.searchInput.focus(); return; } showView(v); }); });
  on(document.getElementById('logoBtn'), 'click', () => showView('home'));
  on(el.avatarBtn, 'click', e => { e.stopPropagation(); if (!state.user){ openLoginModal(); return; } toggleUserMenu(); });
  on(el.userLoginBtn, 'click', () => { toggleUserMenu(false); openLoginModal(); });
  on(el.userLogoutBtn, 'click', () => logout());
  document.addEventListener('click', e => { if (!el.userMenu.contains(e.target) && e.target !== el.avatarBtn) toggleUserMenu(false); });
  on(el.loginClose, 'click', closeLoginModal);
  on(el.loginDiscordBtn, 'click', loginViaDiscord);
  on(el.loginModal, 'click', e => { if (e.target === el.loginModal) closeLoginModal(); });
  on(el.tabLogin, 'click', () => setAuthMode('login'));
  on(el.tabRegister, 'click', () => setAuthMode('register'));
  on(el.localAuthForm, 'submit', submitLocalAuth);
  on(el.continueAsGuest, 'click', closeLoginModal);
  on(el.openLocalFileBtn, 'click', openLocalAudioPicker);
  on(el.settingsOpenFileBtn, 'click', openLocalAudioPicker);
  on(el.backgroundBtn, 'click', openBackgroundPicker);
  on(el.backgroundResetBtn, 'click', resetBackground);
  on(el.backgroundInput, 'change', e => saveSelectedBackground(e.target.files?.[0]));
  on(el.localAudioInput, 'change', e => {
    const f = e.target.files?.[0]; if (!f) return;
    const url = URL.createObjectURL(f);
    const track = { id: 'local_' + Date.now(), title: f.name.replace(/\.[^.]+$/, ''), artist: 'Локальный файл', source: 'LOCAL', localUrl: url, duration: 0, provider: 'local' };
    state.tracks.unshift(track); playTrack(state.tracks.indexOf(track), { force: true });
  });
  on(el.infoDrawerClose, 'click', closeInfoDrawer);
  on(el.infoFavorite, 'click', () => { if (state.currentTrack){ toggleFavorite(state.currentTrack); updateInfoDrawer(); } });
  on(el.infoQueue, 'click', () => notify('Очередь в плеере'));
  on(el.songInfoClose, 'click', closeSongInfo);
  on(el.songInfoModal, 'click', e => { if (e.target === el.songInfoModal) closeSongInfo(); });
  on(el.songInfoPlay, 'click', () => { if (!songInfoCurrent) return; const i = state.tracks.findIndex(x => trackKey(x) === trackKey(songInfoCurrent)); if (i >= 0) playTrack(i, { force: true }); else { state.tracks.unshift(songInfoCurrent); playTrack(0, { force: true }); } closeSongInfo(); showView('player'); });
  on(el.songInfoFavorite, 'click', () => { if (!songInfoCurrent) return; toggleFavorite(songInfoCurrent); el.songInfoFavorite.textContent = isFavorite(songInfoCurrent) ? '♥ В избранном' : '♡ В избранное'; });
  on(el.songInfoDownload, 'click', () => { if (!songInfoCurrent) return; if (songInfoCurrent.downloadUrl){ const a = document.createElement('a'); a.href = songInfoCurrent.downloadUrl; a.download = ''; a.click(); } else notify('Скачивание недоступно'); });
  on(el.equalizerClose, 'click', closeEqualizer);
  on(el.equalizerModal, 'click', e => { if (e.target === el.equalizerModal) closeEqualizer(); });
  on(el.equalizerBtn, 'click', openEqualizer);
  on(el.miniPlay, 'click', playCurrentOrFirst);
  on(el.largePlayBtn, 'click', playCurrentOrFirst);
  on(el.miniPrev, 'click', previous);
  on(el.prevBtn, 'click', previous);
  on(el.miniNext, 'click', next);
  on(el.nextBtn, 'click', next);
  on(el.miniRepeat, 'click', toggleRepeat);
  on(el.repeatBtn, 'click', toggleRepeat);
  on(el.miniShuffle, 'click', toggleShuffle);
  on(el.shuffleBtn, 'click', toggleShuffle);
  on(el.miniFavorite, 'click', () => { if (state.currentTrack) toggleFavorite(state.currentTrack); });
  on(el.miniLyrics, 'click', showLyrics);
  on(el.miniExpand, 'click', () => showView('player'));
  on(el.miniTrackClick, 'click', () => { if (state.currentTrack) showView('player'); });
  on(el.progress, 'input', seekFromProgress);
  on(el.miniProgress, 'input', seekFromMiniProgress);
  on(el.downloadBtn, 'click', downloadCurrent);
  on(el.lyricsBtn, 'click', showLyrics);
  on(el.lyricsClose, 'click', closeLyrics);
  on(el.lyricsModal, 'click', e => { if (e.target === el.lyricsModal) closeLyrics(); });
  on(el.similarBtn, 'click', findSimilar);
  on(el.volumeLarge, 'input', () => setVolume(el.volumeLarge.value));
  on(el.volumeMini, 'input', () => setVolume(el.volumeMini.value));
  on(el.clearHistory, 'click', () => { state.history = []; persist(); renderLibrary(); notify('История очищена'); });
  on(el.clearFavorites, 'click', () => { state.favorites = []; persist(); renderFavorites(); notify('Избранное очищено'); });
  on(el.themeToggle, 'click', () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); });
  on(el.notificationsToggle, 'click', () => { settings.notifications = !settings.notifications; store.set('nova_notifications', settings.notifications ? '1' : '0'); applyToggle(el.notificationsToggle, settings.notifications); });
  on(el.hotkeysToggle, 'click', () => { settings.hotkeys = !settings.hotkeys; store.set('nova_hotkeys', settings.hotkeys ? '1' : '0'); applyToggle(el.hotkeysToggle, settings.hotkeys); });
  on(el.autoplayToggle, 'click', () => { settings.autoplay = !settings.autoplay; store.set('nova_autoplay', settings.autoplay ? '1' : '0'); applyToggle(el.autoplayToggle, settings.autoplay); });
  on(el.playerBack, 'click', () => showView(previousView || 'home'));

  on(el.audio, 'loadedmetadata', updateProgress);
  on(el.audio, 'durationchange', updateProgress);
  on(el.audio, 'timeupdate', updateProgress);
  on(el.audio, 'play', () => { state.playState = 'playing'; updatePlayButtons(); });
  on(el.audio, 'pause', () => { if (state.playState !== 'loading' && state.playState !== 'error') state.playState = 'paused'; updatePlayButtons(); });
  on(el.audio, 'playing', () => { state.playState = 'playing'; updatePlayButtons(); updateProgress(); });
  on(el.audio, 'waiting', () => { if (state.currentTrack){ state.playState = 'buffering'; updatePlayButtons(); } });

  let preEndFadeTriggered = false;
  on(el.audio, 'timeupdate', () => {
    const d = el.audio.duration;
    const c = el.audio.currentTime;
    if (!Number.isFinite(d) || d < 5) return;
    if (!preEndFadeTriggered && d - c < 1.2 && d - c > 0.2 && !state.repeat){ preEndFadeTriggered = true; rampFadeTo(0, 1000); }
  });
  on(el.audio, 'play', () => { preEndFadeTriggered = false; });
  on(el.audio, 'ended', () => {
    state.playState = 'idle';
    preEndFadeTriggered = false;
    if (state.repeat){ el.audio.currentTime = 0; rampFadeTo(1, 200); el.audio.play().catch(() => {}); return; }
    next();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape'){
      if (el.lyricsModal.classList.contains('open')) closeLyrics();
      if (el.songInfoModal.classList.contains('open')) closeSongInfo();
      if (el.equalizerModal.classList.contains('open')) closeEqualizer();
    }
  });
  document.addEventListener('keydown', e => {
    if (!settings.hotkeys) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space'){ e.preventDefault(); playCurrentOrFirst(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) next();
    else if (e.key === 'ArrowLeft' && e.shiftKey) previous();
    else if (e.key === 'ArrowRight' && e.altKey){ seekDelta(5); }
    else if (e.key === 'ArrowLeft' && e.altKey){ seekDelta(-5); }
    else if (e.key.toLowerCase() === 'm') setVolume(state.volume > 0 ? 0 : 100);
  });
  window.addEventListener('beforeunload', persist);

  setInterval(() => {
    if (ytIframe && ytCurrentVideo) { updateProgress(); return; }
    if (state.currentTrack && state.playState === 'playing') updateProgress();
  }, 500);

  applyTheme();
  applyToggle(el.notificationsToggle, settings.notifications);
  applyToggle(el.hotkeysToggle, settings.hotkeys);
  applyToggle(el.autoplayToggle, settings.autoplay);
  el.volumeLarge.value = state.volume;
  el.volumeMini.value = state.volume;
  el.audio.volume = state.volume / 100;
  if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';
  updateModeButtons(); updateMiniPlayer(); renderLibrary(); renderFavorites();
  checkApi(); setInterval(checkApi, 30000);
  el.searchInput.focus();

  const wasCallback = checkLoginCallback();
  setAuthMode('login');
  (async () => {
    if (authToken) await loadUserData(); else renderUser();
    if (wasCallback) closeLoginModal();
    setTimeout(() => { if (!state.user) openLoginModal(); }, 800);
  })();

  async function startup(){
    try {
      el.startupStatus.textContent = 'Восстанавливаем данные…';
      await loadSavedBackground();
      el.startupStatus.textContent = 'Проверяем NOVA…';
      await checkApi(true);
      el.startupStatus.textContent = 'Загружаем популярное…';
      await Promise.allSettled([loadPopular()]);
      renderHome();
    } catch (e){ console.error('[startup]', e); }
    finally { setTimeout(() => el.startupScreen.classList.add('hidden'), 250); }
  }
  async function loadPopular(){
    try { const r = await fetch(apiBase() + '/api/popular'); const d = await r.json(); state.popularTracks = (d.results || []).map(normalizeTrack).filter(Boolean); }
    catch (e){ console.warn('[popular]', e.message); }
  }
  startup();

  (function initWaves(){
    const canvas = document.getElementById('waveCanvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, raf = null, t = 0;
    function resize(){ const dpr = window.devicePixelRatio || 1; const rect = canvas.getBoundingClientRect(); W = rect.width; H = rect.height; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function getAccent(){ return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#a855f7'; }
    function draw(){
      ctx.clearRect(0, 0, W, H);
      const accent = getAccent();
      for (let i = 0; i < 4; i++){
        ctx.beginPath();
        const amp = 18 + i * 8, speed = 0.008 + i * 0.003, yBase = H * 0.6 + i * 18;
        for (let x = 0; x <= W; x += 6){ const y = yBase + Math.sin(x * 0.006 + t * speed * 10 + i) * amp + Math.sin(x * 0.014 + t * speed * 6 + i * 2) * (amp * 0.4); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.strokeStyle = accent; ctx.globalAlpha = 0.06 + i * 0.04; ctx.lineWidth = 2.5 - i * 0.4; ctx.stroke();
      }
      ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw);
    }
    function start(){ resize(); if (raf) cancelAnimationFrame(raf); draw(); }
    window.addEventListener('resize', resize); start();
  })();

  (function initAccentPicker(){
    const c = document.getElementById('accentPresets'); if (!c) return;
    const list = ['purple', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'rose', 'magenta', 'indigo', 'white'];
    c.innerHTML = '';
    const cur = document.documentElement.getAttribute('data-accent') || 'purple';
    list.forEach(a => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'accent-preset' + (a === cur ? ' active' : '');
      b.setAttribute('data-accent', a); b.title = a;
      b.addEventListener('click', () => { document.documentElement.setAttribute('data-accent', a); store.set('nova_accent', a); c.querySelectorAll('.accent-preset').forEach(x => x.classList.remove('active')); b.classList.add('active'); notify('Цвет: ' + a); });
      c.appendChild(b);
    });
  })();

  (function initSuggestions(){
    const input = document.getElementById('searchInput');
    const box = document.getElementById('searchSuggestions');
    if (!input || !box) return;
    let timer = null, lastQ = '', controller = null;
    function hide(){ box.classList.add('hidden'); box.innerHTML = ''; }
    function show(items){
      if (!items.length){ box.innerHTML = '<div class="suggestion-empty">Ничего не найдено</div>'; box.classList.remove('hidden'); return; }
      box.innerHTML = '';
      items.slice(0, 8).forEach((item, i) => {
        const s = document.createElement('div'); s.className = 'suggestion'; s.style.animationDelay = (i * 30) + 'ms';
        const fb = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#111"/></svg>');
        s.innerHTML = '<img src="' + (item.cover || fb) + '" alt=""><div class="suggestion-main"><div class="suggestion-title">' + escapeHtml(item.title || '') + '</div><div class="suggestion-artist">' + escapeHtml(item.artist || '—') + '</div></div><span class="suggestion-badge ' + (item.source === 'FULL' ? 'full' : '') + '">' + (item.source || 'CATALOG') + '</span>';
        s.addEventListener('mousedown', e => { e.preventDefault(); input.value = item.title + (item.artist ? ' ' + item.artist : ''); hide(); search(input.value); });
        box.appendChild(s);
      });
      box.classList.remove('hidden');
    }
    function trigger(){
      const q = input.value.trim();
      if (q.length < 2){ hide(); return; }
      if (q === lastQ) return;
      lastQ = q;
      if (controller) controller.abort();
      controller = new AbortController();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await fetch(apiBase() + '/api/search?q=' + encodeURIComponent(q), { signal: controller.signal });
          const d = await r.json();
          if (input.value.trim() !== q) return;
          show(d.results || []);
          if (d.results && d.results.length) prefetchTracks(d.results.slice(0, 6).map(normalizeTrack).filter(Boolean));
        } catch (e){ if (e.name !== 'AbortError') console.warn(e); }
      }, 250);
    }
    input.addEventListener('input', trigger);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') hide(); });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== input) hide(); });
  })();

  (function initBgPresets(){
    const c = document.getElementById('bgPresets'); if (!c) return;
    const presets = [
      { name: 'Космос', value: 'radial-gradient(ellipse at top,#1a1a3e 0%,#000 60%)' },
      { name: 'Закат', value: 'linear-gradient(135deg,#3a0d1f 0%,#1a0a14 50%,#000 100%)' },
      { name: 'Океан', value: 'linear-gradient(180deg,#001a2e 0%,#000 100%)' },
      { name: 'Лес', value: 'linear-gradient(180deg,#0a1a0a 0%,#000 100%)' },
      { name: 'Пурпур', value: 'radial-gradient(circle at bottom right,#3a0a3a 0%,#000 60%)' },
      { name: 'Графит', value: 'linear-gradient(180deg,#101010 0%,#000 100%)' }
    ];
    c.innerHTML = '';
    presets.forEach(p => {
      const b = document.createElement('div'); b.className = 'bg-preset'; b.title = p.name; b.style.background = p.value;
      b.addEventListener('click', () => { state.background.src = p.value; saveBackgroundData(p.value).catch(() => {}); applyBackground(p.value); notify('Фон: ' + p.name); });
      c.appendChild(b);
    });
  })();

})();
