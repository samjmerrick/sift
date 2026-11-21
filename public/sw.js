// App-shell cache so Sift opens instantly (and offline). Data requests always go to the network.
const CACHE = 'sift-v10';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'vendor/supabase-js-2.118.0.js',
  'lib/balance.js', 'lib/csv.js', 'lib/data.js', 'lib/feed.js', 'lib/generators.js', 'lib/packs.js', 'lib/rank.js', 'lib/sanitise.js', 'lib/source-kinds.js', 'lib/theory.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only same-origin app files — never Supabase API calls.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first, falling back to cache: you always get the latest version when online.
  e.respondWith(
    // cache: 'no-cache' revalidates with the server every time, so a new deploy shows up immediately.
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./'))),
  );
});
