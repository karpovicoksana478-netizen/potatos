const CACHE = 'potatos-v12';
const ASSETS = [
  '/', '/static/style.css', '/static/app.js', '/static/feed.js',
  '/static/chats.js', '/static/profile.js',
  '/static/icon-192.png', '/static/manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// страница быстрее открывается из кэша, фоном обновляется
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}

// картинки (аватарки, превью) — из кэша сразу, без ожидания сети
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) {
    fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => { });
    return cached;
  }
  const res = await fetch(req);
  if (res && res.ok) {
    const len = +(res.headers.get('content-length') || 0);
    const type = res.headers.get('content-type') || '';
    if (len && len < 3 * 1024 * 1024 && type.startsWith('image/'))
      cache.put(req, res.clone());
  }
  return res;
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#/home';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); if ('navigate' in c) c.navigate(url); return; }
      }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); }
  catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '🥔 potatos', {
    body: d.body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    tag: d.tag || 'potatos',
    renotify: true,
    data: { url: d.url || '/#/home' }
  }));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (req.headers.get('range')) return;      // видео/аудио потоком — не перехватываем

  if (url.pathname.startsWith('/static/')) {
    e.respondWith(staleWhileRevalidate(req));
  } else if (url.pathname.startsWith('/media/')) {
    e.respondWith(cacheFirst(req).catch(() => Response.error()));
  } else {
    // страницы/сам шелл: сначала сеть (всегда свежий код), офлайн — из кэша
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() =>
        caches.match(req).then(c => c || (req.mode === 'navigate' ? caches.match('/') : null))
          .then(r => r || Response.error()))
    );
  }
});
