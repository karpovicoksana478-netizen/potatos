/* potatos — core: router, api, auth, tabbar, overlays */
const App = {
  token: localStorage.getItem('potatos_token') || '',
  me: null,
  ws: null,
  route: { name: '', args: [], q: {} },
  wsReady: false,
};

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mediaURL(p) {
  p = String(p || '');
  if (!p || /^(https?:|data:|\/)/.test(p)) return p;
  return '/media/' + p;
}

function ava(url, cls = '') {
  if (!url) return `<div class="ava ava-ph ${cls}">🥔</div>`;
  return `<img class="ava ${cls}" src="${esc(mediaURL(url))}" loading="lazy" onerror="App.avaFail(this)">`;
}
App.avaFail = function (img) {
  const cls = img.className;
  img.outerHTML = `<div class="ava ava-ph ${cls}">🥔</div>`;
};

function toast(msg, ms = 2200) {
  const box = $('#toast');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 320); }, ms);
}

function timeHM(ts) {
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function timeAgoShort(ts) {
  const now = new Date(), d = new Date(ts * 1000);
  const sameDay = now.toDateString() === d.toDateString();
  const y = new Date(now.getTime() - 86400000);
  if (sameDay) return timeHM(ts);
  if (y.toDateString() === d.toDateString()) return 'вчера';
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
}
function timeAgo(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'сейчас';
  if (s < 3600) return Math.floor(s / 60) + ' мин';
  if (s < 86400) return Math.floor(s / 3600) + ' ч';
  if (s < 2592000) return Math.floor(s / 86400) + ' дн';
  return Math.floor(s / 2592000) + ' мес';
}
function nfmt(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------- русские числительные ---------------- */
function pluralWord(n, one, few, many) {
  n = Math.abs(parseInt(n, 10) || 0);
  const a = n % 10, b = n % 100;
  if (b >= 11 && b <= 14) return many;
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}
function plural(n, one, few, many) {
  return (parseInt(n, 10) || 0) + ' ' + pluralWord(n, one, few, many);
}
const people = n => plural(n, 'участник', 'участника', 'участников');
const subsWord = n => pluralWord(n, 'подписчик', 'подписчика', 'подписчиков');
const subs = n => plural(n, 'подписчик', 'подписчика', 'подписчиков');

/* ---------------- темы ---------------- */
const Theme = {
  get() {
    const t = localStorage.getItem('potatos_theme');
    return (t === 'light' || t === 'purple') ? t : 'dark';
  },
  set(name) {
    name = (name === 'light' || name === 'purple') ? name : 'dark';
    localStorage.setItem('potatos_theme', name);
    document.documentElement.dataset.theme = name;
  },
  title(t) {
    t = t || this.get();
    return t === 'light' ? 'Светлая' : t === 'purple' ? 'Фиолетовая' : 'Тёмная';
  }
};

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const headers = {};
  if (App.token) headers['Authorization'] = 'Bearer ' + App.token;
  const o = { method: opts.method || 'GET', headers };
  if (opts.body instanceof FormData) {
    o.body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await fetch(path, o); }
  catch (e) { toast('Нет связи с сервером'); throw e; }
  if (res.status === 401 && App.token) { logoutLocal(); throw new Error('401'); }
  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error)) || 'Ошибка ' + res.status;
    if (!opts.silent) toast(typeof msg === 'string' ? msg : 'Ошибка');
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

/* ---------------- auth ---------------- */
function setToken(t) {
  App.token = t;
  localStorage.setItem('potatos_token', t);
}
function logoutLocal() {
  App.token = ''; App.me = null;
  localStorage.removeItem('potatos_token');
  if (App.ws) { try { App.ws.close(); } catch (e) { } App.ws = null; }
}
async function loadMe() {
  if (!App.token) return null;
  try {
    const d = await api('/api/me', { silent: true });
    App.me = d.user; App.meStats = d.stats;
    return App.me;
  } catch (e) { App.me = null; return null; }
}
function requireAuth() {
  if (!App.token || !App.me) { location.hash = '#/auth'; return false; }
  return true;
}

/* ---------------- overlays ---------------- */
const Overlay = {
  current: null,
  open(node, opts = {}) {
    this.close(true);
    const wrap = $('#overlay');
    const back = document.createElement('div');
    back.className = 'backdrop';
    wrap.appendChild(back);
    wrap.appendChild(node);
    requestAnimationFrame(() => { back.classList.add('on'); node.classList.add('on'); });
    back.onclick = () => this.close();
    this.current = { back, node };
    document.body.style.overscrollBehavior = 'contain';
    return this.current;
  },
  close(instant) {
    if (!this.current) return;
    const { back, node } = this.current;
    this.current = null;
    back.classList.remove('on'); node.classList.remove('on');
    const kill = () => { back.remove(); node.remove(); };
    if (instant) kill(); else setTimeout(kill, 240);
    document.body.style.overscrollBehavior = '';
  }
};

function sheet(title, bodyHTML, opts = {}) {
  const n = document.createElement('div');
  n.className = 'sheet';
  n.innerHTML = `<div class="grab"></div>
    <div class="sh-head"><span>${esc(title)}</span><button class="back" style="width:30px;height:30px;font-size:17px" data-x>✕</button></div>
    <div class="sh-body">${bodyHTML}</div>`;
  Overlay.open(n);
  n.querySelector('[data-x]').onclick = () => Overlay.close();
  return n;
}

function modal(html) {
  const n = document.createElement('div');
  n.className = 'modal';
  n.innerHTML = html;
  Overlay.open(n);
  return n;
}

function confirmModal(text, onYes, yesLabel = 'Да') {
  const m = modal(`<h3>${esc(text)}</h3>
    <div class="row" style="margin-top:18px;gap:10px">
      <button class="btn ghost" data-no>Отмена</button>
      <button class="btn" data-yes>${esc(yesLabel)}</button></div>`);
  m.querySelector('[data-no]').onclick = () => Overlay.close();
  m.querySelector('[data-yes]').onclick = () => { Overlay.close(); onYes(); };
}

/* ---------------- router ---------------- */
const views = {};

function parseHash() {
  let h = location.hash.replace(/^#\/?/, '');
  const qi = h.indexOf('?');
  let q = {};
  if (qi >= 0) {
    new URLSearchParams(h.slice(qi + 1)).forEach((v, k) => q[k] = v);
    h = h.slice(0, qi);
  }
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'home', args: parts.slice(1), q };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const TABS = [
  { id: 'home', label: 'Главная', ic: '🏠' },
  { id: 'plus', label: 'Плюс', ic: '+', plus: true },
  { id: 'chats', label: 'Общение', ic: '💬' },
  { id: 'profile', label: 'Профиль', ic: '👤' },
];

function renderTabbar(active) {
  const bar = $('#tabbar');
  bar.hidden = false;
  bar.innerHTML = TABS.map(t => {
    const on = active === t.id ? ' on' : '';
    if (t.plus) return `<button class="tab plus" data-tab="plus"><span class="ic">+</span><span>${t.label}</span></button>`;
    let inner = `<span class="ic">${t.ic}</span>`;
    if (t.id === 'profile' && App.me && App.me.avatar)
      inner = `<img class="ava" src="${esc(mediaURL(App.me.avatar))}" onerror="App.avaFail(this)">`;
    return `<button class="tab${on}" data-tab="${t.id}">${inner}<span>${t.label}</span></button>`;
  }).join('');
  $$('.tab', bar).forEach(b => b.onclick = () => {
    const t = b.dataset.tab;
    if (t === 'profile') navigate(App.me ? '#/profile/' + App.me.username : '#/auth');
    else navigate('#/' + t);
  });
}

function hideTabbar() { $('#tabbar').hidden = true; }

const ASSET_V = '8';

/* Раздел может не загрузиться (старый кэш) — подтягиваем его файл на лету. */
async function ensureView(name) {
  if (views[name]) return true;
  if (!/^[a-z][a-z0-9]*$/.test(name)) return false;
  const key = 'potatos_js_' + name;
  if (sessionStorage.getItem(key)) return !!views[name];
  sessionStorage.setItem(key, '1');
  await new Promise(res => {
    const s = document.createElement('script');
    s.src = `/static/${name}.js?v=${ASSET_V}`;
    s.onload = () => res();
    s.onerror = () => res();
    document.head.appendChild(s);
  });
  return !!views[name];
}

async function render() {
  const r = parseHash();
  App.route = r;
  Overlay.close(true);
  const screen = $('#screen');
  const isChat = r.name === 'auth';
  screen.classList.toggle('no-nav', isChat);

  if (r.name !== 'auth' && !App.token) { location.hash = '#/auth'; return; }
  if (r.name === 'auth') {
    hideTabbar();
    screen.className = '';
    screen.id = 'screen';
    await views.auth(screen);
    return;
  }
  if (!App.me) await loadMe();
  if (!App.me) { location.hash = '#/auth'; return; }

  if (!views[r.name] && r.name !== 'home') await ensureView(r.name);
  if (!views[r.name] && r.name !== 'home') {
    toast('Раздел не загрузился — обновите страницу (F5)');
    navigate('#/home');
    return;
  }

  const view = views[r.name] || views.home;
  screen.scrollTop = 0;
  screen.innerHTML = '';
  const noNav = ['chat'].includes(r.name);
  screen.classList.toggle('no-nav', noNav);
  const activeTab = ['profile', 'settings', 'edit'].includes(r.name) ? 'profile' : r.name;
  if (noNav) hideTabbar(); else renderTabbar(activeTab);
  try { await view(screen, r); }
  catch (e) {
    console.error(e);
    if (e && e.status === 404) { toast('Раздел временно недоступен'); navigate('#/home'); }
  }
}

/* ---------------- websocket ---------------- */
function connectWS() {
  if (!App.token) return;
  if (App.ws && (App.ws.readyState === 0 || App.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(App.token)}`);
  App.ws = ws;
  ws.onopen = () => { App.wsReady = true; };
  ws.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    handleWSEvent(d);
  };
  ws.onclose = () => { App.wsReady = false; App.ws = null; if (App.token) setTimeout(connectWS, 2500); };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}

function handleWSEvent(d) {
  if (window.Chats) Chats.onEvent(d);
}

/* ---------------- auth screen ---------------- */
views.auth = async function (screen) {
  screen.innerHTML = `
  <div class="auth">
    <div class="logo">🥔</div>
    <div class="brand">pota<span>tos</span></div>
    <div class="sub">анонимная соцсеть: видео, чаты, группы и каналы</div>
    <div class="seg">
      <button class="on" data-mode="login">Вход</button>
      <button data-mode="reg">Регистрация</button>
    </div>
    <div data-form>
      <label class="lbl">Юзернейм</label>
      <input class="field" name="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="username">
      <label class="lbl">Пароль</label>
      <input class="field" name="password" type="password" placeholder="••••••••">
      <div data-extra hidden>
        <label class="lbl">Ник (как вас видят)</label>
        <input class="field" name="nickname" maxlength="32" placeholder="Картошка">
      </div>
      <div style="height:20px"></div>
      <button class="btn" data-go>Войти</button>
      <div class="center muted" style="font-size:12.5px;margin-top:16px;line-height:1.5">
        Без почты и телефона. Только юзернейм и пароль.<br>Запомните их — восстановить доступ нельзя.
      </div>
    </div>
  </div>`;

  let mode = 'login';
  const setMode = m => {
    mode = m;
    $$('[data-mode]', screen).forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('[data-extra]', screen).hidden = m !== 'reg';
    $('[data-go]', screen).textContent = m === 'reg' ? 'Создать аккаунт' : 'Войти';
  };
  $$('[data-mode]', screen).forEach(b => b.onclick = () => setMode(b.dataset.mode));

  const go = async () => {
    const f = n => $(`[name=${n}]`, screen).value.trim();
    const body = { username: f('username'), password: f('password'), nickname: f('nickname') };
    if (!body.username || !body.password) { toast('Заполните юзернейм и пароль'); return; }
    if (mode === 'reg' && !body.nickname) { toast('Введите ник'); return; }
    const btn = $('[data-go]', screen);
    btn.disabled = true;
    try {
      const d = await api(mode === 'reg' ? '/api/register' : '/api/login', { method: 'POST', body });
      setToken(d.token);
      App.me = d.user;
      connectWS();
      navigate('#/home');
    } catch (e) { }
    btn.disabled = false;
  };
  $('[data-go]', screen).onclick = go;
  $$('input', screen).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') go(); });
  if (App.token) { await loadMe(); if (App.me) navigate('#/home'); }
};

/* ---------------- boot ---------------- */
window.__errs = [];
window.addEventListener('error', e => {
  window.__errs.push(String(e.message || e.error || e));
});
window.addEventListener('unhandledrejection', e => {
  window.__errs.push('promise: ' + String(e.reason && e.reason.message || e.reason));
});

App.start = async function () {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/static/sw.js').catch(() => { });
  }
  window.addEventListener('hashchange', render);
  await loadMe();
  if (App.me) connectWS();
  render();
  setInterval(() => { if (App.ws && App.ws.readyState === 1) App.ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
};

window.App = App;
window.api = api;
window.$ = $; window.$$ = $$;
window.esc = esc; window.ava = ava; window.toast = toast;
window.Theme = Theme;
window.plural = plural; window.pluralWord = pluralWord;
window.people = people; window.subs = subs; window.subsWord = subsWord;
window.mediaURL = mediaURL;
window.timeHM = timeHM; window.timeAgoShort = timeAgoShort; window.timeAgo = timeAgo;
window.nfmt = nfmt; window.debounce = debounce;
window.Overlay = Overlay; window.sheet = sheet; window.modal = modal;
window.confirmModal = confirmModal;
window.navigate = navigate; window.views = views;
window.requireAuth = requireAuth; window.logoutLocal = logoutLocal;
window.connectWS = connectWS; window.loadMe = loadMe; window.render = render;
window.hideTabbar = hideTabbar; window.renderTabbar = renderTabbar;
