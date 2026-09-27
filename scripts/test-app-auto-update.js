/**
 * 配信版の自動更新（APP-AUTO-UPDATE）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-app-auto-update.js
 *
 * 目的:
 *   新しい版を検知したら、利用者の操作なしで最新版へ更新する。ただし
 *   ・Service Worker が新しい index.html をキャッシュへ入れ終えた通知（APP_UPDATE_AVAILABLE）を受けてから
 *   ・入力中・保存中・打刻中・PIN でログインした画面などでは待ち、安全になってから
 *   ・1回だけ（同じ版では二度と）再読み込みする
 *   ことを固定する。一定間隔の location.reload() や更新ループになっていないことも確認する。
 *
 * 方式:
 *   index.html から該当ブロックを抜き出し、vm コンテキストで DOM・通信・タイマーを模して評価する。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function slice(startMark, endMark) {
  const s = html.indexOf(startMark);
  const e = s < 0 ? -1 : html.indexOf(endMark, s + startMark.length);
  if (s < 0 || e < 0) {
    console.error("ERROR: index.html から該当ブロックを抽出できませんでした: " + startMark);
    process.exit(1);
  }
  return html.slice(s, e);
}

const UPDATE_CODE = slice("// ===== 配信版の更新検知（開きっぱなしの古い画面を残さない）=====", "// オンライン復帰時: まだ監視を確立できていなければ");
const FETCH_CODE = slice("// ===== 書込み通信の実行中件数 =====", "// ===== 会社（テナント）=====");

// ── 模擬環境 ─────────────────────────────────────────────
function el(tag, props) {
  const o = Object.assign({ tagName: tag, style: {}, id: "", type: "", value: "", defaultValue: "", children: [] }, props || {});
  o.closest = function () { return null; };
  o.getClientRects = function () { return o._hidden ? [] : [1]; };   // _hidden＝display:none の中にある（描画されない）
  return o;
}
function makeEnv(opts) {
  opts = opts || {};
  const E = {
    reloads: 0, posted: [], banners: 0,
    timers: [], nextId: 1,
    store: opts.store || {},             // sessionStorage の中身（再読み込みをまたいで引き継ぐ）
    storeThrows: !!opts.storeThrows,
    fixed: [], inputs: [], timeEdit: false, active: null,
    swHandler: null, visHandlers: [], winHandlers: {}
  };
  const doc = {
    body: {
      style: {},
      appendChild: function (b) { E.bannerEl = b; b.parentNode = doc.body; E.banners++; },
      removeChild: function (b) { if (E.bannerEl === b) E.bannerEl = null; b.parentNode = null; }
    },
    get activeElement() { return E.active || doc.body; },
    createElement: function (t) {
      const o = el(t); o.appendChild = function (c) { o.children.push(c); };
      Object.defineProperty(o, "firstChild", { get: function () { return o.children[0] || null; } });
      return o;
    },
    getElementById: function (id) { return id === "app-update-banner" && E.bannerEl ? E.bannerEl : null; },
    querySelector: function (sel) { return sel === ".time-edit-wrap" && E.timeEdit ? {} : null; },
    querySelectorAll: function (sel) {
      if (sel === 'body [style*="fixed"]') return E.fixed;
      if (sel === "input,textarea,select") return E.inputs;
      return [];
    },
    addEventListener: function (t, f) { if (t === "visibilitychange") E.visHandlers.push(f); },
    visibilityState: "visible"
  };
  const ctx = {
    console: { log: function () { }, error: function () { }, warn: function () { } },
    document: doc,
    window: {
      addEventListener: function (t, f) { (E.winHandlers[t] = E.winHandlers[t] || []).push(f); },
      sessionStorage: {
        getItem: function (k) { if (E.storeThrows) throw new Error("denied"); return Object.prototype.hasOwnProperty.call(E.store, k) ? E.store[k] : null; },
        setItem: function (k, v) { if (E.storeThrows) throw new Error("denied"); E.store[k] = String(v); }
      }
    },
    navigator: {
      onLine: true,
      serviceWorker: opts.noSw ? undefined : {
        controller: opts.noController ? null : { postMessage: function (m) { E.posted.push(m); } },
        addEventListener: function (t, f) { if (t === "message") E.swHandler = f; }
      }
    },
    location: { protocol: "https:", pathname: "/timecard/", reload: function () { E.reloads++; } },
    fetch: function () { return Promise.resolve({ ok: true, headers: { get: function () { return E.headTag || ""; } } }); },
    setInterval: function (f, ms) { const id = E.nextId++; E.timers.push({ id: id, f: f, ms: ms, repeat: true }); return id; },
    clearInterval: function (id) { E.timers = E.timers.filter(function (t) { return t.id !== id; }); },
    setTimeout: function (f, ms) { const id = E.nextId++; E.timers.push({ id: id, f: f, ms: ms, repeat: false }); return id; },
    clearTimeout: function (id) { E.timers = E.timers.filter(function (t) { return t.id !== id; }); },
    // 画面・作業の状態（index.html の他の場所で定義されるグローバル）
    screen: "home", viewerMode: false, adminUrlUsed: false, adminTokenValid: false, demoMode: false,
    savingCount: 0, _apvBusyCount: 0, _apvPutDeferred: false, _apvPutInFlight: 0, _apvHasUnknown: function () { return !!ctx._unknown; },
    _punchSaving: false, pinChecking: false, pinInput: "", staffPinInput: "", staffPinConfirm: "",
    mileageBlocksRerender: function () { return !!ctx._mileageEditing; }, devWatchEditing: function () { return false; }, monthlyDaysEditing: false,
    _appWritesInFlight: 0,
    showAlert: function (m) { (E.alerts = E.alerts || []).push(m); },
    showConfirm: function (m, yes) { (E.confirms = E.confirms || []).push(m); if (E.confirmYes) yes(); }
  };
  if (opts.noSw) delete ctx.navigator.serviceWorker;
  vm.createContext(ctx);
  // "serviceWorker" in navigator の判定のため、キーそのものを消す
  vm.runInContext(UPDATE_CODE, ctx);
  E.ctx = ctx;
  E.sw = function (version) { E.swHandler({ data: version === undefined ? { type: "APP_UPDATE_AVAILABLE" } : { type: "APP_UPDATE_AVAILABLE", version: version } }); };
  // 経過した扱いにしてタイマーを1巡させる（間隔の再確認・SW 待ちの期限）
  E.tick = function (kind) {
    const list = E.timers.slice();
    list.forEach(function (t) {
      if (kind === "interval" && !t.repeat) return;
      if (kind === "timeout" && t.repeat) return;
      if (!t.repeat) E.timers = E.timers.filter(function (x) { return x.id !== t.id; });
      t.f();
    });
  };
  E.idle = function () { ctx._appLastInputAt = 0; };    // 最後の操作から十分に時間が経った
  return E;
}
const KEY = "tc_app_autoreload";

console.log("\n[1] 通常状態：新しい版の準備ができたら1回だけ自動で再読み込みする");
{
  const E = makeEnv();
  E.sw('W/"v2"');
  check("ホーム画面・操作なし：SW の通知で自動的に再読み込みする", E.reloads === 1, "reloads=" + E.reloads);
  check("再読み込みした版をタブに記録する（W/ を外して比較）", JSON.parse(E.store[KEY]).v === '"v2"', E.store[KEY]);
  check("［再読み込み］［後で］のバナーは出さない", E.banners === 0);
  E.sw('"v2"'); E.tick("interval"); E.tick("interval");
  check("通知が重なっても再読み込みは1回だけ", E.reloads === 1, "reloads=" + E.reloads);
  check("再読み込み後は確認用のタイマーを残さない", E.timers.filter(function (t) { return t.repeat; }).length === 0);
}

console.log("\n[2] 更新ループを起こさない");
{
  const store = {};
  const E1 = makeEnv({ store: store });
  E1.sw('"v2"');
  check("1回目：v2 で再読み込み", E1.reloads === 1);
  // 再読み込み後も（何らかの理由で）古いままで、同じ v2 の通知がまた来た
  const E2 = makeEnv({ store: store });
  E2.sw('"v2"'); E2.tick("interval");
  check("同じ版では二度と自動で再読み込みしない", E2.reloads === 0, "reloads=" + E2.reloads);
  check("代わりに従来のバナーを出す（利用者に委ねる）", E2.banners === 1);
  // さらに新しい v3 は再読み込みしてよい
  const E3 = makeEnv({ store: store });
  E3.sw('"v3"');
  check("新しい版（v3）は自動で再読み込みする", E3.reloads === 1);
}
{
  const store = {};
  const E1 = makeEnv({ store: store });
  E1.sw();                                                     // 版の分からない通知（旧 SW）
  check("版の分からない通知でも1回は再読み込みする", E1.reloads === 1);
  const E2 = makeEnv({ store: store });
  E2.sw(); E2.tick("interval");
  check("版の分からない通知での再読み込みは10分に1回まで（ループしない）", E2.reloads === 0 && E2.banners === 1);
}
{
  const E = makeEnv({ storeThrows: true });
  E.sw('"v2"'); E.tick("interval");
  check("記録を残せない（プライベートモード等）ときは自動で再読み込みしない", E.reloads === 0 && E.banners === 1);
}

console.log("\n[3] 作業中は再読み込みせず、安全になった時点で自動更新する");
const blockers = [
  ["時刻修正の入力欄を開いている", function (E) { E.timeEdit = true; }, function (E) { E.timeEdit = false; }],
  ["修正理由の選択など、モーダルを開いている", function (E) { E.fixed = [el("div", { style: { position: "fixed", inset: "0px", display: "flex" } })]; }, function (E) { E.fixed = []; }],
  ["入力欄にフォーカスがある（入力の途中）", function (E) { E.active = el("INPUT", { type: "time" }); }, function (E) { E.active = null; }],
  ["保存していない入力がある", function (E) { E.inputs = [el("INPUT", { type: "text", value: "山田", defaultValue: "" })]; }, function (E) { E.inputs = []; }],
  ["選択を変えたまま保存していないプルダウンがある", function (E) {
    E.inputs = [el("SELECT", { options: [{ defaultSelected: false }, { defaultSelected: false }], selectedIndex: 1 })];
  }, function (E) { E.inputs[0].selectedIndex = 0; }],
  ["勤怠データを保存中（savingCount）", function (E) { E.ctx.savingCount = 1; }, function (E) { E.ctx.savingCount = 0; }],
  ["書込み通信の途中（保存・打刻・API 送信）", function (E) { E.ctx._appWritesInFlight = 1; }, function (E) { E.ctx._appWritesInFlight = 0; }],
  ["管理者の時刻修正＋承認の同時保存中", function (E) { E.ctx._apvBusyCount = 1; }, function (E) { E.ctx._apvBusyCount = 0; }],
  ["保存結果を確認できていない勤怠がある", function (E) { E.ctx._unknown = true; }, function (E) { E.ctx._unknown = false; }],
  ["承認の全体保存を後回し中", function (E) { E.ctx._apvPutDeferred = true; }, function (E) { E.ctx._apvPutDeferred = false; }],
  ["承認の全体保存を送信中", function (E) { E.ctx._apvPutInFlight = 1; }, function (E) { E.ctx._apvPutInFlight = 0; }],
  ["打刻を端末へ保存中", function (E) { E.ctx._punchSaving = true; }, function (E) { E.ctx._punchSaving = false; }],
  ["職員が PIN を入力中", function (E) { E.ctx.screen = "staffPin"; E.ctx.staffPinInput = "12"; }, function (E) { E.ctx.screen = "home"; E.ctx.staffPinInput = ""; }],
  ["管理者 PIN を照合中", function (E) { E.ctx.screen = "pin"; E.ctx.pinChecking = true; }, function (E) { E.ctx.screen = "home"; E.ctx.pinChecking = false; }],
  // ↓ ログイン中の画面は、再読み込みでログアウトするので自動では更新しない。代わりにバナーで知らせる（第4要素＝バナーを出す）
  ["打刻画面の途中（職員を選んだ後）", function (E) { E.ctx.screen = "punch"; }, function (E) { E.ctx.screen = "home"; }, true],
  ["PIN でログインした管理画面（再読み込みでログアウトしてしまう）", function (E) { E.ctx.screen = "admin"; }, function (E) { E.ctx.screen = "home"; }, true],
  ["移動距離の入力フォームを開いている", function (E) { E.ctx._mileageEditing = true; }, function (E) { E.ctx._mileageEditing = false; }],
  ["オフライン", function (E) { E.ctx.navigator.onLine = false; }, function (E) { E.ctx.navigator.onLine = true; }],
  ["操作した直後（5秒以内）", function (E) { E.ctx._appLastInputAt = Date.now(); }, function (E) { E.idle(); }]
];
blockers.forEach(function (b) {
  const E = makeEnv();
  b[1](E);
  E.sw('"v2"'); E.tick("interval"); E.tick("interval");
  const held = E.reloads === 0 && E.banners === (b[3] ? 1 : 0);
  b[2](E);
  E.tick("interval");
  check(b[0] + "：その間は再読み込みせず" + (b[3] ? "（バナーで知らせ）" : "") + "、終わったら1回だけ自動更新する", held && E.reloads === 1, "held=" + held + " reloads=" + E.reloads + " banners=" + E.banners);
});
{
  const E = makeEnv();
  E.ctx.screen = "admin"; E.ctx.adminUrlUsed = true; E.ctx.adminTokenValid = true;
  E.sw('"v2"'); E.tick("interval");
  check("管理者URLの画面：表示中は予告なく再読み込みしない（開いているタブ・月が初期に戻るため）。バナーで知らせる", E.reloads === 0 && E.banners === 1);
  E.ctx.document.visibilityState = "hidden"; E.tick("interval");
  check("管理者URLの画面：タブが裏へ回ったら自動で更新する（トークンで再認証される）", E.reloads === 1);
}
{
  const E = makeEnv();
  E.ctx.screen = "admin"; E.ctx.viewerMode = true;
  E.sw('"v2"');
  const heldV = E.reloads === 0;
  E.ctx.document.visibilityState = "hidden"; E.tick("interval");
  check("閲覧用URLの画面：表示中は待ち、裏へ回ったら自動で更新する", heldV && E.reloads === 1);
}
{
  const E = makeEnv();
  E.ctx.savingCount = 1;                                       // 保存が返ってこないまま
  E.sw('"v2"'); E.tick("interval");
  const quiet = E.banners === 0;
  E.ctx._appAutoSince = Date.now() - 31 * 60 * 1000;           // 30分を超えて待たされた
  E.tick("interval");
  check("作業中で長く待たされたら、再読み込みはせずバナーで知らせる（黙って古いまま残さない）", quiet && E.banners === 1 && E.reloads === 0);
}
{
  const E = makeEnv();
  const hid = el("INPUT", { type: "date", value: "2026-09-01", defaultValue: "" }); hid._hidden = true;
  E.inputs = [hid];                                            // 閉じて display:none で残るモーダルに、開いたときの値が残っている
  E.sw('"v2"');
  check("閉じたモーダル（表示されていない入力欄）に残った値では待たない", E.reloads === 1);
}
{
  const E = makeEnv();
  E.ctx.screen = "admin";                                      // PIN ログインの管理画面でバナーを出した
  E.sw('"v2"'); E.tick("interval");
  E.sw('"v3"');                                                // さらに新しい版が来た
  E.ctx.screen = "home"; E.tick("interval");
  check("バナー表示中に新しい版が来ても、ホームへ戻れば最新の版で1回だけ更新する", E.reloads === 1 && JSON.parse(E.store[KEY]).v === '"v3"', E.store[KEY]);
}
{
  const E = makeEnv();
  E.ctx.screen = "admin"; E.ctx.adminUrlUsed = true; E.ctx.adminTokenValid = true; E.ctx.demoMode = true;
  E.sw('"v2"');
  check("管理者デモ（画面内の操作が再読み込みで消える）は自動更新しない", E.reloads === 0);
}
{
  const E = makeEnv();
  E.inputs = [el("INPUT", { type: "text", value: "abc", defaultValue: "abc" }), el("INPUT", { type: "checkbox", checked: false, defaultChecked: false }),
    el("SELECT", { options: [{ defaultSelected: false }, { defaultSelected: true }], selectedIndex: 1 })];
  E.fixed = [el("div", { style: { position: "fixed", inset: "0px", display: "none" } }), el("div", { id: "app-update-banner", style: { position: "fixed", bottom: "0px" } })];
  E.active = el("BUTTON");
  E.sw('"v2"');
  check("初期値のままの入力・閉じたモーダル・ボタンのフォーカスでは待たない", E.reloads === 1);
}
{
  const E = makeEnv();
  E.ctx._apvBusyCount = undefined;                            // 判定に使う値が壊れていても
  E.ctx._apvHasUnknown = function () { throw new Error("x"); };
  E.sw('"v2"');
  check("状態を判定できないときは再読み込みしない（安全側）", E.reloads === 0);
}

console.log("\n[4] HEAD で配信版の変化を見つけた場合（SW のキャッシュ更新を待ってから1回だけ）");
{
  const E = makeEnv();
  E.ctx._appVersionTag = '"v1"'; E.ctx._appVersionLastCheck = 0; E.headTag = '"v2"';
  E.ctx.checkAppVersion();
  setImmediate(function () {
    check("SW へキャッシュの更新を依頼する", E.posted.some(function (m) { return m && m.type === "CHECK_APP_UPDATE"; }));
    check("SW の通知を待つ間は再読み込みしない（古いキャッシュを表示し直さない）", E.reloads === 0);
    E.sw('"v2"');
    check("SW がキャッシュを入れ替えて通知したら1回だけ再読み込みする", E.reloads === 1);
    E.tick("timeout");
    check("待ちの期限が来ても二重に再読み込みしない", E.reloads === 1);

    const F = makeEnv();
    F.ctx._appVersionTag = '"v1"'; F.ctx._appVersionLastCheck = 0; F.headTag = '"v2"';
    F.ctx.checkAppVersion();
    setImmediate(function () {
      F.tick("timeout");
      check("SW の通知が期限までに来なければ（SW 更新直後でキャッシュが空など）再読み込みで取得する", F.reloads === 1);

      const G = makeEnv({ noSw: true });
      G.ctx._appVersionTag = '"v1"'; G.ctx._appVersionLastCheck = 0; G.headTag = '"v2"';
      G.ctx.checkAppVersion();
      setImmediate(function () {
        check("Service Worker の無い端末は、配信版の変化を確認してから1回だけ再読み込みする", G.reloads === 1 && JSON.parse(G.store[KEY]).v === '"v2"');
        const N = makeEnv();
        N.ctx._appVersionTag = 'W/"v1"'; N.ctx._appVersionLastCheck = 0; N.headTag = '"v1"';   // 弱い印（W/）だけ違う
        N.ctx.checkAppVersion();
        setImmediate(function () {
          N.tick("timeout");
          check("ETag の弱い印（W/）の付き外れだけでは更新とみなさない", N.reloads === 0 && N.posted.length === 0);
        });
        const H = makeEnv();
        H.ctx._appVersionTag = '"v1"'; H.ctx._appVersionLastCheck = 0; H.headTag = "";   // オフライン等で版が取れない
        H.ctx.checkAppVersion();
        setImmediate(function () {
          H.tick("timeout");
          check("版が取れない（オフライン）ときは再読み込みしない", H.reloads === 0 && H.posted.length === 0);
          part5();
        });
      });
    });
  });
}

function part5() {
  console.log("\n[5] 予備のバナー（自動で更新できなかったとき）");
  const btn = function (E, label) { return E.bannerEl && E.bannerEl.children.filter(function (c) { return c.textContent === label; })[0]; };
  const msgOf = function (E) { return E.bannerEl ? E.bannerEl.children[0].textContent : ""; };
  {
    const E = makeEnv();
    E.ctx.screen = "admin";                                      // PIN ログインの管理画面
    E.sw('"v2"'); E.tick("interval");
    check("ログイン中の画面のバナーは「ホームに戻ると自動で更新されます」と伝える", /ホームに戻ると自動で更新されます/.test(msgOf(E)), msgOf(E));
    btn(E, "再読み込み").onclick();
    check("ログイン中の画面で［再読み込み］を押すと、ログアウトすることを確認する（確認しなければ再読み込みしない）",
      E.reloads === 0 && (E.confirms || []).some(function (m) { return /ログアウト/.test(m); }));
    E.confirmYes = true; btn(E, "再読み込み").onclick();
    check("確認したら再読み込みする", E.reloads === 1);
  }
  {
    const E = makeEnv();
    E.ctx.screen = "admin";
    E.sw('"v2"'); E.tick("interval");
    E.ctx.savingCount = 1;                                       // バナーを出したあとで保存が始まった
    btn(E, "再読み込み").onclick();
    check("バナーを出したあとに保存が始まっていたら、［再読み込み］を押しても再読み込みせず案内する",
      E.reloads === 0 && (E.alerts || []).some(function (m) { return /保存・確定・キャンセルのあとで/.test(m); }));
    E.ctx.savingCount = 0; E.inputs = [el("INPUT", { type: "text", value: "x", defaultValue: "" })];
    btn(E, "再読み込み").onclick();
    check("入力の途中でも同じく再読み込みしない", E.reloads === 0);
  }
  {
    const E = makeEnv();
    E.ctx.screen = "admin";                                      // ログイン中の画面で入力の途中
    E.inputs = [el("INPUT", { type: "text", value: "x", defaultValue: "" })];
    E.sw('"v2"'); E.tick("interval");
    check("作業中は、ログイン中の画面でもバナーを出さない（再読み込みを誘わない）", E.banners === 0 && E.reloads === 0);
  }
  {
    const store = { [KEY]: JSON.stringify({ v: '"v2"', at: Date.now() }) };   // v2 は自動で再読み込み済み
    const E = makeEnv({ store: store });
    E.ctx.screen = "admin";                                      // ログイン中の画面向けバナーが出る
    E.sw('"v2"'); E.tick("interval");
    const wasSession = /ホームに戻ると/.test(msgOf(E));
    E.ctx.screen = "home"; E.tick("interval");                   // ホームへ戻ったが、同じ版なので自動では更新できない
    check("自動で更新できないと分かったら、バナーの文言を「再読み込みしてください」へ差し替える（表示と実際を合わせる）",
      wasSession && /再読み込みしてください/.test(msgOf(E)) && E.reloads === 0, msgOf(E));
  }
  {
    const E = makeEnv();
    E.ctx.screen = "admin";
    E.sw('"v2"'); E.tick("interval");
    btn(E, "後で").onclick();
    E.tick("interval"); E.tick("interval");
    check("「後で」を押したら5分は再表示しない（待っている間も）", E.banners === 1);
    E.ctx._appUpdateDismissedAt = Date.now() - 6 * 60 * 1000; E.tick("interval");
    check("5分を過ぎたら再表示する", E.banners === 2);
  }
  {
    const store = { [KEY]: JSON.stringify({ v: '"v2"', at: Date.now() }) };
    const E = makeEnv({ store: store });
    E.sw('"v2"');
    check("自動で更新できない版はバナーで知らせる", E.banners === 1);
    // 「後で」を押した直後に再通知が来ても出さない
    const E2 = makeEnv({ store: store });
    E2.ctx._appUpdateDismissedAt = Date.now();
    E2.sw('"v2"');
    check("「後で」から5分は再表示しない", E2.banners === 0);
  }

  console.log("\n[6] 書込み通信の実行中件数（fetch の差し込み）");
  {
    const pend = [];
    const ctx = { window: { fetch: function (u, o) { return new Promise(function (res, rej) { pend.push({ res: res, rej: rej, o: o }); }); } } };
    vm.createContext(ctx);
    vm.runInContext(FETCH_CODE, ctx);
    const f = ctx.window.fetch;
    f("/a.json");                                 // GET
    f("/a.json", { method: "HEAD" });
    check("GET・HEAD は数えない", ctx._appWritesInFlight === 0);
    const p1 = f("/a.json", { method: "PUT", body: "{}" });
    const p2 = f("/b", { method: "post" });
    check("PUT・POST（小文字も）は送信中として数える", ctx._appWritesInFlight === 2);
    check("通信の内容はそのまま渡す", pend[2].o.method === "PUT" && pend[2].o.body === "{}");
    pend[2].res({ ok: true }); pend[3].rej(new Error("net"));
    Promise.allSettled([p1, p2]).then(function (r) {
      check("完了・失敗のどちらでも数を戻す", ctx._appWritesInFlight === 0, "n=" + ctx._appWritesInFlight);
      check("結果・例外は呼び出し元へそのまま返す", r[0].status === "fulfilled" && r[0].value.ok === true && r[1].status === "rejected");
      part7();
    });
  }
}

function part7() {
  console.log("\n[7] 静的確認");
  check("一定間隔で location.reload() する実装になっていない（setInterval の中で reload しない）",
    !/setInterval\([^;]*location\.reload/.test(html));
  // 自動更新の1箇所＋予備バナーの［再読み込み］（ログアウト確認後／そのまま）の2箇所
  check("location.reload() を呼ぶのは自動更新の1箇所と予備バナーの［再読み込み］だけ",
    (UPDATE_CODE.split("\n").filter(function (l) { return !/^\s*\/\//.test(l); }).join("\n").match(/location\.reload\(\)/g) || []).length === 3);
  check("自動更新は記録を書けた場合にだけ再読み込みする",
    /if\(!_appWriteAutoLog\(\{v:_appAutoTarget,at:Date\.now\(\)\}\)\)\{_appAutoFallback\(\);return;\}\s*\n\s*_appAutoDone=true;\s*\n\s*_appAutoStop\(\);\s*\n\s*location\.reload\(\);/.test(UPDATE_CODE));
  check("sw.js は通知に入れ直した版を添える", /type: 'APP_UPDATE_AVAILABLE', version: shellVersionOf\(res\)/.test(sw));
  check("sw.js を変えたので CACHE_NAME を上げてある（v15 以上）", /const CACHE_NAME = 'timecard-v(1[5-9]|[2-9]\d)'/.test(sw));
  check("書込み件数の差し込みはページ先頭の script（他の通信より前）にある",
    html.indexOf("// ===== 書込み通信の実行中件数 =====") < html.indexOf("async function authFetch("));

  console.log("\n================================");
  console.log("PASS " + pass + " / FAIL " + fail);
  console.log("================================");
  process.exit(fail ? 1 : 0);
}
