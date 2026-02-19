const CACHE_NAME = 'soniphorm-soundlab-v31';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './audio-engine.js',
  './waveform.js',
  './slot-manager.js',
  './dsp.js',
  './effects.js',
  './sampler.js',
  './sequencer.js',
  './recorder-worklet.js'
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

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
