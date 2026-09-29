/* potatos — общение: список чатов, поиск, группы/каналы, переписка */

const Chats = {
  list: [],
  current: null,   // {id, ...}
  view: null,      // 'list' | 'open'
  loadList: async function () {
    try {
      const d = await api('/api/chats');
      Chats.list = d.items;
      return Chats.list;
    } catch (e) { return []; }
  },
  find: function (id) { return Chats.list.find(c => c.id === +id); },
  onEvent: async function (d) {
    if (!d) return;
    if (d.type === 'message') {
      const c = Chats.find(d.chat_id);
      if (c) { c.last = { id: d.message.id, text: d.message.text, kind: d.message.kind, created_at: d.message.created_at, user_id: d.message.user_id }; }
      if (App.route.name === 'chat' && +App.route.args[0] === d.chat_id) {
        ChatView.append(d.message);
        api(`/api/chats/${d.chat_id}/read`, { method: 'POST', silent: true });
        const cc = Chats.find(d.chat_id); if (cc) cc.unread = 0;
      } else {
        const cc = Chats.find(d.chat_id);
        if (cc) cc.unread = (cc.unread || 0) + 1;
        if (App.route.name === 'chats') refreshChatList();
      }
    } else if (d.type === 'typing') {
      if (App.route.name === 'chat' && +App.route.args[0] === d.chat_id) ChatView.typing(d.username);
    } else if (d.type === 'deleted') {
      if (App.route.name === 'chat' && +App.route.args[0] === d.chat_id) ChatView.remove(d.message_id);
      refreshChatList();
    } else if (d.type === 'removed') {
      await Chats.loadList();
      if (App.route.name === 'chat' && +App.route.args[0] === d.chat_id) {
        navigate('#/chats');
        toast('Вас удалили из чата');
      }
    } else if (d.type === 'chat_deleted') {
      await Chats.loadList();
      if (App.route.name === 'chat' && +App.route.args[0] === d.chat_id) {
        navigate('#/chats');
        toast('Чат был удалён владельцем');
      }
    } else if (d.type === 'chat_updated') {
      refreshChatList();
    }
  }
};
window.Chats = Chats;

async function refreshChatList() {
  await Chats.loadList();
  if (App.route.name === 'chat' && ChatView.chat) {
    const fresh = Chats.find(App.route.args[0]);
    if (fresh) Object.assign(ChatView.chat, fresh);
  }
  if (Chats.paint) { Chats.paint(); return; }
  const host = $('[data-chatlist]');
  const onlyDm = (Chats.list || []).filter(c => c.type === 'dm');
  if (host) host.innerHTML = onlyDm.length ? onlyDm.map(chatRow).join('') : chatListEmpty();
  bindChatRows();
}

function chatListEmpty() {
  return `<div class="chat-empty">
    <div style="font-size:46px">💬</div>
    <div style="font-weight:700;color:var(--text)">Пока нет личных переписок</div>
    <div>Найдите человека через поиск выше и напишите ему</div>
  </div>`;
}

function chatRow(c) {
  const ic = c.type === 'channel' ? '📢' : (c.type === 'group' ? '👥' : '');
  let last = 'Нет сообщений';
  if (c.last) {
    const who = c.last.user_id === (App.me && App.me.id) ? 'Вы: ' : '';
    const kind = c.last.kind;
    const body = kind === 'photo' ? '📷 Фото' : kind === 'video' ? '🎬 Видео' :
      kind === 'sticker' ? (c.last.text || '😀') : (c.last.text || '');
    last = who + body;
  }
  return `<div class="chat-row" data-chat="${c.id}">
    <div style="position:relative;flex:none">
      ${ava(c.avatar)}
      <span class="type-ic">${ic}</span>
    </div>
    <div class="b">
      <div class="t">${esc(c.title || 'Чат')}
        ${c.type === 'channel' ? '<span class="v">✓</span>' : ''}</div>
      <div class="l">${esc(last)}</div>
    </div>
    <div class="r">
      <span class="time">${c.last ? timeAgoShort(c.last.created_at) : ''}</span>
      ${c.unread ? `<span class="cnt">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </div>
  </div>`;
}

function bindChatRows() {
  $$('[data-chat]').forEach(r => r.onclick = () => navigate('#/chat/' + r.dataset.chat));
}

/* ---------------- список + поиск ---------------- */
views.chats = async function (screen) {
  if (!requireAuth()) return;
  screen.innerHTML = `
    <div class="topbar">
      <div class="searchbar">
        <span class="ic">🔍</span>
        <input data-q placeholder="Поиск людей, каналов и групп" autocapitalize="none">
        <button data-clearq style="color:var(--muted);font-size:17px" hidden>✕</button>
      </div>
    </div>
    <div data-results></div>
    <div data-listwrap>
      <div data-chatlist>${chatListEmpty()}</div>
    </div>
    <div style="height:30px"></div>`;

  const paintList = () => {
    const host = $('[data-chatlist]', screen);
    if (!host) return;
    const items = Chats.list.filter(c => c.type === 'dm');
    host.innerHTML = items.length ? items.map(chatRow).join('') : chatListEmpty();
    bindChatRows();
  };
  Chats.paint = paintList;

  await Chats.loadList();
  paintList();

  const q = $('[data-q]', screen);
  const results = $('[data-results]', screen);
  const clear = $('[data-clearq]', screen);

  const doSearch = debounce(async () => {
    const term = q.value.trim();
    clear.hidden = !term;
    if (!term) { results.innerHTML = ''; $('[data-listwrap]', screen).hidden = false; return; }
    $('[data-listwrap]', screen).hidden = true;
    results.innerHTML = `<div class="loader"><div class="spin"></div></div>`;
    try {
      const d = await api('/api/search?q=' + encodeURIComponent(term));
      const users = d.users;
      if (!users.length && !d.chats.length) {
        results.innerHTML = `<div class="empty"><div class="ic">🔍</div><div>Ничего не найдено<br><span class="muted">попробуйте другой запрос</span></div></div>`;
        return;
      }
      results.innerHTML = `
        ${users.length ? `<div class="lbl" style="padding:14px 16px 4px;margin:0">Люди</div>` : ''}
        ${users.map(u => `<div class="list-item" data-user="${esc(u.username)}">
            ${ava(u.avatar)}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(u.nickname)}</div>
              <div class="muted" style="font-size:13px">@${esc(u.username)}</div>
            </div>
            <button class="btn sm ghost" data-open="${esc(u.username)}">Профиль</button>
          </div>`).join('')}
        ${d.chats.length ? `<div class="lbl" style="padding:14px 16px 4px;margin:0">Каналы и группы</div>` : ''}
        ${d.chats.map(c => `<div class="list-item" data-openchat="${c.id}">
            ${ava(c.avatar)}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(c.title)} ${c.type === 'channel' ? '📢' : '👥'}</div>
              <div class="muted" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.description || people(c.members_count))}</div>
            </div>
            <button class="btn sm" data-join="${c.id}">${c.joined ? 'Открыть' : 'Вступить'}</button>
          </div>`).join('')}`;
      $$('[data-user]', results).forEach(el => el.onclick = () => navigate('#/profile/' + el.dataset.user));
      $$('[data-open]', results).forEach(el => el.onclick = e => { e.stopPropagation(); navigate('#/profile/' + el.dataset.open); });
      $$('[data-join]', results).forEach(el => el.onclick = async e => {
        e.stopPropagation();
        const id = el.dataset.join;
        const c = Chats.list.find(x => x.id === +id);
        try {
          if (!(c && c.joined)) await api(`/api/chats/${id}/join`, { method: 'POST' });
          navigate('#/chat/' + id);
        } catch (err) { }
      });
      $$('[data-openchat]', results).forEach(el => el.onclick = () => navigate('#/chat/' + el.dataset.openchat));
    } catch (e) { results.innerHTML = ''; }
  }, 320);

  q.oninput = doSearch;
  clear.onclick = () => { q.value = ''; doSearch(); q.focus(); };
};

/* ---------------- переписка ---------------- */
const ChatView = {
  el: null, chat: null, msgs: [], typingTimers: {},

  append(m) {
    if (!m || !this.el) return;
    if (this.msgs.some(x => x.id === m.id)) return;
    const host = $('.msgs', this.el);
    if (!host) return;
    const prev = this.msgs[this.msgs.length - 1];
    this.msgs.push(m);
    host.insertAdjacentHTML('beforeend', msgHTML(m, prev));
    this.bindOne(host.lastElementChild, m);
    host.scrollTop = host.scrollHeight;
  },

  remove(mid) {
    if (!this.el) return;
    this.msgs = this.msgs.filter(x => x.id !== mid);
    const el = this.el.querySelector(`.msg[data-id="${mid}"]`);
    if (el) el.remove();
  },

  typing(username) {
    const t = $('[data-typing]', this.el);
    if (!t) return;
    t.hidden = false;
    t.innerHTML = `<i></i><i></i><i></i><span>@${esc(username)} печатает…</span>`;
    clearTimeout(this.typingTimers[username]);
    this.typingTimers[username] = setTimeout(() => { if (t) t.hidden = true; }, 3000);
  },

  bindOne(el, m) {
    if (!el) return;
    const p = el.querySelector('[data-prof]');
    if (p && m.author && m.author.username) p.onclick = () => navigate('#/profile/' + m.author.username);
  }
};

function msgHTML(m, prev) {
  const mine = App.me && m.user_id === App.me.id;
  const sameDay = prev && new Date(prev.created_at * 1000).toDateString() === new Date(m.created_at * 1000).toDateString();
  let inner = '';
  if (m.kind === 'sticker') inner = `<div class="sticker">${esc(m.text)}</div>`;
  else if (m.kind === 'photo') inner = `<img src="/media/${esc(m.media)}" loading="lazy" onclick="event.stopPropagation()">`;
  else if (m.kind === 'video') inner = `<video src="/media/${esc(m.media)}" controls playsinline preload="metadata"></video>`;
  else inner = `<div class="tx">${esc(m.text)}</div>`;

  const showWho = !mine && m.author && m.author.username && prev && prev.user_id !== m.user_id;
  const day = !prev || !sameDay
    ? `<div class="daysep">${new Date(m.created_at * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div>` : '';

  return `${day}
  <div class="msg ${mine ? 'me' : ''}" data-id="${m.id}">
    ${showWho ? `<div class="who" data-prof style="cursor:pointer">@${esc(m.author.username)}</div>` : ''}
    ${inner}
    <div class="tm">${timeHM(m.created_at)}</div>
  </div>`;
}

views.chat = async function (screen, r) {
  if (!requireAuth()) return;
  const id = +r.args[0];
  let chat = Chats.find(id);
  if (!chat) {
    try { chat = await api('/api/chats/' + id); Chats.list.unshift(chat); }
    catch (e) { toast('Чат не найден'); navigate('#/chats'); return; }
  }
  ChatView.chat = chat;
  const isDM = chat.type === 'dm';

  screen.innerHTML = `
  <div class="convo">
    <div class="convo-head">
      <button class="back" data-back>←</button>
      <div data-hava style="flex:none;cursor:pointer">${ava(chat.avatar, 'sm')}</div>
      <div class="info" data-info style="cursor:pointer">
        <div class="n">${esc(chat.title || 'Чат')} ${chat.type === 'channel' ? '📢' : chat.type === 'group' ? '👥' : ''}</div>
        <div class="s">${chat.type === 'channel' ? subs(chat.members_count)
        : chat.type === 'group' ? people(chat.members_count)
          : (chat.peer ? '@' + esc(chat.peer.username) : '')}</div>
      </div>
      <button class="back" data-menu style="font-size:18px">⋯</button>
    </div>
    <div class="msgs" data-msgs></div>
    <div class="typing" data-typing hidden></div>
    <div data-notjoined></div>
    <div class="composer" data-composer>
      <button class="cbtn" data-attach>📎</button>
      <button class="cbtn" data-stickers>😊</button>
      <textarea class="inp" data-input rows="1" placeholder="Сообщение"></textarea>
      <button class="send" data-send>➤</button>
    </div>
  </div>`;

  const el = $('.convo', screen);
  ChatView.el = el;
  const msgsEl = $('[data-msgs]', el);
  const input = $('[data-input]', el);

  $('[data-back]', el).onclick = () => history.length > 1 ? history.back() : navigate('#/chats');

  /* превью чата для тех, кто не внутри */
  if (!chat.joined) {
    $('[data-notjoined]', el).innerHTML = `
      <div class="joined-banner">Вы не в этом чате. Вступите, чтобы читать и писать.</div>`;
    $('[data-composer]', el).hidden = true;
    const b = document.createElement('div');
    b.style.cssText = 'padding:0 12px 16px';
    b.innerHTML = `<button class="btn" data-join>Вступить в ${chat.type === 'channel' ? 'канал' : 'чат'}</button>`;
    $('[data-notjoined]', el).appendChild(b);
    b.querySelector('[data-join]').onclick = async () => {
      try { chat = await api(`/api/chats/${id}/join`, { method: 'POST' }); await Chats.loadList(); render(); }
      catch (e) { }
    };
  } else {
    api(`/api/chats/${id}/read`, { method: 'POST', silent: true });
    api(`/api/chats/${id}/messages`).then(d => {
      ChatView.msgs = [];
      msgsEl.innerHTML = '';
      d.items.forEach((m, i) => {
        ChatView.msgs.push(m);
        msgsEl.insertAdjacentHTML('beforeend', msgHTML(m, ChatView.msgs[i - 1]));
      });
      msgsEl.scrollTop = msgsEl.scrollHeight;
      $$('.msg', msgsEl).forEach((el2, i) => ChatView.bindOne(el2, d.items[i]));
    }).catch(() => { });
  }

  /* удаление сообщения: долгое нажатие / правая кнопка */
  const canDeleteAny = chat.role === 'owner' || chat.role === 'admin';
  let lpTimer = null;
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  const tryDelete = mid => {
    const msg = ChatView.msgs.find(x => x.id === mid);
    if (!msg) return;
    const mineMsg = msg.user_id === App.me.id;
    if (!mineMsg && !canDeleteAny) { toast('Удалять чужие сообщения может владелец или администратор'); return; }
    if (!mineMsg && chat.role !== 'owner' && msg.role && msg.role === 'owner') {
      toast('Нельзя удалить сообщение владельца'); return;
    }
    confirmModal('Удалить сообщение?', async () => {
      try {
        await api(`/api/chats/${id}/messages/${mid}`, { method: 'DELETE' });
        ChatView.remove(mid);
        toast('Сообщение удалено');
      } catch (e) { }
    }, 'Удалить');
  };
  msgsEl.addEventListener('pointerdown', e => {
    const m = e.target.closest('.msg');
    if (!m || !e.isPrimary) return;
    cancelLP();
    lpTimer = setTimeout(() => { lpTimer = null; tryDelete(+m.dataset.id); }, 520);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => msgsEl.addEventListener(ev, cancelLP));
  msgsEl.addEventListener('scroll', cancelLP, { passive: true });
  msgsEl.addEventListener('contextmenu', e => {
    const m = e.target.closest('.msg');
    if (!m) return;
    e.preventDefault();
    cancelLP();
    tryDelete(+m.dataset.id);
  });

  /* меню чата */
  $('[data-menu]', el).onclick = () => chatMenu(chat);
  $('[data-info]', el).onclick = () => chatMenu(chat);
  $('[data-hava]', el).onclick = () => {
    if (isDM && chat.peer) navigate('#/profile/' + chat.peer.username);
    else chatMenu(chat);
  };

  /* отправка */
  const send = async () => {
    const text = input.value.trim();
    if (!text || !chat.can_post) return;
    input.value = ''; input.style.height = 'auto';
    const fd = new FormData();
    fd.append('text', text); fd.append('kind', 'text');
    try {
      const m = await api(`/api/chats/${id}/send`, { method: 'POST', body: fd });
      ChatView.append(m);
      const c = Chats.find(id); if (c) c.last = { id: m.id, text: m.text, kind: m.kind, created_at: m.created_at, user_id: m.user_id };
    } catch (e) { input.value = text; }
  };
  $('[data-send]', el).onclick = send;
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  let lastTyping = 0;
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
    const now = Date.now();
    if (now - lastTyping > 2000 && App.ws && App.ws.readyState === 1 && chat.can_post) {
      lastTyping = now;
      App.ws.send(JSON.stringify({ type: 'typing', chat_id: id }));
    }
  };

  /* вложения */
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*,video/*'; fileInput.hidden = true;
  el.appendChild(fileInput);
  $('[data-attach]', el).onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileInput.value = '';
    if (!chat.can_post) { toast('Публиковать может только владелец или администратор'); return; }
    const fd = new FormData();
    fd.append('text', ''); fd.append('file', f, f.name);
    toast('Отправка…');
    try {
      const m = await api(`/api/chats/${id}/send`, { method: 'POST', body: fd });
      ChatView.append(m);
    } catch (e) { }
  };

  /* стикеры */
  const STICKERS = ['🥔', '😀', '😂', '🥰', '😎', '🤔', '😭', '🔥', '❤️', '👍', '🙏', '🎉',
    '💩', '🤡', '👀', '💀', '🥲', '🙌', '✨', '🌚', '🍕', '☕', '🐸', '🐱'];
  const stickerBox = document.createElement('div');
  stickerBox.className = 'stickers';
  stickerBox.hidden = true;
  stickerBox.innerHTML = STICKERS.map(s => `<button>${s}</button>`).join('');
  el.insertBefore(stickerBox, $('[data-composer]', el));
  $('[data-stickers]', el).onclick = () => { stickerBox.hidden = !stickerBox.hidden; };
  $$('button', stickerBox).forEach(b => b.onclick = async () => {
    if (!chat.can_post) { toast('Писать может только владелец'); return; }
    const fd = new FormData();
    fd.append('text', ''); fd.append('sticker', b.textContent);
    try {
      const m = await api(`/api/chats/${id}/send`, { method: 'POST', body: fd });
      ChatView.append(m);
      stickerBox.hidden = true;
    } catch (e) { }
  });

  if (chat.can_post === false && chat.joined && chat.type === 'channel') {
    $('[data-composer]', el).hidden = false;
    input.placeholder = 'Только владелец публикует посты';
    input.disabled = true;
    $('[data-send]', el).disabled = true;
  }
};

function roleLabel(role) {
  return role === 'owner' ? 'владелец' : role === 'admin' ? 'администратор' : 'участник';
}

function memberActions(chat, u) {
  const isOwner = chat.owner_id === App.me.id;
  const canRole = isOwner && u.role !== 'owner' && u.id !== chat.owner_id;
  const canKick = chat.can_manage && u.id !== App.me.id && u.role !== 'owner'
    && (isOwner || u.role === 'member');
  const s = sheet(u.nickname || u.username, `
    <div class="menu-item" data-prof><span class="ic">👤</span>Открыть профиль @${esc(u.username)}</div>
    <div class="menu-item" style="opacity:.85"><span class="ic">🛡</span>Права: <b style="margin-left:4px">${roleLabel(u.role)}</b></div>
    ${canRole ? (u.role === 'admin'
      ? `<div class="menu-item" data-demote><span class="ic">⬇️</span>Убрать администратора</div>`
      : `<div class="menu-item" data-promote><span class="ic">⭐</span>Сделать администратором</div>`) : ''}
    ${canKick ? `<div class="menu-item danger" data-kick><span class="ic">🚫</span>Удалить из чата</div>` : ''}
    ${u.role === 'admin' && !isOwner
      ? `<div class="inline-note" style="margin:10px 16px">Администраторов назначает и снимает только владелец чата.</div>` : ''}
  `);
  $('[data-prof]', s).onclick = () => { Overlay.close(); navigate('#/profile/' + u.username); };
  const setRole = async role => {
    try {
      await api(`/api/chats/${chat.id}/roles`, { method: 'POST', body: { username: u.username, role } });
      toast(role === 'admin' ? 'Теперь администратор' : 'Права администратора сняты');
      Overlay.close();
      chatMenu(Object.assign({}, chat, {}));
    } catch (e) { }
  };
  const pr = $('[data-promote]', s); pr && (pr.onclick = () => setRole('admin'));
  const dm = $('[data-demote]', s); dm && (dm.onclick = () => setRole('member'));
  const kick = $('[data-kick]', s);
  kick && (kick.onclick = () => {
    confirmModal(`Удалить @${u.username} из чата?`, async () => {
      try {
        const d = await api(`/api/chats/${chat.id}/members/${u.id}`, { method: 'DELETE' });
        chat.members_count = d.members_count;
        toast('Участник удалён');
        Overlay.close();
        chatMenu(Object.assign({}, chat, {}));
      } catch (e) { }
    }, 'Удалить');
  });
}

function chatMenu(chat) {
  const isOwner = chat.owner_id === App.me.id;
  const manage = !!chat.can_manage;
  const body = `
    <div class="row" style="padding:14px 16px;gap:13px;align-items:center">
      <div style="flex:none">${ava(chat.avatar)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:15.5px">${esc(chat.title || 'Чат')}
          ${chat.type === 'channel' ? '📢' : chat.type === 'group' ? '👥' : ''}</div>
        <div class="muted" style="font-size:12.5px">${people(chat.members_count)} · ${roleLabel(chat.role)}</div>
      </div>
      ${manage && chat.type !== 'dm' ? '<button class="btn sm" data-setup>⚙ Настроить</button>' : ''}
    </div>
    ${chat.description ? `<div class="inline-note" style="margin:2px 16px 10px">${esc(chat.description)}</div>` : ''}
    ${chat.type !== 'dm' ? `
      <div class="lbl" style="padding:8px 16px 4px;margin:0">Ссылка-приглашение</div>
      <div style="padding:0 16px 8px">
        <div class="link-box"><span data-link style="flex:1"></span><button class="btn sm ghost" data-copy>Копировать</button></div>
      </div>` : ''}
    ${manage && chat.type !== 'dm' ? `<div class="menu-item" data-add><span class="ic">➕</span>Добавить участника</div>` : ''}
    <div class="lbl" style="padding:8px 16px 4px;margin:0">Участники · ${nfmt(chat.members_count)}</div>
    <div data-members><div class="loader"><div class="spin"></div></div></div>
    ${isOwner && chat.type !== 'dm' ? `<div class="menu-item danger" data-del><span class="ic">🗑</span>Удалить чат навсегда</div>` : ''}
    ${!isOwner && chat.joined && chat.type !== 'dm' ? `<div class="menu-item danger" data-leave><span class="ic">🚪</span>Покинуть чат</div>` : ''}
    ${chat.peer ? `<div class="menu-item" data-prof><span class="ic">👤</span>Открыть профиль @${esc(chat.peer.username)}</div>` : ''}
    ${manage && chat.type !== 'dm' && !isOwner
      ? `<div class="inline-note" style="margin:8px 16px">Вы администратор этого чата: можете менять оформление и участников, но не удалять чат и не трогать других администраторов.</div>` : ''}
  `;
  const s = sheet(chat.title || 'Чат', body);
  const setup = $('[data-setup]', s);
  setup && (setup.onclick = () => { Overlay.close(); navigate('#/chatsettings/' + chat.id); });

  const linkEl = $('[data-link]', s);
  if (linkEl) linkEl.textContent = location.origin + '/#/join/' + chat.link;
  const copy = $('[data-copy]', s);
  copy && (copy.onclick = async () => {
    try { await navigator.clipboard.writeText(location.origin + '/#/join/' + chat.link); toast('Ссылка скопирована'); }
    catch (e) { toast(location.origin + '/#/join/' + chat.link); }
  });

  api(`/api/chats/${chat.id}/members`).then(d => {
    const host = $('[data-members]', s);
    if (!host) return;
    host.innerHTML = d.items.slice(0, 60).map(u => `
      <div class="list-item" data-u="${esc(u.username)}" style="padding:9px 16px;cursor:pointer">
        ${ava(u.avatar, 'sm')}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14.5px">${esc(u.nickname)}
            ${u.id === App.me.id ? '<span class="muted" style="font-weight:400"> (вы)</span>' : ''}</div>
          <div class="muted" style="font-size:12.5px">@${esc(u.username)}</div>
        </div>
        ${u.role === 'owner' ? '<span class="chip adm">владелец</span>'
        : u.role === 'admin' ? '<span class="chip adm">админ</span>' : ''}
        <span style="color:var(--muted);font-size:16px">›</span>
      </div>`).join('') || '<div class="empty">Пока никого</div>';
    const all = d.items;
    $$('[data-u]', host).forEach(el => el.onclick = () => {
      const u = all.find(x => x.username === el.dataset.u);
      if (u) { Overlay.close(); memberActions(chat, u); }
    });
  }).catch(() => {
    const host = $('[data-members]', s);
    if (host) host.innerHTML = '<div class="empty">Нет доступа</div>';
  });

  const prof = $('[data-prof]', s);
  prof && (prof.onclick = () => { Overlay.close(); navigate('#/profile/' + chat.peer.username); });

  const leave = $('[data-leave]', s);
  leave && (leave.onclick = () => {
    confirmModal('Покинуть чат?', async () => {
      await api(`/api/chats/${chat.id}/leave`, { method: 'POST' });
      Overlay.close(); await Chats.loadList(); navigate('#/chats');
    }, 'Выйти');
  });

  const del = $('[data-del]', s);
  del && (del.onclick = () => {
    confirmModal('Удалить чат для всех? Это необратимо.', async () => {
      try {
        await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
        Overlay.close();
        await Chats.loadList();
        navigate('#/chats');
        toast('Чат удалён');
      } catch (e) { }
    }, 'Удалить навсегда');
  });

  const add = $('[data-add]', s);
  add && (add.onclick = () => {
    const m2 = modal(`<h3>Добавить участника</h3>
      <label class="lbl">Юзернейм</label>
      <input class="field" data-u placeholder="username">
      <div class="row" style="margin-top:16px;gap:10px">
        <button class="btn ghost" data-c>Отмена</button>
        <button class="btn" data-ok>Добавить</button></div>`);
    $('[data-c]', m2).onclick = () => Overlay.close();
    $('[data-ok]', m2).onclick = async () => {
      try {
        await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: { username: $('[data-u]', m2).value.trim() } });
        Overlay.close(); toast('Добавлен(а)');
        chatMenu(Object.assign({}, chat, {}));
      } catch (e) { }
    };
  });
}

/* ---------------- настройки группы / канала ---------------- */
views.chatsettings = async function (screen, r) {
  if (!requireAuth()) return;
  const id = +r.args[0];
  const back = () => history.length > 1 ? history.back() : navigate('#/chat/' + id);
  let chat = Chats.find(id);
  if (!chat) {
    try { chat = await api('/api/chats/' + id); }
    catch (e) { navigate('#/chats'); return; }
  }
  if (!chat.can_manage) { toast('Этот чат настраивает владелец или администратор'); back(); return; }
  const isOwner = chat.owner_id === App.me.id;
  const isChannel = chat.type === 'channel';

  screen.innerHTML = `
    <div class="topbar">
      <button class="back" data-back>←</button>
      <h1>Настройки ${isChannel ? 'канала' : 'группы'}</h1>
    </div>
    <div class="page">
      <div class="center">
        <div style="position:relative;width:96px;margin:6px auto 6px">
          <div data-ava>${ava(chat.avatar, 'lg')}</div>
          <label class="back" for="cava"
            style="position:absolute;right:-4px;bottom:0;background:var(--accent);color:#141414;font-size:16px;cursor:pointer">📷</label>
          <input id="cava" type="file" accept="image/*" hidden>
        </div>
        <div class="muted" style="font-size:12.5px">Фото ${isChannel ? 'канала' : 'группы'}</div>
      </div>

      <label class="lbl">Название</label>
      <input class="field" data-title maxlength="60" value="${esc(chat.title)}">

      <label class="lbl">Описание</label>
      <textarea class="field" data-desc maxlength="300" placeholder="${isChannel ? 'О чём канал' : 'О чём группа'}">${esc(chat.description || '')}</textarea>

      <div style="height:18px"></div>
      <button class="btn" data-save>Сохранить</button>

      <div class="divider"></div>
      <label class="lbl" style="margin-top:0">Люди</label>
      <button class="btn ghost" data-members>👥 Управлять участниками и админами</button>

      <div class="link-box" style="margin-top:12px">
        <span data-link style="flex:1"></span><button class="btn sm ghost" data-copy>Копировать</button>
      </div>

      ${isOwner ? `
      <div class="divider"></div>
      <div class="danger-zone">
        <b>Удалить ${isChannel ? 'канал' : 'группу'}</b>
        <p>Сейчас ${people(chat.members_count)}. Чат и вся история исчезнут у всех — отменить нельзя.</p>
        <button class="btn danger" data-del>Удалить навсегда</button>
      </div>` : `
      <div class="inline-note" style="margin-top:16px">
        Вы администратор: можете менять фото, название, описание и участников.
        Удалять чат и менять права администраторов может только владелец.
      </div>`}
      <div style="height:34px"></div>
    </div>`;

  const backBtn = $('[data-back]', screen);
  backBtn && (backBtn.onclick = back);

  const link = $('[data-link]', screen);
  link.textContent = location.origin + '/#/join/' + chat.link;
  $('[data-copy]', screen).onclick = async () => {
    try { await navigator.clipboard.writeText(link.textContent); toast('Ссылка скопирована'); }
    catch (e) { toast(link.textContent); }
  };

  $('#cava', screen).onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      const d = await api(`/api/chats/${id}/avatar`, { method: 'POST', body: fd });
      chat.avatar = d.avatar;
      const i = Chats.list.findIndex(x => x.id === id);
      if (i >= 0) Chats.list[i].avatar = d.avatar;
      $('[data-ava]', screen).innerHTML = ava(d.avatar, 'lg');
      toast('Фото обновлено');
    } catch (err) { }
  };

  $('[data-save]', screen).onclick = async () => {
    try {
      const d = await api(`/api/chats/${id}`, {
        method: 'PATCH',
        body: { title: $('[data-title]', screen).value, description: $('[data-desc]', screen).value }
      });
      const i = Chats.list.findIndex(x => x.id === id);
      if (i >= 0) Chats.list[i] = Object.assign(Chats.list[i], d);
      toast('Сохранено');
      back();
    } catch (e) { }
  };

  $('[data-members]', screen).onclick = () => chatMenu(chat);

  const delBtn = $('[data-del]', screen);
  delBtn && (delBtn.onclick = () => {
    confirmModal('Удалить чат для всех? Это необратимо.', async () => {
      try {
        await api(`/api/chats/${id}`, { method: 'DELETE' });
        await Chats.loadList();
        navigate('#/chats');
        toast('Чат удалён');
      } catch (e) { }
    }, 'Удалить навсегда');
  });
};

/* ---------------- ссылка-приглашение ---------------- */
views.join = async function (screen, r) {
  if (!requireAuth()) return;
  const link = r.args[0];
  try {
    const c = await api('/api/chat-by-link/' + encodeURIComponent(link));
    if (!c.joined) await api(`/api/chats/${c.id}/join`, { method: 'POST' });
    await Chats.loadList();
    navigate('#/chat/' + c.id);
  } catch (e) {
    toast('Ссылка недействительна');
    navigate('#/chats');
  }
};

/* приложение заходит в раздел общения — подтягиваем список */
const _origRender = window.render;
window.render = async function () {
  await _origRender();
  if (App.route.name === 'chats') refreshChatList();
};
