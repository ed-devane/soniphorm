const CACHE_NAME = 'soniphorm-sonicraft-v189';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=189',
  './app.js',
  './audio-engine.js',
  './waveform.js',
  './slot-manager.js',
  './dsp.js',
  './effects.js',
  './sampler.js',
  './sequencer.js',
  './recorder-worklet.js',
  './midi.js',
  './dmx.js',
  './rec-controller.js',
  './seq-controller.js',
  './sample-controller.js',
  './jszip.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy: always try the network, fall back to cache offline.
// { cache: 'no-store' } is load-bearing, not decoration -- a plain fetch(e.request)
// still goes through Chrome's own HTTP cache (separate from this SW's Cache Storage
// API above), and the dev server (plain `python -m http.server`, no Cache-Control
// header) leaves Chrome free to apply heuristic freshness off Last-Modified and
// serve straight from disk cache without ever reaching the network. That cache is
// disk-persisted, so it survives page reloads AND full browser restarts -- confirmed
// live (27/07) as the real explanation for repeated "still showing the old version"
// reports today that a reload/restart didn't fix, not a one-off fluke each time.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((response) => {
        // Update cache with fresh response
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
