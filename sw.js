// ===== キャッシュ版 =====
// ★ sw.js を変更したら必ず CACHE_NAME を上げる。activate で旧キャッシュを全削除するため、
//   これが「配信済みの古い app shell を確実に捨てる」唯一の安全弁になる。
const CACHE_NAME = 'timecard-v16';

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
  '/timecard/apple-touch-icon-v2.png',
  // 会社ごとの表示用アセット（配信物のみ。業務データは含まない）
  '/timecard/manifest-mantel.json',
  '/timecard/brand/mantel/logo-160.png',
  '/timecard/brand/mantel/logo-320.png',
  '/timecard/brand/mantel/icon-192.png',
  '/timecard/brand/mantel/apple-touch-icon.png'
];

// ===== 会社（通知の表示とクリック時の遷移先）=====
// ★ 会社ごとの違いはこの表だけ。穂乃味は従来と同じ（c を持たない URL・従来のアイコン）。
const APP_URL = 'https://rsb79692-create.github.io/timecard/';
const TENANT_NOTIFY = {
  honomi: { icon: '/timecard/icon-192-v2.png', url: APP_URL },
  mantel: { icon: '/timecard/brand/mantel/icon-192.png', url: APP_URL + '?c=mantel' }
};
function tenantOfPush(data) {
  const t = data && typeof data.tenant === 'string' ? data.tenant : 'honomi';
  return Object.prototype.hasOwnProperty.call(TENANT_NOTIFY, t) ? t : null;
}
// その会社の画面を開いているタブか（穂乃味は c を持たない URL、他社は c=<会社ID>）
function clientIsTenant(clientUrl, tenant) {
  let u;
  try { u = new URL(clientUrl); } catch (e) { return false; }
  if (u.pathname.indexOf('/timecard/') !== 0) return false;
  // #c=mantel&token=… のハッシュ形式でも開ける（index.html と同じ判定）
  let c = u.searchParams.get('c');
  if (c === null && /[&=]/.test(u.hash.replace(/^#/, ''))) c = new URLSearchParams(u.hash.replace(/^#/, '')).get('c');
  return tenant === 'honomi' ? !c : c === tenant;
}

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
// 配信側の目印（ETag / Last-Modified）。★ 本体を取り直すかどうかの目安にだけ使う。
function etagOf(res) {
  if (!res) return '';
  return normVersion(res.headers.get('ETag') || res.headers.get('Last-Modified') || '');
}
// ★★ アプリの版＝index.html の**内容**のハッシュ（キャッシュへ入れるときに計算してヘッダへ残す）。
//   GitHub Pages の ETag は「配信時刻-サイズ」で、index.html を変えない push（文書だけの変更等）でも
//   毎回変わる（2026-09-30 実測）。ETag を版として扱うと、push のたびに「新しい版」になってしまう。
//   ハッシュを計算できない環境だけ、従来どおり ETag を版として使う。
const HASH_HEADER = 'X-TC-Shell-Hash';
function shellVersionOf(res) {
  if (!res) return '';
  return res.headers.get(HASH_HEADER) || etagOf(res);
}
function sha256Hex(buf) {
  try {
    if (!self.crypto || !self.crypto.subtle) return Promise.resolve('');
    return self.crypto.subtle.digest('SHA-256', buf).then(function(h) {
      return Array.from(new Uint8Array(h)).map(function(b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    }).catch(function() { return ''; });
  } catch (e) { return Promise.resolve(''); }
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
// ★ 保存するのは本体と Content-Type・ETag・Last-Modified・内容のハッシュだけ
//   （本体は展開済みなので Content-Encoding / Content-Length を写してはならない）。
function fetchAndStoreShell(cache, allowHttpCache) {
  return fetch(SHELL_URL, { cache: allowHttpCache ? 'no-cache' : 'no-store' }).then(function(res) {
    if (!res || !res.ok || res.status !== 200) return null;
    return res.arrayBuffer().then(function(buf) {
      return sha256Hex(buf).then(function(hash) {
        const h = new Headers();
        ['Content-Type', 'ETag', 'Last-Modified'].forEach(function(k) { const v = res.headers.get(k); if (v) h.set(k, v); });
        if (hash) h.set(HASH_HEADER, 'sha256:' + hash);
        const stored = new Response(buf, { status: 200, statusText: res.statusText || 'OK', headers: h });
        return cache.put(SHELL_URL, stored.clone()).then(function() { return stored; });
      });
    });
  });
}

// キャッシュ済み app shell の版を確認し、変わっていたら入れ替えて画面へ通知する。
// 戻り値: 'updated'（新しい版を通知した）／'same'（最新と確認できた）／'unknown'（通信失敗・非200等で判定できない）。
// ★ 画面へ「最新です」と返してよいのは 'same' だけ。判定できないときに「最新」と扱うと、
//   画面の予備の再読み込みが取り消され、古い画面が残る。
// ★ まず HEAD で版だけ確認する。変わっていなければ本体（gzip 約231KB）を取りに行かない。
//   これが「再訪問のたびに index.html を丸ごと再ダウンロードする」問題の実体的な解決になる。
// ★ 版が取れなかった場合（ヘッダを返さない配信環境・プロキシ）は必ず GET する。
//   「取れない＝更新なし」と扱うと古い画面が恒久的に残る。
// ★ 同時に来た確認（タブ復帰で画面から2本届く等）は、実行中の1本にまとめる（本体の二重取得を避ける）。
let _revalidating = null;
function revalidateShell(cache, cached, servedVersion) {
  if (_revalidating) return _revalidating;
  _revalidating = _revalidateShell(cache, cached, servedVersion).then(function(r) {
    _revalidating = null; return r;
  }, function() { _revalidating = null; return 'unknown'; });
  return _revalidating;
}
function _revalidateShell(cache, cached, servedVersion) {
  const known = servedVersion || shellVersionOf(cached);
  const doUpdate = function() {
    return fetchAndStoreShell(cache).then(function(res) {
      if (!res) return 'unknown';
      // ★ 内容が同じ＝通知しない。キャッシュは入れ直してあるので、次からは HEAD の目印も一致する。
      if (known && shellVersionOf(res) === known) return 'same';
      // version＝キャッシュへ入れ直した版。画面は同じ版で二度と自動再読み込みしない（更新ループ防止）
      return notifyClients({ type: 'APP_UPDATE_AVAILABLE', version: shellVersionOf(res) }).then(function() { return 'updated'; });
    });
  };
  if (!known) return doUpdate().catch(function() { return 'unknown'; });
  return fetch(SHELL_URL, { method: 'HEAD', cache: 'no-store' }).then(function(head) {
    // ★ HEAD が使えない配信経路（405 を返す中継プロキシ等）では、必ず本体を取り直して確認する。
    //   ここで「最新」と扱うと、その端末は二度と更新に気づけない（古いクライアントが居座る）。
    if (!head || !head.ok) return doUpdate();
    // ★ HEAD の目印はキャッシュ済みの本体の目印と比べる（版＝内容のハッシュとは比べられない）
    const fresh = etagOf(head);
    if (fresh && fresh === etagOf(cached)) return 'same'; // 最新版を配信済み＝何もしない
    return doUpdate();
  }).catch(function() { return 'unknown'; });
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
  const src = event.source;
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all([cache.match(SHELL_URL), readServed(cache)]).then(function(r) {
        const cached = r[0], served = r[1];
        // キャッシュが空（SW 更新の直後）は答えない。画面は期限後に再読み込みでネットワークから取る。
        if (!cached) return null;
        // すでにキャッシュを入れ替えたのに、そのときの通知を画面が取りこぼしている場合がある。
        // 「いま動いている版（＝最後に返した版）」と比べ直し、違っていれば通信せず再通知する。
        if (served && served !== shellVersionOf(cached)) {
          return notifyClients({ type: 'APP_UPDATE_AVAILABLE', version: shellVersionOf(cached) });
        }
        return revalidateShell(cache, cached, served).then(function(result) {
          // ★ 最新と確認できたときだけ依頼元へ返す。画面は配信側の目印（ETag）の変化だけで
          //   再読み込みしない（index.html を変えない push で再読み込みさせない）。
          //   判定できないとき（'unknown'）は答えない。画面は期限後の予備の再読み込みで回復する。
          if (result === 'same' && src) { try { src.postMessage({ type: 'APP_UP_TO_DATE' }); } catch (e) {} }
        });
      });
    }).catch(function() {})
  );
});

// ===== FCM Push通知ハンドラ =====
// GitHub Actions が data-only メッセージを送信 → raw push イベントで受信
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  // ★ 未知の会社の通知は表示しない（他社の通知を別の会社の画面へ誘導しない）
  var tenant = tenantOfPush(data);
  if (!tenant) return;
  var tn = TENANT_NOTIFY[tenant];
  var count = parseInt(data.pendingCount || '0', 10);

  if (count > 0 && 'setAppBadge' in self.navigator) {
    self.navigator.setAppBadge(count).catch(function(){});
  }

  var title = '打刻修正申請 ' + count + '件';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: '承認待ちの申請があります。タップして確認してください。',
      icon: tn.icon,
      badge: tn.icon,
      data: { url: tn.url, tenant: tenant },
      tag: tenant === 'honomi' ? 'correction-requests' : ('correction-requests-' + tenant)
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var nd = event.notification.data || {};
  var tenant = (typeof nd.tenant === 'string' && Object.prototype.hasOwnProperty.call(TENANT_NOTIFY, nd.tenant)) ? nd.tenant : 'honomi';
  // ★ 遷移先は会社の表から引く（通知の data の URL をそのまま開かない）
  var url = TENANT_NOTIFY[tenant].url;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clientIsTenant(clients[i].url, tenant) && 'focus' in clients[i]) {
          return clients[i].focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })
  );
});
