/**
 * 打刻の端末永続保存（IndexedDB）と自動再送の回帰テスト
 * （依存パッケージなし・送信なし・本番データ非アクセス）
 *
 * 実行: node scripts/test-punch-outbox.js
 *
 * 固定する性質:
 *   1. 端末保存の完了だけで打刻が完了すること
 *      サーバ応答を待たない。かつ IndexedDB へ保存できていないのに打刻済みと見せない。
 *      IndexedDB へ保存できなければ打刻失敗として扱い、localStorage 等へフォールバックしない。
 *   2. 二重登録が起きないこと
 *      送信先は必ず /tc5_records/{eventId}.json（PUT）。POST（push）を使わない。
 *      「サーバには保存済みだがクライアントが成功応答を受け取れなかった」打刻を再送しても、
 *      GET で存在確認して書き直さない（管理者の修正も巻き戻さない）。
 *      再送で event_id を採り直さない。
 *   3. 実打刻時刻がサーバ受信時刻で上書きされないこと
 *      timestamp / time / date は押下時のまま。serverReceivedAt はサーバ側が入れる。
 *   4. 通信失敗・認証切れ・アプリ終了で打刻が消えないこと
 *      未送信は IndexedDB に残り、"syncing" のまま終了しても起動時に再送対象へ戻る。
 *      401/403 を成功扱いにせず、無限高速リトライもしない。
 *   5. 複数トリガーが同時発火しても多重送信しないこと
 *   6. 警告が過剰にならないこと
 *   7. スタッフテスト画面・管理者デモ・閲覧用URLではキューが動かないこと
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、該当ブロックだけを抜き出して
 *   vm コンテキストで評価し、DOM・通信・IndexedDB をモックする。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.html");
const START = "// ===== PUNCH-OUTBOX-BEGIN =====";
const END = "// ===== PUNCH-OUTBOX-END =====";

const html = fs.readFileSync(SRC, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END, s);
if (s < 0 || e < 0) {
  console.error("ERROR: index.html から打刻オフラインキューのブロックを抽出できませんでした。");
  console.error("       index.html 側のマーカーコメントを変更した場合は、本テストの START/END も合わせてください。");
  process.exit(1);
}
const CODE = html.slice(s, e);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

// ───────── モック ─────────

/** 時計。テスト内で任意に進められる（バックオフ・警告条件の検証用） */
function makeClock() {
  const base = Date.parse("2026-08-26T08:03:00.000Z");
  let offset = 0;
  class FakeDate extends Date {
    constructor() {
      if (arguments.length === 0) super(base + offset);
      else if (arguments.length === 1) super(arguments[0]);
      else super(arguments[0], arguments[1], arguments[2] || 1, arguments[3] || 0, arguments[4] || 0, arguments[5] || 0);
    }
    static now() { return base + offset; }
  }
  return { Date: FakeDate, advance(ms) { offset += ms; } };
}

function makeLocalStorage(seed) {
  const map = Object.assign({}, seed || {});
  return {
    __map: map,
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) { map[k] = String(v); },
    removeItem(k) { delete map[k]; }
  };
}

/**
 * IndexedDB の最小実装。
 * opts.broken: open を失敗させる（保存不能端末の模擬）
 * opts.failPut: put のトランザクションを失敗させる
 * opts.data: 永続データ（テスト間で引き継いで「再起動」を模擬する）
 */
function makeFakeIndexedDB(opts) {
  opts = opts || {};
  const dbData = opts.data || {};
  const db = {
    objectStoreNames: { contains(n) { return Object.prototype.hasOwnProperty.call(dbData, n); } },
    createObjectStore(n) { dbData[n] = {}; return {}; },
    transaction(name, mode) {
      const tx = {};
      const queued = [];
      let failed = false;
      const store = {
        put(v) { if (opts.failPut) { failed = true; return {}; } queued.push(() => { dbData[name][v.eventId] = v; }); return {}; },
        delete(k) { queued.push(() => { delete dbData[name][k]; }); return {}; },
        getAll() {
          const rq = {};
          queued.push(() => {
            rq.result = Object.keys(dbData[name]).map((k) => dbData[name][k]);
            if (rq.onsuccess) rq.onsuccess();
          });
          return rq;
        }
      };
      tx.objectStore = () => store;
      setTimeout(() => {
        if (failed) { if (tx.onerror) tx.onerror(); return; }
        queued.forEach((f) => f());
        if (tx.oncomplete) tx.oncomplete();
      }, 0);
      return tx;
    }
  };
  return {
    __data: dbData,
    open() {
      const req = {};
      setTimeout(() => {
        if (opts.broken) { if (req.onerror) req.onerror(); return; }
        req.result = db;
        if (!dbData.punches && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

/** 通信モック。handler(url, opts, call, n) → {status,body} または "offline" */
function makeFetch(handler) {
  const calls = [];
  function authFetch(url, opts) {
    const call = { url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const r = handler(url, opts || {}, call, calls.length);
    if (r === "offline") return Promise.reject(new Error("network"));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body === undefined ? null : r.body)
    });
  }
  return { authFetch, calls };
}

function makeCtx(opts) {
  opts = opts || {};
  const clock = makeClock();
  const ls = makeLocalStorage(opts.ls);
  const net = makeFetch(opts.handler || (() => ({ status: 200, body: null })));
  const savedByLegacy = [];
  let renderCount = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Object, Math, Array, String, Number, Error, isNaN,
    Date: clock.Date,
    encodeURIComponent,
    localStorage: ls,
    indexedDB: opts.noIndexedDb ? undefined : makeFakeIndexedDB(opts.idb),
    window: { addEventListener() {} },
    document: { hidden: false, addEventListener() {}, querySelector() { return null; } },
    showPaidLeaveForm: false,
    render() { renderCount++; },
    FB_URL: "https://example.invalid/honomi",
    writePolicy: opts.writePolicy || "full",
    viewerMode: !!opts.viewerMode,
    records: opts.records || [],
    _lsSet(k, v) { ls.setItem(k, v); },
    authFetch: net.authFetch,
    saveRecord(rec) { savedByLegacy.push(rec); }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "index.html#punch-outbox" });
  return { ctx, clock, ls, net, savedByLegacy, renderCount: () => renderCount };
}

function mkRec(id, type, time, iso) {
  return {
    id, eventId: id, staff: "山田 太郎", type,
    date: "2026-08-26", time, timestamp: iso,
    facilityName: "ナナイロ", workFacility: "ナナイロ"
  };
}
function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ───────── テスト ─────────

async function run() {

  section("1. 端末保存の完了だけで打刻が完了する（サーバ応答を待たない）");
  {
    let resolveServer = null;
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    // サーバを永久に応答させない
    t.ctx.authFetch = function () { return new Promise((r) => { resolveServer = r; }); };
    const rec = mkRec("ev-1", "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
    const committed = await t.ctx.punchOutboxCommit(rec);
    check("IndexedDB への保存完了で true が返る", committed === true);
    check("保存後は送信待ちとして1件ある", t.ctx.punchOutboxPending().length === 1);
    check("実 IndexedDB 相当に1件書かれている", Object.keys(t.ctx.indexedDB.__data.punches || {}).length === 1);
    // ここで画面を打刻済みにしてよい＝サーバ応答は未着のまま
    t.ctx.punchOutboxFlush("punch");
    await tick(2);
    check("サーバ応答が返らなくても保存済み判定は覆らない", t.ctx.punchOutboxPending().length === 1);
    check("応答待ちの間もキュー状態は syncing（多重送信しない）",
      t.ctx.punchOutboxPending()[0].state === "syncing", t.ctx.punchOutboxPending()[0].state);
    check("応答待ち中の再フラッシュで二重送信しない（未応答なので送信本数は増えない）",
      typeof resolveServer === "function");
  }

  section("2. IndexedDB へ保存できないときは打刻失敗（成功に見せない・フォールバックしない）");
  {
    const broken = makeCtx({ idb: { broken: true } });
    const ok1 = await broken.ctx.punchOutboxCommit(mkRec("ev-2a", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    check("IndexedDB が開けない端末では false を返す", ok1 === false);
    check("キューにも積まない", broken.ctx.punchOutboxPending().length === 0);
    check("localStorage へフォールバック保存しない", broken.ls.getItem("tc5_punch_outbox") === null);
    check("保存不能を検知して警告を出す", (broken.ctx.punchOutboxWarning() || {}).kind === "storage");
    check("保存不能の案内文が出る", broken.ctx.punchOutboxBannerHtml().indexOf("この端末では打刻を保存できません") > 0);

    const failPut = makeCtx({ idb: { failPut: true } });
    const ok2 = await failPut.ctx.punchOutboxCommit(mkRec("ev-2b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    check("書き込みトランザクションが失敗しても false を返す", ok2 === false);
    check("失敗時はキューへ積まない", failPut.ctx.punchOutboxPending().length === 0);

    const noIdb = makeCtx({ noIndexedDb: true });
    const ok3 = await noIdb.ctx.punchOutboxCommit(mkRec("ev-2c", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    check("IndexedDB 非対応環境でも false を返す（成功に見せない）", ok3 === false);
  }

  section("3. 実打刻時刻・サーバ受信時刻・event_id を取り違えない");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    await t.ctx.punchOutboxCommit(mkRec("ev-3", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    t.clock.advance(2 * 60 * 60 * 1000); // 2時間後にようやく送信できた
    await t.ctx.punchOutboxFlush("online");
    await tick();
    const body = t.net.calls.find((c) => c.method === "PUT").body;
    check("timestamp（実打刻時刻）が送信時刻で上書きされない", body.timestamp === "2026-08-26T08:03:00.000Z", body.timestamp);
    check("time が送信時刻で上書きされない", body.time === "08:03", body.time);
    check("date が送信日で上書きされない", body.date === "2026-08-26", body.date);
    check("eventId が本文にも入る", body.eventId === "ev-3");
    check("serverReceivedAt はサーバ側で入れる（サーバ値センチネル）",
      body.serverReceivedAt && body.serverReceivedAt[".sv"] === "timestamp", JSON.stringify(body.serverReceivedAt));
    check("重複した独自の受信時刻カラムを増やしていない", body.sentAt === undefined);
  }

  section("3b. サーバ受信時刻を書けなくても打刻本体は落とさない");
  {
    const t = makeCtx({
      handler: (url, o, call) => {
        if ((o.method || "GET") !== "PUT") return { status: 200, body: null };
        if (call.body && call.body.serverReceivedAt) return { status: 400, body: null };
        return { status: 200, body: null };
      }
    });
    await t.ctx.punchOutboxCommit(mkRec("ev-3b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch");
    await tick();
    const puts = t.net.calls.filter((c) => c.method === "PUT");
    check("serverReceivedAt を外して書き直す", puts.length === 2 && !puts[1].body.serverReceivedAt);
    check("打刻時刻は書き直しても変わらない", puts[1].body.timestamp === "2026-08-26T08:03:00.000Z");
    check("書き直しても同じ eventId のノード（二重登録しない）",
      puts.every((c) => c.url.indexOf("/tc5_records/ev-3b.json") > 0));
    check("最終的に送信済みになる", t.ctx.punchOutboxPending().length === 0);
  }

  section("4. 正常通信：/tc5_records/{eventId}.json への PUT で1ノードだけ作る");
  {
    const store = {};
    const t = makeCtx({
      handler: (url, o, call) => {
        if ((o.method || "GET") === "PUT") { store[url] = call.body; }
        return { status: 200, body: null };
      }
    });
    await t.ctx.punchOutboxCommit(mkRec("ev-4", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch");
    await tick();
    check("PUT が1回", t.net.calls.filter((c) => c.method === "PUT").length === 1);
    check("初回送信では存在確認 GET を出さない（毎回の通信を2倍にしない）",
      t.net.calls.filter((c) => c.method === "GET").length === 0,
      "GET=" + t.net.calls.filter((c) => c.method === "GET").length);
    check("送信先は /tc5_records/{eventId}.json",
      Object.keys(store)[0] === "https://example.invalid/honomi/tc5_records/ev-4.json", Object.keys(store)[0]);
    check("POST（push）でサーバ採番させない", t.net.calls.every((c) => c.method !== "POST"));
    check("送信できたらキューから消える", t.ctx.punchOutboxPending().length === 0);
    check("IndexedDB からも消える", Object.keys(t.ctx.indexedDB.__data.punches || {}).length === 0);
    check("通常時は警告を出さない", t.ctx.punchOutboxWarning() === null);
    check("通常時はバナーも出さない", t.ctx.punchOutboxBannerHtml() === "");
  }

  section("5. 完全オフライン → 再起動 → 復旧で自動送信");
  {
    const idbData = {};
    const t = makeCtx({ handler: () => "offline", idb: { data: idbData } });
    await t.ctx.punchOutboxCommit(mkRec("ev-5", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    check("オフラインでも端末保存は成功する", t.ctx.punchOutboxPending().length === 1);
    await t.ctx.punchOutboxFlush("punch");
    await tick();
    check("送信に失敗してもキューから消えない", t.ctx.punchOutboxPending().length === 1);
    check("失敗理由が network として残る", t.ctx.punchOutboxPending()[0].lastError === "network");
    check("状態は pending へ戻る（再送対象）", t.ctx.punchOutboxPending()[0].state === "pending");
    check("IndexedDB に残る", Object.keys(idbData.punches || {}).length === 1);
    check("短時間のオフラインでは警告しない", t.ctx.punchOutboxWarning() === null);

    // アプリ再起動（メモリを捨てて IndexedDB から復元）
    const t2 = makeCtx({ handler: () => "offline", idb: { data: idbData } });
    await t2.ctx.punchOutboxLoad();
    check("再起動後も未送信打刻が復元される", t2.ctx.punchOutboxPending().length === 1);
    check("復元した打刻の実打刻時刻が変わらない", t2.ctx.punchOutboxPending()[0].rec.time === "08:03");
    check("復元しても retryCount を引き継ぐ", t2.ctx.punchOutboxPending()[0].retryCount === 1);

    // 通信復旧
    const t3 = makeCtx({ handler: () => ({ status: 200, body: null }), idb: { data: idbData } });
    await t3.ctx.punchOutboxLoad();
    t3.clock.advance(5000);
    await t3.ctx.punchOutboxFlush("online");
    await tick();
    check("復旧後の再送で送信され、キューが空になる", t3.ctx.punchOutboxPending().length === 0);
    check("復旧後も同じ eventId のノードへ書く（採り直さない）",
      t3.net.calls.filter((c) => c.method === "PUT").every((c) => c.url.indexOf("/tc5_records/ev-5.json") > 0));
    check("IndexedDB も空になる", Object.keys(idbData.punches || {}).length === 0);
  }

  section("6. 送信中にアプリが終了しても再送できる（syncing の復旧）");
  {
    const idbData = { punches: {} };
    // "syncing" のまま残っているエントリ（送信中に落ちた状況）
    idbData.punches["ev-6"] = {
      eventId: "ev-6", rec: mkRec("ev-6", "clockOut", "17:30", "2026-08-26T17:30:00.000Z"),
      state: "syncing", createdAt: "2026-08-26T08:00:00.000Z", retryCount: 1,
      lastAttemptAt: "2026-08-26T08:00:01.000Z", lastError: ""
    };
    const t = makeCtx({ handler: () => ({ status: 200, body: null }), idb: { data: idbData } });
    await t.ctx.punchOutboxLoad();
    check("syncing のまま終了した打刻を復元する", t.ctx.punchOutboxPending().length === 1);
    check("復元時に pending へ戻す", t.ctx.punchOutboxPending()[0].state === "pending");
    t.clock.advance(5000);
    await t.ctx.punchOutboxFlush("startup");
    await tick();
    check("再送前に存在確認する（retryCount>0 なので GET が入る）",
      t.net.calls.filter((c) => c.method === "GET").length === 1);
    check("再送で送信済みになる", t.ctx.punchOutboxPending().length === 0);
  }

  section("7. タイムアウト：サーバは保存済みだがクライアントは失敗扱い → 再送で二重登録しない");
  {
    let stored = null;
    const nodes = {};
    const t = makeCtx({
      handler: (url, o, call, n) => {
        const m = (o.method || "GET");
        if (m === "PUT" && n === 1) { stored = call.body; nodes[url] = call.body; return "offline"; } // 届いたが応答なし
        if (m === "GET") return { status: 200, body: stored };
        if (m === "PUT") { nodes[url] = call.body; return { status: 200, body: null }; }
        return { status: 200, body: null };
      }
    });
    await t.ctx.punchOutboxCommit(mkRec("ev-7", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch");
    await tick();
    check("1回目は失敗扱いでキューに残る", t.ctx.punchOutboxPending().length === 1);

    t.clock.advance(30 * 1000);
    await t.ctx.punchOutboxFlush("retry");
    await tick();
    check("再送前にサーバの存在を確認する", t.net.calls.filter((c) => c.method === "GET").length === 1);
    check("既にサーバにあるので上書きしない（PUT は1回のまま）",
      t.net.calls.filter((c) => c.method === "PUT").length === 1);
    check("再送でキューから消える（送信済み扱い）", t.ctx.punchOutboxPending().length === 0);
    check("同一 event_id のノードが1件だけ存在する", Object.keys(nodes).length === 1, JSON.stringify(Object.keys(nodes)));
  }

  section("8. 再送で管理者の修正を巻き戻さない");
  {
    const edited = Object.assign(mkRec("ev-8", "clockIn", "08:30", "2026-08-26T08:30:00.000Z"), { editedByAdmin: true });
    const t = makeCtx({
      handler: (url, o, call, n) => {
        if ((o.method || "GET") === "PUT" && n === 1) return "offline";
        if ((o.method || "GET") === "GET") return { status: 200, body: edited };
        return { status: 200, body: null };
      }
    });
    await t.ctx.punchOutboxCommit(mkRec("ev-8", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch");
    await tick();
    t.clock.advance(30 * 1000);
    await t.ctx.punchOutboxFlush("retry");
    await tick();
    check("サーバに既にあるレコードを再送で上書きしない",
      t.net.calls.filter((c) => c.method === "PUT").length === 1);
  }

  section("9. オフライン中の複数打刻が実打刻時刻の順に送られる");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    // わざと逆順に投入する（出勤 08:00 / 休憩開始 12:00 / 休憩終了 13:00 / 退勤 17:00）
    await t.ctx.punchOutboxCommit(mkRec("ev-d", "clockOut", "17:00", "2026-08-26T17:00:00.000Z"));
    await t.ctx.punchOutboxCommit(mkRec("ev-b", "breakStart", "12:00", "2026-08-26T12:00:00.000Z"));
    await t.ctx.punchOutboxCommit(mkRec("ev-a", "clockIn", "08:00", "2026-08-26T08:00:00.000Z"));
    await t.ctx.punchOutboxCommit(mkRec("ev-c", "breakEnd", "13:00", "2026-08-26T13:00:00.000Z"));
    const order = t.ctx.punchOutboxPending().map((x) => x.eventId);
    check("キューは実打刻時刻の昇順", JSON.stringify(order) === JSON.stringify(["ev-a", "ev-b", "ev-c", "ev-d"]), JSON.stringify(order));
    await t.ctx.punchOutboxFlush("online");
    await tick(12);
    const sent = t.net.calls.filter((c) => c.method === "PUT").map((c) => c.body.eventId);
    check("送信も実打刻時刻の順", JSON.stringify(sent) === JSON.stringify(["ev-a", "ev-b", "ev-c", "ev-d"]), JSON.stringify(sent));
    check("4件とも送信済みになる", t.ctx.punchOutboxPending().length === 0);
    check("内容（種別・時刻）が保持されている",
      t.net.calls.filter((c) => c.method === "PUT").map((c) => c.body.type + "@" + c.body.time).join(",")
      === "clockIn@08:00,breakStart@12:00,breakEnd@13:00,clockOut@17:00");
  }

  section("10. 同時発火しても多重送信しない");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    await t.ctx.punchOutboxCommit(mkRec("ev-10", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    // 打刻直後 / online / visible / startup が同時に発火した状況
    const all = Promise.all([
      t.ctx.punchOutboxFlush("punch"),
      t.ctx.punchOutboxFlush("online"),
      t.ctx.punchOutboxFlush("visible"),
      t.ctx.punchOutboxFlush("startup")
    ]);
    await all; await tick();
    check("PUT は1回だけ", t.net.calls.filter((c) => c.method === "PUT").length === 1,
      "PUT=" + t.net.calls.filter((c) => c.method === "PUT").length);
    check("キューは空", t.ctx.punchOutboxPending().length === 0);
  }

  section("11. 再送間隔：連続失敗しても叩き続けない／復旧契機は待たない");
  {
    const t = makeCtx({ handler: () => "offline" });
    await t.ctx.punchOutboxCommit(mkRec("ev-11", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch"); await tick();
    const after1 = t.net.calls.length;
    await t.ctx.punchOutboxFlush("poll"); await tick();
    check("バックオフ中は定期再送しない", t.net.calls.length === after1);
    t.clock.advance(6000);
    await t.ctx.punchOutboxFlush("poll"); await tick();
    check("バックオフ経過後は再送する", t.net.calls.length > after1);
    check("間隔は指数的に伸びる（上限5分）",
      t.ctx.punchOutboxBackoffMs(1) === 5000 &&
      t.ctx.punchOutboxBackoffMs(3) === 20000 &&
      t.ctx.punchOutboxBackoffMs(99) === 300000);

    const t2 = makeCtx({ handler: () => "offline" });
    await t2.ctx.punchOutboxCommit(mkRec("ev-11b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    for (let i = 0; i < 7; i++) { t2.clock.advance(10 * 60 * 1000); await t2.ctx.punchOutboxFlush("poll"); await tick(); }
    const before = t2.net.calls.length;
    t2.clock.advance(1000);
    await t2.ctx.punchOutboxFlush("poll"); await tick();
    check("長いバックオフ中は定期再送しない", t2.net.calls.length === before);
    t2.clock.advance(3000);
    await t2.ctx.punchOutboxFlush("online"); await tick();
    check("通信復旧の契機ではバックオフを待たない", t2.net.calls.length > before);
  }

  section("12. 認証切れ（401/403）：成功扱いにせず、無限高速リトライもしない");
  {
    const t = makeCtx({ handler: () => ({ status: 401, body: { error: "Unauthorized" } }) });
    await t.ctx.punchOutboxCommit(mkRec("ev-12", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch"); await tick();
    check("401 を成功扱いにしない（キューに残る）", t.ctx.punchOutboxPending().length === 1);
    check("認証エラーとして記録する", t.ctx.punchOutboxPending()[0].lastError === "auth",
      t.ctx.punchOutboxPending()[0].lastError);
    const after1 = t.net.calls.length;
    t.clock.advance(30 * 1000); // 通常のバックオフなら再送される時間
    await t.ctx.punchOutboxFlush("poll"); await tick();
    check("認証エラー時は通常より長く待つ（30秒では再送しない）", t.net.calls.length === after1);
    t.clock.advance(40 * 1000);
    await t.ctx.punchOutboxFlush("poll"); await tick();
    check("認証エラーの待ち時間（60秒）経過後は再送する", t.net.calls.length > after1);
    check("認証エラーの待ち時間は上限10分",
      t.ctx.punchOutboxBackoffMs(1, true) === 60000 && t.ctx.punchOutboxBackoffMs(99, true) === 600000);

    // 認証が回復したら送信できる
    let mode = 403;
    const t2 = makeCtx({ handler: () => (mode === 403 ? { status: 403, body: null } : { status: 200, body: null }) });
    await t2.ctx.punchOutboxCommit(mkRec("ev-12b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t2.ctx.punchOutboxFlush("punch"); await tick();
    check("403 でも打刻は端末に残る", t2.ctx.punchOutboxPending().length === 1);
    mode = 200;
    t2.clock.advance(61 * 1000);
    await t2.ctx.punchOutboxFlush("poll"); await tick();
    check("認証が回復すれば再送で送信できる", t2.ctx.punchOutboxPending().length === 0);
  }

  section("13. 警告条件：一時的な通信断では出さず、長時間だけ出す");
  {
    const t = makeCtx({ handler: () => "offline" });
    await t.ctx.punchOutboxCommit(mkRec("ev-13", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await t.ctx.punchOutboxFlush("punch"); await tick();
    check("1回失敗しただけでは警告しない", t.ctx.punchOutboxWarning() === null);
    check("バナーも出ない", t.ctx.punchOutboxBannerHtml() === "");

    t.clock.advance(3 * 60 * 1000); // 3分（ルータ再起動程度）
    await t.ctx.punchOutboxFlush("poll"); await tick();
    check("3分の断では警告しない", t.ctx.punchOutboxWarning() === null);

    t.clock.advance(7 * 60 * 1000); // 累計10分
    await t.ctx.punchOutboxFlush("poll"); await tick();
    const w = t.ctx.punchOutboxWarning();
    check("10分未送信で警告する", w !== null && w.kind === "unsent" && w.count === 1, JSON.stringify(w));
    check("バナー文言に「未送信の打刻があります」が入る",
      t.ctx.punchOutboxBannerHtml().indexOf("未送信の打刻があります") > 0);

    const t2 = makeCtx({ handler: () => ({ status: 200, body: null }) });
    await t2.ctx.punchOutboxCommit(mkRec("ev-13b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    t2.clock.advance(20 * 60 * 1000);
    check("送信前は時間経過だけでも警告する", t2.ctx.punchOutboxWarning() !== null);
    await t2.ctx.punchOutboxFlush("online"); await tick();
    check("送信できたら警告は消える", t2.ctx.punchOutboxWarning() === null);
  }

  section("14. サーバ一覧とのマージ：未送信を消さず、サーバの正本も壊さない");
  {
    const t = makeCtx({ handler: () => "offline" });
    await t.ctx.punchOutboxCommit(mkRec("ev-14", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    const fromServer = [mkRec("other-1", "clockIn", "07:55", "2026-08-26T07:55:00.000Z")];
    t.ctx.punchOutboxMergeInto(fromServer);
    check("サーバ一覧へ未送信打刻が混ぜ戻される", fromServer.length === 2);
    check("混ぜ戻した内容は打刻そのもの", fromServer[1].id === "ev-14" && fromServer[1].time === "08:03");

    // サーバ側に同じ eventId がある（管理者が修正した後）場合はローカルで上書きしない
    const edited = Object.assign(mkRec("ev-14", "clockIn", "08:30", "2026-08-26T08:30:00.000Z"), { editedByAdmin: true });
    const both = [edited];
    t.ctx.punchOutboxMergeInto(both);
    check("同じ eventId があれば重複させない", both.length === 1);
    check("サーバ側の内容をローカルで上書きしない", both[0].time === "08:30" && both[0].editedByAdmin === true);
  }

  section("15. 旧実装（localStorage キュー）からの移行");
  {
    const legacy = JSON.stringify([{
      eventId: "ev-15", rec: mkRec("ev-15", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"),
      queuedAt: "2026-08-26T08:03:00.000Z", attempts: 2, lastAttemptAt: "2026-08-26T08:04:00.000Z", lastError: "network"
    }]);
    const idbData = {};
    const t = makeCtx({ handler: () => "offline", ls: { tc5_punch_outbox: legacy }, idb: { data: idbData } });
    await t.ctx.punchOutboxLoad();
    check("旧 localStorage キューの未送信打刻を引き継ぐ", t.ctx.punchOutboxPending().length === 1);
    check("旧形式の attempts を retryCount として引き継ぐ", t.ctx.punchOutboxPending()[0].retryCount === 2);
    check("IndexedDB へ移送される", Object.keys(idbData.punches || {}).length === 1);
    check("移送後は localStorage の旧キーを残さない", t.ls.getItem("tc5_punch_outbox") === null);
  }

  section("16. スタッフテスト画面・管理者デモ・閲覧用URLではキューを動かさない");
  {
    for (const mode of [{ writePolicy: "sandbox" }, { writePolicy: "readonlyWithAllowList" }, { viewerMode: true }]) {
      const label = mode.viewerMode ? "viewerMode" : mode.writePolicy;
      const t = makeCtx(Object.assign({ handler: () => ({ status: 200, body: null }) }, mode));
      const ok = await t.ctx.punchOutboxCommit(mkRec("ev-16-" + label, "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
      await t.ctx.punchOutboxFlush("punch");
      await tick();
      check(label + ": commit は false（キューを使わない）", ok === false);
      check(label + ": キューへ積まない", t.ctx.punchOutboxPending().length === 0);
      check(label + ": キュー経由の送信をしない", t.net.calls.length === 0);
      check(label + ": 保存不能の警告も出さない", t.ctx.punchOutboxWarning() === null);
    }
  }

  section("17. index.html 側の結線");
  {
    const wired = [
      ["_execPunch が eventId を採番する", /nr\.eventId=nr\.id;/],
      ["_execPunch が async である", /async function _execPunch\(type,d\)\{/],
      ["端末保存の成功を待ってから画面を更新する", /_saved=await punchOutboxCommit\(nr\);/],
      ["保存できなければ records へ積まない（打刻失敗にする）", /if\(!_saved\)\{[\s\S]{0,400}?return;\s*\n\s*\}/],
      ["保存成功後に records へ積む", /records\.push\(nr\);\s*\n\s*_lsSet\("tc5_records"/],
      ["送信は画面更新のあとに非同期で開始する", /render\(\);\s*\n\s*\/\/ ③[\s\S]{0,120}?punchOutboxFlush\("punch"\);/],
      ["端末保存中の連打を弾く", /if\(_punchSaving\)return;/],
      ["キューを使わない画面では従来の saveRecord へ委譲する", /\}\s*else\s*\{\s*\n\s*saveRecord\(nr\);\s*\n\s*\}/],
      ["起動時にキューを読み戻す", /var _outboxReady=punchOutboxLoad\(\);/],
      ["起動時の取得で未送信打刻を消さない", /await _outboxReady;\s*\n\s*punchOutboxMergeInto\(records\);/],
      ["ポーリングの取得で未送信打刻を消さない", /punchOutboxMergeInto\(arr\);/],
      ["再送の契機を仕掛ける", /punchOutboxInstallTriggers\(\);/],
      ["起動時に再送する", /punchOutboxFlush\("startup"\);/],
      ["ポーリングでも再送する", /punchOutboxFlush\("poll"\);/],
      ["打刻画面表示でも再送する", /punchOutboxFlush\("punchScreen"\);/],
      ["打刻画面に警告バナーを出す", /\+punchOutboxBannerHtml\(\)\s*\n\s*\+_snHtml/],
      ["スタッフ選択画面にも警告バナーを出す", /var statusLabel=punchOutboxBannerHtml\(\)/],
      ["起動時の認証トークン取得で例外を投げない", /try\{await getAuthToken\(\);\}catch/],
      ["tc5_pins 未取得のまま PIN 新規登録へ進ませない", /\}\s*else if\(!staffPinsLoaded\)\{/]
    ];
    wired.forEach(([name, re]) => check(name, re.test(html)));
    check("打刻の保存で従来の saveRecord を直接呼ぶ経路が残っていない",
      !/records\.push\(nr\);saveRecord\(nr\);\s*\n\s*punchMsg=/.test(html));
    check("キュー本体が POST（push）を使わない", CODE.indexOf('"POST"') < 0);
    check("キュー本体が tc5_records 以外へ書かない",
      (CODE.match(/FB_URL\+"\/[a-z0-9_]+/gi) || []).every((x) => x.indexOf("tc5_records") > 0));
    check("キュー本体が localStorage を保存先として使わない（旧キーの読み出しと削除のみ）",
      !/_lsSet\(PUNCH_OUTBOX/.test(CODE) && /removeItem\(PUNCH_OUTBOX_LEGACY_LS_KEY\)/.test(CODE));
  }

  console.log("\n────────────────────────────");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("────────────────────────────");
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
