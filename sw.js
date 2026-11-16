// Offline first. The app always runs from the copy stored on the phone, never from the network.
// Updates: when online, the browser notices a new sw.js, downloads ALL files of the new version,
// and only switches when every file arrived (all-or-nothing), so a bad connection can never
// leave a half-updated app. The page then offers "Update ready - tap to restart".
// The voice model is NOT stored here: the Vosk worker keeps it in IndexedDB itself.
const CACHE = 'drill-vi-v13';
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
  // cache: 'reload' skips the browser's HTTP cache so all files belong to the same version.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
  e.respondWith(
    caches.open(CACHE)
      .then((c) => c.match(req, { ignoreSearch: true }))
      .then((hit) => hit || fetch(req)),
  );
});

// The page asks whether every app file is stored ("Offline ready" check).
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'check' || !e.ports[0]) return;
  caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => c.match(f).then((hit) => (hit ? null : f)))))
    .then((res) => e.ports[0].postMessage({ version: CACHE, missing: res.filter(Boolean) }));
});
