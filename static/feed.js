/* potatos — лента, комментарии, экран «+» */

function uploadWithProgress(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    if (App.token) xhr.setRequestHeader('Authorization', 'Bearer ' + App.token);
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error((d && d.detail) || 'Ошибка ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Нет связи'));
    xhr.send(fd);
  });
}

function videoThumb(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    const url = URL.createObjectURL(file);
    v.src = url;
    const done = () => {
      try {
        const c = document.createElement('canvas');
        const w = c.width = Math.min(360, v.videoWidth || 360);
        c.height = Math.round(w * ((v.videoHeight || 16) / (v.videoWidth || 9)));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob(b => { URL.revokeObjectURL(url); resolve(b); }, 'image/jpeg', 0.75);
      } catch (e) { URL.revokeObjectURL(url); resolve(null); }
    };
    v.onloadeddata = () => { v.currentTime = Math.min(0.4, (v.duration || 1) / 3); };
    v.onseeked = done;
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    setTimeout(() => resolve(null), 6000);
  });
}

/* ---------------- comments ---------------- */
async function openComments(videoId, onCount) {
  const body = sheet('Комментарии', `
    <div class="loader" data-load><div class="spin"></div></div>
    <div data-list></div>`);
  const list = $('[data-list]', body);
  const render = items => {
    if (!items.length) { list.innerHTML = `<div class="empty"><div class="ic">💬</div><div>Пока нет комментариев.<br>Будьте первым!</div></div>`; return; }
    list.innerHTML = items.map(c => `
      <div class="cmt">
        <div data-prof="${esc(c.username)}" style="cursor:pointer">${ava(c.avatar, 'sm')}</div>
        <div class="b">
          <div class="u"><b>@${esc(c.username)}</b><span>${timeAgo(c.created_at)}</span></div>
          <div class="tx">${esc(c.text)}</div>
        </div>
      </div>`).join('');
    $$('[data-prof]', list).forEach(el => el.onclick = () => { Overlay.close(); navigate('#/profile/' + el.dataset.prof); });
  };
  try {
    const d = await api(`/api/video/${videoId}/comments`);
    const ld = $('[data-load]', body);
    if (ld) ld.remove();
    render(d.items);
  } catch (e) {
    const ld = $('[data-load]', body);
    if (ld) ld.remove();
  }

  const input = document.createElement('div');
  input.className = 'cmt-input';
  input.innerHTML = `<input placeholder="Комментировать..." maxlength="1000"><button>➤</button>`;
  body.appendChild(input);
  const send = async () => {
    const t = $('input', input).value.trim();
    if (!t) return;
    try {
      const d = await api(`/api/video/${videoId}/comments`, { method: 'POST', body: { text: t } });
      d.created_at = Math.floor(Date.now() / 1000);
      $('input', input).value = '';
      if ($('.empty', list)) list.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'cmt';
      wrap.innerHTML = `<div>${ava(d.avatar, 'sm')}</div><div class="b">
        <div class="u"><b>@${esc(d.username)}</b><span>сейчас</span></div>
        <div class="tx">${esc(d.text)}</div></div>`;
      list.appendChild(wrap);
      list.parentElement.scrollTop = list.parentElement.scrollHeight;
      onCount && onCount();
    } catch (e) { }
  };
  $('button', input).onclick = send;
  $('input', input).onkeydown = e => { if (e.key === 'Enter') send(); };
}

/* ---------------- feed component ---------------- */
function createFeed(root, opts = {}) {
  const st = {
    items: opts.items || [],
    next: opts.next || 0,
    loading: false,
    more: opts.more || null,
    onBack: opts.onBack || null,
    tab: opts.tab || 'all',
    active: null,
    seen: new Set(),
  };

  root.innerHTML = `
    <div class="feed-wrap" style="position:absolute;inset:0">
      <div class="feed" data-feed></div>
      <div class="feed-top" data-top style="display:${opts.hideTabs ? 'none' : 'flex'}">
        <span class="t ${st.tab === 'all' ? 'on' : ''}" data-tab="all">Главная</span>
        <span class="t ${st.tab === 'following' ? 'on' : ''}" data-tab="following">Подписки</span>
      </div>
      ${st.onBack ? `<button class="icon-btn" data-back style="left:10px;top:calc(6px + env(safe-area-inset-top));right:auto">←</button>` : ''}
      <button class="icon-btn" data-mute title="Звук">🔇</button>
    </div>`;

  const feedEl = $('[data-feed]', root);
  const wrap = $('.feed-wrap', root);

  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting && en.intersectionRatio > 0.6) activate(en.target);
    });
  }, { root: feedEl, threshold: [0.6] });

  function linkTags(text) {
    return esc(text || '')
      .replace(/#([\wА-Яа-яЁё]+)/g, '<span class="tag">#$1</span>')
      .replace(/(^|\s)@([a-zA-Z0-9_.]{3,24})/g, '$1<span class="tag">@$2</span>');
  }

  function postCard(v, i) {
    const u = v.user || {};
    const isPhoto = v.kind === 'photo';
    const mediaHTML = isPhoto
      ? `<img class="media" src="/media/${esc(v.media)}" loading="${i < 2 ? 'eager' : 'lazy'}" alt="">`
      : `<video class="media" src="/media/${esc(v.media)}" ${v.thumb ? `poster="/media/${esc(v.thumb)}"` : ''}
           loop playsinline preload="${i < 2 ? 'auto' : 'metadata'}" muted></video>`;
    const followUI = (v.mine || !App.me) ? '' :
      (v.followed
        ? `<button class="follow done" data-follow title="Вы подписаны">✓</button>`
        : `<button class="follow" data-follow title="Подписаться">+</button>`);
    const chip = (v.mine || !App.me || v.followed) ? '' :
      `<button class="follow-chip" data-follow>Подписаться</button>`;
    return `
    <div class="post" data-id="${v.id}" data-i="${i}">
      ${mediaHTML}
      ${v.kind === 'live' ? '<div class="live-tag">● LIVE</div>' : ''}
      <div class="shade"></div>
      <div class="paused">▶</div>
      <div class="bigheart">❤️</div>
      <div class="view-count" data-views style="display:none">👁 ${nfmt(v.views)}</div>
      <div class="rail">
        <div class="ava-wrap">
          <div data-openprof style="cursor:pointer">${ava(u.avatar)}</div>
          ${followUI}
        </div>
        <button class="act ${v.liked ? 'liked' : ''}" data-like title="Нравится">
          <span class="ico">${v.liked ? '❤️' : '🤍'}</span><span class="n" data-likes>${nfmt(v.likes)}</span>
        </button>
        <button class="act" data-comment title="Комментарии">
          <span class="ico">💬</span><span class="n" data-cc>${nfmt(v.comments_count)}</span>
        </button>
        <button class="act ${v.saved ? 'saved' : ''}" data-save title="Сохранить">
          <span class="ico">${v.saved ? '🔖' : '📑'}</span>
        </button>
        <button class="act" data-repost title="Поделиться">
          <span class="ico">🔁</span><span class="n" data-rc>${nfmt(v.reposts)}</span>
        </button>
        <div class="disc">🎵</div>
      </div>
      <div class="meta">
        <div class="nick">
          <span data-openprof style="cursor:pointer">@${esc(u.username || '')}</span>
          ${chip}
        </div>
        <div class="cap">${linkTags(v.caption)}</div>
        <div class="snd"><span class="ic">🎵</span><span class="marq">${esc(v.sound || 'оригинальный звук')}</span></div>
      </div>
      <div class="prog" ${isPhoto ? 'style="display:none"' : ''}><i></i></div>
    </div>`;
  }

  function paint() {
    feedEl.innerHTML = st.items.map(postCard).join('') || '';
    if (!st.items.length) {
      wrap.insertAdjacentHTML('beforeend', `
        <div class="feed-empty">
          <div style="font-size:56px">🥔</div>
          <div style="font-size:17px;font-weight:700;color:#fff">Здесь пока пусто</div>
          <div>Найдите первых авторов или загрузите своё видео</div>
          <div class="row" style="gap:10px">
            ${st.tab === 'following' ? '<button class="btn sm ghost" data-all>Показать все</button>' : ''}
            <button class="btn sm" data-goup>＋ Загрузить</button>
          </div>
        </div>`);
      $('[data-goup]', wrap).onclick = () => navigate('#/plus');
      $('[data-all]', wrap) && ($('[data-all]', wrap).onclick = () => setTab('all'));
    }
    $$('.post', feedEl).forEach(p => { io.observe(p); bindPost(p); });
    const first = $('.post', feedEl);
    if (first) setTimeout(() => activate(first), 60);
  }

  function bindPost(p) {
    const i = +p.dataset.i;
    const v = st.items[i];
    const media = $('.media', p);
    let tapT = null;

    const tapArea = media;
    tapArea.addEventListener('click', () => {
      if (tapT) { clearTimeout(tapT); tapT = null; doLike(true); return; }
      tapT = setTimeout(() => {
        tapT = null;
        if (media.tagName === 'VIDEO') {
          if (media.paused) { media.play().catch(() => { }); $('.paused', p).classList.remove('show'); }
          else { media.pause(); $('.paused', p).classList.add('show'); }
        }
      }, 240);
    });

    $('[data-openprof]', p).onclick = e => {
      e.stopPropagation();
      if (v.user) navigate('#/profile/' + v.user.username);
    };

    const likeBtn = $('[data-like]', p);
    likeBtn.onclick = e => { e.stopPropagation(); doLike(false); };

    function paintLike(d) {
      v.liked = d.liked; v.likes = d.likes;
      likeBtn.classList.toggle('liked', v.liked);
      $('.ico', likeBtn).textContent = v.liked ? '❤️' : '🤍';
      $('[data-likes]', likeBtn).textContent = nfmt(v.likes);
    }
    function bigHeart() {
      const h = $('.bigheart', p);
      h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
    }

    function doLike(force) {
      if (!App.me) { navigate('#/auth'); return; }
      if (force && v.liked) { bigHeart(); return; }
      if (force) { bigHeart(); paintLike({ liked: true, likes: v.likes + 1 }); }
      api(`/api/video/${v.id}/like`, { method: 'POST', silent: true })
        .then(d => paintLike(d))
        .catch(() => { });
    }

    async function toggleFollow() {
      if (!App.me) return navigate('#/auth');
      try {
        const d = await api(`/api/user/${v.user.username}/follow`, { method: 'POST' });
        v.followed = d.followed;
        paintFollow();
        toast(v.followed ? 'Вы подписались' : 'Подписка отменена');
      } catch (err) { }
    }

    function paintFollow() {
      const nick = $('.meta .nick', p);
      let chip = $('.follow-chip', p);
      if (v.followed) {
        if (chip) chip.remove();
      } else if (!chip && nick && App.me && !v.mine) {
        chip = document.createElement('button');
        chip.className = 'follow-chip';
        nick.appendChild(chip);
      }
      if (chip) {
        chip.textContent = 'Подписаться';
        chip.onclick = e => { e.stopPropagation(); toggleFollow(); };
      }
      $$('.rail [data-follow]', p).forEach(btn => {
        btn.classList.toggle('done', v.followed);
        btn.textContent = v.followed ? '✓' : '+';
        btn.onclick = e => { e.stopPropagation(); toggleFollow(); };
      });
    }
    paintFollow();

    $('[data-comment]', p).onclick = e => {
      e.stopPropagation();
      openComments(v.id, () => { v.comments_count++; $('[data-cc]', p).textContent = nfmt(v.comments_count); });
    };

    const saveBtn = $('[data-save]', p);
    saveBtn.onclick = e => {
      e.stopPropagation();
      if (!App.me) return navigate('#/auth');
      api(`/api/video/${v.id}/save`, { method: 'POST' }).then(d => {
        v.saved = d.saved;
        saveBtn.classList.toggle('saved', v.saved);
        $('.ico', saveBtn).textContent = v.saved ? '🔖' : '📑';
        toast(v.saved ? 'Сохранено' : 'Убрано из сохранённых');
      }).catch(() => { });
    };

    $('[data-repost]', p).onclick = e => {
      e.stopPropagation();
      if (!App.me) return navigate('#/auth');
      api(`/api/video/${v.id}/repost`, { method: 'POST' }).then(d => {
        v.reposts = d.reposts;
        $('[data-rc]', p).textContent = nfmt(v.reposts);
        $('[data-repost]', p).classList.toggle('liked', d.reposted);
        toast(d.reposted ? 'Опубликовано у вас в профиле' : 'Репост отменён');
      }).catch(() => { });
    };

    if (media.tagName === 'VIDEO') {
      const bar = $('.prog i', p);
      media.addEventListener('timeupdate', () => {
        if (bar && media.duration) bar.style.width = ((media.currentTime / media.duration) * 100).toFixed(1) + '%';
      });
      media.addEventListener('play', () => $('.paused', p).classList.remove('show'));
      media.addEventListener('pause', () => $('.paused', p).classList.add('show'));
    }
  }

  function activate(p) {
    if (!p || st.active === p) return;
    if (st.active) {
      const pv = $('.media', st.active);
      if (pv && pv.tagName === 'VIDEO') pv.pause();
    }
    st.active = p;
    const id = +p.dataset.id;
    const v = st.items.find(x => x.id === id);
    const media = $('.media', p);
    if (media && media.tagName === 'VIDEO') {
      media.muted = !FeedState.sound;
      media.play().catch(() => { });
      $('.paused', p).classList.remove('show');
    }
    if (v && !st.seen.has(id)) {
      st.seen.add(id);
      api(`/api/video/${id}/view`, { method: 'POST', silent: true }).then(() => {
        v.views++;
        const el = $('[data-views]', p);
        if (el) { el.style.display = 'block'; el.textContent = '👁 ' + nfmt(v.views); }
      }).catch(() => { });
    }
  }

  function setTab(t) {
    st.tab = t;
    root.remove();
    views.home($('#screen'), { q: { tab: t } });
  }

  $$('[data-tab]', root).forEach(el => el.onclick = () => setTab(el.dataset.tab));
  const backBtn = $('[data-back]', root);
  backBtn && (backBtn.onclick = () => { st.onBack ? st.onBack() : navigate('#/home'); });

  const muteBtn = $('[data-mute]', root);
  const paintMute = () => {
    muteBtn.textContent = FeedState.sound ? '🔊' : '🔇';
    $$('.media', feedEl).forEach(m => m.muted = !FeedState.sound);
  };
  muteBtn.onclick = () => {
    FeedState.sound = !FeedState.sound;
    paintMute();
    if (st.active) {
      const m = $('.media', st.active);
      if (m) { m.muted = !FeedState.sound; if (FeedState.sound && m.paused) m.play().catch(() => { }); }
    }
    toast(FeedState.sound ? 'Звук включён' : 'Звук выключен');
  };
  paintMute();

  feedEl.addEventListener('scroll', debounce(() => {
    if (!st.more || st.loading) return;
    if (feedEl.scrollTop + feedEl.clientHeight > feedEl.scrollHeight - feedEl.clientHeight * 1.2) loadMore();
  }, 200));

  async function loadMore() {
    if (st.loading || !st.next) return;
    st.loading = true;
    try {
      const d = await api(`/api/feed?cursor=${st.next}&scope=${st.tab}`);
      const start = st.items.length;
      st.items = st.items.concat(d.items);
      st.next = d.next;
      d.items.forEach((it, k) => feedEl.insertAdjacentHTML('beforeend', postCard(it, start + k)));
      $$('.post', feedEl).slice(-d.items.length).forEach(p => { io.observe(p); bindPost(p); });
    } catch (e) { }
    st.loading = false;
  }

  paint();

  return {
    state: st,
    loadMore,
    destroy() { io.disconnect(); root.innerHTML = ''; },
    append(items) { st.items = st.items.concat(items); paint(); },
  };
}

const FeedState = { sound: false };

/* ---------------- views: home ---------------- */
views.home = async function (screen, r) {
  if (!requireAuth()) return;
  screen.innerHTML = '';
  const tab = (r && r.q && r.q.tab) || 'all';
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom))';
  screen.appendChild(host);
  const d = await api(`/api/feed?scope=${tab}`);
  createFeed(host, {
    items: d.items, next: d.next, tab,
    more: () => true,
  });
};

/* ---------------- views: plus / upload ---------------- */
views.plus = async function (screen) {
  if (!requireAuth()) return;
  let mode = 'video';
  let file = null, thumbBlob = null, previewURL = null;
  let recorder = null, chunks = [], recStream = null, recTimer = null, liveBlob = null;

  screen.innerHTML = `
  <div class="topbar"><h1>Создать</h1></div>
  <div class="page">
    <div class="up-tabs">
      <button class="up-tab" data-m="photo"><span class="ic">🖼</span>Фото</button>
      <button class="up-tab on" data-m="video"><span class="ic">🎬</span>Видео</button>
      <button class="up-tab" data-m="live"><span class="ic">📡</span>Эфир</button>
    </div>

    <div data-pane="photo" hidden>
      <label class="drop" for="f-photo">
        <span class="ic">🖼</span>
        <b>Выбрать фото</b>
        <span class="muted" style="font-size:13px">Из галереи или камеры</span>
      </label>
      <input id="f-photo" type="file" accept="image/*" hidden>
    </div>

    <div data-pane="video">
      <label class="drop" for="f-video">
        <span class="ic">🎬</span>
        <b>Выбрать видео</b>
        <span class="muted" style="font-size:13px">MP4 / WebM, до 400 МБ</span>
      </label>
      <input id="f-video" type="file" accept="video/*" hidden>
    </div>

    <div data-pane="live" hidden>
      <div class="cam-wrap">
        <video data-cam autoplay playsinline muted></video>
      </div>
      <div style="height:12px"></div>
      <div class="live-bar" data-livebar hidden><span class="rec-dot"></span><span data-timer>00:00</span> идёт эфир</div>
      <div style="height:12px"></div>
      <div class="row" style="gap:10px">
        <button class="btn ghost" data-camstart>📷 Включить камеру</button>
        <button class="btn danger" data-camstop hidden>■ Остановить</button>
      </div>
      <div class="inline-note" style="margin-top:14px">
        В первой версии «эфир» записывает видео с камеры в реальном времени — получится обычный живой ролик.
        Настоящий стрим для зрителей добавим следующим этапом.
      </div>
    </div>

    <div data-preview hidden style="margin-top:16px">
      <div class="spread" style="margin-bottom:10px">
        <b>Предпросмотр</b>
        <button class="btn sm ghost" data-clear>Убрать</button>
      </div>
      <div data-holder></div>
      <label class="lbl">Подпись</label>
      <textarea class="field" data-caption maxlength="500" placeholder="Расскажите о видео... #теги"></textarea>
      <label class="lbl">Звук / название трека</label>
      <input class="field" data-sound maxlength="120" placeholder="Например: оригинальный звук — potatos">
      <div style="height:18px"></div>
      <button class="btn" data-publish>Опубликовать</button>
      <div data-progress style="display:none;margin-top:14px">
        <div class="spread" style="font-size:13px;margin-bottom:7px"><span>Загрузка…</span><span data-pct>0%</span></div>
        <div style="height:7px;background:var(--panel3);border-radius:5px;overflow:hidden">
          <div data-bar style="height:100%;width:0;background:linear-gradient(90deg,var(--accent),#ff8a3d);transition:width .2s"></div>
        </div>
      </div>
    </div>
    <div style="height:40px"></div>
  </div>`;

  const panes = {};
  $$('[data-pane]', screen).forEach(p => panes[p.dataset.pane] = p);
  const previewBox = $('[data-preview]', screen);
  const holder = $('[data-holder]', screen);

  function setMode(m) {
    mode = m;
    $$('[data-m]', screen).forEach(b => b.classList.toggle('on', b.dataset.m === m));
    Object.entries(panes).forEach(([k, p]) => p.hidden = k !== m);
    if (m !== 'live') stopCam();
    if (m === 'live') { previewBox.hidden = true; clearFile(); }
  }
  $$('[data-m]', screen).forEach(b => b.onclick = () => setMode(b.dataset.m));

  function clearFile() {
    file = null; thumbBlob = null; liveBlob = null;
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    holder.innerHTML = ''; previewBox.hidden = true;
  }
  $('[data-clear]', screen).onclick = () => { clearFile(); stopCam(); };

  async function showFile(f) {
    if (!f) return;
    file = f;
    liveBlob = null;
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(f);
    if (f.type.startsWith('video/')) {
      holder.innerHTML = `<video class="preview" src="${previewURL}" controls playsinline muted></video>`;
      thumbBlob = await videoThumb(f);
    } else {
      holder.innerHTML = `<img class="preview" src="${previewURL}" alt="">`;
      thumbBlob = f;
    }
    previewBox.hidden = false;
    previewBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#f-photo', screen).onchange = e => showFile(e.target.files[0]);
  $('#f-video', screen).onchange = e => showFile(e.target.files[0]);

  /* ---- камера / эфир ---- */
  const cam = $('[data-cam]', screen);
  const camStart = $('[data-camstart]', screen);
  const camStop = $('[data-camstop]', screen);
  const liveBar = $('[data-livebar]', screen);

  async function startCam() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      cam.srcObject = recStream;
      camStart.textContent = '🔴 Начать эфир';
      camStart.classList.remove('ghost'); camStart.classList.add('danger');
      camStop.hidden = false;
      camStop.textContent = 'Выключить камеру';
      return true;
    } catch (e) { toast('Камера недоступна: разрешите доступ в браузере'); return false; }
  }

  function stopCam() {
    if (recorder && recorder.state === 'recording') stopRec();
    if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
    cam.srcObject = null;
    camStart.hidden = false;
    camStart.textContent = '📷 Включить камеру';
    camStart.classList.add('ghost'); camStart.classList.remove('danger');
    camStop.hidden = true;
    liveBar.hidden = true;
    clearInterval(recTimer); recTimer = null;
  }

  function startRec() {
    chunks = [];
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const type = (chunks[0] && chunks[0].type) || 'video/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? '.mp4' : '.webm';
      await showFile(new File([blob], 'live' + ext, { type }));
      liveBar.hidden = true;
      camStart.hidden = false;
      camStart.textContent = '🔴 Начать эфир';
      camStop.textContent = 'Выключить камеру';
      clearInterval(recTimer); recTimer = null;
      toast('Эфир записан — добавьте подпись и опубликуйте');
    };
    recorder.start();
    let sec = 0;
    liveBar.hidden = false;
    $('[data-timer]', screen).textContent = '00:00';
    recTimer = setInterval(() => {
      sec++;
      $('[data-timer]', screen).textContent =
        String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
    }, 1000);
    camStart.hidden = true;
    camStop.hidden = false;
    camStop.textContent = '■ Завершить эфир';
  }

  function stopRec() { if (recorder && recorder.state === 'recording') recorder.stop(); }

  camStart.onclick = async () => {
    if (!recStream) { if (await startCam()) { } return; }
    if (recorder && recorder.state === 'recording') stopRec();
    else startRec();
  };
  camStop.onclick = () => {
    if (recorder && recorder.state === 'recording') stopRec();
    else stopCam();
  };

  /* ---- публикация ---- */
  $('[data-publish]', screen).onclick = async () => {
    if (!file) { toast('Сначала выберите фото или видео'); return; }
    const caption = $('[data-caption]', screen).value.trim();
    const sound = $('[data-sound]', screen).value.trim();
    const btn = $('[data-publish]', screen);
    const prog = $('[data-progress]', screen);
    btn.disabled = true; prog.style.display = 'block';
    const fd = new FormData();
    fd.append('file', file, file.name || 'media');
    if (thumbBlob) fd.append('thumb', thumbBlob, 'thumb.jpg');
    fd.append('caption', caption);
    fd.append('sound', sound);
    if (mode === 'live') fd.append('kind', 'live');
    try {
      const d = await uploadWithProgress(fd, p => {
        $('[data-pct]', screen).textContent = Math.round(p * 100) + '%';
        $('[data-bar]', screen).style.width = Math.round(p * 100) + '%';
      });
      toast('Опубликовано! 🥔');
      clearFile(); stopCam();
      $('[data-caption]', screen).value = '';
      $('[data-sound]', screen).value = '';
      navigate('#/home');
    } catch (e) {
      toast(e.message || 'Не удалось загрузить');
      btn.disabled = false; prog.style.display = 'none';
    }
  };
};
