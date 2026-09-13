const CACHE_PREFIX = 'shrutibox-';
const CACHE_NAME = CACHE_PREFIX + 'v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// Install — cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Refresh pages online; keep assets available offline within this app's cache.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const navigation = request.mode === 'navigate';
    if (!navigation) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok) {
        // Await persistence so the worker stays alive, without hiding usable responses
        // if storage is full or disabled.
        try { await cache.put(request, response.clone()); } catch (error) {}
      }
      return response;
    } catch (error) {
      if (navigation) {
        const cached = await cache.match(request) || await cache.match('./index.html');
        if (cached) return cached;
      }
      throw error;
    }
  })());
});
