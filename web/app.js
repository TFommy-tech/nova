function renderHome(){
  const recent = state.history.slice(0,10);
  el.homeContinue.innerHTML = '';
  if(!recent.length){
    el.homeContinue.innerHTML='<div class="empty" style="min-width:100%;width:100%"><div>Начни слушать музыку</div></div>';
  } else {
    recent.forEach(t => el.homeContinue.appendChild(makeHomeTrackCard(t)));
  }

  const popular = state.tracks.slice(0,12);
  el.homePopular.innerHTML = '';
  popular.forEach(t => el.homePopular.appendChild(makeHomeTrackCard(t)));

  const q = normalizeSearch(state.query || '');
  const wantsArtist = /(artist|исполнитель|певец|группа|band|singer)/i.test(q);
  const artistsSection = document.getElementById('artistsSection');
  if (artistsSection) artistsSection.style.display = wantsArtist ? '' : 'none';

  if (wantsArtist) {
    const artists = [];
    const seenArtists = new Set();
    for (const t of state.tracks) {
      const key = normalizeSearch(t.artist);
      if (key && !seenArtists.has(key) && !isBadArtist(t.artist)) {
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
  for (const t of state.tracks) {
    if (!t.albumId) continue;
    const key = normalizeSearch((t.album||'')+'|'+(t.artist||''));
    if (t.album && key && !seenAlbums.has(key)) {
      seenAlbums.add(key);
      albums.push(t);
    }
    if (albums.length >= 10) break;
  }
  el.homeAlbums.innerHTML = '';
  albums.forEach(t => el.homeAlbums.appendChild(makeHomeAlbumCard(t)));
}

async function resolveAudioCandidates(track){
  if(!track)return[];
  if(track.localUrl)return[track.localUrl];

  const candidates=[];
  const q=[track.title,track.artist].filter(Boolean).join(' ');

  // Сначала YouTube — полный трек
  if(q){
    try{
      const r = await fetch(apiBase()+'/api/audio/resolve?q='+encodeURIComponent(q), {
        headers:{Accept:'application/json'}
      });
      const d = await r.json().catch(()=>({}));
      if(r.ok && d.ok && d.streamUrl && !candidates.includes(d.streamUrl)){
        candidates.push(d.streamUrl);
      }
    }catch(e){console.warn('[resolve]', e.message)}
  }

  // Audius FULL
  if(track.source==='FULL' && track.id){
    const u = apiBase()+'/api/audio/audius/'+encodeURIComponent(track.id);
    if(!candidates.includes(u)) candidates.push(u);
  }

  // Превью — только fallback
  if(track.preview && !candidates.includes(track.preview)) candidates.push(track.preview);

  return candidates;
}
