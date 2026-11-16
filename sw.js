// Offline support. App files are cached on install.
// Online: network first (so updates arrive). Offline: served from cache.
// The voice model is NOT cached here: the Vosk worker stores it in IndexedDB itself.
const CACHE = 'drill-vi-v12';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'shot-worklet.js',
  'manifest.webmanifest',
  'vendor/vosk.js',
  'audio/drill-2body1head.mp3',
  'audio/shooter-ready.mp3',
  'audio/stand-by.mp3',
  'icons/icon-180.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.url.endsWith('.tar.gz')) return; // model: handled by the Vosk worker

  // Network first, but never wait more than 1.2 s on a bad connection: then use the stored copy
  // (the network answer still updates the store in the background for next time).
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  e.waitUntil(network.catch(() => {}));
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (!cached) return network;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 1200));
    return Promise.race([network.catch(() => cached), timeout]);
  })());
});
