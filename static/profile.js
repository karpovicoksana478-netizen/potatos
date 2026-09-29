/* potatos — профиль (свой и чужой), редактирование, сетка видео */

function openFeedOverlay(items, index) {
  const host = document.createElement('div');
  host.className = 'overlay-feed';
  document.getElementById('app').appendChild(host);
  const f = createFeed(host, {
    items: items.slice(index).concat(items.slice(0, index)),
    hideTabs: true,
    onBack: () => { f.destroy(); host.remove(); },
  });
  return f;
}

function videoGrid(items, emptyText) {
  if (!items.length) return `<div class="grid-empty">${esc(emptyText)}</div>`;
  return `<div class="grid">` + items.map((v, i) => {
    const img = v.thumb ? `/media/${esc(v.thumb)}` : (v.kind === 'photo' ? `/media/${esc(v.media)}` : '');
    const inner = img
      ? `<img src="${img}" loading="lazy" alt="">`
      : (v.kind === 'photo' ? `<img src="/media/${esc(v.media)}" loading="lazy">`
        : `<video src="/media/${esc(v.media)}" preload="metadata" muted></video>`);
    return `<div class="gcell" data-i="${i}">
      ${inner}
      ${v.kind === 'live' ? '<span class="lp">LIVE</span>' : ''}
      <span class="vc">▶ ${nfmt(v.views)}</span>
      <span class="lk">${v.liked ? '❤️' : ''}</span>
    </div>`;
  }).join('') + `</div>`;
}

views.profile = async function (screen, r) {
  if (!requireAuth()) return;
  const username = r.args[0] || App.me.username;
  const isMe = username.toLowerCase() === App.me.username.toLowerCase();

  screen.innerHTML = `<div class="loader"><div class="spin"></div></div>`;

  let prof, stats, followers = [], tab = 'videos', adm = null;
  try {
    const d = await api('/api/user/' + encodeURIComponent(username));
    prof = d.user; stats = d.stats; adm = d.admin || null;
  } catch (e) { navigate('#/home'); return; }

  const loadTab = async () => {
    if (tab === 'saved') {
      const d = await api('/api/saved');
      return d.items;
    }
    const d = await api(`/api/user/${encodeURIComponent(username)}/videos?tab=${tab}`);
    return d.items;
  };

  async function paint() {
    const items = await loadTab().catch(() => []);
    const grid = $('[data-grid]', screen);
    if (grid) {
      grid.innerHTML = videoGrid(items, tab === 'saved' ? 'Нет сохранённых видео'
        : tab === 'liked' ? 'Пока нет лайков' : 'Пока нет видео');
      $$('.gcell', grid).forEach(c => c.onclick = () => openFeedOverlay(items, +c.dataset.i));
    }
  }

  screen.innerHTML = `
    <div class="topbar">
      ${isMe ? '' : '<button class="back" data-back>←</button>'}
      <h1 style="font-size:16px">@${esc(prof.username)}</h1>
      ${isMe ? '<button class="back" data-settings style="font-size:17px">⚙</button>' : ''}
    </div>
    <div class="prof-head">
      <div class="ava-box">
        ${ava(prof.avatar, 'lg')}
        ${adm ? '<button class="prof-adm" data-adm title="Действия администратора">🛡</button>' : ''}
      </div>
      <div class="prof-nick">${esc(prof.nickname)}</div>
      <div class="prof-user">@${esc(prof.username)}</div>
      ${prof.bio ? `<div class="prof-bio">${esc(prof.bio)}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${nfmt(stats.following)}</b><span>${pluralWord(stats.following, 'подписка', 'подписки', 'подписок')}</span></div>
        <div class="stat"><b data-followers>${nfmt(stats.followers)}</b><span>${subsWord(stats.followers)}</span></div>
        <div class="stat"><b>${nfmt(stats.likes)}</b><span>${pluralWord(stats.likes, 'лайк', 'лайка', 'лайков')}</span></div>
      </div>
    </div>
    <div class="prof-actions">
      ${isMe ? `<button class="btn ghost" data-edit>Редактировать профиль</button>`
      : `<button class="btn ${stats.followed ? 'ghost' : ''}" data-follow>${stats.followed ? '✓ Вы подписаны' : 'Подписаться'}</button>
           <button class="btn ghost" data-msg>💬 Написать</button>`}
    </div>
    <div data-circles></div>
    <div class="ptabs">
      <button class="on" data-t="videos">Видео</button>
      ${isMe ? `<button data-t="saved">Сохранённые</button><button data-t="liked">Лайки</button>` : ''}
    </div>
    <div data-grid><div class="loader"><div class="spin"></div></div></div>
    <div style="height:40px"></div>`;

  $('[data-back]', screen) && ($('[data-back]', screen).onclick = () => history.back());
  $('[data-settings]', screen) && ($('[data-settings]', screen).onclick = () => navigate('#/settings'));
  $('[data-edit]', screen) && ($('[data-edit]', screen).onclick = () => navigate('#/edit'));
  $('[data-adm]', screen) && ($('[data-adm]', screen).onclick = () => adminUserMenu(prof, adm));

  /* кружочки с аватарками подписчиков */
  try {
    const d = await api(`/api/user/${encodeURIComponent(username)}/followers`);
    followers = d.items;
    const host = $('[data-circles]', screen);
    if (followers.length) {
      host.innerHTML = `<div class="lbl" style="padding:6px 16px 0;margin:0">Подписчики</div>
        <div class="circle-row">
          ${followers.map(f => `<div class="circ" data-u="${esc(f.username)}">
            ${f.avatar ? `<img src="/media/${esc(f.avatar)}" onerror="App.avaFail(this)">` : `<div class="ph">🥔</div>`}
            <div class="cn">${esc(f.nickname)}</div></div>`).join('')}
        </div>`;
      $$('.circ', host).forEach(c => c.onclick = () => navigate('#/profile/' + c.dataset.u));
    }
  } catch (e) { }

  /* вкладки */
  $$('[data-t]', screen).forEach(b => b.onclick = () => {
    tab = b.dataset.t;
    $$('[data-t]', screen).forEach(x => x.classList.toggle('on', x === b));
    $('[data-grid]', screen).innerHTML = `<div class="loader"><div class="spin"></div></div>`;
    paint();
  });

  /* действия */
  const fb = $('[data-follow]', screen);
  fb && (fb.onclick = async () => {
    try {
      const d = await api(`/api/user/${prof.username}/follow`, { method: 'POST' });
      stats.followed = d.followed;
      stats.followers = d.followers;
      fb.textContent = d.followed ? '✓ Вы подписаны' : 'Подписаться';
      fb.classList.toggle('ghost', d.followed);
      $('[data-followers]', screen).textContent = nfmt(d.followers);
      toast(d.followed ? 'Вы подписались' : 'Подписка отменена');
    } catch (e) { }
  });

  const mb = $('[data-msg]', screen);
  mb && (mb.onclick = async () => {
    try {
      const c = await api('/api/chats/dm', { method: 'POST', body: { username: prof.username } });
      await Chats.loadList();
      navigate('#/chat/' + c.id);
    } catch (e) { }
  });

  await paint();
};

/* ---------------- редактирование профиля ---------------- */
views.edit = async function (screen) {
  if (!requireAuth()) return;
  const me = App.me;
  screen.innerHTML = `
    <div class="topbar">
      <button class="back" data-back>←</button>
      <h1>Редактировать профиль</h1>
    </div>
    <div class="page">
      <div class="center">
        <div style="position:relative;width:96px;margin:6px auto 4px">
          <div data-ava>${ava(me.avatar, 'lg')}</div>
          <label class="back" for="ava-file"
            style="position:absolute;right:-4px;bottom:0;background:var(--accent);color:#141414;font-size:16px;cursor:pointer">📷</label>
          <input id="ava-file" type="file" accept="image/*" hidden>
        </div>
        <div class="muted" style="font-size:12.5px">Аватар картошки 🥔</div>
      </div>

      <label class="lbl">Ник</label>
      <input class="field" data-nick maxlength="32" value="${esc(me.nickname)}">

      <label class="lbl">Юзернейм</label>
      <input class="field" value="@${esc(me.username)}" disabled style="opacity:.6">
      <div class="muted" style="font-size:12px;margin-top:6px">Юзернейм нельзя изменить — он ваш ключ входа.</div>

      <label class="lbl">О себе</label>
      <textarea class="field" data-bio maxlength="200" placeholder="Пара слов о себе...">${esc(me.bio || '')}</textarea>

      <div style="height:22px"></div>
      <button class="btn" data-save>Сохранить</button>
      <div style="height:12px"></div>
      <button class="btn ghost" data-logout>Выйти из аккаунта</button>
      <div class="inline-note" style="margin-top:18px">
        potatos анонимный: ваш профиль — только ник, юзернейм и аватар.
        Ни почта, ни телефон, ни имя не запрашиваются.
      </div>
    </div>`;

  $('[data-back]', screen).onclick = () => history.back();

  const file = $('#ava-file', screen);
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      const d = await api('/api/me/avatar', { method: 'POST', body: fd });
      App.me = d.user;
      $('[data-ava]', screen).innerHTML = ava(d.user.avatar, 'lg');
      renderTabbar(App.route.name);
      toast('Аватар обновлён');
    } catch (e) { }
  };

  $('[data-save]', screen).onclick = async () => {
    try {
      const d = await api('/api/me', {
        method: 'PATCH',
        body: { nickname: $('[data-nick]', screen).value, bio: $('[data-bio]', screen).value }
      });
      App.me = d.user;
      toast('Сохранено');
      navigate('#/profile/' + d.user.username);
    } catch (e) { }
  };

  $('[data-logout]', screen).onclick = () => {
    confirmModal('Выйти из аккаунта?', async () => {
      try { await api('/api/logout', { method: 'POST', silent: true }); } catch (e) { }
      logoutLocal();
      navigate('#/auth');
    }, 'Выйти');
  };
};


/* ---------------- настройки и тема ---------------- */
views.settings = async function (screen) {
  if (!requireAuth()) return;
  const t = Theme.get();
  screen.innerHTML = `
    <div class="topbar">
      <button class="back" data-back>←</button>
      <h1>Настройки</h1>
    </div>
    <div class="page">
      <label class="lbl" style="margin-top:0">Тема оформления</label>
      <div class="theme-row">
        <button class="theme-card ${t === 'dark' ? 'on' : ''}" data-th="dark">
          <div class="sw dark"></div><b>🌙 Тёмная</b>
        </button>
        <button class="theme-card ${t === 'light' ? 'on' : ''}" data-th="light">
          <div class="sw light"></div><b>☀️ Светлая</b>
        </button>
        <button class="theme-card ${t === 'purple' ? 'on' : ''}" data-th="purple">
          <div class="sw purple"></div><b>🍇 Фиолетовая</b>
        </button>
      </div>

      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Аккаунт</label>
      <button class="btn ghost" data-edit>✏️ Редактировать профиль</button>
      <div style="height:10px"></div>
      <button class="btn danger" data-logout>Выйти из аккаунта</button>

      <div class="divider"></div>
      <div class="inline-note">
        <b>potatos 🥔</b> — анонимная соцсеть.<br>
        Никакой почты и телефонов: только ник, юзнейм и пароль.<br>
        Тема хранится на этом устройстве и применяется сразу.
      </div>
      <div style="height:30px"></div>
    </div>`;

  $('[data-back]', screen).onclick = () => history.length > 1 ? history.back() : navigate('#/profile/' + App.me.username);

  $$('[data-th]', screen).forEach(card => card.onclick = () => {
    Theme.set(card.dataset.th);
    $$('[data-th]', screen).forEach(c => c.classList.toggle('on', c === card));
    toast('Тема: ' + Theme.title(card.dataset.th));
  });

  $('[data-edit]', screen).onclick = () => navigate('#/edit');
  $('[data-logout]', screen).onclick = () => {
    confirmModal('Выйти из аккаунта?', async () => {
      try { await api('/api/logout', { method: 'POST', silent: true }); } catch (e) { }
      logoutLocal();
      navigate('#/auth');
    }, 'Выйти');
  };
};

/* ---------------- меню администратора в профиле ---------------- */
function fmtTime(ts) {
  try {
    return new Date(ts * 1000).toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function adminUserMenu(prof, adm) {
  adm = adm || {};
  const banNote = adm.banned
    ? `<div class="inline-note">⛔ Аккаунт заблокирован${adm.banned_forever ? ' навсегда' : ' до ' + fmtTime(adm.banned_until)}</div>`
    : `<div class="inline-note">✅ Аккаунт активен</div>`;
  const postNote = adm.posts_blocked
    ? `<div class="inline-note" style="margin-top:8px">🚫 Публикации запрещены${adm.posts_forever ? ' навсегда' : ' до ' + fmtTime(adm.posts_until)}</div>`
    : '';

  const m = sheet('🛡 ' + prof.nickname, `
    <div class="lbl" style="margin-top:0">Аккаунт</div>
    ${banNote}
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn sm danger" data-b="perm">⛔ Бан навсегда</button>
      <button class="btn sm ghost" data-b="24">🕓 Бан на 24 часа</button>
      <button class="btn sm ghost" data-b="168">🕓 Бан на 7 дней</button>
      ${adm.banned ? '<button class="btn sm" data-b="unban">✅ Разбанить</button>' : ''}
    </div>
    <div class="lbl">Публикации</div>
    ${postNote}
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:${postNote ? '10px' : '0'}">
      <button class="btn sm danger" data-p="perm">🚫 Без постов навсегда</button>
      <button class="btn sm ghost" data-p="24">🚫 Без постов 24 часа</button>
      ${adm.posts_blocked ? '<button class="btn sm" data-p="unban">✅ Разрешить посты</button>' : ''}
    </div>
    <div style="height:16px"></div>`);

  const act = (path, mode) => {
    const hours = (mode === 'perm' || mode === 'unban') ? 0 : +mode;
    const apiMode = (mode === 'perm' || mode === 'unban') ? mode : 'temp';
    const what = path === 'ban'
      ? (mode === 'perm' ? 'заблокировать навсегда'
        : mode === 'unban' ? 'снять блокировку'
          : `заблокировать на ${hours} ч.`)
      : (mode === 'perm' ? 'запретить публикации навсегда'
        : mode === 'unban' ? 'разрешить публикации снова'
          : `запретить публикации на ${hours} ч.`);
    confirmModal(`${what}?`, async () => {
      try {
        await api(`/api/admin/users/${prof.id}/${path}`,
          { method: 'POST', body: { mode: apiMode, hours } });
        Overlay.close();
        toast('Готово');
        render();
      } catch (e) { }
    }, 'Подтвердить');
  };

  $$('[data-b]', m).forEach(b => b.onclick = () => act('ban', b.dataset.b));
  $$('[data-p]', m).forEach(b => b.onclick = () => act('posts', b.dataset.p));
}
