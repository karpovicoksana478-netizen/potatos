const CACHE = 'potatos-v3';
const ASSETS = [
  '/', '/static/style.css', '/static/app.js', '/static/feed.js',
  '/static/chats.js', '/static/profile.js', '/static/icon-192.png',
  '/static/manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/media') || url.pathname.startsWith('/ws'))
    return;

  // сначала сеть (чтобы обновления подхватывались сразу), офлайн — из кэша
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(cached => cached || (e.request.mode === 'navigate' ? caches.match('/') : null))
        .then(r => r || Response.error())
    )
  );
});
