// App-shell cache so Sift opens instantly (and offline). Data requests always go to the network.
const CACHE = 'sift-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg',
  'lib/csv.js', 'lib/data.js', 'lib/feed.js', 'lib/generators.js', 'lib/source-kinds.js', 'lib/theory.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only same-origin app files (and the pinned supabase-js build) — never Supabase API calls.
  const isApp = url.origin === location.origin;
  const isLib = url.hostname === 'cdn.jsdelivr.net';
  if (e.request.method !== 'GET' || !(isApp || isLib)) return;
  // Network first, falling back to cache: you always get the latest version when online.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./'))),
  );
});
