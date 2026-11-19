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
        : `<video src="/media/${esc(v.media)}" preload="none" muted></video>`);
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
    const d = await api(`/api/user/${encodeURIComponent(username)}/videos?tab=${tab}`);
    return d.items;
  };

  async function paint() {
    const items = await loadTab().catch(() => []);
    const grid = $('[data-grid]', screen);
    if (grid) {
      grid.innerHTML = videoGrid(items, tab === 'liked' ? 'Пока нет лайков'
        : tab === 'reposted' ? 'Пока нет репостов' : 'Пока нет видео');
      $$('.gcell', grid).forEach(c => c.onclick = () => openFeedOverlay(items, +c.dataset.i));
    }
  }

  screen.innerHTML = `
    <div class="topbar">
      ${isMe ? '' : '<button class="back" data-back>←</button>'}
      <h1 style="font-size:16px">@${esc(prof.username)}</h1>
      ${isMe ? `<button class="back" data-settings style="font-size:17px">⚙</button>` : ''}
    </div>
    ${prof.banner ? `<div class="prof-banner"><img src="/media/${esc(prof.banner)}" alt=""></div>` : ''}
    <div class="prof-head${prof.banner ? ' has-banner' : ''}">
      <div class="ava-box">
        ${ava(prof.avatar, 'lg')}
        ${adm ? '<button class="prof-adm" data-adm title="Действия администратора">🛡</button>' : ''}
      </div>
      <div class="prof-nick">${esc(prof.nickname)}</div>
      <div class="prof-user">@${esc(prof.username)}${vBadge(prof)}</div>
      ${prof.bio ? `<div class="prof-bio">${esc(prof.bio)}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${nfmt(stats.following)}</b><span>${pluralWord(stats.following, 'подписка', 'подписки', 'подписок')}</span></div>
        <div class="stat"><b data-followers>${nfmt(stats.followers)}</b><span>${subsWord(stats.followers)}</span></div>
        <div class="stat"><b>${nfmt(stats.likes)}</b><span>${pluralWord(stats.likes, 'лайк', 'лайка', 'лайков')}</span></div>
      </div>
    </div>
    <div class="prof-actions">
      ${isMe ? `<button class="btn ghost" data-edit>Редактировать</button>`
      : `<button class="btn ${stats.followed ? 'ghost' : ''}" data-follow>${stats.followed ? '✓ Вы подписаны' : 'Подписаться'}</button>
            <button class="btn ghost" data-msg>💬 Написать</button>`}
    </div>
    <div data-circles></div>
    <div class="ptabs">
      <button class="on" data-t="videos">Видео</button>
      ${isMe ? `<button data-t="liked">Лайки</button>` : ''}<button data-t="reposted">Репосты</button>
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

      <label class="lbl">Баннер профиля</label>
      <div class="banner-row">
        ${me.banner
          ? `<img class="banner-prev" src="/media/${esc(me.banner)}" alt="">`
          : `<div class="banner-ph">🖼 Нет баннера</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14.5px">Фон за аватаркой</div>
          <div class="muted" style="font-size:12.5px;margin-top:3px">${me.banner ? 'Есть свой баннер' : 'Можно сделать свой'}</div>
          <button class="btn sm" data-banner style="margin-top:8px">🖼 ${me.banner ? 'Изменить баннер' : 'Создать баннер'}</button>
        </div>
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

  $('[data-banner]', screen) && ($('[data-banner]', screen).onclick = () => bannerSheet());
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
      <label class="lbl" style="margin-top:0">Уведомления на телефоне</label>
      <button class="btn ghost" data-push>🔔 Push-уведомления</button>

      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Аккаунт</label>
      <button class="btn ghost" data-edit>✏️ Редактировать профиль</button>
      <div style="height:10px"></div>
      <button class="btn ghost" data-chpw>🔑 Сменить пароль</button>
      <div style="height:10px"></div>
      <button class="btn ghost" data-logout>Выйти из аккаунта</button>

      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Мои данные</label>
      <button class="btn ghost" data-export>📦 Выгрузить данные (JSON)</button>
      <div style="height:10px"></div>
      <button class="btn danger" data-del>🗑 Удалить аккаунт</button>

      ${App.me.is_admin ? `
      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Модерация</label>
      <button class="btn ghost" data-adminpanel>🛠 Админ-панель<span data-repcount></span></button>` : ''}

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
  $('[data-chpw]', screen).onclick = () => {
    const m = sheet('🔑 Сменить пароль', `
      <label class="lbl" style="margin-top:0">Текущий пароль</label>
      <input class="field" data-old type="password" autocomplete="current-password" placeholder="••••••••">
      <label class="lbl">Новый пароль (от 6 символов)</label>
      <input class="field" data-new type="password" autocomplete="new-password" placeholder="••••••••">
      <div style="height:16px"></div>
      <button class="btn" data-save>Сменить пароль</button>
      <div class="inline-note" style="margin-top:12px">После смены пароля все сессии на других устройствах будут завершены.</div>`);
    $('[data-save]', m).onclick = async () => {
      const oldPw = $('[data-old]', m).value, newPw = $('[data-new]', m).value;
      if (!oldPw || newPw.length < 6) { toast('Новый пароль от 6 символов'); return; }
      try {
        await api('/api/me/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
        Overlay.close();
        logoutLocal();
        toast('Пароль изменён — войдите заново');
        navigate('#/auth');
      } catch (e) { }
    };
  };
  $('[data-logout]', screen).onclick = () => {
    confirmModal('Выйти из аккаунта?', async () => {
      try { await api('/api/logout', { method: 'POST', silent: true }); } catch (e) { }
      logoutLocal();
      navigate('#/auth');
    }, 'Выйти');
  };

  /* push на телефон: подписка через Service Worker */
  const pb = $('[data-push]', screen);
  const pushOK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!pushOK) {
    pb.disabled = true;
    pb.textContent = '🔕 Push не поддерживаются в этом браузере';
  } else {
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => { pb.textContent = sub ? '🔕 Выключить уведомления' : '🔔 Уведомления на телефоне'; })
      .catch(() => { });
    pb.onclick = async () => {
      pb.disabled = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const cur = await reg.pushManager.getSubscription();
        if (cur) {
          await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: cur.endpoint }, silent: true });
          await cur.unsubscribe();
          pb.textContent = '🔔 Уведомления на телефоне';
          toast('Уведомления выключены');
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Браузер не разрешил уведомления'); return; }
        const d = await api('/api/push/public-key');
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: urlB64ToUint8(d.key)
        });
        await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
        pb.textContent = '🔕 Выключить уведомления';
        toast('Уведомления на телефоне включены');
      } catch (e) {
        toast('Не удалось включить уведомления');
      }
      pb.disabled = false;
    };
  }

  /* выгрузка своих данных файлом */
  $('[data-export]', screen).onclick = async () => {
    const btn = $('[data-export]', screen);
    btn.disabled = true;
    try {
      const d = await api('/api/me/export');
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `potatos-${App.me.username}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('Файл сохранён');
    } catch (e) { }
    btn.disabled = false;
  };

  /* удаление аккаунта */
  $('[data-del]', screen).onclick = () => {
    const m = modal(`<h3>Удалить аккаунт?</h3>
      <p class="muted" style="font-size:13.5px;line-height:1.5;margin:10px 0 0">
        Посты, комментарии, переписка и файлы будут удалены безвозвратно.
        Отменить будет нельзя.</p>
      <label class="lbl" style="margin-top:14px">Пароль</label>
      <input class="field" data-pw type="password" placeholder="••••••••" autocomplete="current-password">
      <div class="row" style="margin-top:16px;gap:10px">
        <button class="btn ghost" data-no>Отмена</button>
        <button class="btn danger" data-yes>Удалить навсегда</button>
      </div>`);
    $('[data-no]', m).onclick = () => Overlay.close();
    const kill = async () => {
      const pw = $('[data-pw]', m).value;
      if (!pw) { toast('Введите пароль'); return; }
      const yes = $('[data-yes]', m);
      yes.disabled = true;
      try {
        await api('/api/me', { method: 'DELETE', body: { password: pw } });
        Overlay.close();
        logoutLocal();
        toast('Аккаунт удалён');
        navigate('#/auth');
      } catch (e) { yes.disabled = false; }
    };
    $('[data-yes]', m).onclick = kill;
    $('[data-pw]', m).onkeydown = e => { if (e.key === 'Enter') kill(); };
  };

  /* админ-панель (только админ): статистика + жалобы со ссылками */
  const rb = $('[data-adminpanel]', screen);
  if (rb) {
    rb.onclick = () => navigate('#/admin');
    api('/api/admin/stats', { silent: true })
      .then(d => { const el = $('[data-repcount]', screen); if (el && d.reports_open) el.textContent = ` (${d.reports_open})`; })
      .catch(() => { });
  }
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

/* ---------------- баннер профиля ---------------- */
const BANNERS = [
  ['#ff9a3d', '#ff5a5a'],   // закат
  ['#7c3aed', '#3b82f6'],   // фиолет-синий
  ['#0ea5e9', '#22c55e'],   // морская волна
  ['#f43f5e', '#a21caf'],   // ягода
  ['#111827', '#374151'],   // графит
  ['#FFC93C', '#ff8a3d'],   // картошка
  ['#10b981', '#84cc16'],   // лайм
];

async function bannerSheet() {
  const m = sheet('🖼 Баннер профиля',
    '<button class="btn" data-upload>📤 Загрузить картинку</button>'
    + '<div style="height:10px"></div>'
    + '<button class="btn" data-create>🎨 Создать в редакторе</button>'
    + '<div style="height:10px"></div>'
    + '<button class="btn ghost" data-remove>🗑 Удалить баннер</button>'
    + '<div class="inline-note" style="margin-top:12px">Баннер — широкий фон (3:1) за вашей аватаркой в профиле.</div>');

  const file = document.createElement('input');
  file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
  document.body.appendChild(file);
  file.onchange = async () => {
    const f = file.files[0]; file.remove();
    if (!f) return;
    const fd = new FormData(); fd.append('file', f, f.name);
    try {
      const d = await api('/api/me/banner', { method: 'POST', body: fd });
      App.me = d.user;
      toast('Баннер обновлён');
      Overlay.close();
      render();
    } catch (e) { }
  };
  $('[data-upload]', m).onclick = () => file.click();
  $('[data-create]', m).onclick = () => { Overlay.close(); bannerBuilder(); };
  $('[data-remove]', m).onclick = async () => {
    try {
      const d = await api('/api/me/banner', { method: 'DELETE' });
      App.me = d.user;
      toast('Баннер удалён');
      Overlay.close();
      render();
    } catch (e) { }
  };
}
window.bannerSheet = bannerSheet;

function bannerBuilder() {
  const nick = (App.me && (App.me.nickname || App.me.username)) || 'potatos';
  const modal = document.createElement('div');
  modal.className = 'draw-modal';
  modal.innerHTML =
    '<div class="draw-top">'
    + '<button class="btn sm ghost" data-cancel>✕ Отмена</button>'
    + '<div class="row" style="gap:8px">'
    + '<button class="btn sm ghost" data-invert>🌗 Текст</button>'
    + '<button class="btn sm" data-ok>✓ Сохранить баннер</button>'
    + '</div>'
    + '</div>'
    + '<div class="draw-stage banner-stage"><canvas data-canvas width="1080" height="360"></canvas></div>'
    + '<div class="draw-tools banner-tools">'
    + '<div class="draw-colors" data-bgs>'
    + BANNERS.map((g, i) => '<button class="banner-bg' + (i === 0 ? ' on' : '') + '" data-bg="' + i + '" style="background:linear-gradient(120deg,' + g[0] + ',' + g[1] + ')"></button>').join('')
    + '<button class="banner-bg banner-bg-img" data-imgbtn title="Своё фото">🖼</button>'
    + '</div>'
    + '<input class="field" data-text maxlength="40" placeholder="Надпись (пусто — ваш ник)">'
    + '</div>'
    + '<input type="file" accept="image/*" data-file hidden>';
  document.body.appendChild(modal);

  const cv = $('[data-canvas]', modal);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  let bg = 0, customImg = null, darkText = false;

  const fileIn = $('[data-file]', modal);
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    if (customImg) {
      const s = Math.max(W / customImg.width, H / customImg.height);
      const w = customImg.width * s, h = customImg.height * s;
      ctx.drawImage(customImg, (W - w) / 2, (H - h) / 2, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 0, W, H);
    } else {
      const pair = BANNERS[bg];
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, pair[0]); g.addColorStop(1, pair[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const text = ($('[data-text]', modal).value || nick).trim() || nick;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 76px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.shadowColor = darkText ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 26;
    ctx.fillStyle = darkText ? '#111111' : '#ffffff';
    ctx.fillText(text, W / 2, H / 2, W - 80);
    ctx.restore();
  };

  $$('[data-bg]', modal).forEach(b => b.onclick = () => {
    bg = +b.dataset.bg;
    customImg = null;
    $$('[data-bg]', modal).forEach(x => x.classList.toggle('on', x === b));
    draw();
  });
  $('[data-imgbtn]', modal).onclick = () => fileIn.click();
  fileIn.onchange = () => {
    const f = fileIn.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { customImg = img; URL.revokeObjectURL(url); draw(); };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось открыть картинку'); };
    img.src = url;
  };
  $('[data-invert]', modal).onclick = () => { darkText = !darkText; draw(); };
  $('[data-text]', modal).oninput = draw;
  const close = () => modal.remove();
  $('[data-cancel]', modal).onclick = close;

  $('[data-ok]', modal).onclick = () => {
    const ok = $('[data-ok]', modal);
    ok.disabled = true;
    cv.toBlob(blob => {
      const fd = new FormData();
      fd.append('file', new File([blob], 'banner.png', { type: 'image/png' }));
      api('/api/me/banner', { method: 'POST', body: fd }).then(d => {
        App.me = d.user;
        toast('Баннер сохранён');
        close();
        render();
      }).catch(() => { ok.disabled = false; });
    }, 'image/png');
  };

  draw();
}
window.bannerBuilder = bannerBuilder;
