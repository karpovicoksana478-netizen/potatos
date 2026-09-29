/* ---------------- админ-панель ---------------- */
views.admin = async function (screen) {
  if (!requireAuth()) return;
  if (!App.me.is_admin) { toast('Только для администратора'); return navigate('#/home'); }

  screen.innerHTML = `
    <div class="topbar"><h1>🛡 Админка</h1></div>
    <div class="page">
      <div class="admin-stats" data-stats>
        <div class="astat"><b>…</b><span>пользователи</span></div>
        <div class="astat"><b>…</b><span>онлайн</span></div>
        <div class="astat"><b>…</b><span>видео</span></div>
        <div class="astat"><b>…</b><span>баны</span></div>
      </div>
      <div class="searchbar" style="margin:14px 0 8px">
        <span class="ic">🔍</span>
        <input data-q placeholder="Поиск: юзнейм или ник" autocapitalize="none">
        <button data-clearq style="color:var(--muted);font-size:17px" hidden>✕</button>
      </div>
      <div data-list><div class="loader"><div class="spin"></div></div></div>
      <div style="height:40px"></div>
    </div>`;

  const list = $('[data-list]', screen);
  const q = $('[data-q]', screen);
  const clear = $('[data-clearq]', screen);

  async function loadStats() {
    try {
      const s = await api('/api/admin/stats');
      const cells = $$('[data-stats] .astat b', screen);
      cells[0].textContent = nfmt(s.users);
      cells[1].textContent = nfmt(s.online);
      cells[2].textContent = nfmt(s.videos);
      cells[3].textContent = nfmt(s.banned);
    } catch (e) { }
  }

  async function loadUsers() {
    list.innerHTML = '<div class="loader"><div class="spin"></div></div>';
    try {
      const d = await api('/api/admin/users?q=' + encodeURIComponent(q.value.trim()));
      if (!d.items.length) {
        list.innerHTML = `<div class="empty"><div class="ic">🔍</div><div>Никого не найдено</div></div>`;
        return;
      }
      list.innerHTML = d.items.map(u => {
        const badges = [
          u.is_admin ? '<span class="badge adm">админ</span>' : '',
          u.online ? '<span class="badge on" title="Онлайн">онлайн</span>' : '',
          u.banned ? `<span class="badge ban ${u.banned_forever ? 'perm' : ''}">${u.banned_forever ? 'вечный бан' : 'бан до ' + fmtTime(u.banned_until)}</span>` : '',
          u.posts_blocked ? `<span class="badge ban posts ${u.posts_forever ? 'perm' : ''}">${u.posts_forever ? 'посты запрещены' : 'посты запрещ. до ' + fmtTime(u.posts_banned_until)}</span>` : '',
        ].join('');
        return `<div class="admin-row" data-id="${u.id}">
          <div class="ar-ava" data-prof="${esc(u.username)}">${ava(u.avatar)}</div>
          <div class="ar-main">
            <div class="ar-name" data-prof="${esc(u.username)}">${esc(u.nickname)}
              <span class="muted" style="font-weight:400">@${esc(u.username)}</span></div>
            <div class="ar-meta muted">${nfmt(u.videos)} видео${badges ? ' ' + badges : ''}</div>
          </div>
          <div class="ar-acts">
            <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
              ${u.banned
            ? `<button class="btn sm ghost" data-unban>✅ Разбанить</button>`
            : `<button class="btn sm danger" data-ban="perm">⬜ Вечный</button>
                 <button class="btn sm ghost" data-ban="24">🕓 24ч</button>
                 <button class="btn sm ghost" data-ban="168">🕓 7д</button>`}
              ${u.posts_blocked
            ? `<button class="btn sm ghost" data-posts="unban">✅ Разрешить посты</button>`
            : `<button class="btn sm ghost" data-posts="24">🚫 Без постов 24ч</button>
                 <button class="btn sm ghost" data-posts="perm">🚫 Без постов навсегда</button>`}
            </div>
          </div>
        </div>`;
      }).join('');

      $$('[data-prof]', list).forEach(el => el.onclick = () => navigate('#/profile/' + el.dataset.prof));      $$('[data-ban]', list).forEach(b => b.onclick = () => {
        const row = b.closest('.admin-row'); const uid = +row.dataset.id;
        const mode = b.dataset.ban;
        const hours = mode === 'perm' ? 0 : +mode;
        confirmModal(mode === 'perm' ? 'Заблокировать навсегда? Пользователь потеряет доступ.'
          : `Заблокировать на ${hours} ч.?`, async () => {
            try {
              await api(`/api/admin/users/${uid}/ban`, { method: 'POST', body: { mode, hours } });
              toast('Готово'); loadUsers(); loadStats();
            } catch (e) { }
          }, 'Заблокировать');
      });
      $$('[data-unban]', list).forEach(b => b.onclick = async () => {
        const row = b.closest('.admin-row'); const uid = +row.dataset.id;
        try {
          await api(`/api/admin/users/${uid}/ban`, { method: 'POST', body: { mode: 'unban' } });
          toast('Блокировка снята'); loadUsers(); loadStats();
        } catch (e) { }
      });
      $$('[data-posts]', list).forEach(b => b.onclick = async () => {
        const row = b.closest('.admin-row'); const uid = +row.dataset.id;
        const mode = b.dataset.posts;
        const hours = mode === 'perm' ? 0 : +mode;
        try {
          await api(`/api/admin/users/${uid}/posts`, { method: 'POST', body: { mode, hours } });
          toast('Готово'); loadUsers(); loadStats();
        } catch (e) { }
      });
    } catch (e) {
      list.innerHTML = `<div class="empty"><div class="ic">⚠️</div><div>Не удалось загрузить список</div></div>`;
    }
  }

  q.oninput = debounce(() => { clear.hidden = !q.value.trim(); loadUsers(); }, 300);
  clear.onclick = () => { q.value = ''; clear.hidden = true; loadUsers(); q.focus(); };

  loadStats();
  loadUsers();
};

function fmtTime(ts) {
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}
