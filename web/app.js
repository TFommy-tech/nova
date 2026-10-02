(function(){
  'use strict';

  const memoryStore = Object.create(null);
  const store = {
    get(key, fallback){
      try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
      catch (_) { return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : fallback; }
    },
    set(key, value){
      try { localStorage.setItem(key, String(value)); }
      catch (_) { memoryStore[key] = String(value); }
    },
    remove(key){
      try { localStorage.removeItem(key); } catch (_) { delete memoryStore[key]; }
    }
  };

  let savedFavorites = [];
  let savedHistory = [];
  let savedUser = null;
  try { savedFavorites = JSON.parse(store.get('nova_favorites', '[]')); } catch (_) { savedFavorites = []; }
  try { savedHistory = JSON.parse(store.get('nova_history', '[]')); } catch (_) { savedHistory = []; }
  try { savedUser = JSON.parse(store.get('nova_user', 'null')); } catch (_) { savedUser = null; }
  if (!Array.isArray(savedFavorites)) savedFavorites = [];
  if (!Array.isArray(savedHistory)) savedHistory = [];

  const API_TOKEN_KEY = 'nova_token';
  let authToken = store.get(API_TOKEN_KEY, '');

  const state = {
    tracks: [],
    popularTracks: [],
    currentIndex: -1,
    currentTrack: null,
    sourceFilter: 'ALL',
    query: 'pop',
    repeat: false,
    shuffle: false,
    favorites: savedFavorites,
    history: savedHistory,
    volume: Number(store.get('nova_volume', '100')) || 100,
    view: 'home',
    playState: 'idle',
    searchRequest: 0,
    user: savedUser,
    background: { src: '', darkness: 72, blur: 0, opacity: 100 }
  };

  const el = {
    searchInput: document.getElementById('searchInput'),
    searchButton: document.getElementById('searchButton'),
    sourceSelect: document.getElementById('sourceSelect'),
    connection: document.getElementById('connection'),
    resultsInfo: document.getElementById('resultsInfo'),
    homeContinue: document.getElementById('homeContinue'),
    homePopular: document.getElementById('homePopular'),
    homeArtists: document.getElementById('homeArtists'),
    homeAlbums: document.getElementById('homeAlbums'),
    homeGreeting: document.getElementById('homeGreeting'),
    backgroundLayer: document.getElementById('backgroundLayer'),
    backgroundShade: document.getElementById('backgroundShade'),
    startupScreen: document.getElementById('startupScreen'),
    startupStatus: document.getElementById('startupStatus'),
    backgroundInput: document.getElementById('backgroundInput'),
    localAudioInput: document.getElementById('localAudioInput'),
    backgroundBtn: document.getElementById('backgroundBtn'),
    backgroundResetBtn: document.getElementById('backgroundResetBtn'),
    settingsOpenFileBtn: document.getElementById('settingsOpenFileBtn'),
    openLocalFileBtn: document.getElementById('openLocalFileBtn'),
    infoDrawer: document.getElementById('infoDrawer'),
    infoDrawerClose: document.getElementById('infoDrawerClose'),
    infoCover: document.getElementById('infoCover'),
    infoTitle: document.getElementById('infoTitle'),
    infoArtist: document.getElementById('infoArtist'),
    infoMeta: document.getElementById('infoMeta'),
    infoFavorite: document.getElementById('infoFavorite'),
    infoQueue: document.getElementById('infoQueue'),
    artistHeroImage: document.getElementById('artistHeroImage'),
    artistHeroName: document.getElementById('artistHeroName'),
    artistTracks: document.getElementById('artistTracks'),
    artistAlbums: document.getElementById('artistAlbums'),
    artistSingles: document.getElementById('artistSingles'),
    albumHeroImage: document.getElementById('albumHeroImage'),
    albumHeroName: document.getElementById('albumHeroName'),
    albumHeroArtist: document.getElementById('albumHeroArtist'),
    albumHeroMeta: document.getElementById('albumHeroMeta'),
    albumTracks: document.getElementById('albumTracks'),
    albumPlay: document.getElementById('albumPlay'),
    grid: document.getElementById('trackGrid'),
    miniPlayer: document.getElementById('miniPlayer'),
    miniCover: document.getElementById('miniCover'),
    miniTitle: document.getElementById('miniTitle'),
    miniArtist: document.getElementById('miniArtist'),
    miniPlay: document.getElementById('miniPlay'),
    miniPlayIcon: document.getElementById('miniPlayIcon'),
    largePlayIcon: document.getElementById('largePlayIcon'),
    bigCover: document.getElementById('bigCover'),
    nowTitle: document.getElementById('nowTitle'),
    nowArtist: document.getElementById('nowArtist'),
    progress: document.getElementById('progress'),
    currentTime: document.getElementById('currentTime'),
    duration: document.getElementById('duration'),
    queueContent: document.getElementById('queueContent'),
    volumeLarge: document.getElementById('volumeLarge'),
    volumeMini: document.getElementById('volumeMini'),
    libraryList: document.getElementById('libraryList'),
    favoritesList: document.getElementById('favoritesList'),
    clearHistory: document.getElementById('clearHistory'),
    clearFavorites: document.getElementById('clearFavorites'),
    settingsVolumeValue: document.getElementById('settingsVolumeValue'),
    lyricsModal: document.getElementById('lyricsModal'),
    lyricsClose: document.getElementById('lyricsClose'),
    lyricsTrackTitle: document.getElementById('lyricsTrackTitle'),
    lyricsTrackArtist: document.getElementById('lyricsTrackArtist'),
    lyricsBody: document.getElementById('lyricsBody'),
    audio: document.getElementById('audio'),
    toast: document.getElementById('toast'),
    avatarBtn: document.getElementById('avatarBtn'),
    userSlot: document.getElementById('userSlot'),
    userMenu: document.getElementById('userMenu'),
    userAvatar: document.getElementById('userAvatar'),
    userName: document.getElementById('userName'),
    userTag: document.getElementById('userTag'),
    userLoginBtn: document.getElementById('userLoginBtn'),
    userLogoutBtn: document.getElementById('userLogoutBtn'),
    loginModal: document.getElementById('loginModal'),
    loginClose: document.getElementById('loginClose'),
    loginDiscordBtn: document.getElementById('loginDiscordBtn'),
    tabLogin: document.getElementById('tabLogin'),
    tabRegister: document.getElementById('tabRegister'),
    localAuthForm: document.getElementById('localAuthForm'),
    authUsername: document.getElementById('authUsername'),
    authPassword: document.getElementById('authPassword'),
    authError: document.getElementById('authError'),
    authSubmit: document.getElementById('authSubmit'),
    continueAsGuest: document.getElementById('continueAsGuest')
  };

  function apiBase(){ return window.location.origin; }

  let backgroundLoaded = false;
  let backgroundDbPromise = null;
  let searchAbort = null;

  function openLocalAudioPicker(){ el.localAudioInput.click(); }
  function openBackgroundPicker(){ el.backgroundInput.click(); }

  function backgroundDb(){
    if (backgroundDbPromise) return backgroundDbPromise;
    backgroundDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('nova-settings', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('settings')) req.result.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return backgroundDbPromise;
  }

  async function saveBackgroundData(value){
    try {
      const db = await backgroundDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(value, 'background');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { try { store.set('nova_background_fallback', value); } catch (_) {} }
  }

  async function loadBackgroundData(){
    try {
      const db = await backgroundDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readonly');
        const req = tx.objectStore('settings').get('background');
        req.onsuccess = () => resolve(req.result || '');
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return store.get('nova_background_fallback', ''); }
  }

  function applyBackground(src){
    if (!src){
      document.body.classList.remove('has-background');
      el.backgroundLayer.style.backgroundImage = 'none';
      el.backgroundLayer.style.background = '#000';
      el.backgroundLayer.style.opacity = '0';
      return;
    }
    document.body.classList.add('has-background');
    if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('/')){
      el.backgroundLayer.style.background = '#000 center/cover no-repeat';
      el.backgroundLayer.style.backgroundImage = 'url("' + src.replace(/"/g, '\\"') + '")';
    } else {
      el.backgroundLayer.style.backgroundImage = 'none';
      el.backgroundLayer.style.background = src;
    }
    el.backgroundLayer.style.opacity = '1';
    el.backgroundShade.style.background = 'rgba(0,0,0,.72)';
    backgroundLoaded = true;
  }

  async function loadSavedBackground(){
    const src = await loadBackgroundData();
    if (src){ state.background.src = src; applyBackground(src); }
  }

  async function saveSelectedBackground(file){
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) return notify('Поддерживаются PNG, JPG, WEBP и GIF');
    const reader = new FileReader();
    reader.onload = async () => {
      state.background.src = String(reader.result || '');
      await saveBackgroundData(state.background.src);
      applyBackground(state.background.src);
      notify('Фон изменён');
    };
    reader.onerror = () => notify('Не удалось загрузить фон');
    reader.readAsDataURL(file);
  }

  function resetBackground(){
    state.background.src = '';
    saveBackgroundData('').catch(() => {});
    applyBackground('');
    notify('Фон сброшен');
  }

  // ==================== USER ====================
  function avatarUrl(user){
    if (!user) return '';
    if (!user.avatar){
      const idx = user.id && /^\d+$/.test(user.id) ? Number(BigInt(user.id) >> 22n) % 6 : 0;
      return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
    }
    const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.' + ext + '?size=128';
  }

  function defaultAvatarSvg(){
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1a1a1a"/><circle cx="32" cy="24" r="10" fill="#4a4a4a"/><path d="M12 56c3-12 11-17 20-17s17 5 20 17z" fill="#4a4a4a"/></svg>');
  }

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
  function toggleUserMenu(force){
    const open = force !== undefined ? force : !el.userMenu.classList.contains('open');
    el.userMenu.classList.toggle('open', open);
  }

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
      state.user = me;
      state.favorites = Array.isArray(favs) ? favs : [];
      state.history = Array.isArray(hist) ? hist : [];
      store.set('nova_user', JSON.stringify(me));
      renderUser();
      renderFavorites();
      renderLibrary();
      notify('Добро пожаловать, ' + me.username + '!');
    } catch (e){
      console.warn('[auth] token invalid');
      authToken = '';
      store.remove(API_TOKEN_KEY);
      state.user = null;
      renderUser();
    }
  }

  function logout(){
    authToken = '';
    store.remove(API_TOKEN_KEY);
    store.remove('nova_user');
    state.user = null;
    state.favorites = [];
    state.history = [];
    persist();
    renderUser();
    renderFavorites();
    renderLibrary();
    notify('Вы вышли');
    toggleUserMenu(false);
  }

  function loginViaDiscord(){ window.location.href = '/api/auth/discord'; }

  function checkLoginCallback(){
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') !== 'success') return false;
    const token = params.get('token');
    if (!token) return false;
    authToken = token;
    store.set(API_TOKEN_KEY, token);
    window.history.replaceState({}, '', '/');
    return true;
  }

  let authMode = 'login';

  function setAuthMode(mode){
    authMode = mode;
    el.tabLogin.classList.toggle('active', mode === 'login');
    el.tabRegister.classList.toggle('active', mode === 'register');
    el.authSubmit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    el.authUsername.value = '';
    el.authPassword.value = '';
    el.authError.classList.add('hidden');
    el.authError.textContent = '';
  }

  function showAuthError(msg){
    el.authError.textContent = msg;
    el.authError.classList.remove('hidden');
  }

  async function submitLocalAuth(e){
    e.preventDefault();
    const username = el.authUsername.value.trim();
    const password = el.authPassword.value;
    if (!username || !password){ showAuthError('Заполни оба поля'); return; }
    el.authSubmit.disabled = true;
    el.authSubmit.textContent = '…';
    try {
      const url = authMode === 'register' ? '/api/register' : '/api/login';
      const r = await fetch(apiBase() + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      authToken = data.token;
      store.set(API_TOKEN_KEY, data.token);
      state.user = data.user;
      store.set('nova_user', JSON.stringify(data.user));
      await loadUserData();
      closeLoginModal();
      renderUser();
    } catch (err){
      showAuthError(err.message || 'Ошибка входа');
    } finally {
      el.authSubmit.disabled = false;
      el.authSubmit.textContent = authMode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  }

  // ==================== RENDER HOME ====================
  function renderHome(){
    const recent = state.history.slice(0, 8);
    el.homeContinue.innerHTML = '';
    if (!recent.length){
      el.homeContinue.innerHTML = '<div class="empty" style="grid-column:1/-1"><div>Начни слушать музыку</div></div>';
    } else {
      recent.forEach(t => el.homeContinue.appendChild(makeHomeTrackCard(t)));
    }

    const popular = state.popularTracks.length ? state.popularTracks : state.tracks.slice(0, 12);
    el.homePopular.innerHTML = '';
    popular.slice(0, 12).forEach(t => el.homePopular.appendChild(makeHomeTrackCard(t)));

    const q = normalizeSearch(state.query || '');
    const wantsArtist = /(artist|исполнитель|певец|группа|band|singer)/i.test(q);
    const artistsSection = document.getElementById('artistsSection');
    if (artistsSection) artistsSection.style.display = wantsArtist ? '' : 'none';

    if (wantsArtist){
      const artists = [];
      const seenArtists = new Set();
      for (const t of state.tracks){
        const key = normalizeSearch(t.artist);
        if (key && !seenArtists.has(key) && !isBadArtist(t.artist)){
          seenArtists.add(key);
          artists.push(t);
        }
        if (artists.length >= 10) break;
      }
      el.homeArtists.innerHTML = '';
      artists.forEach(t => el.homeArtists.appendChild(makeHomeArtistCard(t)));
    }

    const albums = [];
    const seenAlbums = new Set();
    for (const t of state.tracks){
      if (!t.albumId) continue;
      const key = normalizeSearch((t.album || '') + '|' + (t.artist || ''));
      if (t.album && key && !seenAlbums.has(key)){
        seenAlbums.add(key);
        albums.push(t);
      }
      if (albums.length >= 10) break;
    }
    el.homeAlbums.innerHTML = '';
    albums.forEach(t => el.homeAlbums.appendChild(makeHomeAlbumCard(t)));
  }

  function makeHomeTrackCard(track){
    const d = document.createElement('div');
    d.className = 'home-mini-card';
    const img = document.createElement('img');
    img.className = 'home-mini-cover';
    img.alt = '';
    if (track.cover) img.src = track.cover;
    else img.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#0b0b0b"/><text x="150" y="165" fill="#444" font-size="72" text-anchor="middle">♪</text></svg>');
    const title = document.createElement('div');
    title.className = 'home-mini-title';
    title.textContent = track.title || 'Без названия';
    const sub = document.createElement('div');
    sub.className = 'home-mini-sub';
    sub.textContent = track.artist || '—';
    d.append(img, title, sub);
    d.addEventListener('click', () => {
      const i = state.tracks.findIndex(x => trackKey(x) === trackKey(track));
      if (i >= 0) playTrack(i);
      else { state.tracks = [track]; playTrack(0); }
      showView('player');
    });
    return d;
  }

  function makeHomeArtistCard(track){
    const d = makeHomeTrackCard(track);
    d.onclick = () => showArtist(track.artistId || '', track.artist || '');
    d.querySelector('.home-mini-cover').style.borderRadius = '50%';
    d.querySelector('.home-mini-title').classList.add('inline-link');
    return d;
  }

  function makeHomeAlbumCard(track){
    const d = makeHomeTrackCard(track);
    d.onclick = () => { if (track.albumId) showAlbum(track.albumId); };
    d.querySelector('.home-mini-title').classList.add('inline-link');
    return d;
  }

  function updateInfoDrawer(){
    const t = state.currentTrack;
    if (!t){
      el.infoTitle.textContent = 'Ничего не играет';
      el.infoArtist.textContent = '—';
      el.infoMeta.textContent = '—';
      return;
    }
    el.infoTitle.textContent = t.title || 'Без названия';
    el.infoArtist.textContent = t.artist || '—';
    el.infoMeta.textContent = [t.album, t.duration ? formatTime(t.duration) : ''].filter(Boolean).join(' · ') || 'Трек';
    if (t.cover) el.infoCover.src = t.cover;
    else el.infoCover.removeAttribute('src');
    el.infoFavorite.textContent = isFavorite(t) ? 'В избранном' : 'В избранное';
  }

  function openInfoDrawer(){
    if (!state.currentTrack) return;
    updateInfoDrawer();
    el.infoDrawer.classList.add('open');
    el.infoDrawer.setAttribute('aria-hidden', 'false');
  }

  function closeInfoDrawer(){
    el.infoDrawer.classList.remove('open');
    el.infoDrawer.setAttribute('aria-hidden', 'true');
  }

  async function startup(){
    try {
      el.startupStatus.textContent = 'Восстанавливаем данные…';
      await loadSavedBackground();
      el.startupStatus.textContent = 'Проверяем NOVA…';
      await checkApi(true);
      el.startupStatus.textContent = 'Загружаем популярное…';
      await Promise.allSettled([loadPopular(), search('pop', { startup: true })]);
      renderHome();
    } catch (e){ console.error('[NOVA startup]', e); }
    finally { setTimeout(() => el.startupScreen.classList.add('hidden'), 250); }
  }

  async function loadPopular(){
    try {
      const r = await fetch(apiBase() + '/api/popular');
      const d = await r.json();
      state.popularTracks = (d.results || []).map(normalizeTrack);
    } catch (e){ console.warn('[popular]', e.message); }
  }

  function escapeHtml(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatTime(seconds){
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const r = String(s % 60).padStart(2, '0');
    return m + ':' + r;
  }

  function trackKey(track){
    return [String(track.source || ''), String(track.id || ''), String(track.title || ''), String(track.artist || '')].join('|');
  }

  function coverFor(track){ return track && track.cover ? track.cover : ''; }
  function sourceClass(source){ if (source === 'FULL') return 'full'; if (source === 'PREVIEW') return 'preview'; return 'catalog'; }
  function isBadArtist(name){ const x = normalizeSearch(name); return !x || /^(unknown( artist)?|various artists|no name|без названия|без исполнителя|null|undefined)$/i.test(x); }
  function isNoiseTrack(track){ const title = normalizeSearch(track.title); const artist = normalizeSearch(track.artist); if (!title || isBadArtist(artist) || /^(unknown|без названия|null|undefined)$/i.test(title)) return true; return /(^| )(karaoke|instrumental|reaction|parody|tribute|8d)( |$)/i.test(title); }

  function notify(message){
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  function persist(){
    store.set('nova_favorites', JSON.stringify(state.favorites));
    store.set('nova_history', JSON.stringify(state.history));
    store.set('nova_volume', String(state.volume));
  }

  function isFavorite(track){ const key = trackKey(track); return state.favorites.some(t => trackKey(t) === key); }

  function toggleFavorite(track){
    const key = trackKey(track);
    const wasFav = isFavorite(track);
    if (wasFav){
      state.favorites = state.favorites.filter(t => trackKey(t) !== key);
      notify('Удалено из избранного');
      if (state.user && authToken) apiAuth('/api/favorites/' + encodeURIComponent(key), { method: 'DELETE' }).catch(() => {});
    } else {
      state.favorites.unshift(track);
      notify('Добавлено в избранное');
      if (state.user && authToken){
        apiAuth('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(track) }).catch(() => {});
      }
    }
    state.favorites = state.favorites.slice(0, 500);
    persist();
    renderFavorites();
  }

  function addHistory(track){
    const key = trackKey(track);
    state.history = state.history.filter(t => trackKey(t) !== key);
    state.history.unshift(track);
    state.history = state.history.slice(0, 300);
    persist();
    renderLibrary();
    if (state.user && authToken){
      apiAuth('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(track) }).catch(() => {});
    }
  }

  function setConnection(ok, message){
    el.connection.textContent = message;
    el.connection.className = 'connection ' + (ok ? 'ok' : 'bad');
  }

  async function checkApi(silent = false){
    try {
      const r = await fetch(apiBase() + '/api/health', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('health');
      setConnection(true, 'API: online');
    } catch (error) { if (!silent) setConnection(false, 'API: offline'); }
  }

  function filteredTracks(){
    if (state.sourceFilter === 'ALL') return state.tracks;
    return state.tracks.filter(track => track.source === state.sourceFilter);
  }

  function renderTracks(){
    const tracks = filteredTracks();
    el.grid.innerHTML = '';
    if (!tracks.length){
      el.grid.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div>Ничего не найдено</div></div>';
      el.resultsInfo.textContent = '0 результатов';
      return;
    }
    el.resultsInfo.textContent = tracks.length + ' результатов';
    tracks.forEach((track, index) => {
      const actualIndex = state.tracks.indexOf(track);
      const card = document.createElement('article');
      card.className = 'card';
      card.style.animationDelay = (index * 25) + 'ms';
      const coverBox = document.createElement('div');
      coverBox.className = 'cover-box';
      if (coverFor(track)){
        const img = document.createElement('img');
        img.className = 'cover'; img.alt = ''; img.loading = 'lazy';
        img.src = coverFor(track);
        img.onerror = function(){
          img.style.display = 'none';
          const fb = document.createElement('div');
          fb.className = 'cover-fallback'; fb.textContent = '♪';
          coverBox.appendChild(fb);
        };
        coverBox.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'cover-fallback'; fb.textContent = '♪';
        coverBox.appendChild(fb);
      }
      const badge = document.createElement('div');
      badge.className = 'source-badge ' + sourceClass(track.source);
      badge.textContent = track.source || 'CATALOG';
      coverBox.appendChild(badge);
      const play = document.createElement('div');
      play.className = 'play-card';
      play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      coverBox.appendChild(play);
      const copy = document.createElement('div');
      copy.className = 'card-copy';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = track.title || 'Без названия';
      const artist = document.createElement('div');
      artist.className = 'card-artist';
      artist.textContent = track.artist || 'Неизвестный исполнитель';
      copy.appendChild(title);
      copy.appendChild(artist);
      artist.classList.add('inline-link');
      artist.addEventListener('click', function(e){ e.stopPropagation(); showArtist(track.artistId || '', track.artist || ''); });
      card.appendChild(coverBox);
      card.appendChild(copy);
      card.addEventListener('click', () => playTrack(actualIndex));
      card.addEventListener('contextmenu', function(e){ e.preventDefault(); toggleFavorite(track); });
      el.grid.appendChild(card);
    });
  }

  function updateMiniPlayer(){
    const track = state.currentTrack;
    if (!track){
      el.miniTitle.textContent = 'Ничего не играет';
      el.miniArtist.textContent = '—';
      el.miniCover.removeAttribute('src');
      el.miniPlayer.classList.remove('visible');
      return;
    }
    el.miniTitle.textContent = track.title || 'Без названия';
    el.miniArtist.textContent = track.artist || '—';
    if (coverFor(track)) el.miniCover.src = coverFor(track);
    else el.miniCover.removeAttribute('src');
    el.miniPlayer.classList.add('visible');
    updatePlayButtons();
  }

  function updatePlayer(){
    const track = state.currentTrack;
    if (!track){
      el.nowTitle.textContent = 'Ничего не играет';
      el.nowArtist.textContent = 'Выбери трек в поиске';
      el.bigCover.removeAttribute('src');
      el.duration.textContent = '0:00';
      el.currentTime.textContent = '0:00';
      el.progress.value = 0;
      el.progress.style.setProperty('--progress', '0%');
      return;
    }
    el.nowTitle.textContent = track.title || 'Без названия';
    el.nowArtist.textContent = track.artist || '—';
    if (coverFor(track)) el.bigCover.src = coverFor(track);
    else el.bigCover.removeAttribute('src');
    updateQueue();
    updatePlayButtons();
  }

  function updateQueue(){
    if (!state.tracks.length || state.currentIndex < 0){ el.queueContent.textContent = 'Queue is empty'; return; }
    const queued = state.tracks.slice(state.currentIndex + 1, state.currentIndex + 5).map(track => track.title);
    if (!queued.length){ el.queueContent.textContent = 'Queue is empty'; return; }
    el.queueContent.innerHTML = queued.map(title => '<strong>' + escapeHtml(title) + '</strong>').join('<br>');
  }

  function updatePlayButtons(){
    const playing = !!state.currentTrack && !el.audio.paused && state.playState === 'playing';
    const loading = state.playState === 'loading';
    [el.miniPlay, document.getElementById('largePlayBtn')].forEach(btn => { if (btn) btn.classList.toggle('loading', loading); });
    if (loading){
      el.miniPlayIcon.innerHTML = '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="22 22"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".9s" repeatCount="indefinite"/></circle>';
      el.largePlayIcon.innerHTML = el.miniPlayIcon.innerHTML;
      return;
    }
    if (playing){
      el.miniPlayIcon.innerHTML = '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>';
      el.largePlayIcon.innerHTML = el.miniPlayIcon.innerHTML;
    } else {
      el.miniPlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      el.largePlayIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  }

  function normalizeSearch(value){
    return String(value || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function searchScore(track, query){
    const q = normalizeSearch(query);
    const title = normalizeSearch(track.title);
    const artist = normalizeSearch(track.artist);
    if (!q) return 0;
    const tokens = q.split(/\s+/).filter(Boolean);
    let score = 0;
    const combined = title + ' ' + artist;

    if (title === q) score += 1000000;
    else if (title.startsWith(q)) score += 500000;
    else if (title.includes(q)) score += 200000;

    if (artist === q) score += 800000;
    else if (artist.startsWith(q)) score += 400000;
    else if (artist.includes(q)) score += 150000;

    let hits = 0;
    for (const token of tokens){
      if (title.split(/\s+/).includes(token)) hits += 3;
      else if (artist.split(/\s+/).includes(token)) hits += 2;
      else if (combined.includes(token)) hits += 1;
    }
    score += hits * 1500;

    const pop = Number(track.popularity || 0);
    if (pop > 0) score += Math.log10(pop + 1) * 5000;

    if (track.provider === 'itunes') score += 30000;
    if (track.provider === 'spotify') score += 20000;
    if (track.source === 'FULL') score += 500;
    return score;
  }

  function sortSearchResults(list, query){
    return list
      .map((track, index) => ({ track, index, score: searchScore(track, query) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      })
      .map(item => item.track);
  }

  async function search(query, options = {}){
    const q = String(query || '').trim();
    if (!q) return;
    state.query = q;
    const requestId = ++state.searchRequest;
    if (searchAbort) searchAbort.abort();
    const controller = new AbortController();
    searchAbort = controller;
    el.searchButton.disabled = true;
    el.searchButton.textContent = '…';
    el.resultsInfo.textContent = 'Поиск…';
    try {
      const response = await fetch(apiBase() + '/api/search?q=' + encodeURIComponent(q), {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (requestId !== state.searchRequest) return;
      state.tracks = Array.isArray(data.results) ? data.results.map(normalizeTrack) : [];
      state.tracks = sortSearchResults(state.tracks, q);
      renderTracks();
      renderHome();
      setConnection(true, 'API: online');
      el.resultsInfo.textContent = state.tracks.length + ' результатов';
      if (state.tracks.length && !options.startup) notify(state.tracks.length + ' результатов');
    } catch (error){
      if (requestId !== state.searchRequest || error.name === 'AbortError') return;
      console.error('[SEARCH]', error);
      state.tracks = [];
      el.grid.innerHTML = '<div class="empty" style="grid-column:1/-1;"><div>Не удалось выполнить поиск.</div></div>';
      el.resultsInfo.textContent = 'Ошибка';
      setConnection(false, 'API: ошибка');
      notify('Ошибка поиска');
    } finally {
      if (requestId === state.searchRequest){ el.searchButton.disabled = false; el.searchButton.textContent = 'Найти'; }
    }
  }

  function normalizeTrack(track){
    return {
      id: track.id || track.trackId || track.uri || track.link || cryptoLike(track),
      title: track.title || track.trackName || track.name || 'Без названия',
      artist: track.artist || track.artistName || (track.artists && track.artists[0] && track.artists[0].name) || '',
      artistId: track.artistId || (track.artists && track.artists[0] && track.artists[0].id) || '',
      cover: track.cover || track.artwork || track.artworkUrl100 || '',
      preview: track.preview || track.previewUrl || track.preview_url || track.audio || '',
      source: String(track.source || 'CATALOG').toUpperCase(),
      downloadable: !!track.downloadable,
      downloadUrl: track.downloadUrl || '',
      album: track.album || track.albumName || track.collectionName || '',
      albumId: track.albumId || '',
      duration: Number(track.duration || (Number(track.trackTimeMillis || 0) / 1000) || 0),
      bitrate: Number(track.bitrate || track.bitrate_kbps || 0),
      popularity: Number(track.popularity || 0),
      provider: track.provider || '',
      sourceUrl: track.sourceUrl || track.link || track.external_url || '',
      localUrl: track.localUrl || ''
    };
  }

  function cryptoLike(track){
    const str = [track.title || '', track.artist || track.artistName || '', track.source || ''].join('|');
    let hash = 0;
    for (let i = 0; i < str.length; i++){ hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
    return 't_' + Math.abs(hash);
  }

  async function resolveAudioCandidates(track){
    if (!track) return [];
    if (track.localUrl) return [track.localUrl];
    const candidates = [];
    const q = [track.title, track.artist].filter(Boolean).join(' ');
    if (q){
      try {
        const r = await fetch(apiBase() + '/api/audio/resolve?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok && d.streamUrl && !candidates.includes(d.streamUrl)) candidates.push(d.streamUrl);
      } catch (e){ console.warn('[resolve]', e.message); }
    }
    if (track.source === 'FULL' && track.id){
      const u = apiBase() + '/api/audio/audius/' + encodeURIComponent(track.id);
      if (!candidates.includes(u)) candidates.push(u);
    }
    if (track.preview && !candidates.includes(track.preview)) candidates.push(track.preview);
    return candidates;
  }

  async function playUrl(url){
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
    el.audio.src = url;
    el.audio.volume = state.volume / 100;
    el.audio.load();
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { el.audio.removeEventListener('playing', ok); el.audio.removeEventListener('error', bad); };
      const ok = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const bad = () => { if (settled) return; settled = true; cleanup(); reject(new Error('audio error ' + (el.audio.error?.code || ''))); };
      el.audio.addEventListener('playing', ok, { once: true });
      el.audio.addEventListener('error', bad, { once: true });
      setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error('timeout')); }, 12000);
      el.audio.play().catch(bad);
    });
  }

  async function playTrack(index){
    if (!Number.isInteger(index) || index < 0 || index >= state.tracks.length) return;
    const track = state.tracks[index];
    state.currentIndex = index;
    state.currentTrack = track;
    state.playState = 'loading';
    updateMiniPlayer(); updatePlayer(); updateInfoDrawer(); updatePlayButtons();
    try {
      const candidates = await resolveAudioCandidates(track);
      if (!candidates.length) throw new Error('no source');
      let lastError = null;
      for (const url of candidates){
        try {
          await playUrl(url);
          state.playState = 'playing';
          addHistory(track);
          renderHome();
          updatePlayButtons();
          openInfoDrawer();
          updateInfoDrawer();
          return;
        } catch (error){ lastError = error; }
      }
      throw lastError || new Error('no source');
    } catch (error){
      state.playState = 'error';
      updatePlayButtons();
      notify('Не удалось запустить трек');
    }
  }

  function playCurrentOrFirst(){
    if (state.currentTrack){
      if (state.playState === 'loading') return;
      if (el.audio.paused){
        el.audio.play().then(() => { state.playState = 'playing'; updatePlayButtons(); }).catch(() => playTrack(state.currentIndex));
      } else { el.audio.pause(); state.playState = 'paused'; updatePlayButtons(); }
      return;
    }
    if (state.tracks.length) playTrack(0);
  }

  function previous(){
    if (!state.tracks.length) return;
    if (el.audio.currentTime > 4){ el.audio.currentTime = 0; return; }
    let index = state.currentIndex - 1;
    if (index < 0) index = state.tracks.length - 1;
    playTrack(index);
  }

  function next(){
    if (!state.tracks.length) return;
    if (state.shuffle){
      let nextIndex = state.currentIndex;
      if (state.tracks.length > 1){ while (nextIndex === state.currentIndex) nextIndex = Math.floor(Math.random() * state.tracks.length); }
      playTrack(nextIndex); return;
    }
    let nextIndex = state.currentIndex + 1;
    if (nextIndex >= state.tracks.length) nextIndex = 0;
    playTrack(nextIndex);
  }

  function toggleRepeat(){ state.repeat = !state.repeat; updateModeButtons(); notify(state.repeat ? 'Повтор включён' : 'Повтор выключен'); }
  function toggleShuffle(){ state.shuffle = !state.shuffle; updateModeButtons(); notify(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено'); }

  function updateModeButtons(){
    const repeatButtons = [document.getElementById('repeatBtn'), document.getElementById('miniRepeat')];
    const shuffleButtons = [document.getElementById('shuffleBtn'), document.getElementById('miniShuffle')];
    repeatButtons.forEach(btn => { btn.style.color = state.repeat ? '#fff' : ''; btn.style.background = state.repeat ? '#151515' : ''; });
    shuffleButtons.forEach(btn => { btn.style.color = state.shuffle ? '#fff' : ''; btn.style.background = state.shuffle ? '#151515' : ''; });
  }

  function seekFromProgress(){
    if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
    el.audio.currentTime = el.audio.duration * (Number(el.progress.value) / 1000);
  }

  function updateProgress(){
    const duration = el.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0){
      el.progress.value = 0;
      el.progress.style.setProperty('--progress', '0%');
      el.currentTime.textContent = '0:00';
      el.duration.textContent = '0:00';
      return;
    }
    const current = el.audio.currentTime || 0;
    const percent = Math.max(0, Math.min(100, current / duration * 100));
    el.progress.value = Math.round(percent * 10);
    el.progress.style.setProperty('--progress', percent + '%');
    el.currentTime.textContent = formatTime(current);
    el.duration.textContent = formatTime(duration);
  }

  function setVolume(value){
    state.volume = Math.max(0, Math.min(100, Number(value) || 0));
    el.audio.volume = state.volume / 100;
    el.volumeMini.value = state.volume;
    el.volumeLarge.value = state.volume;
    if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';
    persist();
  }

  function showSearchView(){ showView('search'); }

  function showView(view){
    state.view = view;
    const views = {
      home: document.getElementById('homeView'),
      search: document.getElementById('searchView'),
      library: document.getElementById('libraryView'),
      favorites: document.getElementById('favoritesView'),
      settings: document.getElementById('settingsView'),
      player: document.getElementById('playerView'),
      artist: document.getElementById('artistView'),
      album: document.getElementById('albumView')
    };
    Object.keys(views).forEach(key => views[key].classList.toggle('hidden', key !== view));
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === (view === 'player' ? 'search' : view));
    });
    if (view === 'home') renderHome();
    if (view === 'library') renderLibrary();
    if (view === 'favorites') renderFavorites();
  }

  async function showArtist(id, name){
    showView('artist');
    el.artistHeroName.textContent = name || 'Исполнитель';
    el.artistHeroImage.removeAttribute('src');
    el.artistTracks.innerHTML = '<div class="empty">Загрузка…</div>';
    el.artistAlbums.innerHTML = '';
    el.artistSingles.innerHTML = '';
    if (!id){ el.artistTracks.innerHTML = '<div class="empty">Нет данных об артисте.</div>'; return; }
    try {
      const r = await fetch(apiBase() + '/api/artist/' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'artist unavailable');
      el.artistHeroName.textContent = d.artist?.name || name || 'Исполнитель';
      if (d.artist?.picture_xl || d.artist?.picture_big) el.artistHeroImage.src = d.artist.picture_xl || d.artist.picture_big;
      renderList(el.artistTracks, (d.top_tracks || []).map(normalizeTrack));
      const albums = d.albums || [];
      el.artistAlbums.innerHTML = '';
      albums.filter(x => x.type !== 'single').forEach(a => {
        el.artistAlbums.appendChild(makeHomeAlbumCard({ id: String(a.id), albumId: String(a.id), title: a.title, artist: d.artist?.name || name, cover: a.cover_xl || a.cover_big || a.cover_medium || '' }));
      });
      const singles = d.singles || [];
      el.artistSingles.innerHTML = '';
      singles.forEach(a => {
        el.artistSingles.appendChild(makeHomeAlbumCard({ id: String(a.id), albumId: String(a.id), title: a.title, artist: d.artist?.name || name, cover: a.cover_xl || a.cover_big || a.cover_medium || '' }));
      });
    } catch (e){
      el.artistTracks.innerHTML = '<div class="empty">Не удалось загрузить артиста.</div>';
    }
  }

  async function showAlbum(id){
    showView('album');
    el.albumTracks.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      const r = await fetch(apiBase() + '/api/album/' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'album unavailable');
      const rawTracks = Array.isArray(d.tracks) ? d.tracks : (d.tracks?.data || []);
      el.albumHeroName.textContent = d.title || 'Альбом';
      el.albumHeroArtist.textContent = d.artist?.name || '—';
      el.albumHeroMeta.textContent = [d.release_date?.slice?.(0, 4), d.record_type, rawTracks.length + ' треков'].filter(Boolean).join(' · ');
      if (d.cover_xl) el.albumHeroImage.src = d.cover_xl;
      const tracks = rawTracks.map(normalizeTrack);
      el.albumTracks.innerHTML = '';
      tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = '<div style="color:#555;font-size:10px">' + String(i + 1).padStart(2, '0') + '</div><div class="list-main"><strong>' + escapeHtml(t.title) + '</strong><span>' + escapeHtml(t.artist) + '</span></div><div class="row-actions"><button class="small-btn">▶</button></div>';
        row.querySelector('button').onclick = e => { e.stopPropagation(); state.tracks = tracks.slice(); playTrack(i); showView('player'); };
        row.onclick = () => { state.tracks = tracks.slice(); playTrack(i); showView('player'); };
        el.albumTracks.appendChild(row);
      });
      el.albumPlay.onclick = () => { state.tracks = tracks.slice(); if (tracks.length) playTrack(0); };
    } catch (e){
      el.albumTracks.innerHTML = '<div class="empty">Не удалось загрузить альбом.</div>';
    }
  }

  if (document.getElementById('artistBack')) document.getElementById('artistBack').addEventListener('click', () => showView('home'));
  if (document.getElementById('albumBack')) document.getElementById('albumBack').addEventListener('click', () => showView('home'));

  function renderList(container, list){
    container.innerHTML = '';
    if (!list.length){ container.innerHTML = '<div class="empty"><div>Здесь пока ничего нет.</div></div>'; return; }
    list.forEach(track => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const cover = document.createElement('img');
      cover.className = 'list-cover'; cover.alt = '';
      if (track.cover) cover.src = track.cover;
      const main = document.createElement('div');
      main.className = 'list-main';
      const title = document.createElement('strong');
      title.textContent = track.title || 'Без названия';
      const artist = document.createElement('span');
      artist.textContent = track.artist || '—';
      main.append(title, artist);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const play = document.createElement('button');
      play.className = 'small-btn'; play.textContent = '▶';
      const favorite = document.createElement('button');
      favorite.className = 'small-btn';
      favorite.textContent = isFavorite(track) ? '♥' : '♡';
      play.addEventListener('click', event => {
        event.stopPropagation();
        const idx = state.tracks.findIndex(item => trackKey(item) === trackKey(track));
        if (idx >= 0){ playTrack(idx); showView('player'); }
        else { state.tracks = [track]; playTrack(0); showView('player'); }
      });
      favorite.addEventListener('click', event => {
        event.stopPropagation();
        toggleFavorite(track);
        renderLibrary();
        renderFavorites();
      });
      actions.append(play, favorite);
      row.append(cover, main, actions);
      row.addEventListener('click', () => {
        const idx = state.tracks.findIndex(item => trackKey(item) === trackKey(track));
        if (idx >= 0) playTrack(idx);
        else { state.tracks = [track]; playTrack(0); }
        showView('player');
      });
      container.appendChild(row);
    });
  }

  function renderLibrary(){ renderList(el.libraryList, state.history); }
  function renderFavorites(){ renderList(el.favoritesList, state.favorites); }

  async function downloadCurrent(){
    const track = state.currentTrack;
    if (!track){ notify('Нет текущего трека'); return; }
    if (!track.downloadable){ notify('Скачивание недоступно'); return; }
    try {
      const url = track.downloadUrl || '';
      if (!url){ notify('Скачивание недоступно'); return; }
      const response = await fetch(url);
      if (!response.ok) throw new Error('dl');
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (track.artist || 'Unknown') + ' - ' + (track.title || 'Track') + '.mp3';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      notify('Загрузка началась');
    } catch (error){ notify('Не удалось скачать'); }
  }

  async function showLyrics(){
    const track = state.currentTrack;
    if (!track){ notify('Сначала включи трек'); return; }
    el.lyricsTrackTitle.textContent = track.title || 'Текст';
    el.lyricsTrackArtist.textContent = track.artist || '—';
    el.lyricsBody.innerHTML = '<div class="lyrics-loading">Ищу текст…</div>';
    el.lyricsModal.classList.add('open');
    el.lyricsModal.setAttribute('aria-hidden', 'false');
    try {
      const params = new URLSearchParams({ track_name: track.title || '', artist_name: track.artist || '' });
      if (track.album) params.set('album_name', track.album);
      if (track.duration > 0) params.set('duration', String(Math.round(track.duration)));
      const response = await fetch(apiBase() + '/api/lyrics?' + params.toString());
      const data = await response.json();
      if (!response.ok || !data || !data.found) throw new Error(data?.message || 'Не найдено');
      const lyrics = data.syncedLyrics || data.plainLyrics || '';
      if (!lyrics.trim()) throw new Error('Не найдено');
      el.lyricsBody.textContent = lyrics;
    } catch (error){
      el.lyricsBody.innerHTML = '<div class="lyrics-loading">' + escapeHtml(error.message || 'Текст не найден') + '</div>';
    }
  }

  function closeLyrics(){ el.lyricsModal.classList.remove('open'); el.lyricsModal.setAttribute('aria-hidden', 'true'); }
  function showEqualizer(){ notify('Эквалайзер: 5-полосный режим'); }
  function findSimilar(){
    if (!state.currentTrack){ notify('Сначала включи трек'); return; }
    const artist = String(state.currentTrack.artist || '').trim();
    if (!artist) return;
    el.searchInput.value = artist;
    showView('search');
    search(artist);
  }

  // ==================== EVENTS ====================
  el.searchButton.addEventListener('click', () => search(el.searchInput.value));
  el.searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter'){ event.preventDefault(); search(el.searchInput.value); }
  });
  if (el.sourceSelect) el.sourceSelect.addEventListener('change', () => { state.sourceFilter = el.sourceSelect.value; renderTracks(); });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'search'){ showSearchView(); el.searchInput.focus(); return; }
      showView(view);
    });
  });

  document.getElementById('logoBtn').addEventListener('click', () => showView('home'));

  el.avatarBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!state.user){ openLoginModal(); return; }
    toggleUserMenu();
  });
  el.userLoginBtn.addEventListener('click', () => { toggleUserMenu(false); openLoginModal(); });
  el.userLogoutBtn.addEventListener('click', () => logout());
  document.addEventListener('click', e => {
    if (!el.userMenu.contains(e.target) && e.target !== el.avatarBtn) toggleUserMenu(false);
  });

  el.loginClose.addEventListener('click', closeLoginModal);
  el.loginDiscordBtn.addEventListener('click', loginViaDiscord);
  el.loginModal.addEventListener('click', e => { if (e.target === el.loginModal) closeLoginModal(); });

  el.tabLogin.addEventListener('click', () => setAuthMode('login'));
  el.tabRegister.addEventListener('click', () => setAuthMode('register'));
  el.localAuthForm.addEventListener('submit', submitLocalAuth);
  el.continueAsGuest.addEventListener('click', () => { closeLoginModal(); store.set('nova_guest_dismissed', '1'); });

  if (el.openLocalFileBtn) el.openLocalFileBtn.addEventListener('click', openLocalAudioPicker);
  if (el.settingsOpenFileBtn) el.settingsOpenFileBtn.addEventListener('click', openLocalAudioPicker);
  if (el.backgroundBtn) el.backgroundBtn.addEventListener('click', openBackgroundPicker);
  if (el.backgroundResetBtn) el.backgroundResetBtn.addEventListener('click', resetBackground);
  if (el.backgroundInput) el.backgroundInput.addEventListener('change', e => saveSelectedBackground(e.target.files?.[0]));
  if (el.localAudioInput) el.localAudioInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const track = { id: 'local_' + Date.now(), title: file.name.replace(/\.[^.]+$/, ''), artist: 'Локальный файл', album: '', cover: '', source: 'LOCAL', localUrl: url, duration: 0 };
    state.tracks.unshift(track);
    playTrack(state.tracks.indexOf(track));
  });

  if (el.infoDrawerClose) el.infoDrawerClose.addEventListener('click', closeInfoDrawer);
  if (el.infoFavorite) el.infoFavorite.addEventListener('click', () => { if (state.currentTrack){ toggleFavorite(state.currentTrack); updateInfoDrawer(); } });
  if (el.infoQueue) el.infoQueue.addEventListener('click', () => notify('Очередь в плеере'));

  [document.getElementById('miniPlay'), document.getElementById('largePlayBtn')].forEach(btn => btn.addEventListener('click', () => playCurrentOrFirst()));
  [document.getElementById('miniPrev'), document.getElementById('prevBtn')].forEach(btn => btn.addEventListener('click', previous));
  [document.getElementById('miniNext'), document.getElementById('nextBtn')].forEach(btn => btn.addEventListener('click', next));
  [document.getElementById('miniRepeat'), document.getElementById('repeatBtn')].forEach(btn => btn.addEventListener('click', toggleRepeat));
  [document.getElementById('miniShuffle'), document.getElementById('shuffleBtn')].forEach(btn => btn.addEventListener('click', toggleShuffle));

  document.getElementById('progress').addEventListener('input', seekFromProgress);
  document.getElementById('downloadBtn').addEventListener('click', downloadCurrent);
  document.getElementById('lyricsBtn').addEventListener('click', showLyrics);
  el.lyricsClose.addEventListener('click', closeLyrics);
  el.lyricsModal.addEventListener('click', event => { if (event.target === el.lyricsModal) closeLyrics(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && el.lyricsModal.classList.contains('open')) closeLyrics(); });
  document.getElementById('equalizerBtn').addEventListener('click', showEqualizer);
  document.getElementById('similarBtn').addEventListener('click', findSimilar);

  [el.volumeLarge, el.volumeMini].forEach(range => range.addEventListener('input', () => setVolume(range.value)));

  el.clearHistory.addEventListener('click', () => { state.history = []; persist(); renderLibrary(); notify('История очищена'); });
  el.clearFavorites.addEventListener('click', () => { state.favorites = []; persist(); renderFavorites(); notify('Избранное очищено'); });

  el.audio.addEventListener('loadedmetadata', updateProgress);
  el.audio.addEventListener('timeupdate', updateProgress);
  el.audio.addEventListener('play', () => { state.playState = 'playing'; updatePlayButtons(); });
  el.audio.addEventListener('pause', () => { if (state.playState !== 'loading' && state.playState !== 'error') state.playState = 'paused'; updatePlayButtons(); });
  el.audio.addEventListener('playing', () => { state.playState = 'playing'; updatePlayButtons(); openInfoDrawer(); });
  el.audio.addEventListener('waiting', () => { if (state.currentTrack){ state.playState = 'buffering'; updatePlayButtons(); } });
  el.audio.addEventListener('ended', () => {
    state.playState = 'idle';
    if (state.repeat){ el.audio.currentTime = 0; el.audio.play().catch(() => {}); return; }
    next();
  });

  document.addEventListener('keydown', event => {
    if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (event.code === 'Space'){ event.preventDefault(); playCurrentOrFirst(); }
    else if (event.key === 'ArrowRight' && event.shiftKey) next();
    else if (event.key === 'ArrowLeft' && event.shiftKey) previous();
    else if (event.key.toLowerCase() === 'm') setVolume(state.volume > 0 ? 0 : 100);
  });

  window.addEventListener('beforeunload', persist);

  el.volumeLarge.value = state.volume;
  el.volumeMini.value = state.volume;
  el.audio.volume = state.volume / 100;
  if (el.settingsVolumeValue) el.settingsVolumeValue.textContent = state.volume + '%';

  updateModeButtons();
  updateMiniPlayer();
  renderLibrary();
  renderFavorites();

  checkApi();
  setInterval(checkApi, 30000);

  el.searchInput.focus();

  const wasCallback = checkLoginCallback();
  setAuthMode('login');

  (async () => {
    if (authToken){
      await loadUserData();
    } else {
      renderUser();
      const dismissed = store.get('nova_guest_dismissed', '');
      if (!dismissed){
        setTimeout(() => { if (!state.user) openLoginModal(); }, 1500);
      }
    }
    if (wasCallback) closeLoginModal();
  })();

  startup();

  // ===== Search Suggestions =====
  (function initSuggestions(){
    const input = document.getElementById('searchInput');
    const box = document.getElementById('searchSuggestions');
    if (!input || !box) return;
    let timer = null, lastQuery = '', controller = null;
    function hide(){ box.classList.add('hidden'); box.innerHTML = ''; }
    function show(items){
      if (!items.length){ box.innerHTML = '<div class="suggestion-empty">Ничего не найдено</div>'; box.classList.remove('hidden'); return; }
      box.innerHTML = '';
      items.slice(0, 8).forEach(item => {
        const s = document.createElement('div');
        s.className = 'suggestion';
        const fallback = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#111"/></svg>');
        s.innerHTML =
          '<img src="' + (item.cover || fallback) + '" alt="">' +
          '<div class="suggestion-main">' +
            '<div class="suggestion-title">' + escapeHtml(item.title || '') + '</div>' +
            '<div class="suggestion-artist">' + escapeHtml(item.artist || '—') + '</div>' +
          '</div>' +
          '<span class="suggestion-badge ' + (item.source === 'FULL' ? 'full' : '') + '">' + (item.source || 'CATALOG') + '</span>';
        s.addEventListener('mousedown', e => { e.preventDefault(); input.value = item.title + (item.artist ? ' ' + item.artist : ''); hide(); search(input.value); });
        box.appendChild(s);
      });
      box.classList.remove('hidden');
    }
    function trigger(){
      const q = input.value.trim();
      if (q.length < 2){ hide(); return; }
      if (q === lastQuery) return;
      lastQuery = q;
      if (controller) controller.abort();
      controller = new AbortController();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await fetch(apiBase() + '/api/search?q=' + encodeURIComponent(q), { signal: controller.signal });
          const d = await r.json();
          if (input.value.trim() !== q) return;
          show(d.results || []);
        } catch(e){ if (e.name !== 'AbortError') console.warn(e); }
      }, 200);
    }
    input.addEventListener('input', trigger);
    input.addEventListener('focus', trigger);
    input.addEventListener('blur', () => setTimeout(hide, 150));
    document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== input) hide(); });
  })();

  // ===== BG Presets =====
  (function initBgPresets(){
    const container = document.getElementById('bgPresets');
    if (!container) return;
    const presets = [
      { name: 'Космос', value: 'radial-gradient(ellipse at top,#1a1a3e 0%,#000 60%)' },
      { name: 'Закат', value: 'linear-gradient(135deg,#3a0d1f 0%,#1a0a14 50%,#000 100%)' },
      { name: 'Океан', value: 'linear-gradient(180deg,#001a2e 0%,#000 100%)' },
      { name: 'Лес', value: 'linear-gradient(180deg,#0a1a0a 0%,#000 100%)' },
      { name: 'Пурпур', value: 'radial-gradient(circle at bottom right,#3a0a3a 0%,#000 60%)' },
      { name: 'Графит', value: 'linear-gradient(180deg,#101010 0%,#000 100%)' }
    ];
    container.innerHTML = '';
    presets.forEach(p => {
      const b = document.createElement('div');
      b.className = 'bg-preset';
      b.title = p.name;
      b.style.background = p.value;
      b.addEventListener('click', () => {
        state.background.src = p.value;
        saveBackgroundData(p.value).catch(() => {});
        applyBackground(p.value);
        notify('Фон: ' + p.name);
      });
      container.appendChild(b);
    });
  })();
})();
