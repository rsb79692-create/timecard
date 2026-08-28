#!/usr/bin/env node
/**
 * test-records-range.js — tc5_records の期間取得 と app shell キャッシュの回帰テスト
 *
 * ★ 依存パッケージなし・送信なし・本番データ非アクセス。
 *
 * 固定する仕様:
 *   1. 取得済み範囲を「区間の集合」で持ち、未取得の部分（gap）だけを取りに行くこと
 *   2. 月末を "-31" で表す上限値でも区間の隣接判定が壊れないこと
 *   3. 管理・労務士画面の入口が tc5_records を全件取得しないこと
 *   4. 月／年セレクタの選択肢が「最古の打刻日1件」から機械的に作られ、候補が減らないこと
 *   5. 承認漏れ・有給付与の自動算出が「未取得の期間を 0 件と誤認しない」こと（フェイルクローズ）
 *   6. 打刻画面の起動時取得が当日のみのままであること
 *   7. sw.js が app shell 以外（Firebase / 認証 / API）を Cache Storage へ入れないこと
 *
 * 実行: node scripts/test-records-range.js
 * 終了コード: 0=全PASS / 1=FAILあり
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}
function section(t) { console.log("\n── " + t + " ──"); }

// ===== 対象ブロックの抽出 =====
const BEGIN = "// ===== RECORDS-RANGE-BEGIN =====";
const END = "// ===== RECORDS-RANGE-END =====";
const bi = html.indexOf(BEGIN), ei = html.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error("[ERROR] RECORDS-RANGE ブロックを index.html から抽出できません");
  process.exit(1);
}
const CODE = html.slice(bi + BEGIN.length, ei);

// ===== サンドボックス =====
function makeCtx(opts) {
  opts = opts || {};
  const net = { calls: [] };
  const sandbox = {
    console,
    setTimeout: (fn, ms) => { (sandbox.__timers = sandbox.__timers || []).push({ fn, ms }); return 0; },
    Date, Math, JSON, Object, Array, String, Number, RegExp, isNaN, parseInt, parseFloat,
    // --- アプリ側スタブ ---
    FB_URL: "https://example.invalid/honomi",
    records: opts.records || [],
    recordsReady: false, recordsStale: false, monthRecordsReady: false,
    _recLoadedDay: "",
    _LAZY_RETRY_MS: 5000,
    screen: opts.screen || "admin",
    viewerMode: !!opts.viewerMode,
    writePolicy: opts.writePolicy || "full",
    adminTab: opts.adminTab || "records",
    selMonth: opts.selMonth || "2026-08",
    selDate: opts.selDate || "2026-08-28",
    reviewMonth: opts.reviewMonth || "2026-07",
    mealAdminMonth: opts.mealAdminMonth || "",
    adjLogMonth: opts.adjLogMonth || "",
    monthlyDaysYear: opts.monthlyDaysYear || 2026,
    mileage: opts.mileage || { adminYm: "", myMonth: "" },
    showPaidLeaveForm: false, _paidLeaveRenderGuard: false, monthlyDaysEditing: false,
    mileageBlocksRerender: () => false,
    punchOutboxMergeInto: () => {},
    render: () => { sandbox.__renders = (sandbox.__renders || 0) + 1; },
    document: { querySelector: () => null },
    pad: (n) => (n < 10 ? "0" + n : "" + n),
    fmtDateKey: (d) => d.getFullYear() + "-" + sandbox.pad(d.getMonth() + 1) + "-" + sandbox.pad(d.getDate()),
    monthKey: (iso) => (iso ? iso.substring(0, 7) : ""),
    addYm: (ym, n) => {
      const p = ym.split("-");
      const t = parseInt(p[0], 10) * 12 + (parseInt(p[1], 10) - 1) + n;
      return Math.floor(t / 12) + "-" + sandbox.pad((t % 12) + 1);
    },
    getJSTMonthRange: () => ({ first: "2026-08-01" }),
    loadData: (k, d) => (opts.ls && opts.ls[k] !== undefined ? opts.ls[k] : d),
    // ★ 期間取得ブロックは前半の script ブロックにあり、loadData() はまだ定義されていない。
    //   そのため端末保存は localStorage を直接読む。テストでも同じ経路を通す。
    localStorage: {
      getItem: (k) => (opts.ls && opts.ls[k] !== undefined ? JSON.stringify(opts.ls[k]) : null),
      setItem: () => {}
    },
    _lsSet: () => {},
    fetchJson: (url) => {
      net.calls.push(url);
      const r = opts.handler ? opts.handler(url) : null;
      return Promise.resolve(r);
    },
    // fetchRecordsRange は「取得失敗」と「該当 0 件」を区別するため authFetch を直接使う。
    // handler の戻り値: Promise=ハング / "fail"=HTTPエラー / null=該当 0 件 / その他=データ
    authFetch: (url) => {
      net.calls.push(url);
      const r = opts.handler ? opts.handler(url) : null;
      if (r && typeof r.then === "function") return r;
      if (r === "fail") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r === undefined ? null : r) });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { ctx: sandbox, net };
}
function runTimers(t) {
  const list = t.ctx.__timers || [];
  t.ctx.__timers = [];
  list.forEach((x) => { try { x.fn(); } catch (e) {} });
}
const tick = () => new Promise((r) => setImmediate(r));
// 非同期の検証はここへ積み、すべての同期セクションのあとでまとめて解決する
const asyncChecks = [];

// ===================================================================
section("1. 日付ヘルパ（区間の隣接判定）");
{
  const t = makeCtx({});
  const c = t.ctx;
  check("翌日: 2026-08-28 → 2026-08-29", c._recNextDay("2026-08-28") === "2026-08-29");
  check("翌日: 月末 2026-06-30 → 2026-07-01", c._recNextDay("2026-06-30") === "2026-07-01");
  check("翌日: 上限表記 2026-06-31 → 2026-07-01（Date へ素で渡すと 07-02 になる）",
    c._recNextDay("2026-06-31") === "2026-07-01");
  check("翌日: 上限表記 2026-02-31 → 2026-03-01", c._recNextDay("2026-02-31") === "2026-03-01");
  check("翌日: 年またぎ 2026-12-31 → 2027-01-01", c._recNextDay("2026-12-31") === "2027-01-01");
  check("前日: 2026-07-01 → 2026-06-30", c._recPrevDay("2026-07-01") === "2026-06-30");
}

section("2. 取得済み区間の集合");
{
  const t = makeCtx({});
  const c = t.ctx;
  check("初期状態では何も取得済みでない", c.recordsRangeCovers("2026-08-01", "2026-08-31") === false);
  c._recAddIv("2026-08-01", "2026-08-31");
  check("当月を取得したら当月は covered", c.recordsRangeCovers("2026-08-10", "2026-08-20") === true);
  check("取得していない月は covered にならない", c.recordsRangeCovers("2026-07-01", "2026-07-31") === false);
  c._recAddIv("2026-06-01", "2026-06-31");
  check("飛び地は結合されない（6月と8月のあいだの7月は未取得のまま）",
    c.recordsRangeCovers("2026-06-01", "2026-08-31") === false);
  check("gap は 7月だけになる",
    JSON.stringify(c._recGaps("2026-06-01", "2026-08-31")) ===
    JSON.stringify([{ from: "2026-07-01", to: "2026-07-31" }]));
  c._recAddIv("2026-07-01", "2026-07-31");
  check("あいだを埋めると 6〜8月がひと続きになる",
    c.recordsRangeCovers("2026-06-01", "2026-08-31") === true);
  check("埋めたあと gap は無い", c._recGaps("2026-06-01", "2026-08-31").length === 0);
}
{
  const t = makeCtx({});
  const c = t.ctx;
  c._recAddIv("2026-08-28", "2026-08-28");           // 起動時の当日取得
  const gaps = c._recGaps("2026-08-14", "2026-08-28"); // 打刻画面の直近14日
  check("当日取得済みなら直近14日の gap は前半だけ（当日を取り直さない）",
    gaps.length === 1 && gaps[0].from === "2026-08-14" && gaps[0].to === "2026-08-27");
}
{
  const t = makeCtx({});
  const c = t.ctx;
  c._recAddIv("2026-06-01", "2026-06-31");
  const gaps = c._recGaps("2026-05-01", "2026-07-31");
  check("前後に gap がある場合は先頭の gap から返す",
    gaps.length === 2 && gaps[0].from === "2026-05-01" && gaps[0].to === "2026-05-31" &&
    gaps[1].from === "2026-07-01" && gaps[1].to === "2026-07-31");
}

section("3. ensureRecordsRange は未取得部分だけを取りに行く");
{
  const t = makeCtx({ handler: () => ({}) });
  const c = t.ctx;
  c._recAddIv("2026-08-28", "2026-08-28");
  c.ensureRecordsRange("2026-08-14", "2026-08-28");
  check("1回だけ取得する", t.net.calls.length === 1);
  check("startAt が gap の先頭になる", /startAt=%222026-08-14%22/.test(t.net.calls[0]));
  check("endAt が gap の末尾（当日の前日）になる", /endAt=%222026-08-27%22/.test(t.net.calls[0]));
  check("orderBy=\"date\" を使う（.indexOn 前提）", /orderBy=%22date%22/.test(t.net.calls[0]));
}
{
  const t = makeCtx({ handler: () => ({}) });
  const c = t.ctx;
  c._recAddIv("2026-08-01", "2026-08-31");
  c.ensureRecordsRange("2026-08-10", "2026-08-20");
  check("取得済みなら通信しない", t.net.calls.length === 0);
}
{
  const t = makeCtx({ handler: () => new Promise(() => {}) });
  const c = t.ctx;
  c.ensureRecordsRange("2026-08-01", "2026-08-31");
  c.ensureRecordsRange("2026-07-01", "2026-07-31");
  check("同時に走らせるのは1本だけ", t.net.calls.length === 1);
}

section("3-B. 「取得失敗」と「該当0件」を区別する（review-agent 指摘の再発防止）");
{
  // ★ RTDB REST は該当0件でも 200 + null を返す。区別できないと「打刻が1件も無い期間」を
  //   永久に未取得扱いし、5秒ごとに取り直し続け、全期間スキャンもそこで止まる。
  const t = makeCtx({ handler: () => null });   // 200 + null ＝ 該当0件
  const c = t.ctx;
  asyncChecks.push(c.ensureRecordsRange("2020-01-01", "2020-01-31").then(() => {
    check("★ 該当0件でも区間を取得済みとして登録する（無限リトライにしない）",
      c.recordsRangeCovers("2020-01-01", "2020-01-31") === true);
    check("該当0件なら records は増えない", c.records.length === 0);
    const before = t.net.calls.length;
    c.ensureRecordsRange("2020-01-01", "2020-01-31");
    check("2回目は通信しない", t.net.calls.length === before);
  }));
}
{
  const t = makeCtx({ handler: () => "fail" });   // HTTP エラー ＝ 取得失敗
  const c = t.ctx;
  asyncChecks.push(c.ensureRecordsRange("2020-02-01", "2020-02-31").then(() => {
    check("★ 取得失敗のときは区間を登録しない（未取得を取得済みにしない）",
      c.recordsRangeCovers("2020-02-01", "2020-02-31") === false);
  }));
}

section("4. 管理・労務士画面の入口（全件取得をしない）");
{
  const t = makeCtx({ handler: () => ({}), adminTab: "records", ls: { tc5_records_oldest: "2026-04-01" } });
  t.ctx.ensureAdminRecordRanges();
  const full = t.net.calls.filter((u) => /tc5_records\.json$/.test(u));
  check("入口で tc5_records の全件取得をしない", full.length === 0);
  // ★ limitToFirst=1 にしない：date を持たない子が先頭へ来得るため、
  //   1件だけ見て弾くと運用開始月が永久に確定しない（フェイルクローズが解除不能になる）。
  check("最古日の取得は少数件を見て最小の有効日を採る",
    t.net.calls.some((u) => /limitToFirst=[2-9]/.test(u)) &&
    /arr\.forEach\(function\(r\)\{[\s\S]{0,300}?if\(!d\|\|x<d\)d=x;/.test(html));
  check("選択月の範囲取得を行う",
    t.net.calls.some((u) => /startAt=%222026-08-01%22/.test(u)));
}
{
  const t = makeCtx({ handler: () => ({}), adminTab: "monthlyDays", monthlyDaysYear: 2026,
                      ls: { tc5_records_oldest: "2026-04-01" } });
  t.ctx._recAddIv("2026-08-01", "2026-08-31");
  t.ctx.ensureAdminRecordRanges();
  check("月別出勤日数タブは選択年の範囲を取得する",
    t.net.calls.some((u) => /startAt=%222026-01-01%22/.test(u)));
  check("月別出勤日数タブでも全件取得はしない",
    t.net.calls.filter((u) => /tc5_records\.json$/.test(u)).length === 0);
}
{
  const t = makeCtx({ handler: () => ({}), viewerMode: true, screen: "admin",
                      reviewMonth: "2026-07", ls: { tc5_records_oldest: "2026-04-01" } });
  t.ctx.ensureAdminRecordRanges();
  check("労務士画面は対象月（reviewMonth）だけを取得する",
    t.net.calls.some((u) => /startAt=%222026-07-01%22/.test(u)));
  check("労務士画面で全件取得はしない",
    t.net.calls.filter((u) => /tc5_records\.json$/.test(u)).length === 0);
}

section("5. 全期間の分割取得（承認漏れ・有給付与）");
{
  const t = makeCtx({ handler: () => ({}), screen: "admin", ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  check("開始時点では確定していない（0件と断定しない）", c.recordsHistoryReady() === false);
  // 当月から古い月へ1か月ずつ
  const seen = [];
  for (let i = 0; i < 8; i++) {
    c._recHistoryWant = true;
    c._recHistoryStep();
    const last = t.net.calls[t.net.calls.length - 1] || "";
    const m = last.match(/startAt=%22(\d{4}-\d{2})-01%22/);
    if (m && seen.indexOf(m[1]) < 0) { seen.push(m[1]); c._recAddIv(m[1] + "-01", m[1] + "-31"); }
    c._recRangePromise = null; c._recRangeWant = ""; c._recRangeLastTry = 0;
  }
  check("新しい月から順に取得する（2026-08 → 2026-04）",
    JSON.stringify(seen) === JSON.stringify(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]));
  check("1回の取得は1か月分だけ（1MBを一度に取らない）",
    t.net.calls.filter((u) => /tc5_records\.json$/.test(u)).length === 0);
  check("運用開始月まで取り終えたら確定する", c.recordsHistoryReady() === true);
  check("確定後は全期間が covered", c.recordsRangeCovers("2026-04-01", "2026-08-31") === true);
}
{
  const t = makeCtx({ handler: () => ({}), screen: "punch", ls: { tc5_records_oldest: "2026-04-01" } });
  t.ctx._recHistoryWant = true;
  t.ctx._recHistoryStep();
  check("打刻画面では全期間スキャンを走らせない", t.net.calls.length === 0);
}
{
  const t = makeCtx({ handler: () => ({}), screen: "admin", writePolicy: "sandbox",
                      ls: { tc5_records_oldest: "2026-04-01" } });
  t.ctx._recHistoryWant = true;
  t.ctx._recHistoryStep();
  check("スタッフテスト画面（sandbox）では本番を取りに行かない", t.net.calls.length === 0);
}

section("6. 月／年セレクタの選択肢");
{
  const t = makeCtx({ ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  const ms = c.recordsMonthOptions([]);
  const cur = c.monthKey(c.recToday());
  check("運用開始月が含まれる", ms.indexOf("2026-04") >= 0);
  check("当月が含まれる", ms.indexOf(cur) >= 0);
  check("降順（新しい月が先頭）", ms[0] === ms.slice().sort().reverse()[0]);
  check("あいだの月が抜けない", ms.indexOf("2026-06") >= 0 && ms.indexOf("2026-07") >= 0);
  check("指定した月は必ず候補に入る", c.recordsMonthOptions(["2020-01"]).indexOf("2020-01") >= 0);
  const ys = c.recordsYearOptions([]);
  check("年の候補に運用開始年が入る", ys.indexOf(2026) >= 0);
  check("年の候補に当年が入る", ys.indexOf(new Date().getFullYear()) >= 0);
}
{
  // 最古日が未取得でも、メモリ上の records の月は候補から落とさない
  const t = makeCtx({ records: [{ date: "2025-11-05", timestamp: "2025-11-05T00:00:00.000Z" }] });
  const ms = t.ctx.recordsMonthOptions([]);
  check("最古日が未取得でも records にある月は候補に残る", ms.indexOf("2025-11") >= 0);
  check("その場合も当月まで連続で候補になる",
    ms.indexOf("2026-01") >= 0 || ms.indexOf(t.ctx.monthKey(t.ctx.recToday())) >= 0);
}

section("7. フェイルクローズ（未取得の月を 0 件と誤認しない）");
{
  const t = makeCtx({ ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  c._recAddIv("2026-08-01", "2026-08-31");
  check("取得済みの月は known", c.recordsMonthKnown("2026-08") === true);
  check("未取得の月は known ではない（取込値へ落とさない）", c.recordsMonthKnown("2026-06") === false);
  check("運用開始より前の月は known（打刻が存在しない＝従来どおり取込値へ）",
    c.recordsMonthKnown("2026-01") === true);
  check("未来の月は known", c.recordsMonthKnown("2099-01") === true);
  c._recFull = true;
  check("全期間の取得が終われば全月 known", c.recordsMonthKnown("2026-06") === true);
}

section("7-B. 未取得を「データ無し」と断定しない（security-agent 指摘の再発防止）");
{
  // H-2 / M-1: 運用開始月が未確定（端末に tc5_records_oldest が無い）状態
  const t = makeCtx({ records: [{ date: "2026-08-10", timestamp: "2026-08-10T00:00:00.000Z" }] });
  const c = t.ctx;
  check("運用開始月が未確定なら recordsOperationStartMonth() は空",
    c.recordsOperationStartMonth() === "");
  check("選択肢用の recordsOldestMonth() は推定値を返す（候補を減らさない）",
    c.recordsOldestMonth() === "2026-08");
  check("★ 運用開始月が未確定のあいだは過去月を known と断定しない",
    c.recordsMonthKnown("2026-05") === false);
  c._recHistoryWant = true;
  c._recHistoryStep();
  check("★ 運用開始月が未確定のあいだは全期間スキャンを確定させない",
    c.recordsHistoryReady() === false);
}
{
  // H-1: 日付が変わったら取得済み区間をすべて捨てる
  const t = makeCtx({ handler: () => ({}), ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  c._recAddIv("2026-04-01", "2026-08-31");
  c._recFull = true;
  check("★ 日付変更時のリセットが _recIvs / _recFull を対象にしている",
    /_recIvs=\[\];_recFull=false;/.test(html));
  check("旧変数 _recRange は完全に廃止されている（「こちらを直せばよい」と誤認させない）",
    !/_recRange\.(from|to|full)/.test(html));
}
{
  // M-2: 当月の上限は当日で頭打ちにする
  const t = makeCtx({ ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  const today = c.recToday();
  const curYm = today.substring(0, 7);
  check("当月の上限は当日", c.recMonthEnd(curYm) === today);
  check("過去月の上限は月末表記", c.recMonthEnd("2026-04") === "2026-04-31");
  check("当年の上限は当日", c.recYearEnd(today.substring(0, 4)) === today);
  check("過去年の上限は年末", c.recYearEnd("2025") === "2025-12-31");
  // 打刻画面と同じ「…〜当日」の取得で当月が known になること
  c._recAddIv(curYm + "-01", today);
  check("★ 打刻画面の取得範囲（…〜当日）で当月が known になる（移動距離カードが恒久エラーにならない）",
    c.recordsMonthKnown(curYm) === true);
}
{
  // M-1: 運用開始月が確定していれば全期間スキャンは確定できる
  const t = makeCtx({ handler: () => ({}), ls: { tc5_records_oldest: "2026-04-01" } });
  const c = t.ctx;
  const today = c.recToday();
  let m = c.monthKey(today);
  for (let i = 0; i < 24 && m >= "2026-04"; i++) { c._recAddIv(m + "-01", c.recMonthEnd(m)); m = c.addYm(m, -1); }
  c._recHistoryWant = true;
  c._recHistoryStep();
  check("運用開始月が確定していれば全期間スキャンが確定する", c.recordsHistoryReady() === true);
}

section("7-C. 打刻端末（運用開始月が未確定のまま）でも取得済みの月は known");
{
  // ★ ensureRecordsOldest() は管理・労務士画面からしか呼ばれない。打刻端末では
  //   recordsOperationStartMonth() が恒久的に空のままになる。
  //   このとき「実際に取得済みか」を先に見ないと、移動距離カードの
  //   「打刻データを読み込めていません」が消えない誤警告として常設される。
  const t = makeCtx({});                      // ls を与えない＝運用開始月は未確定
  const c = t.ctx;
  const today = c.recToday();
  const curYm = today.substring(0, 7);
  check("前提: 運用開始月は未確定", c.recordsOperationStartMonth() === "");
  check("取得前は当月を known と断定しない", c.recordsMonthKnown(curYm) === false);
  c._recAddIv(curYm + "-01", today);          // punchScreenRecordRange() と同じ「…〜当日」
  check("★ 運用開始月が未確定でも、実際に取得済みの当月は known",
    c.recordsMonthKnown(curYm) === true);
  check("取得していない過去月は known にしない（フェイルクローズは維持）",
    c.recordsMonthKnown("2020-05") === false);
}
{
  // ★ 最古日の取得はセッション中1回だけ。ただし失敗し続ける端末は再試行できること。
  const ok = makeCtx({ handler: () => ({ a: { date: "2026-04-01" } }) });
  asyncChecks.push(ok.ctx.ensureRecordsOldest().then(() => {
    const before = ok.net.calls.length;
    ok.ctx._recOldestLastTry = 0;             // 間隔ガードを外しても
    ok.ctx.ensureRecordsOldest();
    check("★ 最古日の取得に成功したら二度と取りに行かない", ok.net.calls.length === before);
    check("最古日が反映されている", ok.ctx.recordsOperationStartMonth() === "2026-04");
  }));
  const ng = makeCtx({ handler: () => null }); // fetchJson スタブは null＝取得失敗
  asyncChecks.push(ng.ctx.ensureRecordsOldest().then(() => {
    const before = ng.net.calls.length;
    ng.ctx._recOldestLastTry = 0;
    ng.ctx.ensureRecordsOldest();
    check("★ 取得に失敗した端末は再試行できる（恒久停止しない）", ng.net.calls.length > before);
  }));
}
{
  // ★ 1本のハングが他の期間取得を巻き込んで永久に止めない
  const t = makeCtx({ handler: () => new Promise(() => {}) });
  const c = t.ctx;
  c.ensureRecordsRange("2026-08-01", "2026-08-31");
  check("停滞前は2本目を走らせない", t.net.calls.length === 1);
  c._recRangeLastTry = Date.now() - 60000;    // 30秒を超えて止まっている状態
  c.ensureRecordsRange("2026-07-01", "2026-07-31");
  check("★ 30秒を超えたら別の期間取得を走らせる", t.net.calls.length === 2);
  check("追い越された古い応答を捨てる仕組みがある",
    /if\(_recRangePromise!==p\)return;/.test(html));
}

section("8. index.html 側の結線");
{
  const wired = [
    ["管理・労務士画面の入口が ensureAdminRecordRanges を呼ぶ", /\n\s*ensureAdminRecordRanges\(\);/],
    ["入口の全件取得（ensureRecordsFull）が残っていない", /^(?!.*ensureRecordsFull)/s],
    ["起動時の打刻取得は当日のみ", /function loadPunchRecords\(\)\{var d=recToday\(\);return fetchRecordsRange\(d,d\);\}/],
    ["10秒ポーリングは当日分だけ取る", /var _pd=recToday\(\);\s*\n\s*fetchRecordsRange\(_pd,_pd\)/],
    ["朝出勤確認の更新も当日分だけ取る", /mRefBtn\.textContent="更新中…"[\s\S]{0,300}?fetchRecordsRange\(_d,_d\)/],
    ["全件取得のヘルパを残していない（使えるところにあると必ず使われる）", /^(?!.*function fetchRecordsAll)/s],
    ["改名は全期間の取得が終わるまで実行しない", /if\(!recordsHistoryReady\(\)\)\{\s*\n\s*ensureRecordsHistory\(\);/],
    ["承認漏れバナーが集計中を明示する", /_unapvScanning=!recordsHistoryReady\(\)/],
    ["承認漏れ 0 件のときも集計中を明示する", /承認漏れを集計中です/],
    ["有給付与の自動算出が未取得月を取込値へ落とさない", /if\(!recordsMonthKnown\(ym\)\)return\{days:0,src:"none"\};/],
    ["移動距離の警告が対象月の取得状況で判定される（管理）", /!recordsMonthKnown\(mileage\.adminYm\)/],
    ["移動距離の警告が対象月の取得状況で判定される（職員）", /!recordsMonthKnown\(mileage\.myMonth\)/],
    // ★ known 判定は cnt>0 より先。部分取得の月を「確信値」として返さない
    ["有給の自動算出は known 判定を打刻件数より先に行う",
      /if\(!recordsMonthKnown\(ym\)\)return\{days:0,src:"none"\};\s*\n\s*if\(cnt>0\)return\{days:cnt,src:"punch"\};/],
    // ★ 取得範囲を絞ったせいで在籍スタッフが打刻追加の候補から消えない
    ["「打刻を追加」の氏名候補に在籍スタッフを併合する",
      /var allNames=\[\.\.\.new Set\(staffList\.filter\([\s\S]{0,200}?\.concat\(records\.map/],
    // ★ 管理画面を離れたら履歴スキャンのタイマーを止める（打刻端末で永久に回さない）
    ["履歴スキャンのポンプは管理画面を離れると止まる",
      /function _recHistoryTick\(\)\{[\s\S]{0,400}?if\(_recFull\|\|screen!=="admin"\|\|viewerMode\|\|writePolicy==="sandbox"\)\{[\s\S]{0,400}?_recHistoryPumping=false;/],
    ["停滞判定の経過時間は再開時に戻す（離席しただけで警告を出さない）",
      /if\(!_recFull\)_recHistoryStartedAt=0;/],
    // ★ 改名時の端末保存はクォータ超過で例外を投げない経路を通す
    ["改名の端末保存が localStorage 直呼びでない",
      /records\.forEach\(function\(r\)\{if\(r\.staff===orig\)r\.staff=newN;\}\);[\s\S]{0,300}?_lsSet\("tc5_records"/],
    ["SW からの更新通知でバナーを出す", /d\.type!=='APP_UPDATE_AVAILABLE'/],
    // ★ 期間取得ブロックは前半の script ブロックにあり、loadData() は後半で定義される。
    //   評価時点で呼ぶと ReferenceError になり、その script ブロックの残り
    //   （_LAZY_RETRY_MS の初期化など）が丸ごと実行されなくなる。実機で発生させた事故。
    ["期間取得ブロックが評価時に loadData() を呼ばない", /^(?!.*var _recOldestDate=loadData)/s],
    ["最古日の端末保存は参照時に遅延復元する", /function _recOldestFromStorage\(\)\{[\s\S]{0,400}?localStorage\.getItem\("tc5_records_oldest"\)/],
    ["SW が古い版を報告したらバナーを出す", /if\(_swSaysStale\)\{_appVersionLastCheck=now;_appUpdateNotified=true;_showAppUpdateBanner\(\);return;\}/],
    // ★ 「後で」を押した直後の画面復帰で即再表示されないこと（間隔ゲートのあとで判定する）
    ["_swSaysStale の判定は5分間隔ゲートのあと", /if\(now-_appVersionLastCheck<APP_VERSION_MIN_GAP_MS\)return;\s*\n\s*if\(_swSaysStale\)/],
    ["recordsReady のガードを外していない", /if\(!recordsReady&&writePolicy==="full"\)\{/]
  ];
  wired.forEach(([name, re]) => check(name, re.test(html)));
  check("tc5_records の絞り込みなしの全件 GET が 1 箇所も残っていない",
    (html.match(/tc5_records\.json"\)/g) || []).length === 0);
}

section("9. sw.js（app shell キャッシュ）");
{
  check("CACHE_NAME が v13 以上へ更新されている", /const CACHE_NAME = 'timecard-v(1[3-9]|[2-9]\d)'/.test(sw));
  check("activate で旧キャッシュを削除する", /keys\.filter\(function\(k\) \{ return k !== CACHE_NAME; \}\)/.test(sw));
  check("ナビゲーションをキャッシュから返す（stale-while-revalidate）",
    /cache\.match\(SHELL_URL\)[\s\S]{0,300}?revalidateShell\(cache, cached\)/.test(sw));
  check("裏の版確認は HEAD で行う（本体を毎回取り直さない）",
    /fetch\(SHELL_URL, \{ method: 'HEAD', cache: 'no-store' \}\)/.test(sw));
  check("版が取れないときは必ず本体を取り直す（古い画面を残さない）",
    /if \(!known\) return doUpdate\(\)/.test(sw));
  check("版が変わったら画面へ通知する", /notifyClients\(\{ type: 'APP_UPDATE_AVAILABLE' \}\)/.test(sw));
  check("ok でない応答をキャッシュしない", /if \(!res \|\| !res\.ok \|\| res\.status !== 200\) return null;/.test(sw));
  check("app shell 以外のページ（manual.html 等）は素通しする",
    /if \(!isShellRequest\(event\.request\.url\)\) return;/.test(sw));
  check("キャッシュキーはクエリを含まない固定パスへ正規化する",
    /const SHELL_URL = new URL\(SHELL_PATH, self\.location\.origin\)\.href;/.test(sw));
  // ★ Cache Storage へ書き込むのは app shell（cache.put）と OFFLINE_URLS（addAll）だけ
  const puts = sw.match(/cache\.put\(\s*([A-Za-z_$][\w$]*)/g) || [];
  check("cache.put の対象は app shell と版マーカーだけ（勤怠データ・認証・API を保存しない）",
    puts.length === 2 && puts.some((x) => /SHELL_URL$/.test(x)) && puts.some((x) => /SERVED_KEY$/.test(x)));
  check("版マーカーに入れるのは ETag だけ",
    /markServed\(cache, shellVersionOf\(cached\)\)/.test(sw));
  check("通知を取りこぼしたタブへ再通知する（最後に返した版と比べる）",
    /if \(served && served !== shellVersionOf\(cached\)\) \{[\s\S]{0,140}?notifyClients/.test(sw));
  check("ETag の弱い印（W/）を正規化して比較する", /function normVersion\(v\)/.test(sw));
  check("install で app shell を取りに行かない（初回訪問の二重取得を避ける）",
    /self\.addEventListener\('install'[\s\S]*?return cache\.addAll\(OFFLINE_URLS\)\.catch\(function\(\) \{\}\);/.test(sw));
  check("読み込み完了後の CACHE_APP_SHELL で app shell を保存する",
    /data\.type === 'CACHE_APP_SHELL'/.test(sw) && /return cached \? null : fetchAndStoreShell\(cache, true\);/.test(sw));
  check("ページ側が CACHE_APP_SHELL を送る",
    /postMessage\(\{type:'CACHE_APP_SHELL'\}\)/.test(html));
  const addAlls = sw.match(/cache\.addAll\(([^)]*)\)/g) || [];
  check("addAll は OFFLINE_URLS だけ", addAlls.length === 1 && /OFFLINE_URLS/.test(addAlls[0]));
  const offlineList = (sw.match(/const OFFLINE_URLS = \[([\s\S]*?)\];/) || [, ""])[1];
  const offlineUrls = (offlineList.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  check("OFFLINE_URLS は同一オリジンの静的アセットだけ（外部・API・認証を含まない）",
    offlineUrls.length > 0 && offlineUrls.every((u) => /^\/timecard\/[A-Za-z0-9._-]+$/.test(u)));
  check("OFFLINE_URLS に HTML を含めない（app shell は専用の経路で扱う）",
    offlineUrls.every((u) => !/\.html$/.test(u)));
  check("ナビゲーション以外では cache.put を呼ばない（fetch ハンドラ後半）",
    !/mode === 'navigate'[\s\S]*?\n\s*\}\n\n[\s\S]*?cache\.put/.test(sw.split("// ===== それ以外 =====")[1] || ""));
  check("POST/PUT/PATCH をキャッシュ対象にしない", /if \(event\.request\.method !== 'GET'\) return;/.test(sw));
}

Promise.all(asyncChecks).then(() => {
  console.log("\n────────────────────────────");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("────────────────────────────");
  process.exit(fail ? 1 : 0);
});
