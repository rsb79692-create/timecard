const CACHE_NAME = 'timecard-v7';
// index.html は navigate fetch ハンドラで常に network-first のため除外
const OFFLINE_URLS = [
  '/timecard/manifest.json',
  '/timecard/icon-192-v2.png',
  '/timecard/icon-512-v2.png',
  '/timecard/apple-touch-icon-v2.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(OFFLINE_URLS);
    }).catch(function() {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  // HTML(ナビゲーション)は常にネットワーク取得 — HTTPキャッシュをバイパス
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(new Request(event.request, {cache: 'no-store'}))
        .catch(function() { return caches.match(event.request); })
    );
    return;
  }
  event.respondWith(
    fetch(event.request).catch(function() {
      return caches.match(event.request);
    })
  );
});
