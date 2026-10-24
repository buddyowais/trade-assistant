/* Offline shell: app files + chart library are cached; market/AI API calls always go to the network. */
const CACHE = 'ta-v1';
const SHELL = ['./', 'index.html', 'style.css', 'indicators.js', 'analysis.js', 'data.js', 'journal.js', 'ai.js', 'app.js', 'manifest.webmanifest', 'icon-192.png'];
const CDN = 'https://unpkg.com/lightweight-charts@4.2.0/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !req.url.startsWith(CDN)) return; // never cache API traffic
  // network first for our own files (so updates show up), fall back to cache offline
  if (sameOrigin) {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
  }
});
