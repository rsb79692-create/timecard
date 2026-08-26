/**
 * 打刻オフラインキュー（端末保存＋自動再送）の回帰テスト
 * （依存パッケージなし・送信なし・本番データ非アクセス）
 *
 * 実行: node scripts/test-punch-outbox.js
 *
 * 目的:
 *   打刻を「押した瞬間に端末で確定 → 画面は即打刻済み → 送信は裏で再送」にしたときに、
 *   給与へ直結する次の性質が崩れないよう固定する。
 *
 *   1. 二重登録が起きないこと
 *      送信先は必ず /tc5_records/{eventId}.json（PUT）で、POST（push）を使わない。
 *      「サーバには保存されたがクライアントは失敗扱い」になった打刻は、再送時に
 *      GET で存在確認して書き直さない（管理者の修正も巻き戻さない）。
 *   2. 打刻時刻が送信時刻で上書きされないこと
 *      timestamp / time / date は打刻時のまま。sentAt（送信時刻）と
 *      serverReceivedAt（サーバ受信時刻）は別フィールドで区別する。
 *   3. 通信失敗で打刻が消えないこと
 *      未送信打刻は IndexedDB と localStorage の両方へ残り、再起動後に復元される。
 *      サーバから打刻一覧を取り直しても、未送信分が画面から消えない。
 *   4. 警告が過剰にならないこと
 *      一時的な通信断では出さず、5分以上未送信または5回以上失敗で出す。
 *   5. スタッフテスト画面・管理者デモ・閲覧用URLではキューが動かないこと
 *      （テスト打刻を端末へ残して本番へ再送しない）
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、該当ブロックだけを抜き出して
 *   vm コンテキストで評価し、DOM・通信・IndexedDB・localStorage をモックする。
 *   本番データへは一切アクセスしない。
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
  return { Date: FakeDate, advance(ms) { offset += ms; }, get ms() { return base + offset; } };
}

/** localStorage の最小実装 */
function makeLocalStorage() {
  const map = {};
  return {
    __map: map,
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) { map[k] = String(v); },
    removeItem(k) { delete map[k]; }
  };
}

/** IndexedDB の最小実装（open / transaction / put / delete / getAll のみ） */
function makeFakeIndexedDB(sharedData) {
  const dbData = sharedData || {};
  const db = {
    objectStoreNames: { contains(n) { return Object.prototype.hasOwnProperty.call(dbData, n); } },
    createObjectStore(n) { dbData[n] = {}; return {}; },
    transaction(name) {
      const tx = {};
      const queued = [];
      const store = {
        put(v) { queued.push(() => { dbData[name][v.eventId] = v; }); return {}; },
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
      setTimeout(() => { queued.forEach((f) => f()); if (tx.oncomplete) tx.oncomplete(); }, 0);
      return tx;
    }
  };
  return {
    __data: dbData,
    open() {
      const req = {};
      setTimeout(() => {
        req.result = db;
        if (!dbData.punches && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

/**
 * 通信モック。calls に全リクエストを記録する。
 * handler(url, opts, call) が返すもの:
 *   {status,body}   … その内容で応答
 *   "offline"       … 通信断（reject）
 */
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

/** 実行コンテキストを1つ組み立てる */
function makeCtx(opts) {
  opts = opts || {};
  const clock = makeClock();
  const ls = makeLocalStorage();
  const net = makeFetch(opts.handler || (() => ({ status: 200, body: null })));
  const savedByLegacy = [];
  let renderCount = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, JSON, Object, Math, Array, String, Number, Error, isNaN,
    Date: clock.Date,
    encodeURIComponent,
    localStorage: ls,
    indexedDB: opts.noIndexedDb ? undefined : makeFakeIndexedDB(opts.idbData),
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

/** 打刻レコードを1件作る（_execPunch が作る形と同じ最小構成） */
function mkRec(id, type, time, iso) {
  return {
    id, eventId: id, staff: "山田 太郎", type,
    date: "2026-08-26", time, timestamp: iso,
    facilityName: "ナナイロ", workFacility: "ナナイロ"
  };
}

/** マイクロタスク・setTimeout(0) を消化する */
function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 6); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ───────── テスト ─────────

async function run() {

  section("1. 正常通信：打刻は端末へ即保存され、そのままサーバへ送られる");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    const rec = mkRec("ev-1", "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
    t.ctx.records.push(rec);
    t.ctx.punchOutboxSave(rec);

    // 送信結果を待たずに、この時点で端末保存が済んでいること
    check("押下直後に端末（localStorage）へ未送信打刻が残る",
      JSON.parse(t.ls.getItem("tc5_punch_outbox") || "[]").length === 1);
    check("押下直後に打刻一覧のキャッシュも更新される",
      JSON.parse(t.ls.getItem("tc5_records") || "[]").length === 1);
    check("送信は非同期（この時点ではまだキューに残っている）",
      t.ctx.punchOutboxPending().length === 1);

    await tick();
    const put = t.net.calls.filter((c) => c.method === "PUT");
    check("PUT が1回だけ発行される", put.length === 1, "calls=" + JSON.stringify(t.net.calls.map((c) => c.method)));
    check("送信先は /tc5_records/{eventId}.json",
      put[0] && put[0].url === "https://example.invalid/honomi/tc5_records/ev-1.json", put[0] && put[0].url);
    check("POST（push）でノードを採番させない",
      t.net.calls.every((c) => c.method !== "POST"));
    check("送信できたらキューから消える", t.ctx.punchOutboxPending().length === 0);
    check("localStorage の未送信キューも空になる", t.ls.getItem("tc5_punch_outbox") === null);
    check("IndexedDB からも消える",
      Object.keys(t.ctx.indexedDB.__data.punches || {}).length === 0);
    check("通常時は警告を出さない", t.ctx.punchOutboxWarning() === null);
  }

  section("2. 打刻時刻・送信時刻・event_id を取り違えない");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    const rec = mkRec("ev-2", "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
    t.ctx.punchOutboxSave(rec);
    t.clock.advance(2 * 60 * 60 * 1000); // 2時間後に送信できたことにする
    await tick();
    const body = t.net.calls.find((c) => c.method === "PUT").body;
    check("timestamp（実打刻時刻）が送信時刻で上書きされない", body.timestamp === "2026-08-26T08:03:00.000Z", body.timestamp);
    check("time（実打刻時刻）が送信時刻で上書きされない", body.time === "08:03", body.time);
    check("date が送信日で上書きされない", body.date === "2026-08-26", body.date);
    check("eventId が本文にも入る", body.eventId === "ev-2");
    check("sentAt（送信時刻）を別フィールドで持つ", typeof body.sentAt === "string" && body.sentAt !== body.timestamp, body.sentAt);
    check("serverReceivedAt はサーバ側で入れる（サーバ値センチネル）",
      body.serverReceivedAt && body.serverReceivedAt[".sv"] === "timestamp", JSON.stringify(body.serverReceivedAt));
  }

  section("2b. サーバ受信時刻を書けなくても打刻本体は落とさない");
  {
    // serverReceivedAt（サーバ値センチネル）を含む PUT が 400 で拒否される環境を想定
    const t = makeCtx({
      handler: (url, o, call) => {
        if ((o.method || "GET") !== "PUT") return { status: 200, body: null };
        if (call.body && call.body.serverReceivedAt) return { status: 400, body: null };
        return { status: 200, body: null };
      }
    });
    t.ctx.punchOutboxSave(mkRec("ev-2b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    const puts = t.net.calls.filter((c) => c.method === "PUT");
    check("serverReceivedAt を外して書き直す", puts.length === 2 && !puts[1].body.serverReceivedAt);
    check("打刻時刻は書き直しても変わらない", puts[1].body.timestamp === "2026-08-26T08:03:00.000Z");
    check("書き直しても同じ eventId のノード（二重登録しない）",
      puts.every((c) => c.url.indexOf("/tc5_records/ev-2b.json") > 0));
    check("最終的に送信済みになる", t.ctx.punchOutboxPending().length === 0);
  }

  section("3. 完全オフライン：打刻は消えず、端末へ残る");
  {
    const idbData = {};
    const t = makeCtx({ handler: () => "offline", idbData });
    const rec = mkRec("ev-3", "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
    t.ctx.records.push(rec);
    t.ctx.punchOutboxSave(rec);
    await tick();
    check("送信に失敗してもキューから消えない", t.ctx.punchOutboxPending().length === 1);
    check("失敗理由が network として記録される", t.ctx.punchOutboxPending()[0].lastError === "network");
    check("localStorage に残る", JSON.parse(t.ls.getItem("tc5_punch_outbox")).length === 1);
    check("IndexedDB に残る", Object.keys(idbData.punches || {}).length === 1);
    check("オフラインの短時間では警告を出さない", t.ctx.punchOutboxWarning() === null);

    // アプリ再起動（メモリを捨てて localStorage / IndexedDB から復元）
    const t2 = makeCtx({ handler: () => "offline", idbData });
    t2.ls.setItem("tc5_punch_outbox", t.ls.getItem("tc5_punch_outbox"));
    await t2.ctx.punchOutboxLoad();
    check("再起動後も未送信打刻が復元される", t2.ctx.punchOutboxPending().length === 1);
    check("復元した打刻の時刻が変わらない", t2.ctx.punchOutboxPending()[0].rec.time === "08:03");

    // 通信復旧
    const t3 = makeCtx({ handler: (u, o) => ((o.method || "GET") === "GET" ? { status: 200, body: null } : { status: 200, body: null }), idbData });
    await t3.ctx.punchOutboxLoad();
    t3.clock.advance(5 * 1000); // 再起動〜復旧までの経過
    await t3.ctx.punchOutboxFlush("online");
    await tick();
    check("復旧後の再送で送信され、キューが空になる", t3.ctx.punchOutboxPending().length === 0);
    check("復旧後の再送も同じ eventId のノードへ書く",
      t3.net.calls.filter((c) => c.method === "PUT").every((c) => c.url.indexOf("/tc5_records/ev-3.json") > 0));
  }

  section("4. IndexedDB が使えない端末でも localStorage だけで残る");
  {
    const t = makeCtx({ handler: () => "offline", noIndexedDb: true });
    t.ctx.punchOutboxSave(mkRec("ev-4", "clockOut", "17:30", "2026-08-26T17:30:00.000Z"));
    await tick();
    check("IndexedDB 無しでも端末へ保存される", JSON.parse(t.ls.getItem("tc5_punch_outbox")).length === 1);
    const t2 = makeCtx({ noIndexedDb: true });
    t2.ls.setItem("tc5_punch_outbox", t.ls.getItem("tc5_punch_outbox"));
    await t2.ctx.punchOutboxLoad();
    check("IndexedDB 無しでも再起動後に復元される", t2.ctx.punchOutboxPending().length === 1);
  }

  section("5. タイムアウト：サーバは保存済みだがクライアントは失敗扱い → 再送しても二重登録しない");
  {
    // 1回目: PUT はサーバへ届いたが応答が返らなかった（＝クライアントは失敗扱い）
    // 2回目: GET で存在確認 → 既にあるので書かない
    let stored = null;
    const t = makeCtx({
      handler: (url, o, call, n) => {
        const m = (o.method || "GET");
        if (m === "PUT" && n === 1) { stored = call.body; return "offline"; } // 届いたが応答なし
        if (m === "GET") return { status: 200, body: stored };
        return { status: 200, body: null };
      }
    });
    t.ctx.punchOutboxSave(mkRec("ev-5", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    check("1回目は失敗扱いでキューに残る", t.ctx.punchOutboxPending().length === 1);

    t.clock.advance(30 * 1000); // バックオフを越える
    await t.ctx.punchOutboxFlush("retry");
    await tick();
    const puts = t.net.calls.filter((c) => c.method === "PUT");
    const gets = t.net.calls.filter((c) => c.method === "GET");
    check("再送前にサーバの存在を確認する（GET が入る）", gets.length === 1);
    check("既にサーバにあるので上書きしない（PUT は1回のまま）", puts.length === 1, "PUT=" + puts.length);
    check("再送でキューから消える（送信済み扱い）", t.ctx.punchOutboxPending().length === 0);
    check("そもそも別ノードは作られない（全リクエストが同一 eventId のパス）",
      t.net.calls.every((c) => c.url.indexOf("/tc5_records/ev-5.json") > 0));
  }

  section("6. 再送で管理者の修正を巻き戻さない");
  {
    // サーバ側には「管理者が時刻を修正した同一 eventId のレコード」がある想定
    const edited = Object.assign(mkRec("ev-6", "clockIn", "08:30", "2026-08-26T08:30:00.000Z"), { editedByAdmin: true });
    const t = makeCtx({
      handler: (url, o, call, n) => {
        if ((o.method || "GET") === "PUT" && n === 1) return "offline";
        if ((o.method || "GET") === "GET") return { status: 200, body: edited };
        return { status: 200, body: null };
      }
    });
    t.ctx.punchOutboxSave(mkRec("ev-6", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    t.clock.advance(30 * 1000);
    await t.ctx.punchOutboxFlush("retry");
    await tick();
    check("サーバに既にあるレコードを再送で上書きしない",
      t.net.calls.filter((c) => c.method === "PUT").length === 1);
  }

  section("7. 複数件：オフライン中の複数打刻が打刻順に送られる");
  {
    const t = makeCtx({ handler: () => ({ status: 200, body: null }) });
    // わざと逆順に投入する
    t.ctx.punchOutboxEnqueue(mkRec("ev-c", "clockOut", "17:30", "2026-08-26T17:30:00.000Z"));
    t.ctx.punchOutboxEnqueue(mkRec("ev-a", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    t.ctx.punchOutboxEnqueue(mkRec("ev-b", "breakStart", "12:00", "2026-08-26T12:00:00.000Z"));
    const order = t.ctx.punchOutboxPending().map((e) => e.eventId);
    check("キューは打刻時刻の昇順", JSON.stringify(order) === JSON.stringify(["ev-a", "ev-b", "ev-c"]), JSON.stringify(order));
    await t.ctx.punchOutboxFlush("test");
    await tick();
    const sent = t.net.calls.filter((c) => c.method === "PUT").map((c) => c.body.eventId);
    check("送信も打刻順", JSON.stringify(sent) === JSON.stringify(["ev-a", "ev-b", "ev-c"]), JSON.stringify(sent));
    check("3件とも送信済みになる", t.ctx.punchOutboxPending().length === 0);
  }

  section("8. 再送間隔（バックオフ）：連続失敗しても叩き続けない");
  {
    const t = makeCtx({ handler: () => "offline" });
    t.ctx.punchOutboxSave(mkRec("ev-8", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    const after1 = t.net.calls.length;
    await t.ctx.punchOutboxFlush("immediate"); // 待たずにもう一度
    await tick();
    check("バックオフ中は再送しない", t.net.calls.length === after1, "calls=" + t.net.calls.length);
    t.clock.advance(6 * 1000);
    await t.ctx.punchOutboxFlush("after-backoff");
    await tick();
    check("バックオフ経過後は再送する", t.net.calls.length > after1);
    check("間隔は指数的に伸びる（上限あり）",
      t.ctx.punchOutboxBackoffMs(1) === 5000 &&
      t.ctx.punchOutboxBackoffMs(2) === 10000 &&
      t.ctx.punchOutboxBackoffMs(3) === 20000 &&
      t.ctx.punchOutboxBackoffMs(99) === 5 * 60 * 1000);

    // 通信復旧・起動・画面復帰は「状況が変わった」契機なのでバックオフを待たない
    const t2 = makeCtx({ handler: () => "offline" });
    t2.ctx.punchOutboxSave(mkRec("ev-8b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    for (let i = 0; i < 6; i++) { t2.clock.advance(10 * 60 * 1000); await t2.ctx.punchOutboxFlush("poll"); await tick(); }
    const before = t2.net.calls.length;
    t2.clock.advance(1000);
    await t2.ctx.punchOutboxFlush("poll"); await tick();
    check("長いバックオフ中は定期再送しない", t2.net.calls.length === before);
    t2.clock.advance(3 * 1000);
    await t2.ctx.punchOutboxFlush("online"); await tick();
    check("通信復旧の契機ではバックオフを待たずに再送する", t2.net.calls.length > before);
  }

  section("9. 警告条件：一時的な通信断では出さず、続いたときだけ出す");
  {
    const t = makeCtx({ handler: () => "offline" });
    t.ctx.punchOutboxSave(mkRec("ev-9", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    await tick();
    check("1回失敗しただけでは警告しない", t.ctx.punchOutboxWarning() === null);
    check("バナーも出ない", t.ctx.punchOutboxBannerHtml() === "");

    // 4回失敗・4分経過までは出さない
    for (let i = 0; i < 3; i++) { t.clock.advance(60 * 1000); await t.ctx.punchOutboxFlush("r"); await tick(); }
    const w4 = t.ctx.punchOutboxPending()[0];
    check("4回失敗・4分経過では警告しない", w4.attempts === 4 && t.ctx.punchOutboxWarning() === null,
      "attempts=" + w4.attempts);

    t.clock.advance(60 * 1000);
    await t.ctx.punchOutboxFlush("r"); await tick();
    const w = t.ctx.punchOutboxWarning();
    check("5回失敗（=5分経過）で警告する", w !== null && w.count === 1, JSON.stringify(w));
    check("バナー文言に「未送信の打刻があります」が入る",
      t.ctx.punchOutboxBannerHtml().indexOf("未送信の打刻があります") > 0);

    // 送信できたら警告は消える
    const t2 = makeCtx({ handler: () => ({ status: 200, body: null }) });
    t2.ctx.punchOutboxEnqueue(mkRec("ev-9b", "clockIn", "08:03", "2026-08-26T08:03:00.000Z"));
    t2.clock.advance(10 * 60 * 1000);
    check("送信前は時間経過だけでも警告する", t2.ctx.punchOutboxWarning() !== null);
    await t2.ctx.punchOutboxFlush("r"); await tick();
    check("送信できたら警告は消える", t2.ctx.punchOutboxWarning() === null);
  }

  section("10. サーバから打刻一覧を取り直しても未送信打刻が消えない");
  {
    const t = makeCtx({ handler: () => "offline" });
    const rec = mkRec("ev-10", "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
    t.ctx.punchOutboxSave(rec);
    await tick();
    const fromServer = [mkRec("other-1", "clockIn", "07:55", "2026-08-26T07:55:00.000Z")];
    t.ctx.punchOutboxMergeInto(fromServer);
    check("サーバ一覧へ未送信打刻が混ぜ戻される", fromServer.length === 2);
    check("混ぜ戻した内容は打刻そのもの", fromServer[1].id === "ev-10" && fromServer[1].time === "08:03");
    // 既にサーバ側にも入っている場合は重複させない
    const both = [mkRec("ev-10", "clockIn", "08:03", "2026-08-26T08:03:00.000Z")];
    t.ctx.punchOutboxMergeInto(both);
    check("サーバ側にも同じ eventId があれば重複させない", both.length === 1);
  }

  section("11. スタッフテスト画面・管理者デモ・閲覧用URLではキューを動かさない");
  {
    for (const mode of [{ writePolicy: "sandbox" }, { writePolicy: "readonlyWithAllowList" }, { viewerMode: true }]) {
      const label = mode.viewerMode ? "viewerMode" : mode.writePolicy;
      const t = makeCtx(Object.assign({ handler: () => ({ status: 200, body: null }) }, mode));
      const rec = mkRec("ev-11-" + label, "clockIn", "08:03", "2026-08-26T08:03:00.000Z");
      t.ctx.punchOutboxSave(rec);
      await tick();
      check(label + ": キューへ積まない", t.ctx.punchOutboxPending().length === 0);
      check(label + ": 端末へ未送信打刻を残さない", t.ls.getItem("tc5_punch_outbox") === null);
      check(label + ": 既存の saveRecord 経路（従来動作）へ委譲する", t.savedByLegacy.length === 1);
      check(label + ": キュー経由の送信をしない", t.net.calls.length === 0);
    }
  }

  section("12. index.html 側の結線（打刻経路がキューを通っていること）");
  {
    const wired = [
      ["_execPunch が eventId を採番する", /nr\.eventId=nr\.id;/],
      ["_execPunch の保存がキュー経由", /records\.push\(nr\);punchOutboxSave\(nr\);/],
      ["起動時にキューを読み戻す", /var _outboxReady=punchOutboxLoad\(\);/],
      ["起動時の取得で未送信打刻を消さない", /await _outboxReady;\s*\n\s*punchOutboxMergeInto\(records\);/],
      ["ポーリングの取得で未送信打刻を消さない", /punchOutboxMergeInto\(arr\);/],
      ["再送の契機を仕掛ける", /punchOutboxInstallTriggers\(\);/],
      ["起動完了時に再送する", /punchOutboxFlush\("startup"\);/],
      ["ポーリングでも再送する", /punchOutboxFlush\("poll"\);/],
      ["打刻画面表示でも再送する", /punchOutboxFlush\("punchScreen"\);/],
      ["打刻画面に警告バナーを出す", /\+punchOutboxBannerHtml\(\)\s*\n\s*\+_snHtml/],
      ["スタッフ選択画面にも警告バナーを出す", /var statusLabel=punchOutboxBannerHtml\(\)/]
    ];
    wired.forEach(([name, re]) => check(name, re.test(html)));
    check("打刻の保存で従来の saveRecord を直接呼ばない（キュー未経由の送信を残さない）",
      !/records\.push\(nr\);saveRecord\(nr\);\s*\n\s*punchMsg=/.test(html));
    check("キュー本体が POST（push）を使わない", CODE.indexOf('"POST"') < 0 && CODE.indexOf("method:\"POST\"") < 0);

    // 通信断でも起動が「通信エラー」画面で止まらないこと（止まると打刻自体ができない）
    check("起動時の認証トークン取得で例外を投げない",
      /try\{await getAuthToken\(\);\}catch/.test(html));
    // 上の変更で通信断時もスタッフ選択に到達するため、PIN未取得のまま新規登録させない
    check("tc5_pins 未取得のまま PIN 新規登録へ進ませない",
      /\}\s*else if\(!staffPinsLoaded\)\{/.test(html));
    check("tc5_pins は取得成功（不在含む）のときだけ既読扱いにする",
      /if\(!r\.ok\)throw new Error\("pins HTTP "\+r\.status\);/.test(html));
    check("キュー本体が tc5_records 以外へ書かない",
      (CODE.match(/FB_URL\+"\/[a-z0-9_]+/gi) || []).every((x) => x.indexOf("tc5_records") > 0));
  }

  console.log("\n────────────────────────────");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("────────────────────────────");
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
