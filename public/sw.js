const CACHE = 'shortping-static-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/icon.svg', '/offline.html'])));
});
self.addEventListener('activate', (event) =>
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
    ]),
  ),
);
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate')
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
});
