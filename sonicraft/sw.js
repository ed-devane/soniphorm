const CACHE_NAME = 'soniphorm-sonicraft-v150';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=150',
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
  './gen.js',
  './rec-controller.js',
  './seq-controller.js',
  './sample-controller.js',
  './gen-controller.js',
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

// Network-first strategy: always try the network, fall back to cache offline
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // Update cache with fresh response
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
