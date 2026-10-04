(function () {
  'use strict';

  // ============================================================
  // PRECONNECT
  // ============================================================
  [['preconnect', 'https://www.youtube-nocookie.com'],
   ['preconnect', 'https://www.youtube.com'],
   ['dns-prefetch', 'https://i.ytimg.com'],
   ['dns-prefetch', 'https://e-cdns-images.dzcdn.net'],
   ['dns-prefetch', 'https://cdn-images.dzcdn.net']].forEach(([rel, href]) => {
    const l = document.createElement('link');
    l.rel = rel; l.href = href;
    if (rel === 'preconnect') l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
  });

  // ============================================================
  // STORE
  // ============================================================
  const memStore = Object.create(null);
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : v; } catch { return memStore[k] ?? f; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { memStore[k] = String(v); } },
    remove(k) { try { localStorage.removeItem(k); } catch { delete memStore[k]; } }
  };

  // ============================================================
  // STATE
  // ============================================================
  const API_TOKEN_KEY = 'nova_token';
  let authToken = store.get(API_TOKEN_KEY, '');

  let savedFavorites = [];
  let savedHistory = [];
  let savedUser = null;
  let savedLocalTracks = [];
  try { savedFavorites = JSON.parse(store.get('nova_favorites', '[]')); } catch { savedFavorites = []; }
  try { savedHistory = JSON.parse(store.get('nova_history', '[]')); } catch { savedHistory = []; }
  try { savedUser = JSON.parse(store.get('nova_user', 'null')); } catch { savedUser = null; }
  try { savedLocalTracks = JSON.parse(store.get('nova_local_tracks', '[]')); } catch { savedLocalTracks = []; }
  if (!Array.isArray(savedFavorites)) savedFavorites = [];
  if (!Array.isArray(savedHistory)) savedHistory = [];
  if (!Array.isArray(savedLocalTracks)) savedLocalTracks = [];

  document.documentElement.setAttribute('data-accent', store.get('nova_accent', 'purple'));

  const _v = Number(store.get('nova_volume', '100'));
  const initialVolume = Number.isFinite(_v) && _v >= 0 && _v <= 100 ? Math.round(_v) : 100;

  const state = {
    tracks: [],
    popularTracks: [],
    recommendations: [],
    currentIndex: -1,
    currentTrack: null,
    query: '',
    repeat: false,
    shuffle: false,
    smartShuffleQueue: [],
    shuffleHistory: [],
    favorites: savedFavorites,
    history: savedHistory,
    localTracks: savedLocalTracks,
    volume: initialVolume,
    view: 'home',
    previousView: 'home',
    lastNonPlayerView: 'home',
    searchRequest: 0,
    user: savedUser,
    background: { src: '' },
    queue: [],
    albumContext: null,
    playlists: [],
    currentPlaylistId: null,
    searchFilter: 'all',
    lastSearchArtists: [],
    lastSearchAlbums: [],
    eq: (() => {
      try {
        const raw = JSON.parse(store.get('nova_eq', '{"on":false,"bands":[0,0,0,0,0]}'));
        if (!raw || !Array.isArray(raw.bands) || raw.bands.length !== 5) return { on: false, bands: [0,0,0,0,0] };
        raw.on = raw.bands.some(x => Number(x) !== 0);
        return raw;
      } catch { return { on: false, bands: [0,0,0,0,0] }; }
    })()
  };

  const settings = {
    theme: store.get('nova_theme', 'dark'),
    notifications: store.get('nova_notifications', '1') === '1',
    hotkeys: store.get('nova_hotkeys', '1') === '1',
    autoplay: store.get('nova_autoplay', '1') === '1'
  };

  let ytIframe = null;
  let ytCurrentVideo = '';
  let ytVideoDuration = 0;
  let ytVideoCurrentTime = 0;
  let playRequestId = 0;
  let playAbort = null;
  let userIntent = 'idle';
  let ytPauseWatchdog = null;
  let mutedBefore = 100;
  let lastPlaybackError = '';
  let currentlyPreviewContext = null;

  const localResolveCache = new Map();
  const LOCAL_RESOLVE_TTL = 25 * 60 * 1000;
  const pendingPrefetches = new Set();

  // ============================================================
  // EL MAP
  // ============================================================
  function $(id) { return document.getElementById(id); }
  function safeEl(id) {
    let n = $(id);
    if (!n) { console.warn('[init] missing:', id); n = document.createElement('div'); n.style.display = 'none'; }
    return n;
  }
  const el = {};
  [
    // shell
    'sidebar','logoBtn','userSlot','avatarBtn','userMenu','userAvatar','userName','userTag','userLoginBtn','userLogoutBtn','openProfileBtn',
    'topbarBack','searchWrap','searchInput','searchSuggestions',
    // layers
    'backgroundLayer','backgroundShade','ambientGlow','startupScreen','startupStatus',
    'backgroundInput','localAudioInput',
    // login
    'loginModal','loginClose','loginDiscordBtn','loginTabs','tabLogin','tabRegister','localAuthForm',
    'authUsername','authPassword','authError','authSubmit','authSubmitText','continueAsGuest',
    // home
    'waveCanvas','homeGreeting','homeContinue','homeContinueSection','homeRecommendations','recommendationsSection','recommendationsSub',
    'homePopular','homePopularSection','homeArtists','artistsSection','homeAlbums','homeAlbumsSection',
    // search
    'searchFilters','resultsInfo','searchArtistsBlock','searchArtists','searchTracksBlock','searchTracksTitle','trackGrid',
    // artist
    'artistBanner','artistBannerBg','artistHeroImage','artistHeroName','artistHeroMeta','artistTracks','artistAlbums','artistSingles',
    'artistShowAllBtn','artistTracksSection','artistAlbumsSection','artistSinglesSection',
    // album
    'albumHeroImage','albumHeroType','albumHeroName','albumHeroArtist','albumHeroMeta','albumPlay','albumShuffle','albumAddToPlaylist','albumTracks',
    // library
    'libraryTabs','clearHistory','historyList','localList','localDrop','openLocalFileBtn',
    // favorites
    'favoritesPlay','favoritesShuffle','clearFavorites','favoritesList',
    // playlists
    'createPlaylistBtn','playlistsGrid',
    'playlistHeroImage','playlistHeroName','playlistHeroMeta','playlistPlay','playlistShuffle','playlistDelete','playlistTracks',
    // player
    'lyricsPanel','lyricsRefresh','lyricsInlineContent','bigCoverWrap','bigCover',
    'nowTitle','nowArtist','nowChips','progress','currentTime','duration',
    'downloadBtn','repeatBtn','prevBtn','largePlayBtn','largePlayIcon','nextBtn','shuffleBtn','favoriteBtn','queueToggleBtn','moreBtn',
    'volumeLarge','equalizerBtn','similarBtn','lyricsBtn',
    // settings
    'themeToggle','accentPresets','backgroundBtn','backgroundResetBtn','bgPresets','settingsVolumeValue',
    'autoplayToggle','notificationsToggle','hotkeysToggle','settingsOpenFileBtn',
    'settingsAccountName','settingsAccountHint','settingsAccountBtn',
    'clearHistory2','clearFavorites2','clearCacheBtn','diagnostics',
    // queue panel
    'queuePanel','queueClear','queueClose','queueContent',
    // mini player
    'miniPlayer','miniProgress','miniTrackClick','miniCover','miniTitle','miniArtist',
    'miniShuffle','miniPrev','miniPlay','miniPlayIcon','miniNext','miniRepeat',
    'miniTime','miniFavorite','miniLyrics','miniExpand','miniVolIcon','volumeMini',
    // modals
    'songInfoModal','songInfoClose','songInfoCover','songInfoSource','songInfoTitle','songInfoArtist','songInfoAlbum','songInfoMeta',
    'songInfoPlay','songInfoFavorite','songInfoQueue','songInfoDownload',
    'equalizerModal','equalizerClose','equalizerPresets','equalizerBands','eqNotice',
    'profileModal','profileModalClose','profileAvatarBig','profileName','profileTag','profileSummaryTitle',
    'statTracks','statArtists','statPlaylists','profileTopArtists','profileTopTracks',
    'playlistPickerModal','playlistPickerClose','playlistPickerList','playlistPickerNew',
    'playlistCreateModal','playlistCreateClose','playlistNameInput','playlistDescInput','playlistCreateSubmit',
    'contextMenu','toast',
    // audio
    'audio','youtubePlayerWrap'
  ].forEach(id => { el[id] = safeEl(id); });

  function on(node, ev, fn) { if (node && typeof node.addEventListener === 'function') node.addEventListener(ev, fn); }
  function apiBase() { return window.location.origin; }

  // ============================================================
  // CUSTOM CURSOR
  // ============================================================
  (function initCursor() {
    if (window.matchMedia && !window.matchMedia('(pointer: fine)').matches) return;
    const dot = document.createElement('div'); dot.className = 'nova-cursor-dot';
    const ring = document.createElement('div'); ring.className = 'nova-cursor-ring';
    const glow = document.createElement('div'); glow.className = 'nova-cursor-glow';
    document.body.append(glow, ring, dot);

    let visible = false, gx = 0, gy = 0, gtx = 0, gty = 0;
    function show() { if (visible) return; visible = true; dot.classList.add('visible'); ring.classList.add('visible'); glow.classList.add('visible'); }
    function hide() { visible = false; dot.classList.remove('visible'); ring.classList.remove('visible'); glow.classList.remove('visible'); }
    function tick() { gx += (gtx - gx) * 0.1; gy += (gty - gy) * 0.1; glow.style.transform = `translate3d(${gx - 90}px,${gy - 90}px,0)`; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
    window.addEventListener('mousemove', e => {
      const x = e.clientX, y = e.clientY; gtx = x; gty = y;
      dot.style.transform = `translate3d(${x - 3}px,${y - 3}px,0)`;
      ring.style.transform = `translate3d(${x - 14}px,${y - 14}px,0)`;
      if (!visible) { gx = x; gy = y; show(); }
    }, { passive: true });
    window.addEventListener('mouseleave', hide);
    window.addEventListener('mouseenter', show);
    window.addEventListener('blur', hide);
    function interactive(t) { return t?.closest && !!t.closest('button, a, input, textarea, select, .card, .home-mini-card, .list-row, .nav-btn, .queue-row, .suggestion, .eq-preset, .accent-preset, .bg-preset, .artist-link, .player-tab, .small-btn, .inline-control, .context-item, .playlist-card, .playlist-picker-item, .search-filter, .page-tab'); }
    function textInput(t) { return t?.closest && !!t.closest('input, textarea, [contenteditable="true"]'); }
    document.addEventListener('mouseover', e => {
      const t = e.target;
      if (textInput(t)) { ring.classList.add('typing'); ring.classList.remove('hover'); dot.classList.remove('hover'); glow.classList.remove('hover'); }
      else if (interactive(t)) { ring.classList.add('hover'); ring.classList.remove('typing'); dot.classList.add('hover'); glow.classList.add('hover'); }
      else { ring.classList.remove('hover', 'typing'); dot.classList.remove('hover'); glow.classList.remove('hover'); }
    });
    document.addEventListener('mousedown', () => { dot.classList.add('click'); ring.classList.add('click'); glow.classList.add('click'); });
    document.addEventListener('mouseup', () => { dot.classList.remove('click'); ring.classList.remove('click'); glow.classList.remove('click'); });
    document.documentElement.classList.add('nova-custom-cursor');
  })();

  // ============================================================
  // AUDIO GRAPH (EQ, fades, volume)
  // ============================================================
  let audioCtx = null, sourceNode = null, fadeGain = null, volumeGain = null, eqFilters = null, audioGraphReady = false;

  const EQ_BANDS = [
    { freq: 60, type: 'lowshelf', label: '60' },
    { freq: 230, type: 'peaking', label: '230' },
    { freq: 910, type: 'peaking', label: '910' },
    { freq: 3600, type: 'peaking', label: '3.6k' },
    { freq: 14000, type: 'highshelf', label: '14k' }
  ];
  const EQ_PRESETS = {
    'Flat': [0, 0, 0, 0, 0], 'Bass Boost': [12, 10, 4, 0, 0], 'Vocal': [-4, 0, 5, 7, 5],
    'Rock': [8, 5, -2, 5, 8], 'Pop': [-2, 4, 6, 4, -2], 'Jazz': [6, 3, -3, 3, 6],
    'Classical': [6, 3, 0, 3, 6], 'Loudness': [10, 7, 0, 5, 8]
  };

  function initAudioGraph() {
    if (audioGraphReady) {
      if (audioCtx?.state === 'suspended') audioCtx.resume().then(applyEq).catch(() => {});
      else applyEq();
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(el.audio);
      fadeGain = audioCtx.createGain(); fadeGain.gain.value = 1;
      volumeGain = audioCtx.createGain(); volumeGain.gain.value = state.volume / 100;
      eqFilters = EQ_BANDS.map(b => {
        const f = audioCtx.createBiquadFilter();
        f.type = b.type; f.frequency.value = b.freq;
        if (b.type === 'peaking') f.Q.value = 1.0;
        f.gain.value = 0; return f;
      });
      sourceNode.connect(fadeGain);
      fadeGain.connect(volumeGain);
      let prev = volumeGain;
      eqFilters.forEach(f => { prev.connect(f); prev = f; });
      prev.connect(audioCtx.destination);
      audioGraphReady = true; applyEq();
      if (audioCtx.state === 'suspended') audioCtx.resume().then(applyEq).catch(() => {});
    } catch { audioGraphReady = false; audioCtx = fadeGain = volumeGain = eqFilters = null; }
  }
  function applyEq() {
    if (!eqFilters || !audioGraphReady || !audioCtx) return;
    const on = state.eq.on;
    state.eq.bands.forEach((g, i) => {
      if (!eqFilters[i]) return;
      const target = on ? Number(g) : 0;
      eqFilters[i].gain.cancelScheduledValues(audioCtx.currentTime);
      eqFilters[i].gain.setValueAtTime(target, audioCtx.currentTime);
    });
  }
  function rampFadeTo(t, ms) {
    if (!audioGraphReady || !fadeGain || !audioCtx) return;
    const now = audioCtx.currentTime;
    fadeGain.gain.cancelScheduledValues(now);
    fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
    fadeGain.gain.linearRampToValueAtTime(t, now + ms / 1000);
  }
  function fadeOutAndWait(ms) { if (!audioGraphReady || !fadeGain || !audioCtx) return Promise.resolve(); rampFadeTo(0, ms); return new Promise(r => setTimeout(r, ms + 20)); }
  function fadeIn(ms) {
    if (!audioGraphReady || !fadeGain || !audioCtx) return;
    fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
    fadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
    fadeGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + ms / 1000);
  }
  function setEqBand(i, v) {
    state.eq.bands[i] = Number(v);
    state.eq.on = state.eq.bands.some(x => Number(x) !== 0);
    store.set('nova_eq', JSON.stringify(state.eq));
    if (!audioGraphReady) initAudioGraph();
    applyEq();
  }
  function applyEqPreset(n) {
    const p = EQ_PRESETS[n]; if (!p) return;
    state.eq.bands = p.slice();
    state.eq.on = p.some(x => Number(x) !== 0);
    store.set('nova_eq', JSON.stringify(state.eq));
    if (!audioGraphReady) initAudioGraph();
    applyEq(); renderEqBands();
  }

  // ============================================================
  // HELPERS
  // ============================================================
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const sec = Math.floor(s), m = Math.floor(sec / 60), r = String(sec % 60).padStart(2, '0');
    return `${m}:${r}`;
  }
  function formatNumber(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function trackKey(t) { return [t.provider || t.source || '', t.providerId || t.id || '', t.title || '', t.artist || ''].join('|'); }
  function coverFor(t) { return t?.cover || ''; }
  function normalizeSearch(v) {
    return String(v || '').toLowerCase().replace(/[’'`´]/g, '').replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function cleanTitleLocal(t) {
    if (!t) return '';
    return String(t).replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/#\S+/g, ' ')
      .replace(/\b(official|lyric|lyrics|video|audio|visualizer|hd|hq|4k|prod\.?|explicit|clean|mv|m\/v)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function splitArtistsList(raw) {
    if (!raw) return [];
    return String(raw).split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b)\s*/i)
      .map(s => s.trim()).filter(Boolean);
  }
  function artistsHtml(s) {
    const parts = splitArtistsList(s);
    if (!parts.length) return '—';
    return parts.map(a => `<a class="artist-link" data-artist="${escapeHtml(a)}" href="javascript:void(0)">${escapeHtml(a)}</a>`).join(', ');
  }
  function isFavorite(t) { const k = trackKey(t); return state.favorites.some(x => trackKey(x) === k); }
  function persist() {
    store.set('nova_favorites', JSON.stringify(state.favorites.slice(0, 500)));
    store.set('nova_history', JSON.stringify(state.history.slice(0, 500)));
    store.set('nova_local_tracks', JSON.stringify(state.localTracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album || '',
      duration: t.duration || 0, provider: 'local', source: 'LOCAL',
      localUrl: t.localUrl || '', filePath: t.filePath || '', cover: t.cover || ''
    }))));
    store.set('nova_volume', String(state.volume));
    store.set('nova_eq', JSON.stringify(state.eq));
  }
  function notify(msg, kind) {
    if (!settings.notifications && kind !== 'error') return;
    el.toast.textContent = msg;
    el.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(notify._t);
    notify._t = setTimeout(() => { el.toast.className = 'toast'; }, 2600);
  }
  function setConnection(ok, msg) {
    // Не показываем пользователю в новом UI, только внутренний лог
    console.debug('[conn]', ok ? 'ok' : 'bad', msg);
  }

  // ============================================================
  // API
  // ============================================================
  async function apiAuth(path, opts = {}) {
    const headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + authToken };
    const r = await fetch(apiBase() + path, { ...opts, headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function checkApi(silent) {
    try {
      const r = await fetch(apiBase() + '/api/health');
      if (!r.ok) throw new Error('health');
      setConnection(true, 'online');
      return true;
    } catch { setConnection(false, 'offline'); return false; }
  }

  // ============================================================
  // NORMALIZE
  // ============================================================
  function normalizeTrack(t) {
    if (!t) return null;
    const artistObj = (t.artist && typeof t.artist === 'object') ? t.artist : null;
    const albumObj = (t.album && typeof t.album === 'object') ? t.album : null;
    const artistName = artistObj ? (artistObj.name || '') : (t.artistName || t.artist || '');
    const artistId = artistObj ? String(artistObj.id || '') : String(t.artistId || '');
    const albumTitle = albumObj ? (albumObj.title || '') : (t.albumName || t.collectionName || t.album || '');
    const albumId = albumObj ? String(albumObj.id || '') : String(t.albumId || '');
    const cover = t.cover || t.artwork || t.artworkUrl100 ||
      (albumObj && (albumObj.cover_xl || albumObj.cover_big || albumObj.cover_medium)) || '';
    return {
      id: t.id || t.providerId || cryptoLike(t),
      providerId: t.providerId || t.id || '',
      provider: t.provider || '',
      title: t.title || t.trackName || t.name || 'Без названия',
      artist: artistName, artistId, cover,
      source: String(t.source || 'CATALOG').toUpperCase(),
      album: albumTitle, albumId,
      duration: Number(t.duration || 0),
      popularity: Number(t.popularity || 0),
      explicit: !!t.explicit,
      sourceUrl: t.sourceUrl || t.link || '',
      releaseDate: t.releaseDate || '',
      localUrl: t.localUrl || '',
      videoId: t.videoId || '',
      downloadable: !!t.downloadable,
      downloadUrl: t.downloadUrl || '',
      _resolveData: t._resolveData || null
    };
  }
  function cryptoLike(t) {
    const s = [t.title || '', t.artist || '', t.provider || t.source || ''].join('|');
    let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return 't_' + Math.abs(h);
  }

  // ============================================================
  // AMBIENT GLOW (из обложки)
  // ============================================================
  const ambientCache = new Map();
  function updateAmbientFromCover(url) {
    if (!url) { document.body.classList.remove('has-ambient'); return; }
    if (ambientCache.has(url)) { applyAmbient(ambientCache.get(url)); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 24;
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 128) continue;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (!n) { ambientCache.set(url, null); document.body.classList.remove('has-ambient'); return; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        ambientCache.set(url, [r, g, b]);
        applyAmbient([r, g, b]);
      } catch { document.body.classList.remove('has-ambient'); }
    };
    img.onerror = () => document.body.classList.remove('has-ambient');
    img.src = url;
  }
  function applyAmbient(rgb) {
    if (!rgb) return;
    document.documentElement.style.setProperty('--glow', rgb.join(','));
    document.body.classList.add('has-ambient');
  }

  // ============================================================
  // USER
  // ============================================================
  function avatarUrl(u) {
    if (!u) return '';
    if (!u.avatar) {
      const idx = u.id && /^\d+$/.test(u.id) ? Number(BigInt(u.id) >> 22n) % 6 : 0;
      return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    }
    const ext = String(u.avatar).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
  }
  function defaultAvatarSvg() {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#141414"/><circle cx="32" cy="24" r="10" fill="#3a3a3a"/><path d="M12 56c3-12 11-17 20-17s17 5 20 17z" fill="#3a3a3a"/></svg>');
  }
  function renderUser() {
    const u = state.user;
    if (u) {
      el.avatarBtn.classList.add('logged-in');
      const url = u.provider === 'discord' ? avatarUrl(u) : defaultAvatarSvg();
      el.avatarBtn.innerHTML = `<img src="${url}" alt="">`;
      el.userAvatar.src = url;
      el.userName.textContent = u.username || 'User';
      el.userTag.textContent = u.provider === 'discord' ? 'Discord аккаунт' : 'Локальный аккаунт';
      el.userLoginBtn.style.display = 'none';
      el.userLogoutBtn.style.display = 'flex';
      el.homeGreeting.textContent = 'С возвращением, ' + (u.username || 'User') + '!';
      if (el.settingsAccountName) el.settingsAccountName.textContent = u.username || 'User';
      if (el.settingsAccountHint) el.settingsAccountHint.textContent = u.provider === 'discord' ? 'Discord аккаунт' : 'Локальный аккаунт';
      if (el.settingsAccountBtn) el.settingsAccountBtn.textContent = 'Выйти';
    } else {
      el.avatarBtn.classList.remove('logged-in');
      el.avatarBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c.9-3.7 3.1-5.5 7-5.5s6.1 1.8 7 5.5"/></svg>';
      el.userAvatar.removeAttribute('src');
      el.userName.textContent = 'Гость';
      el.userTag.textContent = 'не авторизован';
      el.userLoginBtn.style.display = 'flex';
      el.userLogoutBtn.style.display = 'none';
      el.homeGreeting.textContent = 'Добро пожаловать в NOVA';
      if (el.settingsAccountName) el.settingsAccountName.textContent = 'Гость';
      if (el.settingsAccountHint) el.settingsAccountHint.textContent = 'Не авторизован';
      if (el.settingsAccountBtn) el.settingsAccountBtn.textContent = 'Войти';
    }
  }
  function openLoginModal() { el.loginModal.classList.add('open'); el.loginModal.setAttribute('aria-hidden', 'false'); }
  function closeLoginModal() { el.loginModal.classList.remove('open'); el.loginModal.setAttribute('aria-hidden', 'true'); }
  function toggleUserMenu(force) {
    const o = force !== undefined ? force : !el.userMenu.classList.contains('open');
    el.userMenu.classList.toggle('open', o);
  }
  async function loadUserData() {
    if (!authToken) return;
    try {
      const [me, favs, hist, pls] = await Promise.all([
        apiAuth('/api/me').catch(() => null),
        apiAuth('/api/favorites').catch(() => []),
        apiAuth('/api/history').catch(() => []),
        apiAuth('/api/playlists').catch(() => [])
      ]);
      if (me) state.user = me;
      if (Array.isArray(favs)) state.favorites = favs;
      if (Array.isArray(hist)) state.history = hist;
      if (Array.isArray(pls)) state.playlists = pls;
      if (me) store.set('nova_user', JSON.stringify(me));
      renderUser(); renderFavorites(); renderHistory(); renderPlaylists();
      loadRecommendations();
      refreshDiagnostics();
    } catch {
      authToken = ''; store.remove(API_TOKEN_KEY); state.user = null;
      renderUser();
    }
  }
  function logout() {
    authToken = ''; store.remove(API_TOKEN_KEY); store.remove('nova_user');
    state.user = null; state.favorites = []; state.history = [];
    state.recommendations = []; state.queue = []; state.playlists = [];
    persist(); renderUser(); renderFavorites(); renderHistory(); renderPlaylists();
    updateQueue(); renderHome(); notify('Вы вышли');
    toggleUserMenu(false); refreshDiagnostics();
  }
  function loginViaDiscord() { window.location.href = '/api/auth/discord'; }
  function checkLoginCallback() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('login') !== 'success') return false;
    const t = p.get('token'); if (!t) return false;
    authToken = t; store.set(API_TOKEN_KEY, t);
    window.history.replaceState({}, '', '/');
    return true;
  }
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    el.tabLogin.classList.toggle('active', mode === 'login');
    el.tabRegister.classList.toggle('active', mode === 'register');
    if (el.authSubmitText) el.authSubmitText.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    el.authUsername.value = ''; el.authPassword.value = '';
    el.authError.classList.add('hidden'); el.authError.textContent = '';
  }
  function showAuthError(m) { el.authError.textContent = m; el.authError.classList.remove('hidden'); }
  async function submitLocalAuth(e) {
    e.preventDefault();
    const u = el.authUsername.value.trim(), p = el.authPassword.value;
    if (!u || !p) { showAuthError('Заполни оба поля'); return; }
    el.authSubmit.disabled = true;
    if (el.authSubmitText) el.authSubmitText.textContent = 'Загрузка…';
    try {
      const url = authMode === 'register' ? '/api/register' : '/api/login';
      const r = await fetch(apiBase() + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Ошибка');
      authToken = d.token; store.set(API_TOKEN_KEY, d.token);
      state.user = d.user; store.set('nova_user', JSON.stringify(d.user));
      await loadUserData();
      closeLoginModal(); renderUser();
    } catch (err) { showAuthError(err.message || 'Ошибка входа'); }
    finally {
      el.authSubmit.disabled = false;
      if (el.authSubmitText) el.authSubmitText.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  }

  // ============================================================
  // BACKGROUND
  // ============================================================
  let backgroundDbPromise = null;
  function backgroundDb() {
    if (backgroundDbPromise) return backgroundDbPromise;
    backgroundDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('nova-settings', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('settings')) req.result.createObjectStore('settings'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return backgroundDbPromise;
  }
  async function saveBgData(v) {
    try {
      const db = await backgroundDb();
      await new Promise((res, rej) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(v, 'background');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch { try { store.set('nova_background_fallback', v); } catch {} }
  }
  async function loadBgData() {
    try {
      const db = await backgroundDb();
      return await new Promise((res, rej) => {
        const tx = db.transaction('settings', 'readonly');
        const r = tx.objectStore('settings').get('background');
        r.onsuccess = () => res(r.result || '');
        r.onerror = () => rej(r.error);
      });
    } catch { return store.get('nova_background_fallback', ''); }
  }
  function applyBackground(src) {
    if (!src) {
      document.body.classList.remove('has-background');
      el.backgroundLayer.style.backgroundImage = 'none';
      el.backgroundLayer.style.background = '#000';
      el.backgroundLayer.style.opacity = '0';
      return;
    }
    document.body.classList.add('has-background');
    if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('/')) {
      el.backgroundLayer.style.background = '#000 center/cover no-repeat';
      el.backgroundLayer.style.backgroundImage = `url("${src.replace(/"/g, '\\"')}")`;
    } else {
      el.backgroundLayer.style.backgroundImage = 'none';
      el.backgroundLayer.style.background = src;
    }
    el.backgroundLayer.style.opacity = '1';
  }
  async function loadSavedBackground() {
    const src = await loadBgData();
    if (src) { state.background.src = src; applyBackground(src); }
  }
  async function saveSelectedBackground(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return notify('Поддерживаются PNG, JPG, WEBP и GIF');
    const reader = new FileReader();
    reader.onload = async () => {
      state.background.src = String(reader.result || '');
      await saveBgData(state.background.src);
      applyBackground(state.background.src);
      notify('Фон изменён');
    };
    reader.readAsDataURL(file);
  }
  function resetBackground() {
    state.background.src = '';
    saveBgData('').catch(() => {});
    applyBackground('');
    notify('Фон сброшен');
  }

  // ============================================================
  // YOUTUBE
  // ============================================================
  function ytSendCommand(func, args) {
    if (!ytIframe || !ytIframe.contentWindow) return false;
    try { ytIframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*'); return true; }
    catch { return false; }
  }
  function ytPlay() { userIntent = 'playing'; ytStopPauseWatchdog(); ytSendCommand('playVideo'); }
  function ytStartPauseWatchdog() {
    if (ytPauseWatchdog) return;
    ytPauseWatchdog = setInterval(() => {
      if (!ytIframe || !ytCurrentVideo) { ytStopPauseWatchdog(); return; }
      if (userIntent !== 'paused') { ytStopPauseWatchdog(); return; }
      ytSendCommand('pauseVideo');
    }, 200);
  }
  function ytStopPauseWatchdog() { if (ytPauseWatchdog) { clearInterval(ytPauseWatchdog); ytPauseWatchdog = null; } }

  window.addEventListener('message', e => {
    if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin || '')) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!data || !data.event) return;
    if (data.event === 'onReady') {
      if (userIntent === 'playing' || userIntent === 'loading') { ytSendCommand('playVideo'); ytSendCommand('setVolume', [state.volume]); }
    }
    if (data.event === 'onStateChange') {
      const s = data.info;
      if (s === 1) { if (userIntent === 'paused') { ytSendCommand('pauseVideo'); return; } if (userIntent !== 'playing') { userIntent = 'playing'; updatePlayButtons(); } }
      else if (s === 2) { if (userIntent === 'paused') return; if (userIntent === 'playing') ytSendCommand('playVideo'); }
      else if (s === 0) { if (userIntent === 'playing') { state.repeat ? (ytSendCommand('seekTo', [0, true]), ytPlay()) : next(); } }
      else if (s === -1) { if (userIntent === 'playing') ytSendCommand('playVideo'); }
    }
    if (data.event === 'infoDelivery' && data.info) {
      if (typeof data.info.currentTime === 'number') ytVideoCurrentTime = data.info.currentTime;
      if (typeof data.info.duration === 'number' && data.info.duration > 0) ytVideoDuration = data.info.duration;
      updateProgress();
    }
  });

  function playYouTube(videoId, myId) {
    return new Promise((resolve, reject) => {
      const wrap = el.youtubePlayerWrap;
      if (!wrap) return reject(new Error('no youtube wrap'));
      wrap.innerHTML = '';
      ytIframe = null; ytCurrentVideo = videoId; ytVideoDuration = 0; ytVideoCurrentTime = 0;
      ytStopPauseWatchdog();
      try { el.audio.pause(); } catch {}
      el.audio.removeAttribute('src'); el.audio.load();

      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'autoplay; encrypted-media');
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000;';
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&enablejsapi=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&fs=0&disablekb=1&hl=en&origin=${encodeURIComponent(location.origin)}`;

      let resolved = false;
      const finish = (err) => {
        if (resolved) return; resolved = true;
        if (myId !== undefined && myId !== playRequestId) { reject(new Error('Aborted')); return; }
        err ? reject(err) : resolve();
      };
      const handshake = () => {
        try {
          if (myId !== undefined && myId !== playRequestId) return;
          iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'nova' }), '*');
          ['onReady', 'onStateChange', 'infoDelivery'].forEach(ev =>
            iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: [ev] }), '*'));
        } catch {}
      };
      const tryPlay = () => {
        if (myId !== undefined && myId !== playRequestId) return;
        if (userIntent === 'paused') { ytSendCommand('pauseVideo'); return; }
        ytSendCommand('playVideo');
        ytSendCommand('setVolume', [state.volume]);
        ytSendCommand('unMute');
      };
      iframe.addEventListener('load', () => {
        handshake(); tryPlay();
        [60, 200, 600, 1200].forEach(t => setTimeout(() => { handshake(); tryPlay(); }, t));
        setTimeout(() => finish(), 500);
      });
      iframe.addEventListener('error', () => finish(new Error('iframe load error')));
      wrap.appendChild(iframe);
      ytIframe = iframe;
      setTimeout(() => finish(), 8000);
    });
  }

  // ============================================================
  // PLAYBACK RESOLVE (provider-based)
  // ============================================================
  async function resolvePlaybackServer(track, signal) {
    // 1. Direct playable: local или Audius с providerId
    if (track.provider === 'audius' && track.providerId)
      return { provider: 'audius', kind: 'audius', url: '/api/audio/audius/' + encodeURIComponent(track.providerId) };
    if (track.provider === 'youtube' && track.videoId)
      return { provider: 'youtube', kind: 'youtube', videoId: track.videoId, url: '/api/audio/youtube/' + encodeURIComponent(track.videoId) };
    if (track.source === 'LOCAL' && track.localUrl)
      return { provider: 'local', kind: 'local', url: track.localUrl };

    // 2. POST /api/playback/resolve
    try {
      const r = await fetch(apiBase() + '/api/playback/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: track.title, artist: track.artist, duration: track.duration,
          provider: track.provider, providerId: track.providerId, videoId: track.videoId
        }),
        signal
      });
      if (r.ok) {
        const d = await r.json();
        if (d.url) return d;
      }
    } catch (e) { if (e.name === 'AbortError') throw e; }

    // 3. Fallback: старый GET /api/audio/resolve
    try {
      const params = new URLSearchParams({
        title: cleanTitleLocal(track.title) || track.title,
        artist: splitArtistsList(track.artist)[0] || track.artist || '',
        duration: String(track.duration || 0)
      });
      const r = await fetch(apiBase() + '/api/audio/resolve?' + params, { signal });
      if (r.ok) {
        const d = await r.json();
        if (d.ok && d.streamUrl) return { ...d, url: d.streamUrl, kind: d.provider === 'audius' ? 'audius' : 'youtube', videoId: d.videoId };
      }
    } catch (e) { if (e.name === 'AbortError') throw e; }

    throw new Error('Не удалось найти источник воспроизведения');
  }

  // ============================================================
  // HOME
  // ============================================================
  function renderHome() {
    // continue listening
    const recent = state.history.slice(0, 8);
    el.homeContinue.innerHTML = '';
    if (!recent.length) {
      el.homeContinue.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Начни слушать музыку</div></div>';
    } else recent.forEach(t => el.homeContinue.appendChild(makeMiniCard(t, 'track')));
    el.homeContinueSection.style.display = '';

    // recommendations
    if (state.user && state.recommendations.length) {
      el.recommendationsSection.style.display = '';
      el.homeRecommendations.innerHTML = '';
      state.recommendations.slice(0, 12).forEach(t => el.homeRecommendations.appendChild(makeMiniCard(t, 'track')));
    } else el.recommendationsSection.style.display = 'none';

    // popular
    const popular = state.popularTracks.length ? state.popularTracks : state.tracks.slice(0, 12);
    el.homePopular.innerHTML = '';
    if (popular.length) popular.slice(0, 12).forEach(t => el.homePopular.appendChild(makeMiniCard(t, 'track')));
    else el.homePopular.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Пока пусто</div></div>';
    setTimeout(() => prefetchTracks(popular.slice(0, 6)), 500);

    // artists & albums (from search)
    const artists = [], seenA = new Set();
    const albums = [], seenAl = new Set();
    for (const t of state.tracks) {
      const ak = normalizeSearch(t.artist);
      if (ak && !seenA.has(ak) && !isBadArtist(t.artist)) {
        seenA.add(ak); artists.push(t);
        if (artists.length >= 10) break;
      }
    }
    for (const t of state.tracks) {
      if (!t.albumId && !t.album) continue;
      const k = normalizeSearch(t.album + '|' + t.artist);
      if (!seenAl.has(k)) { seenAl.add(k); albums.push(t); if (albums.length >= 10) break; }
    }
    el.artistsSection.style.display = artists.length ? '' : 'none';
    if (artists.length) {
      el.homeArtists.innerHTML = '';
      artists.forEach(t => el.homeArtists.appendChild(makeMiniCard(t, 'artist')));
    }
    el.homeAlbumsSection.style.display = albums.length ? '' : 'none';
    if (albums.length) {
      el.homeAlbums.innerHTML = '';
      albums.forEach(t => el.homeAlbums.appendChild(makeMiniCard(t, 'album')));
    }
  }
  function isBadArtist(n) {
    const x = normalizeSearch(n);
    return !x || /^(unknown( artist)?|various artists|no name|без названия|null|undefined)$/i.test(x);
  }
  function placeholderCover() {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#0a0a0a"/><text x="150" y="168" fill="#2e2e2e" font-size="72" text-anchor="middle">♪</text></svg>');
  }
  function makeMiniCard(track, kind) {
    const d = document.createElement('div');
    d.className = 'home-mini-card';
    const img = document.createElement('img');
    img.className = 'home-mini-cover';
    img.alt = '';
    img.src = track.cover || placeholderCover();
    img.onerror = () => { img.src = placeholderCover(); };
    const t = document.createElement('div');
    t.className = 'home-mini-title';
    t.textContent = track.title || track.album || '—';
    const s = document.createElement('div');
    s.className = 'home-mini-sub';
    s.innerHTML = kind === 'artist' ? 'Исполнитель' : kind === 'album' ? (track.artist || 'Альбом') : artistsHtml(track.artist);
    d.append(img, t, s);
    if (kind === 'artist') {
      d.addEventListener('click', () => showArtist(track.artistId || '', track.artist || ''));
    } else if (kind === 'album') {
      d.addEventListener('click', () => { if (track.albumId) showAlbum(track.albumId); else if (track.album) notify('Альбом недоступен'); });
    } else {
      d.addEventListener('click', () => playByTrackObject(track));
      d.addEventListener('mouseenter', () => prefetchTrack(track), { once: true });
    }
    return d;
  }
  function playByTrackObject(track) {
    const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
    if (i >= 0) playTrack(i);
    else { state.tracks = [track]; playTrack(0); }
  }

  // ============================================================
  // SEARCH
  // ============================================================
  let searchAbort = null;
  let searchDebounce = null;
  function sortSearchResults(list, q) {
    return list.map((t, i) => ({ t, i, s: searchScore(t, q) }))
      .sort((a, b) => b.s !== a.s ? b.s - a.s : a.i - b.i).map(x => x.t);
  }
  function searchScore(track, query) {
    const q = normalizeSearch(query), ti = normalizeSearch(track.title), ar = normalizeSearch(track.artist);
    if (!q) return 0;
    const tokens = q.split(/\s+/).filter(Boolean);
    let score = 0; const cb = ti + ' ' + ar;
    if (ti === q && ar === q) score += 10_000_000;
    else if (ti === q) score += 5_000_000;
    else if (ar === q) score += 4_000_000;
    else if (ti.startsWith(q)) score += 2_000_000;
    else if (ti.includes(q)) score += 1_000_000;
    else if (ar.startsWith(q) || ar.includes(q)) score += 700_000;
    else {
      let hits = 0;
      for (const tk of tokens) {
        if (ti.split(/\s+/).includes(tk)) hits += 5;
        else if (ar.split(/\s+/).includes(tk)) hits += 3;
        else if (cb.includes(tk)) hits += 1;
      }
      score += hits * 50_000;
    }
    const pop = Number(track.popularity || 0);
    if (pop > 0) score += Math.log10(pop + 1) * 3000;
    if (track.provider === 'audius') score += 20000;
    if (track.explicit) score += 5000;
    const low = (track.title + ' ' + track.artist).toLowerCase();
    const userWants = /\b(remix|live|instrumental|cover|karaoke|slowed|sped|nightcore)\b/i.test(q);
    if (!userWants) {
      if (/\bremix\b/.test(low)) score -= 300_000;
      if (/\blive\b/.test(low)) score -= 250_000;
      if (/\bcover\b/.test(low)) score -= 400_000;
    }
    return score;
  }

  async function doSearch(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) return;
    state.query = q;

    if (!opts.silent) showView('search');

    const reqId = ++state.searchRequest;
    if (searchAbort) searchAbort.abort();
    const controller = new AbortController();
    searchAbort = controller;

    if (el.resultsInfo) el.resultsInfo.textContent = 'Поиск…';
    renderSkeleton();

    try {
      const r = await fetch(apiBase() + '/api/search?q=' + encodeURIComponent(q), {
        headers: { Accept: 'application/json' }, signal: controller.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (reqId !== state.searchRequest) return; // race-safe
      state.tracks = Array.isArray(d.results) ? d.results.map(normalizeTrack).filter(Boolean) : [];
      state.lastSearchArtists = Array.isArray(d.artists) ? d.artists : [];
      if (el.resultsInfo) el.resultsInfo.textContent = `${state.tracks.length} результатов`;
      renderTracks();
      renderSearchArtists();
      renderHome();
      if (state.tracks.length) prefetchTracks(state.tracks.slice(0, 8));
    } catch (e) {
      if (e.name === 'AbortError' || reqId !== state.searchRequest) return;
      state.tracks = [];
      state.lastSearchArtists = [];
      if (el.trackGrid) el.trackGrid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div>Ошибка: ${escapeHtml(e.message)}</div></div>`;
      if (el.resultsInfo) el.resultsInfo.textContent = 'Ошибка поиска';
    } finally {
      if (reqId === state.searchRequest) { /* ok */ }
    }
  }

  function renderSkeleton() {
    const grid = el.trackGrid;
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('div');
      c.className = 'card';
      c.innerHTML = `<div class="cover-box" style="animation:pulse 1.4s ease infinite"></div><div class="card-copy"><div style="height:11px;background:#141414;border-radius:5px;margin-bottom:6px"></div><div style="height:9px;background:#101010;border-radius:5px;width:70%"></div></div>`;
      grid.appendChild(c);
    }
  }

  function renderTracks() {
    const grid = el.trackGrid;
    if (!grid) return;
    grid.innerHTML = '';
    if (!state.tracks.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div>Ничего не найдено</div><div style="margin-top:6px;font-size:11px;color:var(--text-4)">Попробуй другое название или исполнителя</div></div>`;
      return;
    }
    state.tracks.forEach((track, index) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.style.animationDelay = (index * 15) + 'ms';
      card.dataset.index = String(index);

      const coverBox = document.createElement('div');
      coverBox.className = 'cover-box';
      const img = document.createElement('img');
      img.className = 'cover'; img.alt = '';
      img.src = coverFor(track) || placeholderCover();
      img.onerror = () => { img.style.display = 'none'; const fb = document.createElement('div'); fb.className = 'cover-fallback'; fb.textContent = '♪'; coverBox.appendChild(fb); };
      coverBox.appendChild(img);

      if (track.provider) {
        const badge = document.createElement('div');
        badge.className = 'source-badge';
        badge.textContent = track.provider;
        coverBox.appendChild(badge);
      }

      const play = document.createElement('div');
      play.className = 'play-card';
      play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      coverBox.appendChild(play);

      const info = document.createElement('button');
      info.className = 'info-card';
      info.title = 'Информация';
      info.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>';
      info.addEventListener('click', e => { e.stopPropagation(); openSongInfo(track); });
      coverBox.appendChild(info);

      const copy = document.createElement('div');
      copy.className = 'card-copy';
      const ti = document.createElement('div');
      ti.className = 'card-title';
      ti.textContent = track.title || 'Без названия';
      ti.title = track.title || '';
      ti.addEventListener('click', e => { e.stopPropagation(); openSongInfo(track); });
      const ar = document.createElement('div');
      ar.className = 'card-artist';
      ar.innerHTML = artistsHtml(track.artist);
      copy.append(ti, ar);

      card.append(coverBox, copy);
      card.addEventListener('click', () => { state.albumContext = null; playTrack(index); });
      card.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, track); });
      card.addEventListener('mouseenter', () => prefetchTrack(track), { once: true });
      grid.appendChild(card);
    });
  }

  function renderSearchArtists() {
    const wrap = el.searchArtistsBlock;
    const grid = el.searchArtists;
    if (!wrap || !grid) return;
    if (!state.lastSearchArtists.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    grid.innerHTML = '';
    state.lastSearchArtists.forEach(a => {
      const card = document.createElement('div');
      card.className = 'home-mini-card';
      const img = document.createElement('img');
      img.className = 'home-mini-cover';
      img.src = a.picture || placeholderCover();
      img.alt = '';
      img.onerror = () => { img.src = placeholderCover(); };
      const t = document.createElement('div');
      t.className = 'home-mini-title'; t.textContent = a.name;
      const s = document.createElement('div');
      s.className = 'home-mini-sub'; s.textContent = a.nbFan ? `${formatNumber(a.nbFan)} фанатов` : 'Исполнитель';
      card.append(img, t, s);
      card.addEventListener('click', () => showArtist(a.providerId, a.name));
      grid.appendChild(card);
    });
  }

  // ============================================================
  // PREFETCH
  // ============================================================
  function prefetchTracks(tracks) { tracks.forEach(prefetchTrack); }
  function prefetchTrack(t) {
    if (!t) return;
    const title = cleanTitleLocal(String(t.title || '').trim()) || String(t.title || '').trim();
    const primaryArtist = splitArtistsList(t.artist)[0] || t.artist || '';
    if (!title && !primaryArtist) return;
    const ck = normalizeSearch(title + ' ' + primaryArtist);
    const c = localResolveCache.get(ck);
    if (c && Date.now() - c.time < LOCAL_RESOLVE_TTL) return;
    if (pendingPrefetches.has(ck)) return;
    pendingPrefetches.add(ck);
    const params = new URLSearchParams({
      title, artist: primaryArtist,
      duration: String(t.duration || 0),
      q: [title, primaryArtist].filter(Boolean).join(' ')
    });
    fetch(apiBase() + '/api/audio/resolve?' + params, { headers: { Accept: 'application/json' } })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.streamUrl) {
          localResolveCache.set(ck, {
            time: Date.now(), streamUrl: d.streamUrl, provider: d.provider,
            videoId: d.videoId || '', videoTitle: d.videoTitle || '', videoChannel: d.videoChannel || ''
          });
        }
      })
      .catch(() => {})
      .finally(() => pendingPrefetches.delete(ck));
  }

  // ============================================================
  // PLAY TRACK
  // ============================================================
  async function playTrack(index, opts = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= state.tracks.length) return;
    const track = state.tracks[index];
    const isSame = state.currentTrack && trackKey(track) === trackKey(state.currentTrack);
    const isActive = userIntent === 'playing' || userIntent === 'paused' || userIntent === 'loading';
    if (isSame && isActive && !opts.force) { openSongInfo(state.currentTrack); return; }

    const myId = ++playRequestId;
    if (playAbort) { try { playAbort.abort(); } catch {} }
    const controller = new AbortController();
    playAbort = controller;

    ytStopPauseWatchdog();
    clearLyricsSync();

    const shouldFade = audioGraphReady && state.currentTrack && (userIntent === 'playing');
    if (shouldFade) await fadeOutAndWait(160);
    try { el.audio.pause(); } catch {}

    state.currentIndex = index;
    state.currentTrack = track;
    userIntent = 'loading';
    lastPlaybackError = '';
    resetProgressUI();
    updateMiniPlayer(); updatePlayerView(); updatePlayButtons();
    updateAmbientFromCover(track.cover);
    addRecentToShuffleHistory(track);

    initAudioGraph();
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(applyEq).catch(() => {});

    // Check local
    if (track.source === 'LOCAL' && track.localUrl) {
      try {
        await playUrl(track.localUrl, myId);
        onPlaybackStarted(track, { provider: 'local', url: track.localUrl });
      } catch (e) {
        if (e.message === 'Aborted') return;
        onPlaybackError(e);
      }
      return;
    }

    // Try resolve
    let stream = null;
    try {
      stream = await resolvePlaybackServer(track, controller.signal);
    } catch (e) {
      if (e.name === 'AbortError' || e.message === 'Aborted') return;
      onPlaybackError(e);
      return;
    }
    if (myId !== playRequestId) return;
    if (!stream || !stream.url) { onPlaybackError(new Error('Нет playable URL')); return; }

    track._resolveData = { ...stream, time: Date.now() };

    try {
      await playStream(stream, myId);
      if (myId !== playRequestId) return;
      onPlaybackStarted(track, stream);
    } catch (e) {
      if (myId !== playRequestId || e.message === 'Aborted') return;
      onPlaybackError(e);
    }
  }

  function onPlaybackStarted(track, stream) {
    userIntent = 'playing';
    updatePlayButtons();
    addHistory(track);
    reportTrackPlay(track);
    if (!state.queue.some(x => trackKey(x) === trackKey(track))) state.queue.push(track);
    updateQueue(); renderHome();
    updatePlayerView(); updateMiniPlayer();
    setTimeout(() => { updatePlayButtons(); applyEq(); }, 300);
    setTimeout(loadRecommendations, 8000);
    // reload lyrics if active
    const lyrBtn = document.querySelector('.player-tab[data-tab="lyrics"]');
    if (lyrBtn?.classList.contains('active') && state.currentTrack) loadLyrics(state.currentTrack);
    // prefetch next
    const nextIdx = state.currentIndex + 1;
    if (nextIdx < state.tracks.length) setTimeout(() => prefetchTrack(state.tracks[nextIdx]), 1200);
    refreshDiagnostics();
  }

  function onPlaybackError(e) {
    userIntent = 'error';
    lastPlaybackError = e.message || String(e);
    updatePlayButtons();
    notify('Не удалось воспроизвести: ' + lastPlaybackError, 'error');
    refreshDiagnostics();
  }

  async function playUrl(url, myId) {
    userIntent = 'playing';
    ytStopPauseWatchdog();
    el.audio.pause();
    el.audio.removeAttribute('src'); el.audio.load();
    el.audio.src = url;
    if (!audioGraphReady) el.audio.volume = state.volume / 100;
    el.audio.load();
    if (audioGraphReady && fadeGain && audioCtx && volumeGain) {
      fadeGain.gain.cancelScheduledValues(audioCtx.currentTime); fadeGain.gain.value = 0;
      volumeGain.gain.cancelScheduledValues(audioCtx.currentTime); volumeGain.gain.value = state.volume / 100;
    }
    await new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        el.audio.removeEventListener('playing', ok);
        el.audio.removeEventListener('error', bad);
        clearInterval(tick);
      };
      const ok = () => { if (done) return; done = true; cleanup(); resolve(); };
      const bad = () => { if (done) return; done = true; cleanup(); reject(new Error('audio error ' + (el.audio.error?.code || ''))); };
      el.audio.addEventListener('playing', ok, { once: true });
      el.audio.addEventListener('error', bad, { once: true });
      setTimeout(() => { if (done) return; done = true; cleanup(); reject(new Error('timeout')); }, 25000);
      const tick = setInterval(() => {
        if (myId !== undefined && myId !== playRequestId) { if (done) return; done = true; cleanup(); try { el.audio.pause(); } catch {} reject(new Error('Aborted')); }
      }, 100);
      el.audio.play().catch(bad);
    });
    if (audioGraphReady && fadeGain) fadeIn(280);
  }

  async function playStream(stream, myId) {
    if (!stream || !stream.url) throw new Error('empty stream url');
    if (stream.kind === 'youtube' || /\/api\/audio\/youtube\//.test(stream.url)) {
      const vid = stream.videoId || String(stream.url).match(/\/api\/audio\/youtube\/([A-Za-z0-9_-]{6,20})/)?.[1];
      if (!vid) throw new Error('no videoId');
      await playYouTube(vid, myId);
      return;
    }
    el.youtubePlayerWrap.innerHTML = '';
    ytIframe = null; ytCurrentVideo = '';
    await playUrl(stream.url, myId);
  }

  function playCurrentOrFirst() {
    initAudioGraph();
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(applyEq).catch(() => {});

    if (ytIframe && ytCurrentVideo) {
      const isPlaying = userIntent === 'playing' || userIntent === 'loading';
      if (isPlaying) {
        userIntent = 'paused'; updatePlayButtons();
        for (let i = 0; i < 8; i++) setTimeout(() => { if (userIntent === 'paused') ytSendCommand('pauseVideo'); }, i * 60);
        ytStartPauseWatchdog();
      } else { ytPlay(); updatePlayButtons(); }
      return;
    }
    if (state.currentTrack) {
      if (userIntent === 'loading') return;
      if (el.audio.paused) {
        if (audioGraphReady && fadeGain && audioCtx) {
          fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
          fadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
          fadeGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.15);
        }
        userIntent = 'playing';
        el.audio.play().then(updatePlayButtons).catch(() => playTrack(state.currentIndex, { force: true }));
      } else { el.audio.pause(); userIntent = 'paused'; updatePlayButtons(); }
      return;
    }
    if (state.tracks.length) playTrack(0);
  }

  function previous() {
    if (!state.tracks.length) return;
    if (!ytIframe && el.audio.currentTime > 4) { el.audio.currentTime = 0; return; }
    let i = state.currentIndex - 1;
    if (i < 0) i = state.tracks.length - 1;
    playTrack(i, { force: true });
  }

  function next() {
    if (!state.tracks.length) return;
    if (state.shuffle) { playTrack(smartShuffleNext(), { force: true }); return; }
    let ni = state.currentIndex + 1;
    if (ni >= state.tracks.length) ni = 0;
    playTrack(ni, { force: true });
  }

  // ============================================================
  // SMART SHUFFLE
  // ============================================================
  function addRecentToShuffleHistory(track) {
    const k = trackKey(track);
    state.shuffleHistory = state.shuffleHistory.filter(x => x !== k);
    state.shuffleHistory.unshift(k);
    state.shuffleHistory = state.shuffleHistory.slice(0, 30);
  }
  function smartShuffleNext() {
    const total = state.tracks.length;
    if (total <= 1) return 0;
    const currentKey = state.currentTrack ? trackKey(state.currentTrack) : '';
    const currentArtist = normalizeSearch(splitArtistsList(state.currentTrack?.artist)[0] || '');
    const recent = new Set(state.shuffleHistory.slice(0, 12));

    const candidates = [];
    for (let i = 0; i < total; i++) {
      const t = state.tracks[i];
      const k = trackKey(t);
      if (k === currentKey) continue;
      const a = normalizeSearch(splitArtistsList(t.artist)[0] || '');
      let score = 0;
      if (recent.has(k)) score -= 100;
      if (a && a === currentArtist) score -= 50;
      score += Math.random() * 10;
      candidates.push({ i, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.i ?? 0;
  }
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    if (state.shuffle) { state.shuffleHistory = []; if (state.currentTrack) addRecentToShuffleHistory(state.currentTrack); }
    updateModeButtons();
    notify(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
  }
  function toggleRepeat() {
    state.repeat = !state.repeat;
    updateModeButtons();
    notify(state.repeat ? 'Повтор включён' : 'Повтор выключен');
  }
  function updateModeButtons() {
    el.repeatBtn?.classList.toggle('active', state.repeat);
    el.miniRepeat?.classList.toggle('active', state.repeat);
    el.shuffleBtn?.classList.toggle('active', state.shuffle);
    el.miniShuffle?.classList.toggle('active', state.shuffle);
  }

  // ============================================================
  // PROGRESS / SEEK
  // ============================================================
  function resetProgressUI() {
    [el.progress, el.miniProgress].forEach(p => {
      if (!p) return;
      p.value = 0;
      p.style.setProperty('--progress', '0%');
    });
    if (el.currentTime) el.currentTime.textContent = '0:00';
    if (el.duration) el.duration.textContent = '0:00';
    if (el.miniTime) el.miniTime.textContent = '0:00 / 0:00';
  }
  function updateProgress() {
    let c = 0, d = 0;
    if (ytIframe && ytCurrentVideo) { c = ytVideoCurrentTime; d = ytVideoDuration; }
    else { d = el.audio.duration; c = el.audio.currentTime || 0; }
    if (!Number.isFinite(d) || d <= 0) {
      if (el.currentTime) el.currentTime.textContent = formatTime(c);
      if (el.duration) el.duration.textContent = '0:00';
      if (el.miniTime) el.miniTime.textContent = formatTime(c) + ' / 0:00';
      return;
    }
    const p = Math.max(0, Math.min(100, c / d * 100));
    if (el.progress && !el.progress.matches(':active')) {
      el.progress.value = Math.round(p * 10);
      el.progress.style.setProperty('--progress', p + '%');
    }
    if (el.currentTime) el.currentTime.textContent = formatTime(c);
    if (el.duration) el.duration.textContent = formatTime(d);
    if (el.miniProgress && !el.miniProgress.matches(':active')) {
      el.miniProgress.value = Math.round(p * 10);
      el.miniProgress.style.setProperty('--progress', p + '%');
    }
    if (el.miniTime) el.miniTime.textContent = formatTime(c) + ' / ' + formatTime(d);
  }
  function seekToValue(v) {
    const pct = Number(v) / 1000;
    if (ytIframe && ytCurrentVideo && ytVideoDuration > 0) {
      const t = ytVideoDuration * pct;
      ytSendCommand('seekTo', [t, true]); ytVideoCurrentTime = t;
      updateProgress();
      if (userIntent === 'paused') ytSendCommand('pauseVideo'); else ytSendCommand('playVideo');
      return;
    }
    if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
    el.audio.currentTime = el.audio.duration * pct;
  }
  function seekDelta(d) {
    if (ytIframe && ytCurrentVideo) {
      const t = Math.max(0, ytVideoCurrentTime + d);
      ytSendCommand('seekTo', [t, true]); ytVideoCurrentTime = t;
      updateProgress();
      if (userIntent === 'paused') ytSendCommand('pauseVideo');
      return;
    }
    if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
    el.audio.currentTime = Math.max(0, Math.min(el.audio.duration, (el.audio.currentTime || 0) + d));
  }

  // ============================================================
  // VOLUME
  // ============================================================
  function setVolume(v) {
    state.volume = Math.max(0, Math.min(100, Number(v) || 0));
    if (audioGraphReady && volumeGain && audioCtx) {
      volumeGain.gain.setTargetAtTime(state.volume / 100, audioCtx.currentTime, 0.01);
    } else el.audio.volume = state.volume / 100;
    if (el.volumeMini) el.volumeMini.value = state.volume;
    if (el.volumeLarge) el.volumeLarge.value = state.volume;
    if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';
    if (ytIframe && ytCurrentVideo) ytSendCommand('setVolume', [state.volume]);
    try { store.set('nova_volume', String(state.volume)); } catch {}
  }

  // ============================================================
  // PLAY BUTTONS
  // ============================================================
  function updatePlayButtons() {
    const playing = userIntent === 'playing' && !!state.currentTrack;
    const loading = userIntent === 'loading';
    [el.miniPlay, el.largePlayBtn].forEach(b => b?.classList.toggle('loading', loading));
    if (!el.miniPlayIcon || !el.largePlayIcon) return;
    if (loading) {
      const svg = '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="22 22"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite"/></circle>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg;
      return;
    }
    if (playing) {
      const svg = '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg;
    } else {
      const svg = '<path d="M8 5v14l11-7z"/>';
      el.miniPlayIcon.innerHTML = svg; el.largePlayIcon.innerHTML = svg;
    }
  }

  // ============================================================
  // MINI PLAYER
  // ============================================================
  function updateMiniPlayer() {
    const t = state.currentTrack;
    if (!t) {
      el.miniTitle.textContent = 'Ничего не играет';
      el.miniArtist.innerHTML = '—';
      el.miniCover.removeAttribute('src');
      el.miniPlayer.classList.remove('visible');
      return;
    }
    el.miniTitle.textContent = t.title || 'Без названия';
    el.miniArtist.innerHTML = artistsHtml(t.artist);
    if (coverFor(t)) el.miniCover.src = coverFor(t); else el.miniCover.removeAttribute('src');
    el.miniPlayer.classList.add('visible');
    el.miniFavorite.classList.toggle('fav-active', isFavorite(t));
    updatePlayButtons();
  }

  // ============================================================
  // FULL PLAYER
  // ============================================================
  function updatePlayerView() {
    const t = state.currentTrack;
    const placeholder = placeholderCover();
    if (!t) {
      el.nowTitle.textContent = 'Ничего не играет';
      el.nowArtist.textContent = 'Выбери трек в поиске';
      el.bigCover.src = placeholder;
      el.currentTime.textContent = '0:00';
      el.duration.textContent = '0:00';
      el.progress.value = 0;
      el.progress.style.setProperty('--progress', '0%');
      el.nowChips.innerHTML = '';
      el.favoriteBtn.classList.remove('active');
      return;
    }
    el.nowTitle.textContent = t.title || 'Без названия';
    el.nowArtist.innerHTML = artistsHtml(t.artist);
    el.nowTitle.onclick = () => openSongInfo(t);

    // Chips
    const chips = [];
    const low = (t.title + ' ' + t.album).toLowerCase();
    if (/\b(remix|edit|mix)\b/.test(low)) chips.push('Remix');
    if (/\blive\b/.test(low)) chips.push('Live');
    if (/\binstrumental\b/.test(low)) chips.push('Instrumental');
    if (/\bkaraoke\b/.test(low)) chips.push('Karaoke');
    if (/\b(cover)\b/.test(low)) chips.push('Cover');
    if (t.explicit) chips.push('Explicit');
    if (t.provider) chips.push(t.provider);
    el.nowChips.innerHTML = chips.map(c => `<span class="now-chip">${escapeHtml(c)}</span>`).join('');

    if (coverFor(t)) {
      const img = new Image();
      img.onload = () => { if (state.currentTrack === t) el.bigCover.src = coverFor(t); };
      img.onerror = () => { if (state.currentTrack === t) el.bigCover.src = placeholder; };
      img.src = coverFor(t);
    } else el.bigCover.src = placeholder;

    el.favoriteBtn.classList.toggle('active', isFavorite(t));
    updateQueue();
    updatePlayButtons();
  }

  // ============================================================
  // QUEUE
  // ============================================================
  function addToQueue(track) {
    if (!track) return;
    const k = trackKey(track);
    if (state.queue.some(x => trackKey(x) === k)) return notify('Уже в очереди');
    state.queue.push(track);
    updateQueue();
    notify('Добавлено в очередь');
  }
  function playNext(track) {
    if (!track) return;
    const k = trackKey(track);
    const filtered = state.queue.filter(x => trackKey(x) !== k);
    filtered.unshift(track);
    state.queue = filtered;
    updateQueue();
    notify('Играет следующим');
  }
  function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queue.splice(index, 1);
    updateQueue();
  }
  function clearQueue() {
    state.queue = [];
    updateQueue();
    notify('Очередь очищена');
  }
  function updateQueue() {
    const box = el.queueContent;
    if (!box) return;
    if (!state.queue.length) {
      box.innerHTML = '<div class="queue-empty">Очередь пуста<br><span style="font-size:11px;color:var(--text-4)">Добавь треки, чтобы продолжить</span></div>';
      return;
    }
    box.innerHTML = '';
    state.queue.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'queue-row' + (state.currentTrack && trackKey(state.currentTrack) === trackKey(t) ? ' active' : '');
      row.draggable = true;
      row.dataset.index = String(i);

      const drag = document.createElement('span');
      drag.className = 'queue-drag';
      drag.textContent = '⋮⋮';

      const cover = document.createElement('img');
      cover.className = 'queue-cover';
      cover.alt = '';
      cover.src = coverFor(t) || placeholderCover();
      cover.onerror = () => { cover.src = placeholderCover(); };

      const main = document.createElement('div');
      main.className = 'queue-main';
      main.innerHTML = `<div class="queue-title-text">${escapeHtml(t.title || '—')}</div><div class="queue-artist-text">${artistsHtml(t.artist)}</div>`;

      const rm = document.createElement('button');
      rm.className = 'queue-remove';
      rm.textContent = '×';
      rm.title = 'Убрать';
      rm.addEventListener('click', e => { e.stopPropagation(); removeFromQueue(i); });

      row.append(drag, cover, main, rm);
      row.addEventListener('click', () => {
        const idx = state.tracks.findIndex(x => trackKey(x) === trackKey(t));
        if (idx >= 0) playTrack(idx, { force: true });
        else { state.tracks.push(t); playTrack(state.tracks.length - 1, { force: true }); }
      });

      // drag&drop
      row.addEventListener('dragstart', e => {
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('dragover'); });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('dragover');
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = Number(row.dataset.index);
        if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
          const [m] = state.queue.splice(from, 1);
          state.queue.splice(to, 0, m);
          updateQueue();
        }
      });

      box.appendChild(row);
    });
  }

  // ============================================================
  // FAVORITES
  // ============================================================
  function toggleFavorite(t) {
    if (!t) return;
    const k = trackKey(t);
    if (isFavorite(t)) {
      state.favorites = state.favorites.filter(x => trackKey(x) !== k);
      notify('Удалено из избранного');
      if (state.user && authToken) apiAuth('/api/favorites/' + encodeURIComponent(k), { method: 'DELETE' }).catch(() => {});
    } else {
      state.favorites.unshift(t);
      notify('Добавлено в избранное');
      if (state.user && authToken) apiAuth('/api/favorites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t)
      }).catch(() => {});
    }
    state.favorites = state.favorites.slice(0, 500);
    persist();
    renderFavorites();
    updateMiniPlayer();
    if (state.currentTrack) updatePlayerView();
  }
  function renderFavorites() {
    const box = el.favoritesList;
    if (!box) return;
    if (!state.favorites.length) {
      box.innerHTML = `<div class="empty"><div>Нет избранных треков</div><div style="margin-top:6px;font-size:11px;color:var(--text-4)">Добавляй понравившиеся песни сердцем</div></div>`;
      return;
    }
    renderList(box, state.favorites, { context: 'favorites' });
  }

  // ============================================================
  // HISTORY (grouped)
  // ============================================================
  function renderHistory() {
    const box = el.historyList;
    if (!box) return;
    if (!state.history.length) {
      box.innerHTML = `<div class="empty"><div>История пуста</div><div style="margin-top:6px;font-size:11px;color:var(--text-4)">Прослушанные треки появятся здесь</div></div>`;
      return;
    }
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const startOfWeek = startOfToday - 6 * 86400000;
    const groups = { today: [], yesterday: [], week: [], earlier: [] };
    state.history.forEach(t => {
      const ts = t.playedAt || t.addedAt || Date.now();
      if (ts >= startOfToday) groups.today.push(t);
      else if (ts >= startOfYesterday) groups.yesterday.push(t);
      else if (ts >= startOfWeek) groups.week.push(t);
      else groups.earlier.push(t);
    });
    box.innerHTML = '';
    const labels = { today: 'Сегодня', yesterday: 'Вчера', week: 'Эта неделя', earlier: 'Ранее' };
    for (const key of ['today', 'yesterday', 'week', 'earlier']) {
      const list = groups[key];
      if (!list.length) continue;
      const head = document.createElement('div');
      head.className = 'search-block-title';
      head.style.marginTop = '18px';
      head.textContent = labels[key];
      box.appendChild(head);
      const wrap = document.createElement('div');
      wrap.className = 'list';
      renderList(wrap, list, { context: 'history', withTime: true });
      box.appendChild(wrap);
    }
  }

  // ============================================================
  // LIST RENDERING (shared)
  // ============================================================
  function renderList(container, list, opts = {}) {
    container.innerHTML = '';
    if (!list.length) return;
    list.forEach(track => {
      const row = document.createElement('div');
      row.className = 'list-row';
      if (state.currentTrack && trackKey(state.currentTrack) === trackKey(track)) row.classList.add('active');

      const cover = document.createElement('img');
      cover.className = 'list-cover';
      cover.alt = '';
      cover.src = coverFor(track) || placeholderCover();
      cover.onerror = () => { cover.src = placeholderCover(); };

      const main = document.createElement('div');
      main.className = 'list-main';
      const title = document.createElement('strong');
      title.textContent = track.title || 'Без названия';
      const sub = document.createElement('span');
      if (opts.withTime && track.playedAt) {
        const d = new Date(track.playedAt);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        sub.innerHTML = `${hh}:${mm} · ${artistsHtml(track.artist)}`;
      } else {
        sub.innerHTML = artistsHtml(track.artist);
      }
      main.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const play = document.createElement('button');
      play.className = 'small-btn';
      play.title = 'Играть';
      play.textContent = '▶';
      play.addEventListener('click', e => {
        e.stopPropagation();
        const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
        if (i >= 0) playTrack(i, { force: true });
        else { state.tracks = [track]; playTrack(0, { force: true }); }
      });

      const fav = document.createElement('button');
      fav.className = 'small-btn';
      fav.title = 'Избранное';
      fav.textContent = isFavorite(track) ? '♥' : '♡';
      fav.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(track); });

      actions.append(play, fav);

      row.append(cover, main, actions);
      row.addEventListener('click', () => {
        const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
        if (i >= 0) playTrack(i); else { state.tracks = [track]; playTrack(0); }
      });
      row.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, track, opts); });
      row.addEventListener('mouseenter', () => prefetchTrack(track), { once: true });
      container.appendChild(row);
    });
  }

  // ============================================================
  // ARTIST / ALBUM
  // ============================================================
  async function showArtist(id, name) {
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
      el.artistBannerBg.style.backgroundImage = `url("${src.replace(/"/g, '\\"')}")`;
      el.artistBannerBg.classList.add('loaded');
    };

    if (!name && !id) { el.artistTracks.innerHTML = '<div class="empty">Нет данных</div>'; return; }
    try {
      let artistId = id, picture = '';
      if (!artistId && name) {
        try {
          const sr = await fetch(apiBase() + '/api/artist-search?q=' + encodeURIComponent(name));
          const sd = await sr.json().catch(() => ({}));
          if (sr.ok && sd?.id) { artistId = sd.id; picture = sd.picture || ''; }
        } catch {}
      }
      if (!artistId) {
        el.artistHeroName.textContent = name || 'Исполнитель';
        if (picture) el.artistHeroImage.src = picture;
        el.artistTracks.innerHTML = '<div class="empty">Точных совпадений не найдено</div>';
        return;
      }
      const r = await fetch(apiBase() + '/api/artist/' + encodeURIComponent(artistId));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unavailable');
      const artist = d.artist || {};
      const pic = artist.picture || picture || '';
      el.artistHeroName.textContent = artist.name || name || 'Исполнитель';
      if (pic) el.artistHeroImage.src = pic;

      const meta = [];
      if (artist.nbFan) meta.push(`<span>${formatNumber(artist.nbFan)} фанатов</span>`);
      if (d.top_tracks?.length) meta.push(`<span>${d.top_tracks.length} треков</span>`);
      const totalRel = (d.albums?.length || 0) + (d.singles?.length || 0);
      if (totalRel) meta.push(`<span>${totalRel} релизов</span>`);
      el.artistHeroMeta.innerHTML = meta.join('');

      const allTracks = (d.top_tracks || []).map(normalizeTrack).filter(Boolean);
      let expanded = false;
      const INITIAL = 5;
      const drawTop = () => {
        if (!allTracks.length) { el.artistTracks.innerHTML = '<div class="empty">У этого артиста пока нет доступных треков</div>'; return; }
        renderList(el.artistTracks, expanded ? allTracks : allTracks.slice(0, INITIAL), { context: 'artist' });
      };
      drawTop();
      if (allTracks.length > INITIAL) {
        el.artistShowAllBtn.classList.remove('hidden');
        el.artistShowAllBtn.textContent = `Показать все (${allTracks.length})`;
        el.artistShowAllBtn.onclick = () => {
          expanded = !expanded;
          el.artistShowAllBtn.textContent = expanded ? 'Свернуть' : `Показать все (${allTracks.length})`;
          drawTop();
        };
      }
      setTimeout(() => prefetchTracks(allTracks.slice(0, 3)), 200);

      const albums = (d.albums || []);
      el.artistAlbums.innerHTML = '';
      el.artistAlbumsSection.style.display = albums.length ? '' : 'none';
      albums.forEach(a => el.artistAlbums.appendChild(makeMiniCard({
        id: a.providerId, albumId: a.providerId, album: a.title,
        title: a.title, artist: artist.name || name, cover: a.cover
      }, 'album')));

      const singles = (d.singles || []);
      el.artistSingles.innerHTML = '';
      el.artistSinglesSection.style.display = singles.length ? '' : 'none';
      singles.forEach(a => el.artistSingles.appendChild(makeMiniCard({
        id: a.providerId, albumId: a.providerId, album: a.title,
        title: a.title, artist: artist.name || name, cover: a.cover
      }, 'album')));
    } catch {
      el.artistTracks.innerHTML = '<div class="empty">Не удалось загрузить данные артиста</div>';
    }
  }

  async function showAlbum(id) {
    showView('album');
    el.albumTracks.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      const r = await fetch(apiBase() + '/api/album/' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unavailable');
      const raw = d.tracks || [];
      el.albumHeroName.textContent = d.title || 'Альбом';
      el.albumHeroArtist.textContent = d.artist?.name || '—';
      el.albumHeroType.textContent = (d.recordType || 'album').toUpperCase();
      el.albumHeroMeta.textContent = [
        d.releaseDate?.slice?.(0, 4),
        raw.length ? `${raw.length} треков` : ''
      ].filter(Boolean).join(' · ') || '—';
      if (d.cover) el.albumHeroImage.src = d.cover;

      const tracks = raw.map(normalizeTrack).filter(Boolean);
      el.albumTracks.innerHTML = '';
      if (!tracks.length) {
        el.albumTracks.innerHTML = '<div class="empty">Пустой альбом</div>';
        return;
      }
      tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        const idx = document.createElement('div');
        idx.className = 'list-index';
        idx.textContent = String(i + 1).padStart(2, '0');
        const main = document.createElement('div');
        main.className = 'list-main';
        main.innerHTML = `<strong>${escapeHtml(t.title)}</strong><span>${artistsHtml(t.artist)}</span>`;
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        const play = document.createElement('button');
        play.className = 'small-btn';
        play.textContent = '▶';
        play.addEventListener('click', e => {
          e.stopPropagation();
          state.tracks = tracks.slice();
          playTrack(i, { force: true });
        });
        actions.appendChild(play);
        row.append(idx, main, actions);
        row.addEventListener('click', () => { state.tracks = tracks.slice(); playTrack(i); });
        row.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, t); });
        row.addEventListener('mouseenter', () => prefetchTrack(t), { once: true });
        el.albumTracks.appendChild(row);
      });

      el.albumPlay.onclick = () => { state.tracks = tracks.slice(); playTrack(0, { force: true }); };
      el.albumShuffle.onclick = () => {
        state.tracks = tracks.slice().sort(() => Math.random() - 0.5);
        state.shuffle = true; updateModeButtons();
        playTrack(0, { force: true });
      };
      el.albumAddToPlaylist.onclick = () => openPlaylistPicker(tracks);

      setTimeout(() => prefetchTracks(tracks.slice(0, 4)), 200);
    } catch {
      el.albumTracks.innerHTML = '<div class="empty">Не удалось загрузить</div>';
    }
  }

  // ============================================================
  // PLAYLISTS
  // ============================================================
  async function loadPlaylists() {
    if (!state.user || !authToken) { state.playlists = []; renderPlaylists(); return; }
    try {
      const r = await apiAuth('/api/playlists');
      state.playlists = Array.isArray(r) ? r : [];
      renderPlaylists();
    } catch { state.playlists = []; renderPlaylists(); }
  }
  function renderPlaylists() {
    const grid = el.playlistsGrid;
    if (!grid) return;
    grid.innerHTML = '';
    if (!state.user) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Войди, чтобы создавать плейлисты</div>';
      return;
    }
    if (!state.playlists.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Плейлистов пока нет<br><span style="font-size:11px;color:var(--text-4)">Нажми «Новый плейлист», чтобы создать</span></div>';
      return;
    }
    state.playlists.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      const cover = document.createElement('div');
      cover.className = 'playlist-card-cover';
      const firstCover = pl.tracks?.find(t => t.cover)?.cover || '';
      if (pl.cover) cover.style.backgroundImage = `url("${pl.cover}")`;
      else if (firstCover) cover.style.backgroundImage = `url("${firstCover}")`;
      const body = document.createElement('div');
      body.className = 'playlist-card-body';
      body.innerHTML = `<div class="playlist-card-name">${escapeHtml(pl.name)}</div><div class="playlist-card-meta">${pl.tracks?.length || 0} треков</div>`;
      card.append(cover, body);
      card.addEventListener('click', () => openPlaylist(pl.id));
      grid.appendChild(card);
    });
  }
  async function openPlaylist(id) {
    const pl = state.playlists.find(p => p.id === id);
    if (!pl) return;
    state.currentPlaylistId = id;
    showView('playlist');
    el.playlistHeroName.textContent = pl.name;
    el.playlistHeroMeta.textContent = `${pl.tracks?.length || 0} треков${pl.description ? ' · ' + pl.description : ''}`;
    const firstCover = pl.cover || pl.tracks?.find(t => t.cover)?.cover || '';
    el.playlistHeroImage.src = firstCover || placeholderCover();

    const box = el.playlistTracks;
    box.innerHTML = '';
    if (!pl.tracks?.length) {
      box.innerHTML = '<div class="empty">Плейлист пуст</div>';
    } else {
      renderList(box, pl.tracks, { context: 'playlist' });
    }

    el.playlistPlay.onclick = () => {
      if (!pl.tracks?.length) return;
      state.tracks = pl.tracks.slice();
      playTrack(0, { force: true });
    };
    el.playlistShuffle.onclick = () => {
      if (!pl.tracks?.length) return;
      state.tracks = pl.tracks.slice().sort(() => Math.random() - 0.5);
      state.shuffle = true; updateModeButtons();
      playTrack(0, { force: true });
    };
    el.playlistDelete.onclick = async () => {
      if (!confirm('Удалить плейлист?')) return;
      try {
        await apiAuth('/api/playlists/' + id, { method: 'DELETE' });
        state.playlists = state.playlists.filter(p => p.id !== id);
        renderPlaylists();
        showView('playlists');
        notify('Плейлист удалён');
      } catch { notify('Не удалось удалить', 'error'); }
    };
  }
  function openPlaylistCreate(prefillTrack) {
    el.playlistNameInput.value = '';
    el.playlistDescInput.value = '';
    el.playlistCreateModal.classList.add('open');
    el.playlistCreateModal.setAttribute('aria-hidden', 'false');
    el.playlistCreateModal.dataset.prefillTrack = prefillTrack ? JSON.stringify(prefillTrack) : '';
    setTimeout(() => el.playlistNameInput.focus(), 80);
  }
  async function submitPlaylistCreate() {
    const name = el.playlistNameInput.value.trim();
    const description = el.playlistDescInput.value.trim();
    if (!name) return notify('Введи название');
    if (!state.user || !authToken) { closePlaylistCreate(); openLoginModal(); return; }
    try {
      const r = await apiAuth('/api/playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });
      state.playlists.unshift(r);
      // add prefill if any
      const prefillRaw = el.playlistCreateModal.dataset.prefillTrack;
      if (prefillRaw) {
        try {
          const t = JSON.parse(prefillRaw);
          await apiAuth('/api/playlists/' + r.id + '/tracks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t)
          });
          r.tracks.push(t);
        } catch {}
      }
      renderPlaylists();
      closePlaylistCreate();
      notify('Плейлист создан');
      if (!el.playlistCreateModal.dataset.prefillTrack) {
        // no-op
      }
      el.playlistCreateModal.dataset.prefillTrack = '';
    } catch { notify('Не удалось создать', 'error'); }
  }
  function closePlaylistCreate() {
    el.playlistCreateModal.classList.remove('open');
    el.playlistCreateModal.setAttribute('aria-hidden', 'true');
  }
  function openPlaylistPicker(tracks) {
    if (!state.user || !authToken) { openLoginModal(); return; }
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    el.playlistPickerModal.dataset.tracks = JSON.stringify(arr);
    const box = el.playlistPickerList;
    box.innerHTML = '';
    if (!state.playlists.length) {
      box.innerHTML = '<div class="playlist-picker-empty">Плейлистов пока нет</div>';
    } else {
      state.playlists.forEach(pl => {
        const row = document.createElement('div');
        row.className = 'playlist-picker-item';
        row.textContent = pl.name + (pl.tracks?.length ? ` · ${pl.tracks.length}` : '');
        row.addEventListener('click', () => addTracksToPlaylist(pl.id, arr));
        box.appendChild(row);
      });
    }
    el.playlistPickerModal.classList.add('open');
    el.playlistPickerModal.setAttribute('aria-hidden', 'false');
  }
  async function addTracksToPlaylist(plId, tracks) {
    try {
      for (const t of tracks) {
        await apiAuth('/api/playlists/' + plId + '/tracks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t)
        });
      }
      const pl = state.playlists.find(p => p.id === plId);
      if (pl) {
        for (const t of tracks) {
          if (!pl.tracks.some(x => trackKey(x) === trackKey(t))) pl.tracks.push(t);
        }
      }
      notify(`Добавлено в «${pl?.name || 'плейлист'}»`);
      closePlaylistPicker();
      if (state.currentPlaylistId === plId) openPlaylist(plId);
    } catch { notify('Не удалось добавить', 'error'); }
  }
  function closePlaylistPicker() {
    el.playlistPickerModal.classList.remove('open');
    el.playlistPickerModal.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // LOCAL MUSIC
  // ============================================================
  function localAudioPicker() { el.localAudioInput.click(); }
  async function handleLocalFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    let added = 0;
    for (const file of arr) {
      if (!file.type.startsWith('audio/') && !/\.(mp3|wav|flac|ogg|m4a|webm|opus|aac)$/i.test(file.name)) continue;
      const url = URL.createObjectURL(file);
      const fallbackTitle = file.name.replace(/\.[^.]+$/, '');
      const track = {
        id: 'local_' + crypto.randomUUID ? crypto.randomUUID() : ('local_' + Date.now() + Math.random().toString(36).slice(2)),
        provider: 'local', source: 'LOCAL',
        title: fallbackTitle,
        artist: 'Локальный файл',
        album: '',
        duration: 0,
        localUrl: url,
        cover: '',
        filePath: file.name
      };
      // try metadata via audio element
      try {
        const meta = await new Promise(res => {
          const a = new Audio();
          a.preload = 'metadata';
          a.onloadedmetadata = () => res({ duration: a.duration || 0 });
          a.onerror = () => res(null);
          a.src = url;
          setTimeout(() => res(null), 3000);
        });
        if (meta?.duration) track.duration = meta.duration;
      } catch {}
      state.localTracks.unshift(track);
      added++;
    }
    state.localTracks = state.localTracks.slice(0, 500);
    persist();
    renderLocal();
    if (added) notify(`Добавлено файлов: ${added}`);
  }
  function renderLocal() {
    const box = el.localList;
    if (!box) return;
    if (!state.localTracks.length) {
      box.innerHTML = '';
      return;
    }
    renderList(box, state.localTracks, { context: 'local' });
  }

  // ============================================================
  // CONTEXT MENU
  // ============================================================
  function showContextMenu(e, track, opts = {}) {
    const menu = el.contextMenu;
    menu.innerHTML = '';
    const items = [
      { label: 'Играть', icon: '▶', action: () => {
        const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
        if (i >= 0) playTrack(i, { force: true });
        else { state.tracks = [track]; playTrack(0, { force: true }); }
      }},
      { label: 'Играть следующим', icon: '→', action: () => playNext(track) },
      { label: 'Добавить в очередь', icon: '+', action: () => addToQueue(track) },
      { divider: true },
      { label: 'Добавить в плейлист', icon: '☰', action: () => openPlaylistPicker(track) },
      { label: isFavorite(track) ? 'Убрать из избранного' : 'В избранное', icon: '♥', action: () => toggleFavorite(track) },
      { divider: true },
      { label: 'Открыть исполнителя', icon: '⌕', action: () => {
        const a = splitArtistsList(track.artist)[0];
        if (a) showArtist(track.artistId || '', a);
      }},
      { label: 'Открыть альбом', icon: '▤', action: () => {
        if (track.albumId) showAlbum(track.albumId); else notify('Альбом недоступен');
      }},
    ];
    items.forEach(it => {
      if (it.divider) {
        const d = document.createElement('div');
        d.className = 'context-divider';
        menu.appendChild(d);
        return;
      }
      const row = document.createElement('div');
      row.className = 'context-item';
      row.innerHTML = `<span style="width:14px;text-align:center">${it.icon}</span><span>${escapeHtml(it.label)}</span>`;
      row.addEventListener('click', () => { hideContextMenu(); it.action(); });
      menu.appendChild(row);
    });
    menu.classList.remove('hidden');
    const mw = 220, mh = menu.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true, capture: true }), 10);
  }
  function hideContextMenu() { el.contextMenu.classList.add('hidden'); }

  // ============================================================
  // SONG INFO MODAL
  // ============================================================
  let songInfoCurrent = null;
  function openSongInfo(track) {
    if (!track) return;
    songInfoCurrent = track;
    el.songInfoCover.src = track.cover || placeholderCover();
    el.songInfoCover.style.display = track.cover ? 'block' : 'none';
    el.songInfoTitle.textContent = track.title || 'Без названия';
    el.songInfoArtist.innerHTML = artistsHtml(track.artist);
    el.songInfoAlbum.textContent = track.album || '—';
    el.songInfoAlbum.style.cursor = track.albumId ? 'pointer' : 'default';
    el.songInfoAlbum.onclick = () => { if (track.albumId) { closeSongInfo(); showAlbum(track.albumId); } };
    el.songInfoMeta.textContent = [track.duration ? formatTime(track.duration) : '', track.releaseDate?.slice(0, 4)].filter(Boolean).join(' · ') || '—';
    el.songInfoSource.textContent = track.provider || 'CATALOG';
    el.songInfoFavorite.textContent = isFavorite(track) ? '♥ В избранном' : '♡ В избранное';
    el.songInfoModal.classList.add('open');
    el.songInfoModal.setAttribute('aria-hidden', 'false');
  }
  function closeSongInfo() {
    el.songInfoModal.classList.remove('open');
    el.songInfoModal.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // LYRICS
  // ============================================================
  let lyricsTimer = null;
  let lyricsLines = [];
  let lyricsActiveIndex = -1;

  function parseLrc(lrc) {
    if (!lrc) return [];
    const out = [];
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/;
    for (const raw of String(lrc).split(/\r?\n/)) {
      const m = raw.match(re);
      if (!m) continue;
      const min = Number(m[1]), sec = Number(m[2]);
      const msPart = (m[3] || '0').padEnd(3, '0').slice(0, 3);
      const t = min * 60 + sec + Number(msPart) / 1000;
      const text = String(m[4] || '').trim();
      if (text) out.push({ t, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  function clearLyricsSync() {
    if (lyricsTimer) { clearInterval(lyricsTimer); lyricsTimer = null; }
    lyricsLines = [];
    lyricsActiveIndex = -1;
  }
  function highlightLyrics() {
    if (!lyricsLines.length) return;
    const box = el.lyricsInlineContent;
    if (!box) return;
    let t = 0;
    if (ytIframe && ytCurrentVideo) t = ytVideoCurrentTime || 0;
    else t = el.audio.currentTime || 0;
    let idx = -1;
    for (let i = 0; i < lyricsLines.length; i++) { if (lyricsLines[i].t <= t) idx = i; else break; }
    if (idx === lyricsActiveIndex) return;
    lyricsActiveIndex = idx;
    const rows = box.querySelectorAll('.lyrics-line');
    rows.forEach((r, i) => r.classList.toggle('active', i === idx));
    if (idx >= 0 && rows[idx]) {
      const target = rows[idx].offsetTop - box.clientHeight / 2 + rows[idx].clientHeight / 2;
      try { box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }); } catch {}
    }
  }
  async function loadLyrics(track, force) {
    if (!track) return;
    const box = el.lyricsInlineContent;
    if (!box) return;
    if (!force && box.dataset.trackKey === trackKey(track) && box.dataset.loaded === '1') return;
    clearLyricsSync();
    box.dataset.trackKey = trackKey(track);
    box.dataset.loaded = '0';
    box.innerHTML = '<div class="lyrics-placeholder">Ищу текст…</div>';

    const params = new URLSearchParams({
      track_name: track.title || '',
      artist_name: track.artist || ''
    });
    if (track.album) params.set('album_name', track.album);
    if (track.duration > 0) params.set('duration', String(Math.round(track.duration)));
    if (track._resolveData?.videoTitle) params.set('fb_title', track._resolveData.videoTitle);
    if (track._resolveData?.videoChannel) params.set('fb_artist', track._resolveData.videoChannel);

    try {
      const r = await fetch(apiBase() + '/api/lyrics?' + params);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.found) {
        box.innerHTML = '<div class="lyrics-placeholder">Текст не найден</div>';
        box.dataset.loaded = '1';
        return;
      }
      const synced = d.syncedLyrics || '';
      const plain = d.plainLyrics || '';
      let lines = synced ? parseLrc(synced) : [];
      if (lines.length) {
        lyricsLines = lines;
        box.innerHTML = '';
        lines.forEach((l, i) => {
          const div = document.createElement('div');
          div.className = 'lyrics-line';
          div.dataset.time = String(l.t);
          div.dataset.index = String(i);
          div.textContent = l.text;
          div.addEventListener('click', () => {
            if (ytIframe && ytCurrentVideo) { ytSendCommand('seekTo', [l.t, true]); ytVideoCurrentTime = l.t; }
            else if (Number.isFinite(el.audio.duration)) el.audio.currentTime = l.t;
            highlightLyrics();
          });
          box.appendChild(div);
        });
        highlightLyrics();
        lyricsTimer = setInterval(highlightLyrics, 150);
        box.dataset.loaded = '1';
        return;
      }
      if (plain?.trim()) {
        box.innerHTML = `<div style="white-space:pre-wrap;color:#ccc;font-size:14px;line-height:1.9">${escapeHtml(plain)}</div>`;
        box.dataset.loaded = '1';
        return;
      }
      box.innerHTML = '<div class="lyrics-placeholder">Текст не найден</div>';
      box.dataset.loaded = '1';
    } catch (e) {
      box.innerHTML = `<div class="lyrics-placeholder">${escapeHtml(e.message || 'Ошибка загрузки')}</div>`;
      box.dataset.loaded = '1';
    }
  }
  function setPlayerTab(tab) {
    document.querySelectorAll('.player-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'lyrics') {
      el.lyricsPanel.classList.remove('hidden');
      el.lyricsPanel.setAttribute('aria-hidden', 'false');
      el.bigCoverWrap.style.display = 'none';
      if (state.currentTrack) loadLyrics(state.currentTrack);
    } else {
      el.lyricsPanel.classList.add('hidden');
      el.lyricsPanel.setAttribute('aria-hidden', 'true');
      el.bigCoverWrap.style.display = '';
      clearLyricsSync();
    }
  }
  function showLyrics() {
    if (state.view !== 'player') showView('player');
    setTimeout(() => setPlayerTab('lyrics'), 60);
  }

  // ============================================================
  // VIEWS
  // ============================================================
  function showView(view) {
    if (state.view === view) return;
    if (state.view !== 'player') state.lastNonPlayerView = state.view;
    state.view = view;
    const map = {
      home: el.homeView || $('homeView'),
      search: $('searchView'),
      library: $('libraryView'),
      favorites: $('favoritesView'),
      playlists: $('playlistsView'),
      playlist: $('playlistView'),
      settings: $('settingsView'),
      player: $('playerView'),
      artist: $('artistView'),
      album: $('albumView')
    };
    Object.entries(map).forEach(([k, node]) => { if (node) node.classList.toggle('hidden', k !== view); });
    document.querySelectorAll('.nav-btn').forEach(b => {
      const v = b.dataset.view;
      const active = v === view || (view === 'playlist' && v === 'playlists');
      b.classList.toggle('active', active);
    });
    // back button
    const isNested = ['artist', 'album', 'playlist', 'player'].includes(view);
    el.topbarBack.classList.toggle('hidden', !isNested);

    if (view === 'home') renderHome();
    if (view === 'library') { renderHistory(); renderLocal(); }
    if (view === 'favorites') renderFavorites();
    if (view === 'playlists') { loadPlaylists(); renderPlaylists(); }
    if (view === 'settings') { renderSettingsUi(); refreshDiagnostics(); }
    if (view === 'player') { updatePlayerView(); updateQueue(); }
  }
  function goBack() {
    const target = state.lastNonPlayerView || 'home';
    if (state.view === 'playlist') { showView('playlists'); return; }
    if (state.view === 'player') { showView(target); return; }
    showView(target);
  }

  // ============================================================
  // HASH ROUTING (лёгкий)
  // ============================================================
  window.addEventListener('hashchange', () => {
    const h = window.location.hash.replace('#', '');
    if (h && h !== state.view) {
      // только для простых
      if (['home', 'search', 'library', 'favorites', 'playlists', 'settings'].includes(h)) showView(h);
    }
  });

  // ============================================================
  // SETTINGS UI
  // ============================================================
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    if (el.themeToggle) el.themeToggle.textContent = settings.theme === 'dark' ? 'Тёмная' : 'Светлая';
    store.set('nova_theme', settings.theme);
  }
  function applyToggle(btn, on) {
    if (!btn) return;
    btn.textContent = on ? 'Вкл' : 'Выкл';
    btn.classList.toggle('primary', on);
    btn.classList.toggle('off', !on);
  }
  function renderSettingsUi() {
    applyTheme();
    applyToggle(el.notificationsToggle, settings.notifications);
    applyToggle(el.hotkeysToggle, settings.hotkeys);
    applyToggle(el.autoplayToggle, settings.autoplay);
    if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';
    renderAccentPicker();
    renderBgPresets();
    renderUser();
  }
  function renderAccentPicker() {
    const c = el.accentPresets;
    if (!c) return;
    c.innerHTML = '';
    const list = ['purple', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'rose', 'magenta', 'indigo', 'white'];
    const cur = document.documentElement.getAttribute('data-accent') || 'purple';
    list.forEach(a => {
      const b = document.createElement('button');
      b.className = 'accent-preset' + (a === cur ? ' active' : '');
      b.dataset.accent = a;
      b.title = a;
      b.addEventListener('click', () => {
        document.documentElement.setAttribute('data-accent', a);
        store.set('nova_accent', a);
        c.querySelectorAll('.accent-preset').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        // обновить glow из обложки в новом accent
        if (state.currentTrack?.cover) updateAmbientFromCover(state.currentTrack.cover);
        notify('Цвет: ' + a);
      });
      c.appendChild(b);
    });
  }
  function renderBgPresets() {
    const c = el.bgPresets;
    if (!c) return;
    const presets = [
      { name: 'Нет', value: '' },
      { name: 'Космос', value: 'radial-gradient(ellipse at top,#0b0b1e 0%,#000 60%)' },
      { name: 'Закат', value: 'linear-gradient(135deg,#2a0a14 0%,#0a0408 60%,#000 100%)' },
      { name: 'Океан', value: 'linear-gradient(180deg,#001018 0%,#000 100%)' },
      { name: 'Графит', value: 'linear-gradient(180deg,#101010 0%,#000 100%)' }
    ];
    c.innerHTML = '';
    presets.forEach(p => {
      const b = document.createElement('div');
      b.className = 'bg-preset';
      b.title = p.name;
      b.style.background = p.value || '#0a0a0a';
      if (p.value) b.style.background = p.value;
      b.addEventListener('click', () => {
        state.background.src = p.value;
        saveBgData(p.value).catch(() => {});
        applyBackground(p.value);
        notify('Фон: ' + p.name);
      });
      c.appendChild(b);
    });
  }
  function renderEqBands() {
    const box = el.equalizerBands;
    if (!box) return;
    box.innerHTML = '';
    EQ_BANDS.forEach((b, i) => {
      const val = state.eq.bands[i] || 0;
      const w = document.createElement('div');
      w.className = 'eq-band';
      w.innerHTML = `<div class="eq-band-value">${val > 0 ? '+' : ''}${val}</div><input type="range" class="eq-slider" min="-15" max="15" value="${val}" step="1" data-band="${i}"><div class="eq-band-label">${b.label}</div>`;
      box.appendChild(w);
      const s = w.querySelector('input');
      s.addEventListener('input', () => {
        const v = Number(s.value);
        w.querySelector('.eq-band-value').textContent = (v > 0 ? '+' : '') + v;
        setEqBand(i, v);
      });
    });
  }
  function renderEqPresets() {
    const box = el.equalizerPresets;
    if (!box) return;
    box.innerHTML = '';
    Object.keys(EQ_PRESETS).forEach(n => {
      const b = document.createElement('button');
      b.className = 'eq-preset';
      b.textContent = n;
      b.addEventListener('click', () => applyEqPreset(n));
      box.appendChild(b);
    });
  }
  function openEqualizer() {
    initAudioGraph();
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(applyEq).catch(() => {});
    renderEqBands(); renderEqPresets();
    const isYt = !!(ytIframe && ytCurrentVideo);
    if (isYt) {
      el.eqNotice.textContent = 'Эквалайзер не применяется к YouTube-трекам. Запусти Audius или локальный файл.';
      el.eqNotice.style.display = 'block';
    } else if (!state.currentTrack) {
      el.eqNotice.textContent = 'Сначала включи трек.';
      el.eqNotice.style.display = 'block';
    } else el.eqNotice.style.display = 'none';
    el.equalizerModal.classList.add('open');
    el.equalizerModal.setAttribute('aria-hidden', 'false');
  }
  function closeEqualizer() {
    el.equalizerModal.classList.remove('open');
    el.equalizerModal.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // PROFILE MODAL
  // ============================================================
  async function openProfile() {
    el.profileModal.classList.add('open');
    el.profileModal.setAttribute('aria-hidden', 'false');
    const u = state.user;
    if (u) {
      const url = u.provider === 'discord' ? avatarUrl(u) : defaultAvatarSvg();
      el.profileAvatarBig.innerHTML = `<img src="${url}" alt="">`;
      el.profileName.textContent = u.username || 'User';
      el.profileTag.textContent = '@' + (u.username || 'user').toLowerCase();
    } else {
      el.profileAvatarBig.textContent = 'G';
      el.profileName.textContent = 'Гость';
      el.profileTag.textContent = '@guest';
    }
    if (!u || !authToken) {
      el.statTracks.textContent = '0';
      el.statArtists.textContent = '0';
      el.statPlaylists.textContent = '0';
      el.profileSummaryTitle.textContent = 'Войди, чтобы увидеть статистику';
      el.profileTopArtists.innerHTML = '<div class="profile-panel-empty">Нет данных</div>';
      el.profileTopTracks.innerHTML = '<div class="profile-panel-empty">Нет данных</div>';
      return;
    }
    el.profileSummaryTitle.textContent = 'Загрузка…';
    try {
      const s = await apiAuth('/api/stats');
      el.statTracks.textContent = formatNumber(s.tracks || 0);
      el.statArtists.textContent = formatNumber(s.artists || 0);
      el.statPlaylists.textContent = formatNumber(s.playlists || 0);
      el.profileSummaryTitle.textContent = (s.tracks || 0) > 0 ? 'Твоя медиатека активна' : 'Пока чистая история';
      if (s.topArtists?.length) {
        el.profileTopArtists.innerHTML = s.topArtists.map((a, i) =>
          `<div class="profile-panel-item" data-artist="${escapeHtml(a.name)}"><div class="profile-panel-num">${i + 1}</div><div class="profile-panel-info"><div class="profile-panel-title">${escapeHtml(a.name)}</div><div class="profile-panel-sub">Артист</div></div><div class="profile-panel-count">${a.count}</div></div>`).join('');
        el.profileTopArtists.querySelectorAll('.profile-panel-item').forEach(it => it.addEventListener('click', () => {
          closeProfile(); showArtist('', it.dataset.artist);
        }));
      } else el.profileTopArtists.innerHTML = '<div class="profile-panel-empty">Нет данных</div>';
      if (s.topTracks?.length) {
        el.profileTopTracks.innerHTML = s.topTracks.map((t, i) =>
          `<div class="profile-panel-item" data-idx="${i}"><div class="profile-panel-num">${i + 1}</div><div class="profile-panel-info"><div class="profile-panel-title">${escapeHtml(t.track.title || '—')}</div><div class="profile-panel-sub">${escapeHtml(t.track.artist || '')}</div></div><div class="profile-panel-count">${t.count}</div></div>`).join('');
        el.profileTopTracks.querySelectorAll('.profile-panel-item').forEach(it => it.addEventListener('click', () => {
          const tr = s.topTracks[Number(it.dataset.idx)].track;
          closeProfile();
          state.tracks = [normalizeTrack(tr)].filter(Boolean);
          if (state.tracks.length) playTrack(0, { force: true });
        }));
      } else el.profileTopTracks.innerHTML = '<div class="profile-panel-empty">Нет данных</div>';
    } catch { el.profileSummaryTitle.textContent = 'Не удалось загрузить'; }
  }
  function closeProfile() {
    el.profileModal.classList.remove('open');
    el.profileModal.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // HISTORY HELPERS
  // ============================================================
  function addHistory(track) {
    const k = trackKey(track);
    state.history = state.history.filter(x => trackKey(x) !== k);
    state.history.unshift({ ...track, playedAt: Date.now() });
    state.history = state.history.slice(0, 300);
    persist();
    renderHistory();
    if (state.user && authToken) {
      apiAuth('/api/history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(track)
      }).catch(() => {});
    }
  }
  function reportTrackPlay(track) {
    if (!track || !state.user || !authToken) return;
    apiAuth('/api/track-play', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(track)
    }).catch(() => {});
  }
  async function loadRecommendations() {
    if (!state.user || !authToken) { state.recommendations = []; return; }
    try {
      const r = await apiAuth('/api/recommendations');
      state.recommendations = (r.results || []).map(normalizeTrack).filter(Boolean);
      if (el.recommendationsSub) {
        el.recommendationsSub.textContent = r.based_on?.length ? 'По мотивам: ' + r.based_on.slice(0, 3).join(', ') : 'Популярное сейчас';
      }
      renderHome();
    } catch { state.recommendations = []; }
  }

  // ============================================================
  // DIAGNOSTICS
  // ============================================================
  function refreshDiagnostics() {
    const box = el.diagnostics;
    if (!box) return;
    const t = state.currentTrack;
    const rows = [
      ['Backend', (location.origin || '—')],
      ['Track', t ? `${t.title || '—'} — ${t.artist || '—'}` : '—'],
      ['Provider', t?.provider || '—'],
      ['Stream URL', t?._resolveData?.url ? t._resolveData.url.slice(0, 80) + '…' : '—'],
      ['Audio error', lastPlaybackError || (el.audio?.error ? `code ${el.audio.error.code}` : 'нет')],
      ['readyState', el.audio?.readyState ?? '—'],
      ['networkState', el.audio?.networkState ?? '—'],
      ['currentTime', Number.isFinite(el.audio?.currentTime) ? el.audio.currentTime.toFixed(1) + 's' : '—'],
      ['duration', Number.isFinite(el.audio?.duration) ? el.audio.duration.toFixed(1) + 's' : '—'],
      ['volume', state.volume + '%'],
      ['queue', `${state.queue.length} треков`],
      ['favorites', `${state.favorites.length}`],
      ['history', `${state.history.length}`]
    ];
    box.innerHTML = rows.map(([k, v]) =>
      `<div class="diag-row"><span class="diag-key">${escapeHtml(k)}</span><span class="diag-val">${escapeHtml(String(v))}</span></div>`
    ).join('');
  }

  // ============================================================
  // WAVE CANVAS
  // ============================================================
  (function initWaves() {
    const canvas = el.waveCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, raf = null, t = 0;
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function getAccent() {
      return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      const accent = getAccent();
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        const amp = 16 + i * 8, speed = 0.008 + i * 0.003, yBase = H * 0.6 + i * 18;
        for (let x = 0; x <= W; x += 6) {
          const y = yBase + Math.sin(x * 0.006 + t * speed * 10 + i) * amp
            + Math.sin(x * 0.014 + t * speed * 6 + i * 2) * (amp * 0.4);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.05 + i * 0.03;
        ctx.lineWidth = 2 - i * 0.3;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      t++; raf = requestAnimationFrame(draw);
    }
    function start() { resize(); if (raf) cancelAnimationFrame(raf); draw(); }
    window.addEventListener('resize', resize);
    start();
  })();

  // ============================================================
  // WIRE HANDLERS
  // ============================================================

  // Sidebar nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v === 'settings') { showView('settings'); return; }
      if (v === 'search') { showView('search'); el.searchInput.focus(); return; }
      showView(v);
    });
  });
  on(el.logoBtn, 'click', () => showView('home'));
  on(el.topbarBack, 'click', goBack);

  // Search
  let searchDebounceTimer = null;
  on(el.searchInput, 'input', () => {
    clearTimeout(searchDebounceTimer);
    const v = el.searchInput.value.trim();
    if (!v) return;
    searchDebounceTimer = setTimeout(() => doSearch(v), 350);
  });
  on(el.searchInput, 'keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchDebounceTimer); doSearch(el.searchInput.value); el.searchInput.blur(); }
    if (e.key === 'Escape') el.searchInput.blur();
  });

  // Search filters
  document.querySelectorAll('.search-filter').forEach(b => {
    b.addEventListener('click', () => {
      state.searchFilter = b.dataset.filter;
      document.querySelectorAll('.search-filter').forEach(x => x.classList.toggle('active', x === b));
      applySearchFilter();
    });
  });
  function applySearchFilter() {
    const f = state.searchFilter;
    el.searchArtistsBlock.style.display = (f === 'all' || f === 'artists') && state.lastSearchArtists.length ? '' : 'none';
    el.searchTracksBlock.style.display = (f === 'all' || f === 'tracks') ? '' : 'none';
  }

  // User slot
  on(el.avatarBtn, 'click', e => {
    e.stopPropagation();
    if (!state.user) { openLoginModal(); return; }
    toggleUserMenu();
  });
  on(el.userLoginBtn, 'click', () => { toggleUserMenu(false); openLoginModal(); });
  on(el.userLogoutBtn, 'click', () => logout());
  on(el.openProfileBtn, 'click', () => { toggleUserMenu(false); openProfile(); });
  document.addEventListener('click', e => {
    if (!el.userMenu.contains(e.target) && e.target !== el.avatarBtn) toggleUserMenu(false);
  });

  // Login modal
  on(el.loginClose, 'click', closeLoginModal);
  on(el.loginDiscordBtn, 'click', loginViaDiscord);
  on(el.loginModal, 'click', e => { if (e.target === el.loginModal) closeLoginModal(); });
  on(el.tabLogin, 'click', () => setAuthMode('login'));
  on(el.tabRegister, 'click', () => setAuthMode('register'));
  on(el.localAuthForm, 'submit', submitLocalAuth);
  on(el.continueAsGuest, 'click', closeLoginModal);

  // Settings
  on(el.themeToggle, 'click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  on(el.notificationsToggle, 'click', () => {
    settings.notifications = !settings.notifications;
    store.set('nova_notifications', settings.notifications ? '1' : '0');
    applyToggle(el.notificationsToggle, settings.notifications);
  });
  on(el.hotkeysToggle, 'click', () => {
    settings.hotkeys = !settings.hotkeys;
    store.set('nova_hotkeys', settings.hotkeys ? '1' : '0');
    applyToggle(el.hotkeysToggle, settings.hotkeys);
  });
  on(el.autoplayToggle, 'click', () => {
    settings.autoplay = !settings.autoplay;
    store.set('nova_autoplay', settings.autoplay ? '1' : '0');
    applyToggle(el.autoplayToggle, settings.autoplay);
  });
  on(el.backgroundBtn, 'click', () => el.backgroundInput.click());
  on(el.backgroundResetBtn, 'click', resetBackground);
  on(el.backgroundInput, 'change', e => saveSelectedBackground(e.target.files?.[0]));
  on(el.settingsOpenFileBtn, 'click', localAudioPicker);
  on(el.settingsAccountBtn, 'click', () => {
    if (state.user) logout();
    else openLoginModal();
  });
  on(el.clearHistory2, 'click', () => {
    state.history = [];
    persist(); renderHistory();
    if (state.user && authToken) apiAuth('/api/history', { method: 'DELETE' }).catch(() => {});
    notify('История очищена');
  });
  on(el.clearFavorites2, 'click', () => {
    state.favorites = [];
    persist(); renderFavorites();
    notify('Избранное очищено');
  });
  on(el.clearCacheBtn, 'click', () => {
    localResolveCache.clear();
    notify('Кэш резолва очищен');
  });

  // Library tabs
  document.querySelectorAll('#libraryTabs .page-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#libraryTabs .page-tab').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.page-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    });
  });
  on(el.clearHistory, 'click', () => {
    state.history = [];
    persist(); renderHistory();
    if (state.user && authToken) apiAuth('/api/history', { method: 'DELETE' }).catch(() => {});
    notify('История очищена');
  });
  on(el.openLocalFileBtn, 'click', localAudioPicker);
  on(el.localAudioInput, 'change', e => { handleLocalFiles(e.target.files); el.localAudioInput.value = ''; });

  // Local drop zone
  if (el.localDrop) {
    el.localDrop.addEventListener('click', () => localAudioPicker());
    ['dragenter', 'dragover'].forEach(ev => el.localDrop.addEventListener(ev, e => {
      e.preventDefault(); el.localDrop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => el.localDrop.addEventListener(ev, e => {
      e.preventDefault(); el.localDrop.classList.remove('dragover');
    }));
    el.localDrop.addEventListener('drop', e => {
      if (e.dataTransfer?.files) handleLocalFiles(e.dataTransfer.files);
    });
  }
  // Глобальный DnD на весь view
  document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    const v = state.view;
    if (v === 'library' || v === 'home') {
      e.preventDefault();
      handleLocalFiles(e.dataTransfer.files);
      if (v !== 'library') showView('library');
    }
  });

  // Favorites actions
  on(el.favoritesPlay, 'click', () => {
    if (!state.favorites.length) return;
    state.tracks = state.favorites.slice();
    playTrack(0, { force: true });
  });
  on(el.favoritesShuffle, 'click', () => {
    if (!state.favorites.length) return;
    state.tracks = state.favorites.slice().sort(() => Math.random() - 0.5);
    state.shuffle = true; updateModeButtons();
    playTrack(0, { force: true });
  });
  on(el.clearFavorites, 'click', () => {
    state.favorites = [];
    persist(); renderFavorites();
    notify('Избранное очищено');
  });

  // Playlists
  on(el.createPlaylistBtn, 'click', () => openPlaylistCreate());
  on(el.playlistCreateClose, 'click', closePlaylistCreate);
  on(el.playlistCreateModal, 'click', e => { if (e.target === el.playlistCreateModal) closePlaylistCreate(); });
  on(el.playlistCreateSubmit, 'click', submitPlaylistCreate);
  on(el.playlistNameInput, 'keydown', e => { if (e.key === 'Enter') submitPlaylistCreate(); });
  on(el.playlistPickerClose, 'click', closePlaylistPicker);
  on(el.playlistPickerModal, 'click', e => { if (e.target === el.playlistPickerModal) closePlaylistPicker(); });
  on(el.playlistPickerNew, 'click', () => {
    const tracksRaw = el.playlistPickerModal.dataset.tracks;
    closePlaylistPicker();
    let tracks = [];
    try { tracks = JSON.parse(tracksRaw || '[]'); } catch {}
    openPlaylistCreate(tracks[0]);
  });

  // Player controls
  on(el.miniPlay, 'click', playCurrentOrFirst);
  on(el.largePlayBtn, 'click', playCurrentOrFirst);
  on(el.prevBtn, 'click', previous);
  on(el.miniPrev, 'click', previous);
  on(el.nextBtn, 'click', next);
  on(el.miniNext, 'click', next);
  on(el.repeatBtn, 'click', toggleRepeat);
  on(el.miniRepeat, 'click', toggleRepeat);
  on(el.shuffleBtn, 'click', toggleShuffle);
  on(el.miniShuffle, 'click', toggleShuffle);
  on(el.favoriteBtn, 'click', () => { if (state.currentTrack) toggleFavorite(state.currentTrack); });
  on(el.miniFavorite, 'click', () => { if (state.currentTrack) toggleFavorite(state.currentTrack); });
  on(el.lyricsBtn, 'click', showLyrics);
  on(el.miniLyrics, 'click', showLyrics);
  on(el.queueToggleBtn, 'click', () => {
    const open = !el.queuePanel.classList.contains('open');
    el.queuePanel.classList.toggle('open', open);
    el.queuePanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  });
  on(el.queueClose, 'click', () => {
    el.queuePanel.classList.remove('open');
    el.queuePanel.setAttribute('aria-hidden', 'true');
  });
  on(el.queueClear, 'click', clearQueue);
  on(el.moreBtn, 'click', e => { if (state.currentTrack) showContextMenu(e, state.currentTrack); });
  on(el.similarBtn, 'click', () => {
    if (!state.currentTrack) return notify('Сначала включи трек');
    const a = splitArtistsList(state.currentTrack.artist)[0];
    if (!a) return;
    el.searchInput.value = a;
    doSearch(a);
  });
  on(el.downloadBtn, 'click', downloadCurrent);

  on(el.progress, 'input', () => seekToValue(el.progress.value));
  on(el.miniProgress, 'input', () => seekToValue(el.miniProgress.value));
  on(el.volumeLarge, 'input', () => setVolume(el.volumeLarge.value));
  on(el.volumeMini, 'input', () => setVolume(el.volumeMini.value));
  on(el.miniVolIcon, 'click', () => {
    if (state.volume > 0) { mutedBefore = state.volume; setVolume(0); }
    else setVolume(mutedBefore || 100);
  });
  on(el.miniExpand, 'click', () => { if (state.currentTrack) showView('player'); });
  on(el.miniTrackClick, 'click', () => { if (state.currentTrack) showView('player'); });
  on(el.bigCover, 'click', () => openSongInfo(state.currentTrack));

  // Player tabs
  document.querySelectorAll('.player-tab').forEach(tab => {
    tab.addEventListener('click', () => setPlayerTab(tab.dataset.tab));
  });
  on(el.lyricsRefresh, 'click', () => { if (state.currentTrack) loadLyrics(state.currentTrack, true); });

  // Song info modal
  on(el.songInfoClose, 'click', closeSongInfo);
  on(el.songInfoModal, 'click', e => { if (e.target === el.songInfoModal) closeSongInfo(); });
  on(el.songInfoPlay, 'click', () => {
    if (!songInfoCurrent) return;
    const i = state.tracks.findIndex(x => trackKey(x) === trackKey(songInfoCurrent));
    if (i >= 0) playTrack(i, { force: true });
    else { state.tracks.unshift(songInfoCurrent); playTrack(0, { force: true }); }
    closeSongInfo();
  });
  on(el.songInfoFavorite, 'click', () => {
    if (!songInfoCurrent) return;
    toggleFavorite(songInfoCurrent);
    el.songInfoFavorite.textContent = isFavorite(songInfoCurrent) ? '♥ В избранном' : '♡ В избранное';
  });
  on(el.songInfoQueue, 'click', () => { if (songInfoCurrent) addToQueue(songInfoCurrent); });
  on(el.songInfoDownload, 'click', () => {
    if (!songInfoCurrent) return;
    const saved = state.currentTrack;
    state.currentTrack = songInfoCurrent;
    downloadCurrent().finally(() => { state.currentTrack = saved; });
  });

  // Equalizer
  on(el.equalizerBtn, 'click', openEqualizer);
  on(el.equalizerClose, 'click', closeEqualizer);
  on(el.equalizerModal, 'click', e => { if (e.target === el.equalizerModal) closeEqualizer(); });

  // Profile
  on(el.profileModalClose, 'click', closeProfile);
  on(el.profileModal, 'click', e => { if (e.target === el.profileModal) closeProfile(); });
  el.profileModal?.querySelectorAll('.profile-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action;
      if (a === 'logout') { closeProfile(); logout(); }
      else if (a === 'copy') { if (state.user) { try { navigator.clipboard.writeText(state.user.id); notify('ID скопирован'); } catch {} } else notify('Войди'); }
    });
  });

  // Audio events
  on(el.audio, 'loadedmetadata', updateProgress);
  on(el.audio, 'durationchange', updateProgress);
  on(el.audio, 'timeupdate', updateProgress);
  on(el.audio, 'play', () => { userIntent = 'playing'; updatePlayButtons(); });
  on(el.audio, 'pause', () => { if (userIntent !== 'loading' && userIntent !== 'error') userIntent = 'paused'; updatePlayButtons(); });
  on(el.audio, 'playing', () => { userIntent = 'playing'; updatePlayButtons(); updateProgress(); });
  on(el.audio, 'waiting', () => { if (state.currentTrack && userIntent !== 'paused') updatePlayButtons(); });
  on(el.audio, 'error', () => {
    if (state.currentTrack && userIntent !== 'paused') {
      lastPlaybackError = 'audio error ' + (el.audio.error?.code || '');
      refreshDiagnostics();
    }
  });
  let preEndFadeTriggered = false;
  on(el.audio, 'timeupdate', () => {
    const d = el.audio.duration, c = el.audio.currentTime;
    if (!Number.isFinite(d) || d < 5) return;
    if (!preEndFadeTriggered && d - c < 1.2 && d - c > 0.2 && !state.repeat) {
      preEndFadeTriggered = true;
      rampFadeTo(0, 1000);
    }
  });
  on(el.audio, 'play', () => { preEndFadeTriggered = false; });
  on(el.audio, 'ended', () => {
    clearLyricsSync();
    userIntent = 'idle';
    preEndFadeTriggered = false;
    if (state.repeat) {
      el.audio.currentTime = 0;
      rampFadeTo(1, 200);
      el.audio.play().catch(() => {});
      return;
    }
    if (!settings.autoplay) return;
    next();
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (el.songInfoModal.classList.contains('open')) closeSongInfo();
      else if (el.equalizerModal.classList.contains('open')) closeEqualizer();
      else if (el.profileModal.classList.contains('open')) closeProfile();
      else if (el.playlistPickerModal.classList.contains('open')) closePlaylistPicker();
      else if (el.playlistCreateModal.classList.contains('open')) closePlaylistCreate();
      else if (el.queuePanel.classList.contains('open')) {
        el.queuePanel.classList.remove('open');
        el.queuePanel.setAttribute('aria-hidden', 'true');
      }
      hideContextMenu();
      return;
    }
    // Ctrl+K — фокус на поиск
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      return;
    }
    if (!settings.hotkeys) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); playCurrentOrFirst(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekDelta(5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekDelta(-5); }
    else if (e.key.toLowerCase() === 'n') next();
    else if (e.key.toLowerCase() === 'p') previous();
    else if (e.key.toLowerCase() === 'm') setVolume(state.volume > 0 ? 0 : (mutedBefore || 100));
    else if (e.key.toLowerCase() === 'l') showLyrics();
  });

  // Interval safety
  setInterval(() => {
    if (ytIframe && ytCurrentVideo) {
      if (userIntent === 'paused') ytSendCommand('pauseVideo');
      updateProgress(); updatePlayButtons();
      return;
    }
    if (state.currentTrack && userIntent === 'playing') updateProgress();
  }, 1000);
  setInterval(refreshDiagnostics, 3000);
  setInterval(checkApi, 30000);

  // Artist links (global delegation)
  document.addEventListener('click', e => {
    const link = e.target?.closest?.('.artist-link');
    if (!link) return;
    e.preventDefault(); e.stopPropagation();
    const name = link.dataset.artist || link.textContent || '';
    if (name) showArtist('', name);
  }, true);

  // beforeunload
  window.addEventListener('beforeunload', persist);

  // Suggestions (популярное)
  (function initSuggestions() {
    const input = el.searchInput;
    const box = el.searchSuggestions;
    if (!input || !box) return;
    let popularItems = [];
    let popularLoaded = false;
    let popularTime = 0;
    let timer = null;
    function hide() { box.classList.add('hidden'); box.innerHTML = ''; }
    function showLoading() { box.innerHTML = '<div class="suggestion-empty">Загрузка…</div>'; box.classList.remove('hidden'); }
    function showEmpty() { box.innerHTML = '<div class="suggestion-empty">Ничего не найдено</div>'; box.classList.remove('hidden'); }
    function show(items, label) {
      if (!items.length) { showEmpty(); return; }
      box.innerHTML = label ? `<div class="suggestion-label">${escapeHtml(label)}</div>` : '';
      items.slice(0, 8).forEach((item, i) => {
        const s = document.createElement('div');
        s.className = 'suggestion';
        s.style.animationDelay = (i * 25) + 'ms';
        const fb = placeholderCover();
        s.innerHTML = `<img src="${item.cover || fb}" alt=""><div class="suggestion-main"><div class="suggestion-title">${escapeHtml(item.title || '')}</div><div class="suggestion-artist">${escapeHtml(item.artist || '—')}</div></div><span class="suggestion-badge">${item.provider || 'CATALOG'}</span>`;
        s.addEventListener('mousedown', e => {
          e.preventDefault();
          input.value = [item.title, item.artist].filter(Boolean).join(' ');
          hide();
          doSearch(input.value);
        });
        box.appendChild(s);
      });
      box.classList.remove('hidden');
    }
    async function getPopular() {
      if (popularLoaded && Date.now() - popularTime < 10 * 60 * 1000) return popularItems;
      showLoading();
      try {
        const r = await fetch(apiBase() + '/api/popular');
        const d = await r.json();
        popularItems = (d.results || []).map(normalizeTrack).filter(Boolean);
        popularLoaded = true; popularTime = Date.now();
      } catch { popularItems = []; }
      return popularItems;
    }
    async function trigger() {
      const q = input.value.trim().toLowerCase();
      const items = await getPopular();
      if (!items.length) { hide(); return; }
      if (!q) { show(items.slice(0, 8), 'Популярное сейчас'); return; }
      const filtered = items.filter(x => {
        const t = String(x.title || '').toLowerCase();
        const a = String(x.artist || '').toLowerCase();
        return t.includes(q) || a.includes(q);
      });
      if (filtered.length) { show(filtered, 'Популярное'); return; }
      hide();
    }
    input.addEventListener('focus', () => { clearTimeout(timer); timer = setTimeout(trigger, 80); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(trigger, 150); });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== input) hide(); });
  })();

  // Download
  async function downloadCurrent() {
    const track = state.currentTrack;
    if (!track) return notify('Нет трека');
    try {
      const rd = track._resolveData;
      const vid = rd?.videoId || track.videoId;
      if (vid) {
        const name = ((track.artist || 'Unknown') + ' - ' + (track.title || 'Track')).replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120);
        const a = document.createElement('a');
        a.href = apiBase() + '/api/download/youtube/' + encodeURIComponent(vid) + '?name=' + encodeURIComponent(name);
        a.download = name + '.m4a';
        document.body.appendChild(a); a.click(); a.remove();
        notify('Загрузка началась');
        return;
      }
      notify('Источник не поддерживает скачивание', 'error');
    } catch { notify('Не удалось скачать', 'error'); }
  }

  // ============================================================
  // START
  // ============================================================
  applyTheme();
  setVolume(state.volume);
  updateModeButtons();
  renderUser();
  renderFavorites();
  renderHistory();
  renderLocal();
  renderPlaylists();
  updateMiniPlayer();
  updateQueue();
  renderAccentPicker();
  renderBgPresets();
  checkApi();
  refreshDiagnostics();

  const wasCallback = checkLoginCallback();
  setAuthMode('login');
  (async () => {
    if (authToken) await loadUserData();
    else renderUser();
    if (wasCallback) closeLoginModal();
    else setTimeout(() => { if (!state.user) openLoginModal(); }, 700);
  })();

  async function startup() {
    try {
      el.startupStatus.textContent = 'Восстанавливаем данные…';
      await loadSavedBackground();
      el.startupStatus.textContent = 'Проверяем NOVA…';
      await checkApi(true);
      el.startupStatus.textContent = 'Загружаем популярное…';
      try {
        const r = await fetch(apiBase() + '/api/popular');
        const d = await r.json();
        state.popularTracks = (d.results || []).map(normalizeTrack).filter(Boolean);
      } catch {}
      renderHome();
    } catch (e) { console.error('[startup]', e); }
    finally { setTimeout(() => el.startupScreen.classList.add('hidden'), 250); }
  }
  startup();

  // expose для отладки
  window.NOVA = { state, settings, playTrack, doSearch, showView };

})();
