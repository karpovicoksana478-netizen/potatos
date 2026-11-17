/* potatos — админ-панель: статистика и очередь жалоб со ссылками на видео */

function reportLink(r) {
  const t = r.target || {};
  if (r.kind === 'post') return `#/video/${t.id || r.target_id}`;
  if (r.kind === 'comment') return `#/video/${t.video_id || ''}`;
  return null;
}

views.admin = async function (screen) {
  if (!requireAuth()) return;
  if (!App.me.is_admin) { toast('Только для администратора'); navigate('#/home'); return; }

  screen.innerHTML = `
    <div class="topbar">
      <button class="back" data-back>←</button>
      <h1 style="font-size:17px">🛠 Админ-панель</h1>
    </div>
    <div class="page">
      <div class="admin-stats" data-stats>
        <div class="astat"><b>—</b><span>Зарегистрировано</span></div>
        <div class="astat"><b>—</b><span>Онлайн сейчас</span></div>
        <div class="astat"><b>—</b><span>Видео</span></div>
        <div class="astat"><b>—</b><span>Эфиров в эфире</span></div>
      </div>
      <div class="divider"></div>
      <div class="spread" style="margin-bottom:10px">
        <label class="lbl" style="margin:0">Жалобы<span data-opencount></span></label>
        <div class="seg" style="max-width:220px">
          <button class="on" data-f="open">Открытые</button>
          <button data-f="done">Закрытые</button>
        </div>
      </div>
      <div data-reports><div class="loader"><div class="spin"></div></div></div>
      <div style="height:30px"></div>
    </div>`;

  $('[data-back]', screen).onclick = () => history.back();

  /* статистика */
  api('/api/admin/stats', { silent: true }).then(d => {
    const cells = $$('.astat b', screen);
    if (cells.length >= 4) {
      cells[0].textContent = d.users;
      cells[1].textContent = d.online;
      cells[2].textContent = d.videos;
      cells[3].textContent = (d.streams || 0);
    }
    const oc = $('[data-opencount]', screen);
    if (oc && d.reports_open) oc.textContent = ` (${d.reports_open})`;
  }).catch(() => { });

  let filter = 'open';
  const box = $('[data-reports]', screen);

  async function paint() {
    box.innerHTML = '<div class="loader"><div class="spin"></div></div>';
    let d;
    try { d = await api('/api/admin/reports?status=' + filter, { silent: true }); }
    catch (e) {
      box.innerHTML = '<div class="inline-note">Не удалось загрузить жалобы</div>';
      return;
    }
    if (!d.items.length) {
      box.innerHTML = '<div class="inline-note">Жалоб нет — всё чисто 🎉</div>';
      return;
    }
    box.innerHTML = d.items.map(r => {
      const t = r.target || {};
      const what = r.kind === 'post' ? 'Видео' : 'Комментарий';
      const snippet = (t.caption || t.text || '').slice(0, 140) || (r.kind === 'post' ? '[медиа]' : '—');
      const link = reportLink(r);
      const done = r.status !== 'open';
      return `<div class="rep-row" data-id="${r.id}">
        <div class="rep-h"><b>${what}</b> · @${esc(t.owner || '?')} · ${timeAgo(r.created_at)}</div>
        <div class="rep-x">${esc(snippet)}</div>
        <div class="rep-m">причина: ${esc(r.reason || '—')} · от @${esc(r.reporter || '?')}</div>
        ${link ? `<a class="msg-link rep-link" href="${esc(link)}">▶ Открыть ${r.kind === 'post' ? 'видео' : 'видео с комментарием'}</a>` : ''}
        ${done ? '<div class="rep-m">✅ Рассмотрено</div>' : `
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn sm danger" data-del>🗑 Удалить</button>
          <button class="btn sm ghost" data-close>Закрыть</button>
        </div>`}
      </div>`;
    }).join('');
    $$('.rep-row', box).forEach(row => {
      const id = +row.dataset.id;
      const del = $('[data-del]', row);
      const close = $('[data-close]', row);
      del && (del.onclick = () => confirmModal('Удалить этот контент?', async () => {
        try {
          await api(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { action: 'delete' } });
          toast('Контент удалён');
          paint();
        } catch (e) { }
      }, 'Удалить'));
      close && (close.onclick = async () => {
        try {
          await api(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { action: 'close' } });
          toast('Жалоба закрыта');
          paint();
        } catch (e) { }
      });
    });
  }

  $$('[data-f]', screen).forEach(b => b.onclick = () => {
    filter = b.dataset.f;
    $$('[data-f]', screen).forEach(x => x.classList.toggle('on', x === b));
    paint();
  });

  await paint();
};
