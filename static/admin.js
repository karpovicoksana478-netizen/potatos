/* potatos — админ-панель: статистика, верификация, админка, жалобы и журнал действий */

function reportLink(r) {
  const t = r.target || {};
  if (r.kind === 'post') return `#/video/${t.id || r.target_id}`;
  if (r.kind === 'comment') return `#/video/${t.video_id || ''}`;
  return null;
}

const ACTION_IC = {
  ban: '⛔', posts_ban: '🚫', report_resolve: '✅', report_close: '📁',
  delete_video: '🗑', delete_comment: '💬', grant_admin: '🛡', revoke_admin: '🛡',
  verify: '✓', undo: '↩️',
};
function actionDesc(a) {
  const d = a.detail || {};
  switch (a.action) {
    case 'ban': {
      const s = d.new === -1 ? 'Забанил навсегда' : d.new > 0 ? 'Забанил временно' : 'Разбанил';
      return `${s} @${d.username || a.target_id}`;
    }
    case 'posts_ban': {
      const s = d.new === -1 ? 'Запретил посты навсегда' : d.new > 0 ? 'Запретил посты временно' : 'Разрешил посты';
      return `${s} @${d.username || a.target_id}`;
    }
    case 'report_resolve': return `Решил жалобу${d.reason ? ' («' + d.reason + '»)' : ''}`;
    case 'report_close': return 'Закрыл жалобу';
    case 'delete_video': return `Удалил видео «${d.summary || '[медиа]'}» (автор @${d.owner || '?'})`;
    case 'delete_comment': return `Удалил комментарий «${d.summary || '—'}» (автор @${d.owner || '?'})`;
    case 'grant_admin': return `Выдал админку @${d.username || ''}`;
    case 'revoke_admin': return `Забрал админку @${d.username || ''}`;
    case 'verify': return `${d.on ? 'Выдал' : 'Снял'} галочку @${d.username || ''}`;
    default: return a.action;
  }
}

views.admin = async function (screen) {
  if (!requireAuth()) return;
  if (!App.me.is_admin) { toast('Только для администратора'); navigate('#/home'); return; }
  const isSuper = !!App.me.is_super;

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
      ${isSuper ? `
      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Выдать админку</label>
      <div class="verify-row">
        <input class="field" data-gq placeholder="Юзернейм (без @)" autocapitalize="none" autocorrect="off" spellcheck="false">
        <button class="btn sm" data-gfind>Найти</button>
      </div>
      <div data-gres style="margin-top:10px"></div>
      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Галочка верификации</label>
      <div class="verify-row">
        <input class="field" data-vq placeholder="Юзернейм (без @)" autocapitalize="none" autocorrect="off" spellcheck="false">
        <button class="btn sm" data-vfind>Найти</button>
      </div>
      <div data-vres style="margin-top:10px"></div>` : ''}
      <div class="divider"></div>
      <button class="actions-toggle" data-acttoggle>
        <span>Журнал действий<span data-acount class="muted" style="font-weight:400"></span></span>
        <span class="actions-arrow" data-arrow>▾</span>
      </button>
      <div data-actions style="margin-top:10px"></div>
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

  const findByUsername = async (q, container, renderCard) => {
    const uq = q.trim().replace(/^@/, '');
    if (!uq) { container.innerHTML = ''; return; }
    container.innerHTML = '<div class="loader"><div class="spin"></div></div>';
    let d;
    try { d = await api('/api/admin/users?q=' + encodeURIComponent(uq) + '&limit=5', { silent: true }); }
    catch (e) { container.innerHTML = '<div class="inline-note">Не удалось найти</div>'; return; }
    const exact = (d.items || []).find(u => (u.username || '').toLowerCase() === uq.toLowerCase());
    if (!exact) {
      container.innerHTML = `<div class="inline-note">Пользователь @${esc(uq)} не найден</div>`;
      return;
    }
    renderCard(exact);
  };

  /* ---------- выдача админки (только суперадмин) ---------- */
  if (isSuper) {
    const gq = $('[data-gq]', screen);
    const gres = $('[data-gres]', screen);
    const renderG = u => {
      const on = !!u.is_admin;
      gres.innerHTML = `
        <div class="list-item" style="cursor:default">
          ${ava(u.avatar)}
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${esc(u.nickname)}</div>
            <div class="muted" style="font-size:13px">@${esc(u.username)}</div>
            <div class="muted" style="font-size:12.5px;margin-top:2px">${u.is_super ? '⭐ Главный админ' : on ? '🛡 Админ' : 'Не админ'}</div>
          </div>
          ${u.is_super ? '' : `<button class="btn sm ${on ? 'ghost' : ''}" data-toggle>${on ? 'Забрать админку' : '✓ Выдать админку'}</button>`}
        </div>`;
      const t = $('[data-toggle]', gres);
      if (!t) return;
      t.onclick = async () => {
        t.disabled = true;
        try {
          const d = await api('/api/admin/grant', { method: 'POST', body: { username: u.username, on: !u.is_admin } });
          u.is_admin = d.is_admin;
          renderG(u);
          toast(u.is_admin ? 'Админка выдана 🛡' : 'Админка снята');
        } catch (e) { t.disabled = false; }
      };
    };
    $('[data-gfind]', screen).onclick = () => findByUsername(gq.value, gres, renderG);
    gq.onkeydown = e => { if (e.key === 'Enter') findByUsername(gq.value, gres, renderG); };
  }

  /* ---------- верификация (только суперадмин) ---------- */
  if (isSuper) {
    const vq = $('[data-vq]', screen);
    const vres = $('[data-vres]', screen);
    const renderV = u => {
      vres.innerHTML = `
        <div class="list-item" style="cursor:default">
          ${ava(u.avatar)}
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${esc(u.nickname)}${vBadge(u)}</div>
            <div class="muted" style="font-size:13px">@${esc(u.username)}</div>
            <div class="muted" style="font-size:12.5px;margin-top:2px">${u.verified ? '✓ Верифицирован' : 'Не верифицирован'}</div>
          </div>
          <button class="btn sm ${u.verified ? 'ghost' : ''}" data-toggle>${u.verified ? 'Убрать галку' : '✓ Выдать галку'}</button>
        </div>`;
      const t = $('[data-toggle]', vres);
      t.onclick = async () => {
        t.disabled = true;
        try {
          const d = await api(`/api/admin/users/${u.id}/verify`, { method: 'POST', body: { on: !u.verified } });
          u.verified = d.verified;
          renderV(u);
          toast(u.verified ? 'Галка выдана' : 'Галка снята');
        } catch (e) { t.disabled = false; }
      };
    };
    $('[data-vfind]', screen).onclick = () => findByUsername(vq.value, vres, renderV);
    vq.onkeydown = e => { if (e.key === 'Enter') findByUsername(vq.value, vres, renderV); };
  }

  /* ---------- журнал действий модерации (сворачиваемый, внутри свой скролл) ---------- */
  const actionsBox = $('[data-actions]', screen);
  const actionsToggle = $('[data-acttoggle]', screen);
  const arrow = $('[data-arrow]', screen);
  const acount = $('[data-acount]', screen);
  let actionsOpen = false;
  const paintCollapse = () => {
    actionsBox.style.display = actionsOpen ? '' : 'none';
    if (arrow) arrow.textContent = actionsOpen ? '▴' : '▾';
    actionsToggle.classList.toggle('open', actionsOpen);
  };
  actionsToggle.onclick = () => { actionsOpen = !actionsOpen; paintCollapse(); };
  paintCollapse();
  const paintActions = async () => {
    let d;
    try { d = await api('/api/admin/actions?limit=40', { silent: true }); } catch (e) {
      actionsBox.innerHTML = '<div class="inline-note">Не удалось загрузить журнал</div>';
      return;
    }
    if (acount) acount.textContent = d.items.length ? ` · ${d.items.length}` : '';
    if (!d.items.length) {
      actionsBox.innerHTML = '<div class="inline-note">Действий модерации ещё не было</div>';
      return;
    }
    actionsBox.innerHTML = d.items.map(a => `
      <div class="rep-row action-row" data-id="${a.id}">
        <div class="rep-h">${ACTION_IC[a.action] || '•'} <b>@${esc(a.actor || 'удалён')}</b> · ${timeAgo(a.created_at)}</div>
        <div class="rep-x">${esc(actionDesc(a))}</div>
        <div class="rep-m">${a.undone ? '↩️ Отменено' : a.undoable ? `<button class="btn sm ghost" data-undo>Отменить</button>` : 'Нельзя отменить'}
          ${(a.action === 'delete_video' || a.action === 'delete_comment') && !a.undone ? `<button class="btn sm danger" data-purge style="margin-left:8px">Насовсем</button>` : ''}
        </div>
      </div>`).join('');
    $$('.action-row', actionsBox).forEach(row => {
      const id = +row.dataset.id;
      const un = $('[data-undo]', row);
      const pu = $('[data-purge]', row);
      un && (un.onclick = () => confirmModal('Отменить это действие?', async () => {
        try {
          await api(`/api/admin/actions/${id}/undo`, { method: 'POST' });
          toast('Действие отменено');
          paintActions();
        } catch (e) { }
      }, 'Отменить'));
      pu && (pu.onclick = () => confirmModal('Удалить безвозвратно? Отменить будет нельзя.', async () => {
        try {
          await api(`/api/admin/actions/${id}/purge`, { method: 'POST' });
          toast('Удалено насовсем');
          paintActions();
        } catch (e) { }
      }, 'Насовсем'));
    });
  };

  /* ---------- статистика ---------- */
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

  /* ---------- жалобы ---------- */
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
    paintCollapse();
    $$('.rep-row', box).forEach(row => {
      const id = +row.dataset.id;
      const del = $('[data-del]', row);
      const close = $('[data-close]', row);
      del && (del.onclick = () => confirmModal('Удалить этот контент?', async () => {
        try {
          await api(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { action: 'delete' } });
          toast('Контент удалён');
          paint();
          paintActions();
        } catch (e) { }
      }, 'Удалить'));
      close && (close.onclick = async () => {
        try {
          await api(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { action: 'close' } });
          toast('Жалоба закрыта');
          paint();
          paintActions();
        } catch (e) { }
      });
    });
  }

  $$('[data-f]', screen).forEach(b => b.onclick = () => {
    filter = b.dataset.f;
    $$('[data-f]', screen).forEach(x => x.classList.toggle('on', x === b));
    paint();
  });

  await Promise.all([paint(), paintActions()]);
};
