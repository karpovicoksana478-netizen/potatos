/* potatos — прямые эфиры: WebRTC mesh + чат
   Камера — 720p@30, съёмка экрана — до 1080p@30. Целевое качество зависит
   от числа зрителей, но стартуем на ступень скромнее и по статистике WebRTC
   (CPU/потери) понижаем профиль, чтобы не было лагов. Звук — моно 64 кбит/с. */
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

/* Профили качества по числу зрителей. Чем их больше, тем меньше нагрузка
   на кодировщик стримера (у каждого зрителя свой RTCPeerConnection).
   Старт — на ступень скромнее целевой, дальше по статистике только понижаем. */
const LIVE_PROFILES = [
  { upTo: 3, label: 'HD 30', height: 720, fps: 30, videoBitrate: 2500000, audioBitrate: 64000 },
  { upTo: 8, label: 'HD 24', height: 540, fps: 24, videoBitrate: 1500000, audioBitrate: 64000 },
  { upTo: 20, label: 'SD 20', height: 480, fps: 20, videoBitrate: 900000, audioBitrate: 48000 },
  { upTo: Infinity, label: 'LD 15', height: 360, fps: 15, videoBitrate: 500000, audioBitrate: 48000 },
];
function liveProfileIndex(viewers) {
  const i = LIVE_PROFILES.findIndex(p => viewers <= p.upTo);
  return i === -1 ? LIVE_PROFILES.length - 1 : i;
}
function liveProfile(viewers) {
  return LIVE_PROFILES[liveProfileIndex(viewers)];
}
function startProfileIndex(viewers) {
  return Math.min(LIVE_PROFILES.length - 1, liveProfileIndex(viewers) + 1);
}

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
  const canScreen = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
  const m = sheet('🔴 Новый эфир', `
    <label class="lbl" style="margin-top:0">Название эфира</label>
    <input class="field" data-title maxlength="80" placeholder="Например: болтаем про картошку">
    <div class="inline-note" style="margin-top:12px">
      Трансляция в реальном времени. Подписчикам придёт уведомление в «Активность».
      Лимит — 3 эфира одновременно.
    </div>
    <div class="live-src">
      <button class="btn danger" data-cam>📷 Эфир с камеры</button>
      ${canScreen ? '<button class="btn ghost" data-screen>🖥 Запись экрана (только ПК)</button>' : ''}
    </div>
    ${canScreen ? '' : '<div class="inline-note" style="margin-top:8px;font-size:12px">🖥 Запись экрана доступна только на компьютере (браузер телефона не поддерживает эту функцию).</div>'}`);
  const input = $('[data-title]', m);
  input.focus();

  async function startLive(mode) {
    const title = input.value.trim();
    let stream = null;
    try {
      if (mode === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
          audio: true,
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
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
      Live.pendingMode = null;
    }
  }
  $('[data-cam]', m).onclick = () => startLive('camera');
  const screenBtn = $('[data-screen]', m); screenBtn && (screenBtn.onclick = () => startLive('screen'));
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); startLive('camera'); } };
}
window.startStreamFlow = startStreamFlow;

/* ---------------- качество отправки (адаптивное) ---------------- */
function applyLiveQuality(pc, viewers, level) {
  const idx = Math.max(0, Math.min(LIVE_PROFILES.length - 1,
    level == null ? startProfileIndex(viewers) : level));
  const prof = LIVE_PROFILES[idx];
  const screen = !!(Live.room && Live.room.mode === 'screen');
  // текст на экране требует больше бит, чем камера
  const videoBitrate = Math.round(prof.videoBitrate * (screen ? 1.25 : 1));
  const track = pc.getSenders().map(s => s.track).find(t => t && t.kind === 'video');
  const srcH = (track && track.getSettings && track.getSettings().height) || 720;
  const scale = Math.max(1, srcH / prof.height);  // даунскейл, если источник больше
  pc.getSenders().forEach(s => {
    if (!s.track) return;
    const p = s.getParameters();
    if (s.track.kind === 'video') {
      p.encodings = [{
        maxBitrate: videoBitrate,
        maxFramerate: prof.fps,
        scaleResolutionDownBy: scale,
        priority: 'high',
      }];
      // при нехватке ресурсов уменьшаем кадр, но сохраняем плавность
      p.degradationPreference = 'maintain-framerate';
    } else if (s.track.kind === 'audio') {
      p.encodings = [{ maxBitrate: prof.audioBitrate, priority: 'high' }];
    }
    s.setParameters(p).catch(() => { });
  });
  return prof;
}

function currentQualityLabel() {
  const pcs = Object.values((Live.room && Live.room.pcs) || {});
  const level = pcs.length
    ? Math.max(...pcs.map(pc => pc.qLevel || 0))
    : startProfileIndex(Live.room ? Live.room.viewers || 0 : 0);
  return LIVE_PROFILES[Math.max(0, Math.min(LIVE_PROFILES.length - 1, level))].label;
}

function updateLiveQualityLabel() {
  const el = Live.room && Live.room.qualityEl;
  if (el) el.textContent = currentQualityLabel();
}

function retuneLiveQuality(viewers) {
  const target = liveProfileIndex(viewers);
  Object.values((Live.room && Live.room.pcs) || {}).forEach(pc => {
    if (pc.qLevel == null) pc.qLevel = startProfileIndex(viewers);
    if (pc.qLevel < target) pc.qLevel = target;   // зрителей стало больше — не перегружаем стримера
    applyLiveQuality(pc, viewers, pc.qLevel);
  });
  return liveProfile(viewers);
}

/* Следим за статистикой кодировщика: если Chrome говорит про CPU/losses —
   понижаем ступень. Это дешевле, чем держать 720p на слабом телефоне. */
async function monitorLivePc(pc) {
  if (!pc || pc.connectionState !== 'connected') return;
  let stats;
  try { stats = await pc.getStats(); } catch (e) { return; }
  let video = null;
  stats.forEach(s => {
    if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) video = s;
  });
  if (!video) return;
  const prev = pc.qPrev || { encoded: 0, dropped: 0 };
  const encoded = video.framesEncoded || 0;
  const dropped = video.framesDropped || 0;
  const dEnc = encoded - prev.encoded;
  const dDrop = dropped - prev.dropped;
  pc.qPrev = { encoded, dropped };
  if (dEnc <= 0) return;
  const reason = video.qualityLimitationReason || 'none';
  const dropRatio = dDrop / dEnc;
  const limited = reason === 'cpu' || dropRatio > 0.08 || (reason === 'bandwidth' && dropRatio > 0.02);
  pc.qLimited = limited ? (pc.qLimited || 0) + 1 : 0;
  if (pc.qLimited >= 2 && pc.qLevel < LIVE_PROFILES.length - 1) {
    pc.qLimited = 0;
    pc.qLevel += 1;
    applyLiveQuality(pc, Live.room ? Live.room.viewers || 0 : 0, pc.qLevel);
    updateLiveQualityLabel();
  }
}

/* ICE-кандидаты могут прийти раньше remoteDescription — копим и применяем позже */
async function flushLiveIce(pc) {
  const list = pc.pendingIce || [];
  pc.pendingIce = [];
  for (const cand of list) {
    try { await pc.addIceCandidate(cand); } catch (e) { }
  }
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
  Live.room = { sid, isBroadcaster, pcs: {}, localStream: null, remotePc: null,
                leaving: false, viewers: info.viewers || 0 };

  screen.innerHTML = `
  <div class="live-room">
    <div class="live-head">
      <button class="back" data-back>←</button>
      <div class="live-head-t">
        <div class="live-head-title">${esc(info.title)}</div>
        <div class="live-head-sub"><span class="live-badge">● LIVE</span> <span data-quality>${liveProfile(info.viewers || 0).label}</span> · 👁 <span data-viewers>${nfmt(info.viewers)}</span> · ❤ <span data-likes>${nfmt(info.likes || 0)}</span> · @${esc(info.user.username)}</div>
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
  Live.room.qualityEl = $('[data-quality]', screen);

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
      Live.room.mode = Live.pendingMode || 'camera';
      Live.pendingStream = null;
      Live.pendingMode = null;
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
        });
      } catch (e) {
        toast('Камера недоступна: разрешите доступ в браузере');
        await api('/api/live/end', { method: 'POST', body: { id: sid }, silent: true }).catch(() => { });
        navigate('#/home?tab=live');
        return;
      }
    }
    Live.room.mode = Live.room.mode || 'camera';
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
    pc.pendingIce = [];
    Live.room.pcs[viewerId] = pc;
    Live.room.localStream.getTracks().forEach(t => pc.addTrack(t, Live.room.localStream));
    pc.qLevel = startProfileIndex(Live.room.viewers || 0);
    pc.qLimited = 0;
    pc.qPrev = null;
    applyLiveQuality(pc, Live.room.viewers || 0, pc.qLevel);
    pc.qTimer = setInterval(() => monitorLivePc(pc), 2000);
    pc.onicecandidate = e => { if (e.candidate) liveSend({ type: 'live-ice', sid, to: viewerId, cand: e.candidate }); };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { clearTimeout(pc.downTimer); pc.downTimer = null; pc.retried = false; return; }
      if (st === 'closed') { clearInterval(pc.qTimer); delete Live.room.pcs[viewerId]; return; }
      if (st === 'failed' || st === 'disconnected') {
        if (pc.downTimer) return;
        pc.downTimer = setTimeout(() => {
          pc.downTimer = null;
          if (pc.connectionState === 'connected') return;
          if (!pc.retried) {                       // первая попытка — пересобираем ICE
            pc.retried = true;
            try { pc.restartIce(); } catch (e) { }
            return;
          }
          clearInterval(pc.qTimer);
          try { pc.close(); } catch (e) { }        // не помогло — убираем мёртвого зрителя
          delete Live.room.pcs[viewerId];
        }, st === 'failed' ? 1500 : 6000);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    liveSend({ type: 'live-offer', sid, to: viewerId, sdp: pc.localDescription });
  }

  // --- зритель ---
  async function setupViewer() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.pendingIce = [];
    Live.room.remotePc = pc;
    pc.ontrack = e => {
      video.srcObject = e.streams[0];
      wait.hidden = true;
      video.play().catch(() => { });   // авто.play с звуком иногда блокируется
    };
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
    await flushLiveIce(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    liveSend({ type: 'live-answer', sid, to: from, sdp: pc.localDescription });
  };
  Live.room.onAnswer = async (from, sdp) => {
    const pc = Live.room.pcs[from];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushLiveIce(pc);
    }
  };
  Live.room.onIce = async (from, cand) => {
    const pc = Live.room.pcs[from] || Live.room.remotePc;
    if (!pc) return;
    try {
      if (!pc.remoteDescription) {
        (pc.pendingIce || (pc.pendingIce = [])).push(new RTCIceCandidate(cand));
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) { }
  };
  Live.room.onPeer = from => { offerTo(from).catch(e => console.error(e)); };
  Live.room.onPeerLeft = from => {
    const pc = Live.room.pcs[from];
    if (pc) {
      clearTimeout(pc.downTimer);
      clearInterval(pc.qTimer);
      try { pc.close(); } catch (e) { }
      delete Live.room.pcs[from];
    }
  };
  Live.room.onViewers = n => {
    Live.room.viewers = n;
    const el = $('[data-viewers]', screen);
    if (el) el.textContent = nfmt(n);
    retuneLiveQuality(n);
    updateLiveQualityLabel();
  };
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
  Object.values(r.pcs || {}).forEach(pc => {
    clearTimeout(pc.downTimer);
    clearInterval(pc.qTimer);
    try { pc.close(); } catch (e) { }
  });
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
