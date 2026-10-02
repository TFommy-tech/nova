// NOVA frontend logic

const API = ''; // empty means same origin

const els = {
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  resultsSection: document.getElementById('results'),
  resultsList: document.getElementById('results-list'),
  welcome: document.getElementById('welcome'),
  nowPlaying: document.getElementById('now-playing'),
  npCover: document.getElementById('np-cover'),
  npTitle: document.getElementById('np-title'),
  npArtist: document.getElementById('np-artist'),
  audio: document.getElementById('audio-player'),
  lyricsBtn: document.getElementById('lyrics-btn'),
  lyricsBox: document.getElementById('lyrics-box'),
  loginBtn: document.getElementById('login-btn'),
  userInfo: document.getElementById('user-info'),
  userAvatar: document.getElementById('user-avatar'),
  userName: document.getElementById('user-name'),
  toast: document.getElementById('toast')
};

let currentTrack = null;

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  setTimeout(() => els.toast.classList.add('hidden'), 3000);
}

// ---------- Discord login check ----------
(function checkLogin() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('login') === 'success') {
    const username = params.get('username') || 'User';
    const avatar = params.get('avatar');

    els.loginBtn.classList.add('hidden');
    els.userInfo.classList.remove('hidden');
    els.userName.textContent = username;

    if (avatar) {
      els.userAvatar.src = 'https://cdn.discordapp.com/avatars/' +
        params.get('id') + '/' + avatar + '.png';
    } else {
      els.userAvatar.src = 'https://cdn.discordapp.com/embed/avatars/0.png';
    }

    showToast('Добро пожаловать, ' + username + '!');
    window.history.replaceState({}, '', '/');
  }
})();

// ---------- Search ----------
async function doSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;

  els.resultsList.innerHTML = '<div style="color:#8888a0">Поиск...</div>';
  els.resultsSection.classList.remove('hidden');
  els.welcome.classList.add('hidden');

  try {
    const res = await fetch(API + '/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      els.resultsList.innerHTML = '<div style="color:#8888a0">Ничего не найдено</div>';
      return;
    }

    els.resultsList.innerHTML = '';
    data.results.forEach(track => {
      const card = document.createElement('div');
      card.className = 'track-card';
      card.innerHTML =
        '<img class="track-cover" src="' + (track.cover || '') + '" alt="" />' +
        '<div class="track-title">' + escapeHtml(track.title || 'Untitled') + '</div>' +
        '<div class="track-artist">' + escapeHtml(track.artist || 'Unknown') + '</div>' +
        '<span class="track-source">' + escapeHtml(track.source || '') + '</span>';
      card.addEventListener('click', () => playTrack(track));
      els.resultsList.appendChild(card);
    });
  } catch (e) {
    console.error(e);
    els.resultsList.innerHTML = '<div style="color:#ff6b6b">Ошибка поиска</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

els.searchBtn.addEventListener('click', doSearch);
els.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

// ---------- Play track ----------
async function playTrack(track) {
  currentTrack = track;

  els.nowPlaying.classList.remove('hidden');
  els.npTitle.textContent = track.title || 'Untitled';
  els.npArtist.textContent = track.artist || 'Unknown';
  els.npCover.src = track.cover || '';
  els.lyricsBox.classList.add('hidden');
  els.lyricsBox.textContent = '';

  showToast('Загружаем аудио...');

  try {
    const q = (track.artist ? track.artist + ' ' : '') + track.title;
    const res = await fetch(API + '/api/audio/resolve?q=' + encodeURIComponent(q));
    const data = await res.json();

    if (!data.ok || !data.streamUrl) {
      showToast('Не удалось найти аудио');
      return;
    }

    els.audio.src = data.streamUrl;
    els.audio.play().catch(() => {});
    showToast('Играет: ' + track.title);
  } catch (e) {
    console.error(e);
    showToast('Ошибка воспроизведения');
  }
}

// ---------- Lyrics ----------
els.lyricsBtn.addEventListener('click', async () => {
  if (!currentTrack) return;

  els.lyricsBox.classList.remove('hidden');
  els.lyricsBox.textContent = 'Загружаем текст...';

  try {
    const params = new URLSearchParams({
      track_name: currentTrack.title || '',
      artist_name: currentTrack.artist || ''
    });

    if (currentTrack.album) params.set('album_name', currentTrack.album);
    if (currentTrack.duration) params.set('duration', Math.round(currentTrack.duration));

    const res = await fetch(API + '/api/lyrics?' + params.toString());
    const data = await res.json();

    if (data.found) {
      els.lyricsBox.textContent = data.plainLyrics || data.syncedLyrics || 'Текст пуст';
    } else {
      els.lyricsBox.textContent = 'Текст не найден';
    }
  } catch (e) {
    console.error(e);
    els.lyricsBox.textContent = 'Ошибка загрузки текста';
  }
});
