/* potatos — прямые эфиры: WebRTC mesh + чат
   Трафик держим низким: 360p@12fps, ~300 кбит/с видео, моно-звук ~32 кбит/с. */
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

const Live = {
  room: null,        // { sid, isBroadcaster, localStream, pcs: {uid: pc}, remotePc, leaving }
  pollTimer: null,
  pendingStream: null,   // поток (камера/экран), захваченный до старта эфира
  pendingMode: null,     // 'camera' | 'screen'
};

function liveSend(obj) {
  if (App.ws && App.ws.readyState === 1) App.ws.send(JSON.stringify(obj));
}

/* ---------------- общий кусок: верхние вкладки как в ленте ---------------- */
function feedTopHTML(tab) {
  return `<div class="feed-top" data-top style="display:flex">
    <span class="t ${tab === 'all' ? 'on' : ''}" data-goto="all">Главная</span>
    <span class="t ${tab === 'following' ? 'on' : ''}" data-goto="following">Подписки</span>
    <span class="t ${tab === 'live' ? 'on' : ''}" data-goto="live">Эфиры</span>
  </div>
  <button class="icon-btn feed-search" data-vsearch title="Поиск видео">🔍</button>`;
}
function bindFeedTop(root) {
  $$('[data-goto]', root).forEach(el => el.onclick = () => {
    const t = el.dataset.goto;
    navigate(t === 'all' ? '#/home' : '#/home?tab=' + t);
  });
  const vs = $('[data-vsearch]', root);
  vs && (vs.onclick = () => { if (window.openVideoSearch) openVideoSearch(); });
}

/* ---------------- список активных эфиров (вкладка «Эфиры») ---------------- */
Live.list = async function (host, tab) {
  host.innerHTML = `<div class="live-tab">
    ${feedTopHTML(tab)}
    <div class="live-scroll">
      <div class="live-start-row"><button class="btn danger" data-golive style="width:100%">🔴 Начать прямой эфир</button></div>
      <div data-list><div class="loader"><div class="spin"></div></div></div>
      <div style="height:30px"></div>
    </div>
  </div>`;
  bindFeedTop(host);

  $('[data-golive]', host).onclick = () => startStreamFlow();

  const paint = async () => {
    const box = $('[data-list]', host);
    if (!box) return;
    let d;
    try { d = await api('/api/live', { silent: true }); } catch (e) {
      box.innerHTML = '<div class="grid-empty">Не удалось загрузить эфиры</div>';
      return;
    }
    if (!d.items.length) {
      box.innerHTML = `<div class="feed-empty" style="position:static;padding:60px 20px">
        <div style="font-size:52px">📡</div>
        <div style="font-size:17px;font-weight:700;color:#fff">Пока никто не в эфире</div>
        <div>Станьте первым — начните прямой эфир</div>
      </div>`;
      return;
    }
    box.innerHTML = d.items.map(l => `
      <div class="live-card" data-id="${l.id}">
        <div class="live-ava">${ava(l.user && l.user.avatar, 'sm')}</div>
        <div class="live-main">
          <div class="live-title">${esc(l.title)}</div>
          <div class="live-meta"><span class="live-badge">● LIVE</span>
            @${esc(l.user && l.user.username || '?')} · 👁 ${nfmt(l.viewers)} · ❤ ${nfmt(l.likes || 0)}</div>
        </div>
        <button class="btn sm" data-watch>Смотреть</button>
      </div>`).join('');
    $$('.live-card', box).forEach(card => {
      const id = +card.dataset.id;
      $('[data-watch]', card).onclick = () => navigate('#/live/' + id);
      card.onclick = e => { if (!e.target.closest('button')) navigate('#/live/' + id); };
    });
  };
  await paint();
  Live.pollTimer = setInterval(() => {
    if (!document.body.contains(host)) { clearInterval(Live.pollTimer); return; }
    paint();
  }, 8000);
};

function startStreamFlow() {
  const m = sheet('🔴 Новый эфир', `
    <label class="lbl" style="margin-top:0">Название эфира</label>
    <input class="field" data-title maxlength="80" placeholder="Например: болтаем про картошку">
    <div class="inline-note" style="margin-top:12px">
      Трансляция в реальном времени. Подписчикам придёт уведомление в «Активность».
      Лимит — 3 эфира одновременно.
    </div>
    <div class="live-src">
      <button class="btn danger" data-cam>📷 Эфир с камеры</button>
      <button class="btn ghost" data-screen>🖥 Запись экрана</button>
    </div>`);
  const input = $('[data-title]', m);
  input.focus();

  async function startLive(mode) {
    const title = input.value.trim();
    let stream = null;
    try {
      if (mode === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
          audio: true,
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 12, max: 15 }, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
      }
    } catch (e) {
      toast(mode === 'screen' ? 'Выбор экрана отменён' : 'Камера недоступна: разрешите доступ в браузере');
      return;
    }
    Live.pendingStream = stream;
    Live.pendingMode = mode;
    try {
      const d = await api('/api/live/start', { method: 'POST', body: { title } });
      Overlay.close();
      navigate('#/live/' + d.id);
    } catch (e) {
      stream.getTracks().forEach(t => t.stop());
      Live.pendingStream = null;
    }
  }
  $('[data-cam]', m).onclick = () => startLive('camera');
  $('[data-screen]', m).onclick = () => startLive('screen');
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); startLive('camera'); } };
}
window.startStreamFlow = startStreamFlow;

/* ---------------- низкозатратная настройка трека ---------------- */
function lowBandwidth(pc) {
  pc.getSenders().forEach(s => {
    if (!s.track) return;
    const p = s.getParameters();
    if (s.track.kind === 'video') {
      p.encodings = [{ maxBitrate: 300000, maxFramerate: 12 }];
      p.degradationPreference = 'maintain-framerate';
    } else if (s.track.kind === 'audio') {
      p.encodings = [{ maxBitrate: 32000 }];
    }
    s.setParameters(p).catch(() => { });
  });
}

/* ---------------- комната эфира ---------------- */
async function renderRoom(screen, sid) {
  if (!requireAuth()) return;
  screen.innerHTML = '<div class="loader"><div class="spin"></div></div>';
  let info;
  try { info = await api('/api/live/' + sid, { silent: true }); }
  catch (e) { toast('Эфир не найден или уже закончился'); navigate('#/home?tab=live'); return; }

  const me = App.me;
  const isBroadcaster = me && info.user && me.id === info.user.id;
  Live.room = { sid, isBroadcaster, pcs: {}, localStream: null, remotePc: null, leaving: false };

  screen.innerHTML = `
  <div class="live-room">
    <div class="live-head">
      <button class="back" data-back>←</button>
      <div class="live-head-t">
        <div class="live-head-title">${esc(info.title)}</div>
        <div class="live-head-sub"><span class="live-badge">● LIVE</span> 👁 <span data-viewers>${nfmt(info.viewers)}</span> · ❤ <span data-likes>${nfmt(info.likes || 0)}</span> · @${esc(info.user.username)}</div>
      </div>
      ${isBroadcaster ? '<button class="back mic-toggle" data-mic title="Выключить микрофон">🎤</button><button class="btn sm danger" data-end>■ Завершить</button>' : ''}
    </div>
    <div class="live-stage">
      <video data-video ${isBroadcaster ? 'muted autoplay playsinline' : 'autoplay playsinline'}></video>
      <div class="live-waiting" data-wait>${isBroadcaster ? 'Запускаем камеру…' : 'Подключаемся к эфиру…'}</div>
      <button class="like-fab" data-like aria-label="Нравится">❤</button>
      <div class="hearts" data-hearts></div>
    </div>
    <div class="live-chat" data-chat>
      <div class="live-chat-msgs" data-msgs></div>
      <div class="live-input">
        <input data-chat-input maxlength="300" placeholder="Чат эфира…" autocomplete="off">
        <button class="csend" data-chat-send>➤</button>
      </div>
    </div>
  </div>`;

  const video = $('[data-video]', screen);
  const wait = $('[data-wait]', screen);
  const msgs = $('[data-msgs]', screen);
  const chatInput = $('[data-chat-input]', screen);
  const likesEl = $('[data-likes]', screen);
  const heartsBox = $('[data-hearts]', screen);
  const likeBtn = $('[data-like]', screen);
  Live.room.likes = info.likes || 0;

  function paintLikes(n) {
    Live.room.likes = n;
    if (likesEl) likesEl.textContent = nfmt(n);
  }
  function burstHearts(n) {
    if (!heartsBox) return;
    for (let i = 0; i < (n || 3); i++) {
      const h = document.createElement('span');
      h.className = 'heart-particle';
      h.textContent = '❤';
      h.style.left = (55 + Math.random() * 35) + '%';
      h.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
      h.style.animationDelay = (Math.random() * 0.25) + 's';
      heartsBox.appendChild(h);
      setTimeout(() => h.remove(), 1600);
    }
  }
  Live.room.onLike = likes => { paintLikes(likes); burstHearts(1); };
  likeBtn.onclick = () => {
    burstHearts(3);
    api(`/api/live/${sid}/like`, { method: 'POST', silent: true })
      .then(d => paintLikes(d.likes))
      .catch(() => { });
  };

  const micBtn = $('[data-mic]', screen);
  if (micBtn) {
    Live.room.micOn = true;
    micBtn.onclick = () => {
      const on = !Live.room.micOn;
      Live.room.micOn = on;
      Live.room.localStream.getAudioTracks().forEach(t => t.enabled = on);
      micBtn.textContent = on ? '🎤' : '🔇';
      micBtn.title = on ? 'Выключить микрофон' : 'Включить микрофон';
      toast(on ? 'Микрофон включён' : 'Микрофон выключен');
    };
  }

  function addMsg(m) {
    const who = m.uid === (me && me.id) ? 'Вы' : '@' + esc(m.username || '?');
    msgs.insertAdjacentHTML('beforeend', `<div class="live-msg ${m.uid === (me && me.id) ? 'me' : ''}">
      <b>${who}</b> ${esc(m.text)}</div>`);
    msgs.scrollTop = msgs.scrollHeight;
  }
  Live.room.addMsg = addMsg;

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    liveSend({ type: 'live-chat', sid, text });
    chatInput.value = '';
  }
  $('[data-chat-send]', screen).onclick = sendChat;
  chatInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } };

  $('[data-back]', screen).onclick = () => { leaveRoom(); navigate('#/home?tab=live'); };

  // --- широко вещательный (стример) ---
  async function setupBroadcaster() {
    let stream;
    if (Live.pendingStream) {
      stream = Live.pendingStream;
      Live.pendingStream = null;
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 12, max: 15 }, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
      } catch (e) {
        toast('Камера недоступна: разрешите доступ в браузере');
        await api('/api/live/end', { method: 'POST', body: { id: sid }, silent: true }).catch(() => { });
        navigate('#/home?tab=live');
        return;
      }
    }
    // если аудио ещё нет (экран без системного звука) — просим доступ к микрофону отдельно
    if (!stream.getAudioTracks().length) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
        mic.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (e) {
        toast('Микрофон выключен — эфир без звука');
      }
    }
    // если зритель сам «выключит» демонстрацию экрана — завершим эфир
    stream.getTracks().forEach(t => t.addEventListener('ended', () => {
      api('/api/live/end', { method: 'POST', body: { id: sid }, silent: true }).catch(() => { });
      cleanupRoom();
      navigate('#/home?tab=live');
    }));
    Live.room.localStream = stream;
    video.srcObject = stream;
    wait.hidden = true;
    liveSend({ type: 'live-join', sid });
  }

  // offer создаётся для каждого зрителя, когда сервер скажет «он в комнате»
  async function offerTo(viewerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    Live.room.pcs[viewerId] = pc;
    Live.room.localStream.getTracks().forEach(t => pc.addTrack(t, Live.room.localStream));
    lowBandwidth(pc);
    pc.onicecandidate = e => { if (e.candidate) liveSend({ type: 'live-ice', sid, to: viewerId, cand: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        try { pc.close(); } catch (e) { }
        delete Live.room.pcs[viewerId];
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    liveSend({ type: 'live-offer', sid, to: viewerId, sdp: pc.localDescription });
  }

  // --- зритель ---
  async function setupViewer() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    Live.room.remotePc = pc;
    pc.ontrack = e => { video.srcObject = e.streams[0]; wait.hidden = true; };
    pc.onicecandidate = e => { if (e.candidate) liveSend({ type: 'live-ice', sid, to: info.user.id, cand: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.restartIce && pc.restartIce();
      }
    };
    // зритель ничего не отправляет, но добавляем recvonly-трансиверы
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    liveSend({ type: 'live-join', sid });
    // fallback: если поток не появился за 15 сек — сообщим
    setTimeout(() => { if (!video.srcObject && !Live.room.leaving) wait.textContent = 'Ожидаем стрим… (проверьте, идёт ли эфир)'; }, 15000);
  }

  // события сервера — через LiveRoom.onEvent
  Live.room.onOffer = async (from, sdp) => {
    const pc = Live.room.remotePc;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    liveSend({ type: 'live-answer', sid, to: from, sdp: pc.localDescription });
  };
  Live.room.onAnswer = async (from, sdp) => {
    const pc = Live.room.pcs[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  };
  Live.room.onIce = async (from, cand) => {
    const pc = Live.room.pcs[from] || Live.room.remotePc;
    if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { } }
  };
  Live.room.onPeer = from => { offerTo(from).catch(e => console.error(e)); };
  Live.room.onPeerLeft = from => {
    const pc = Live.room.pcs[from];
    if (pc) { try { pc.close(); } catch (e) { } delete Live.room.pcs[from]; }
  };
  Live.room.onViewers = n => { const el = $('[data-viewers]', screen); if (el) el.textContent = nfmt(n); };
  Live.room.onEnd = () => {
    toast('Эфир завершён');
    cleanupRoom();
    navigate('#/home?tab=live');
  };
  Live.room.onChat = addMsg;
  Live.room.onFull = () => { toast('Зал полон — мест нет'); cleanupRoom(); navigate('#/home?tab=live'); };
  Live.room.onError = msg => { toast(msg || 'Ошибка эфира'); cleanupRoom(); navigate('#/home?tab=live'); };

  const endBtn = $('[data-end]', screen);
  if (endBtn) endBtn.onclick = () => confirmModal('Завершить эфир для всех?', async () => {
    try { await api('/api/live/end', { method: 'POST', body: { id: sid } }); } catch (e) { }
    cleanupRoom();
    navigate('#/home?tab=live');
  }, 'Завершить');

  if (isBroadcaster) await setupBroadcaster();
  else await setupViewer();
}

function cleanupRoom() {
  const r = Live.room;
  if (!r) return;
  r.leaving = true;
  try { liveSend({ type: 'live-leave', sid: r.sid }); } catch (e) { }
  Object.values(r.pcs || {}).forEach(pc => { try { pc.close(); } catch (e) { } });
  if (r.remotePc) { try { r.remotePc.close(); } catch (e) { } }
  if (r.localStream) r.localStream.getTracks().forEach(t => t.stop());
  Live.room = null;
}
function leaveRoom() { cleanupRoom(); }

/* маршрутизация событий от сервера (из app.js handleWSEvent) */
window.LiveRoom = {
  onEvent(d) {
    const r = Live.room;
    if (!r || d.sid !== r.sid) return;
    switch (d.type) {
      case 'live-peer': r.onPeer && r.onPeer(d.from); break;
      case 'live-peer-left': r.onPeerLeft && r.onPeerLeft(d.from); break;
      case 'live-offer': r.onOffer && r.onOffer(d.from, d.sdp); break;
      case 'live-answer': r.onAnswer && r.onAnswer(d.from, d.sdp); break;
      case 'live-ice': r.onIce && r.onIce(d.from, d.cand); break;
      case 'live-like': r.onLike && r.onLike(d.likes); break;
      case 'live-viewers': r.onViewers && r.onViewers(d.viewers); break;
      case 'live-chat': r.onChat && r.onChat(d); break;
      case 'live-end': r.onEnd && r.onEnd(); break;
      case 'live-full': r.onFull && r.onFull(); break;
      case 'live-error': r.onError && r.onError(d.detail); break;
    }
  },
};

window.Live = Live;
window.cleanupLive = cleanupRoom;

views.live = async function (screen, r) {
  const sid = +((r.args && r.args[0]) || 0);
  if (sid) return renderRoom(screen, sid);
  return Live.list(screen, 'live');
};

/* выход из эфира при уходе со страницы */
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/live')) leaveRoom();
});
