// Service worker: makes the app installable and keeps a copy of its files on the phone.
// Network first: when online, the latest files are always used (and the saved copy refreshed);
// when offline, the saved copy is used, so the app still opens and Meter mode still works.
// Map tiles, place search, routing and the online rates file are never cached here.
const CACHE = 'tuktuk-rider-v28';

const APP_FILES = [
  './',
  'index.html',
  'admin.html',
  'manifest.webmanifest',
  'config.json',
  'css/style.css',
  'js/settings.js',
  'js/maps.js',
  'js/receipt.js',
  'js/app.js',
  'js/passenger.js',
  'js/admin.js',
  'js/cost.js',
  'js/install.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];
const LIBRARIES = APP_FILES.filter((f) => f.startsWith('https://'));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // one by one, so a single failed file doesn't stop the install
      .then((cache) => Promise.allSettled(APP_FILES.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isAppFile = url.origin === self.location.origin || LIBRARIES.includes(url.href);
  if (!isAppFile) return; // maps, search, routing, rates: straight to the network

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
          .then((hit) => hit || Response.error())
      )
  );
});
