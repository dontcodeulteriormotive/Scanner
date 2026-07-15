/* MacroScan service worker — offline app shell + smart runtime caching.
   Bump CACHE_VERSION whenever the shell files change to force an update. */
const CACHE_VERSION = 'macroscan-v3';
const RUNTIME = 'macroscan-runtime-v1';

/* App shell — cached on install so the app opens with no network.
   Relative paths so it works whether served from a domain root or a
   GitHub Pages project subpath (e.g. /macroscan/). */
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icon.svg',
  'icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION && k !== RUNTIME)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Open Food Facts lookups: always go to the network. The app already
  // shows a friendly message if it can't reach the database offline.
  if (url.hostname.endsWith('openfoodfacts.org')) {
    return; // let the browser handle it normally
  }

  // Navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('index.html').then(r => r || caches.match('./'))
      )
    );
    return;
  }

  // Same-origin static assets: cache-first, then update the cache in the
  // background so the next load gets fresh files.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Cross-origin (Google Fonts, ZXing CDN): stale-while-revalidate so the
  // barcode reader and fonts keep working after the first online load.
  event.respondWith(
    caches.open(RUNTIME).then(cache =>
      cache.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
