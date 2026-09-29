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
    const remote = typeof file === 'string';
    const url = remote ? file : URL.createObjectURL(file);
    const cleanup = () => { if (!remote) URL.revokeObjectURL(url); };
    v.src = url;
    const done = () => {
      try {
        const c = document.createElement('canvas');
        const w = c.width = Math.min(360, v.videoWidth || 360);
        c.height = Math.round(w * ((v.videoHeight || 16) / (v.videoWidth || 9)));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob(b => { cleanup(); resolve(b); }, 'image/jpeg', 0.75);
      } catch (e) { cleanup(); resolve(null); }
    };
    v.onloadeddata = () => { v.currentTime = Math.min(0.4, (v.duration || 1) / 3); };
    v.onseeked = done;
    v.onerror = () => { cleanup(); resolve(null); };
    setTimeout(() => { cleanup(); resolve(null); }, 6000);
  });
}

/* ---------------- comments ---------------- */
async function openComments(videoId, onCount) {
  const body = sheet('Комментарии', `
    <div class="loader" data-load><div class="spin"></div></div>
    <div data-list></div>`);
  const list = $('[data-list]', body);
  let reply = null;   // {id, username, text}
  let file = null;    // File с фото

  const cmtHTML = c => `
    <div class="cmt" data-id="${c.id}">
      <div class="cmt-ava" data-prof="${esc(c.username)}">${ava(c.avatar, 'sm')}</div>
      <div class="b">
        <div class="u"><b data-prof="${esc(c.username)}">@${esc(c.username)}</b><span>${timeAgo(c.created_at)}</span></div>
        ${c.parent ? `<div class="cmt-quote" data-qprof="${esc(c.parent.username)}">
            <b>@${esc(c.parent.username)}</b><i>${esc((c.parent.text || '').slice(0, 120))}</i></div>` : ''}
        ${c.media ? `<img class="cmt-img" src="${esc(mediaURL(c.media))}" alt="">` : ''}
        ${c.text ? `<div class="tx">${esc(c.text)}</div>` : ''}
        <div class="cmt-act"><button data-reply data-ruid="${c.id}" data-ruser="${esc(c.username)}"
          data-rtext="${esc((c.text || '').slice(0, 120))}">Ответить</button></div>
      </div>
    </div>`;

  const openPhoto = src => {
    const n = document.createElement('div');
    n.className = 'photo-view';
    n.innerHTML = `<img src="${esc(src)}" alt="">`;
    n.onclick = () => n.remove();
    body.appendChild(n);
    requestAnimationFrame(() => n.classList.add('on'));
  };

  const bind = root => {
    $$('[data-prof]', root).forEach(el => el.onclick = () => { Overlay.close(); navigate('#/profile/' + el.dataset.prof); });
    $$('[data-qprof]', root).forEach(el => el.onclick = () => { Overlay.close(); navigate('#/profile/' + el.dataset.qprof); });
    $$('.cmt-img', root).forEach(im => im.onclick = () => openPhoto(im.src));
    $$('[data-reply]', root).forEach(btn => btn.onclick = () => {
      reply = { id: +btn.dataset.ruid, username: btn.dataset.ruser, text: btn.dataset.rtext };
      paintChips();
      const inp = $('input', input);
      inp.focus();
      inp.placeholder = 'Ответ @' + reply.username;
    });
  };

  const render = items => {
    if (!items.length) {
      list.innerHTML = `<div class="empty"><div class="ic">💬</div><div>Пока нет комментариев.<br>Будьте первым!</div></div>`;
      return;
    }
    list.innerHTML = items.map(cmtHTML).join('');
    bind(list);
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

  /* поле ввода: ответ, фото, текст */
  const input = document.createElement('div');
  input.className = 'cmt-input';
  input.innerHTML = `
    <div class="cmt-chips" data-chips hidden></div>
    <div class="cmt-row">
      <button class="cbtn" data-attach title="Отправить фото">🖼️</button>
      <input placeholder="Комментировать..." maxlength="1000">
      <button class="csend">➤</button>
    </div>`;
  body.appendChild(input);

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.hidden = true;
  body.appendChild(fileInput);
  $('[data-attach]', input).onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('В комментарии можно отправить фото'); return; }
    if (f.size > 10 * 1024 * 1024) { toast('Фото слишком большое (до 10 МБ)'); return; }
    file = f;
    paintChips();
  };

  const paintChips = () => {
    const box = $('[data-chips]', input);
    if (!reply && !file) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `
      ${reply ? `<div class="cmt-chip"><b>↩ Ответ @${esc(reply.username)}</b>
        <span>${esc(reply.text)}</span><button class="x" data-xr>×</button></div>` : ''}
      ${file ? `<div class="cmt-chip"><img class="thumb" src="${URL.createObjectURL(file)}" alt="">
        <span>${esc(file.name.slice(0, 28))}</span><button class="x" data-xf>×</button></div>` : ''}`;
    const xr = $('[data-xr]', box);
    xr && (xr.onclick = () => {
      reply = null;
      $('input', input).placeholder = 'Комментировать...';
      paintChips();
    });
    const xf = $('[data-xf]', box);
    xf && (xf.onclick = () => { file = null; paintChips(); });
  };

  const send = async () => {
    const t = $('input', input).value.trim();
    if (!t && !file) return;
    const fd = new FormData();
    fd.append('text', t);
    if (reply) fd.append('parent_id', String(reply.id));
    if (file) fd.append('file', file, file.name);
    try {
      const d = await api(`/api/video/${videoId}/comments`, { method: 'POST', body: fd });
      d.created_at = Math.floor(Date.now() / 1000);
      $('input', input).value = '';
      $('input', input).placeholder = 'Комментировать...';
      reply = null; file = null;
      paintChips();
      if ($('.empty', list)) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', cmtHTML(d));
      bind(list);
      const scroller = list.parentElement;
      scroller.scrollTop = scroller.scrollHeight;
      onCount && onCount();
    } catch (e) { }
  };
  $('.csend', input).onclick = send;
  const txt = $('input', input);
  txt.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
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
    const adminDel = (App.me && App.me.is_admin && !v.mine)
      ? `<button class="del-badge" data-del title="Удалить видео">🗑</button>` : '';
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
          ${adminDel}
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

    // клик по всему посту (оверлеи .shade/.paused перехватывают события — раньше пауза «не срабатывала»)
    p.addEventListener('click', e => {
      if (e.target.closest('button, a, input, textarea, [data-openprof], .meta')) return;
      if (media.tagName !== 'VIDEO') return;
      if (tapT) { clearTimeout(tapT); tapT = null; doLike(true); return; }
      tapT = setTimeout(() => {
        tapT = null;
        if (media.muted) media.muted = false;   // первый тап включает звук
        if (media.paused) { media.play().catch(() => { }); $('.paused', p).classList.remove('show'); }
        else { media.pause(); $('.paused', p).classList.add('show'); }
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

    const delBtn = $('[data-del]', p);
    delBtn && (delBtn.onclick = e => {
      e.stopPropagation();
      confirmModal('Удалить это видео?', async () => {
        try {
          await api(`/api/video/${v.id}`, { method: 'DELETE' });
          p.remove();
          st.items = st.items.filter(x => x.id !== v.id);
          toast('Видео удалено');
        } catch (err) { }
      }, 'Удалить');
    });

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
      // звук включён сразу; если браузер не даёт автоплей со звуком —
      // играем без звука, звук включится после первого касания
      media.muted = false;
      media.play().catch(() => {
        media.muted = true;
        media.play().catch(() => { });
      });
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

/* ---------------- карандаш: рисование поверх фото/видео ---------------- */
function drawEditor(src, isVideo, cb) {
  const modal = document.createElement('div');
  modal.className = 'draw-modal';
  modal.innerHTML = `
    <div class="draw-top">
      <button class="btn sm ghost" data-cancel>✕ Отмена</button>
      <div class="row" style="gap:6px">
        <button class="btn sm ghost" data-undo>↶ Назад</button>
        <button class="btn sm ghost" data-wipe>🧽 Очистить</button>
        <button class="btn sm" data-ok>✓ Готово</button>
      </div>
    </div>
    <div class="draw-stage"><canvas data-canvas></canvas></div>
    <div class="draw-tools">
      <div class="draw-colors">
        ${['#ffffff', '#ffe14d', '#ff5a5a', '#4dc3ff', '#7cff6b', '#000000']
      .map((c, i) => `<button class="draw-color ${i ? '' : 'on'}" data-color="${c}" style="background:${c}"></button>`).join('')}
      </div>
      <input type="range" min="4" max="48" value="12" data-width title="Толщина">
      <span class="muted" data-wlabel style="font-size:13px">12</span>
    </div>`;
  document.body.appendChild(modal);
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const finish = blob => { close(); cb && cb(blob); };
  const onKey = e => { if (e.key === 'Escape') finish(null); };
  document.addEventListener('keydown', onKey);
  $('[data-cancel]', modal).onclick = () => finish(null);

  const cv = $('[data-canvas]', modal), ctx = cv.getContext('2d');
  let base = null, color = '#ffffff', width = 12, strokes = [], cur = null;

  function sizeCanvas(w, h) {
    const max = 1280;
    const k = Math.min(1, max / Math.max(w, h));
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    redraw();
  }

  function redraw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (base) ctx.drawImage(base, 0, 0, cv.width, cv.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    [...strokes, ...(cur ? [cur] : [])].forEach(s => {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
      ctx.beginPath();
      s.pts.forEach((p, i) => i ? ctx.lineTo(p[0] * cv.width, p[1] * cv.height)
        : ctx.moveTo(p[0] * cv.width, p[1] * cv.height));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * cv.width + .01, s.pts[0][1] * cv.height);
      ctx.stroke();
    });
  }

  const pos = e => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  cv.addEventListener('pointerdown', e => {
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    cur = { color, width, pts: [pos(e)] }; redraw();
  });
  cv.addEventListener('pointermove', e => {
    if (!cur) return;
    cur.pts.push(pos(e)); redraw();
  });
  const up = () => { if (cur) { strokes.push(cur); cur = null; redraw(); } };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);

  $$('[data-color]', modal).forEach(b => b.onclick = () => {
    color = b.dataset.color;
    $$('[data-color]', modal).forEach(x => x.classList.toggle('on', x === b));
  });
  $('[data-width]', modal).oninput = e => {
    width = +e.target.value;
    $('[data-wlabel]', modal).textContent = width;
  };
  $('[data-undo]', modal).onclick = () => { strokes.pop(); redraw(); };
  $('[data-wipe]', modal).onclick = () => { strokes = []; redraw(); };

  $('[data-ok]', modal).onclick = () => {
    if (!strokes.length) return finish(null);
    if (isVideo) {
      // прозрачный слой: рисунок ляжет поверх видео на сервере
      cv.toBlob(b => finish(b), 'image/png');
    } else {
      cv.toBlob(b => finish(b), 'image/jpeg', 0.92);
    }
  };

  // база: для фото — сама картинка, для видео — только кадр для размеров
  const probe = new Image();
  probe.onload = () => {
    base = isVideo ? null : probe;
    sizeCanvas(probe.naturalWidth || 720, probe.naturalHeight || 1280);
  };
  if (isVideo) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = src;
    v.onloadedmetadata = () => { sizeCanvas(v.videoWidth || 720, v.videoHeight || 1280); v.src = ''; };
    v.onerror = () => sizeCanvas(720, 1280);
  } else {
    probe.src = src;
  }
}

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
  let drawBlob = null;        // рисунок поверх видео (PNG с прозрачностью)
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
        <div class="row" style="gap:8px">
          <button class="btn sm ghost" data-draw>✏️ Нарисовать</button>
          <button class="btn sm ghost" data-clear>Убрать</button>
        </div>
      </div>
      <div data-holder></div>
      <div class="inline-note" data-drawnote hidden style="margin-top:10px">✏️ Рисунок будет на фото или поверх видео</div>
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
    drawBlob = null;
    $('[data-drawnote]', screen).hidden = true;
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

  /* ---- карандаш: рисование поверх фото/видео ---- */
  $('[data-draw]', screen).onclick = () => {
    if (!file) return toast('Сначала выберите фото или видео');
    const isVideo = file.type.startsWith('video/');
    drawEditor(previewURL, isVideo, blob => {
      if (!blob) return;
      if (isVideo) {
        drawBlob = blob;
        $('[data-drawnote]', screen).hidden = false;
        toast('Рисунок сохранён — наложится при публикации');
      } else {
        file = blob;
        thumbBlob = blob;
        URL.revokeObjectURL(previewURL);
        previewURL = URL.createObjectURL(blob);
        holder.innerHTML = `<img class="preview" src="${previewURL}" alt="">`;
        toast('Рисунок наложен на фото');
      }
    });
  };

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
    const caption = $('[data-caption]', screen).value.trim();
    const sound = $('[data-sound]', screen).value.trim();
    if (!file) { toast('Сначала выберите фото или видео'); return; }
    const btn = $('[data-publish]', screen);
    const prog = $('[data-progress]', screen);
    btn.disabled = true; prog.style.display = 'block';
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'media');
      if (thumbBlob) fd.append('thumb', thumbBlob, 'thumb.jpg');
      if (drawBlob && file.type.startsWith('video/')) fd.append('draw', drawBlob, 'draw.png');
      fd.append('caption', caption);
      fd.append('sound', sound);
      if (mode === 'live') fd.append('kind', 'live');
      await uploadWithProgress(fd, p => {
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
