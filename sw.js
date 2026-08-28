// ===== キャッシュ版 =====
// ★ sw.js を変更したら必ず CACHE_NAME を上げる。activate で旧キャッシュを全削除するため、
//   これが「配信済みの古い app shell を確実に捨てる」唯一の安全弁になる。
const CACHE_NAME = 'timecard-v13';

// app shell（index.html）のキャッシュキー。
// ★ クエリ付き（?admin= / ?token= 等）でも必ずこの1つのキーへ正規化する。
//   GitHub Pages はクエリを無視して同じ index.html を返すため、クエリごとに別エントリを
//   作るとキャッシュが増殖し、更新時に取り残しが出る。
const SHELL_PATH = '/timecard/';
const SHELL_URL = new URL(SHELL_PATH, self.location.origin).href;

// app shell 以外の静的アセット（オフライン起動用）
const OFFLINE_URLS = [
  '/timecard/manifest.json',
  '/timecard/icon-192-v2.png',
  '/timecard/icon-512-v2.png',
  '/timecard/apple-touch-icon-v2.png'
];

// ===== キャッシュしてよいもの／絶対にキャッシュしないもの =====
// ★ Cache Storage へ入れるのは「配信物」だけである。
//   Firebase Realtime Database（勤怠データ）・Identity Toolkit（認証）・/api/*（通知・移動距離）は
//   個人情報と認証情報そのものなので、fetch ハンドラで cache.put を一切呼ばない。
//   実装上は「app shell と OFFLINE_URLS 以外へは cache.put しない」ホワイトリスト方式にしてある
//   （除外リスト方式にすると、新しい API を足したときに黙って漏れる）。
function isShellRequest(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.origin !== self.location.origin) return false;
  return u.pathname === SHELL_PATH || u.pathname === SHELL_PATH + 'index.html';
}

// ★ GitHub Pages は同じ内容でも Accept-Encoding によって ETag の弱い印（W/）が付き外れする
//   （2026-08-28 実測: gzip なら W/"…"、identity なら "…"）。印の有無で「更新された」と
//   誤検知しないよう、比較の前に必ず取り除く。
function normVersion(v) { return String(v || '').replace(/^W\//, ''); }
function shellVersionOf(res) {
  if (!res) return '';
  return normVersion(res.headers.get('ETag') || res.headers.get('Last-Modified') || '');
}
// 「最後に画面へ返した版」。★ 通知を取りこぼしたタブが二度と更新に気づけなくなるのを防ぐ。
//   キャッシュを入れ替えたあとに再確認しても、比較相手がキャッシュ（＝すでに新版）だと
//   差が無いことになってしまう。実際に返した版を残しておき、そちらと比べる。
const SERVED_KEY = SHELL_PATH + '__served_version';
function markServed(cache, version) {
  return cache.put(SERVED_KEY, new Response(version || '', { headers: { 'Content-Type': 'text/plain' } }))
    .catch(function() {});
}
function readServed(cache) {
  return cache.match(SERVED_KEY).then(function(r) { return r ? r.text() : ''; }).catch(function() { return ''; });
}

function notifyClients(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function(list) { list.forEach(function(c) { try { c.postMessage(msg); } catch (e) {} }); })
    .catch(function() {});
}

// app shell を取得して Cache Storage へ入れる。ok でない応答は保存しない
// （壊れた／404 の HTML を焼き付けると、オフライン時に壊れた画面が恒久的に残る）。
// allowHttpCache=true は初回訪問のプリフェッチ（CACHE_APP_SHELL）専用。
// （名前に反して実装は 'no-cache'＝必ず再検証。理由は下記）
// ★ Chromium ではナビゲーションの応答が Service Worker の fetch から HTTP キャッシュ経由で再利用できない
//   （default / force-cache のいずれでもネットワークへ行くことを実測で確認した）。
//   そのため初回訪問だけは約231KB をもう一度取得する。代わりに 2回目以降は 0 バイトになるため、
//   2回訪問した時点で合計転送量はプリフェッチしない場合と同じになり、初回直後からオフライン起動できる。
//   プリフェッチでも 'no-cache'（＝必ず再検証）を使う。'default' や 'force-cache' だと、HTTP キャッシュに
//   残っている古いエントリをそのまま焼き付ける余地がある。
function fetchAndStoreShell(cache, allowHttpCache) {
  return fetch(SHELL_URL, { cache: allowHttpCache ? 'no-cache' : 'no-store' }).then(function(res) {
    if (!res || !res.ok || res.status !== 200) return null;
    return cache.put(SHELL_URL, res.clone()).then(function() { return res; });
  });
}

// キャッシュ済み app shell の版を確認し、変わっていたら入れ替えて画面へ通知する。
// ★ まず HEAD で版だけ確認する。変わっていなければ本体（gzip 約231KB）を取りに行かない。
//   これが「再訪問のたびに index.html を丸ごと再ダウンロードする」問題の実体的な解決になる。
// ★ 版が取れなかった場合（ヘッダを返さない配信環境・プロキシ）は必ず GET する。
//   「取れない＝更新なし」と扱うと古い画面が恒久的に残る。
function revalidateShell(cache, cached, servedVersion) {
  const known = normVersion(servedVersion || shellVersionOf(cached));
  const doUpdate = function() {
    return fetchAndStoreShell(cache).then(function(res) {
      if (!res) return null;
      if (known && shellVersionOf(res) === known) return null; // 実質同じ＝通知しない
      return notifyClients({ type: 'APP_UPDATE_AVAILABLE' });
    });
  };
  if (!known) return doUpdate().catch(function() {});
  return fetch(SHELL_URL, { method: 'HEAD', cache: 'no-store' }).then(function(head) {
    // ★ HEAD が使えない配信経路（405 を返す中継プロキシ等）では、必ず本体を取り直して確認する。
    //   ここで null を返すと、その端末は二度と更新に気づけない（古いクライアントが居座る）。
    if (!head || !head.ok) return doUpdate();
    const fresh = shellVersionOf(head);
    if (fresh && fresh === known) return null; // 最新版を配信済み＝何もしない
    return doUpdate();
  }).catch(function() {});
}

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // ★ ここで app shell を取りに行ってはならない。install はページの読み込み中に走るため、
      //   ナビゲーションの応答がまだ HTTP キャッシュへ書き終わっておらず、初回訪問だけ
      //   約231KB を二重にダウンロードすることになる（実測で確認）。
      //   app shell の保存は、読み込み完了後にページから CACHE_APP_SHELL を受け取って行う。
      return cache.addAll(OFFLINE_URLS).catch(function() {});
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

  // ===== HTML（ナビゲーション）=====
  if (event.request.mode === 'navigate') {
    // manual.html など app shell 以外のページは素通し（index.html を返してはならない）
    if (!isShellRequest(event.request.url)) return;
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(SHELL_URL).then(function(cached) {
          if (cached) {
            // 先にキャッシュを返して即座に起動させ、裏で版を確認する（stale-while-revalidate）
            event.waitUntil(
              markServed(cache, shellVersionOf(cached))
                .then(function() { return revalidateShell(cache, cached); })
            );
            return cached;
          }
          return fetchAndStoreShell(cache)
            .then(function(res) { return res || fetch(event.request); })
            .catch(function() { return fetch(event.request); });
        });
      }).catch(function() { return fetch(event.request); })
    );
    return;
  }

  // ===== それ以外 =====
  // ★ ここでは cache.put を一切行わない。Firebase RTDB（勤怠データ）・Identity Toolkit（認証）・
  //   /api/*（通知・移動距離）の応答が Cache Storage へ入らないことを、この一点で保証する。
  //   失敗時のフォールバックは install で入れた OFFLINE_URLS にしか当たらない。
  event.respondWith(
    fetch(event.request).catch(function() {
      // ★ オリジン全体ではなく自分のキャッシュだけを探す（同一オリジンの別 SW が作った
      //   キャッシュに当たらないようにする）。
      return caches.open(CACHE_NAME).then(function(cache) { return cache.match(event.request); });
    })
  );
});

// 画面側からの明示的な版確認（オンライン復帰・タブ復帰時）
// ★ GitHub Pages のオリジンは同一ユーザーの全リポジトリで共有される。
//   /timecard/ 配下のページからの依頼だけを受け付ける。
function isOwnClient(source) {
  if (!source || !source.url) return false;
  try { return new URL(source.url).pathname.indexOf(SHELL_PATH) === 0; } catch (e) { return false; }
}
self.addEventListener('message', function(event) {
  if (!isOwnClient(event.source)) return;
  const data = event.data || {};
  // 読み込み完了後の app shell 保存依頼（初回訪問用）。
  // 既に保存済みなら何もしない。HTTP キャッシュを使ってよい（直前のナビゲーションの応答が残っている）。
  if (data.type === 'CACHE_APP_SHELL') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(SHELL_URL).then(function(cached) {
          return cached ? null : fetchAndStoreShell(cache, true);
        });
      }).catch(function() {})
    );
    return;
  }
  if (data.type !== 'CHECK_APP_UPDATE') return;
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all([cache.match(SHELL_URL), readServed(cache)]).then(function(r) {
        const cached = r[0], served = r[1];
        if (!cached) return null;
        // すでにキャッシュを入れ替えたのに、そのときの通知を画面が取りこぼしている場合がある。
        // 「いま動いている版（＝最後に返した版）」と比べ直し、違っていれば通信せず再通知する。
        if (served && served !== shellVersionOf(cached)) {
          return notifyClients({ type: 'APP_UPDATE_AVAILABLE' });
        }
        return revalidateShell(cache, cached, served);
      });
    }).catch(function() {})
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
