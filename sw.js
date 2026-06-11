const CACHE_NAME = 'timecard-v12';
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

// ===== FCM Push通知ハンドラ =====
// GitHub Actions が data-only メッセージを送信 → raw push イベントで受信
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  var count = parseInt(data.pendingCount || '0', 10);

  if (count > 0 && 'setAppBadge' in self.navigator) {
    self.navigator.setAppBadge(count).catch(function(){});
  }

  var title = '打刻修正申請 ' + count + '件';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: '承認待ちの申請があります。タップして確認してください。',
      icon: '/timecard/icon-192-v2.png',
      badge: '/timecard/icon-192-v2.png',
      data: { url: 'https://rsb79692-create.github.io/timecard/' },
      tag: 'correction-requests'
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url)
    || 'https://rsb79692-create.github.io/timecard/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.includes('/timecard/') && 'focus' in clients[i]) {
          return clients[i].focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })
  );
});
