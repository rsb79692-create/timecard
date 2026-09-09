#!/usr/bin/env node
/**
 * test-unapproved-summary.js — 承認漏れサマリー・通知件数集計の回帰テスト
 *
 * ★ 依存パッケージなし・送信なし・本番データ非アクセス。
 *
 * 固定する仕様:
 *   1. 過去日の未承認 (日付, 氏名) 組だけを数える（当日は数えない）
 *   2. 承認済みを誤検出しない／打刻の無い日を承認漏れにしない
 *   3. 削除済み打刻だけの日を承認漏れにしない
 *   4. 出勤のみ／退勤のみ／時刻欠落／勤務時間異常の判定が従来仕様のままであること
 *   5. ★ (日付, 氏名) 索引を使う高速版が、records 全件 filter の素朴版と完全に同じ結果を返すこと
 *      （速度のために判定結果を変えていないことの証明）
 *   6. 集計が records / approvals を書き換えないこと
 *
 * 実行: node scripts/test-unapproved-summary.js
 * 終了コード: 0=全PASS / 1=FAILあり
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}
function section(t) { console.log("\n── " + t + " ──"); }

// ===== 対象ブロックの抽出 =====
const BEGIN = "// ===== UNAPPROVED-SUMMARY-BEGIN =====";
const END = "// ===== UNAPPROVED-SUMMARY-END =====";
const bi = html.indexOf(BEGIN), ei = html.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error("[ERROR] UNAPPROVED-SUMMARY ブロックを index.html から抽出できません");
  process.exit(1);
}
const CODE = html.slice(bi + BEGIN.length, ei);

// 判定の中身（validateAttendanceRecord / isPastDate）も本体から切り出して使う。
// ★ スタブに置き換えると「判定が変わっていないこと」を確かめられない。
function pick(name) {
  const re = new RegExp("^function " + name + "\\([\\s\\S]*?\\n\\}", "m");
  const m = html.match(re);
  if (!m) { console.error("[ERROR] " + name + " を抽出できません"); process.exit(1); }
  return m[0];
}
const DEPS = pick("validateAttendanceRecord") + "\n" + pick("isPastDate") + "\n";

function makeCtx(opts) {
  opts = opts || {};
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, RegExp, isNaN, parseInt, parseFloat,
    records: opts.records || [],
    approvals: opts.approvals || {},
    correctionRequests: opts.correctionRequests || [],
    paidLeaveRequests: opts.paidLeaveRequests || [],
    masterFacilities: [],
    adminTab: "", showUnapprovedOnly: false, plHighlightId: null, showPaidLeaveHistory: false,
    render: () => {}, setTab: () => {},
    pad: (n) => (n < 10 ? "0" + n : "" + n),
    fmtDateKey: (d) => d.getFullYear() + "-" + (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1)
      + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate()
  };
  vm.createContext(sandbox);
  vm.runInContext(DEPS + CODE, sandbox);
  return sandbox;
}

// ===== 参照実装（変更前の素朴版）=====
// ★ 未承認の通知件数を、変更前の「notifyIds を records 全走査で作る」やり方でそのまま数える。
//   現行実装はこれを getUnapprovedSummary().total で置き換えているため、
//   **恒等であること**をここで固定する（同じ集合を数えているという主張の証明）。
function refNotifyUnapproved(ctx) {
  const notifyIds = {}, seen = {};
  ctx.records.filter((r) => !r.deleted && ctx.isPastDate(r.date)).forEach((r) => {
    const key = r.date + "__" + r.staff;
    if (seen[key]) return; seen[key] = true;
    if (!ctx.approvals[key]) notifyIds[key + "__unapproved"] = true;
  });
  return Object.keys(notifyIds).length;
}

// ★ 高速化前と同じ書き方をそのまま持つ。高速版がこれと一致することを確かめるためのもの。
function refNotificationCounts(ctx) {
  const records = ctx.records, approvals = ctx.approvals;
  const fmt = ctx.fmtDateKey;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = fmt(cutoff), todayStr = fmt(new Date());
  const missingList = [], seenMissing = {};
  records.filter((r) => !r.deleted && r.date < todayStr && r.date >= cutoffStr).forEach((r) => {
    const key = r.date + "__" + r.staff;
    if (seenMissing[key]) return; seenMissing[key] = true;
    if (approvals[key]) return;
    const sr = records.filter((rx) => rx.staff === r.staff && rx.date === r.date && !rx.deleted);
    const v = ctx.validateAttendanceRecord(r.staff, r.date, sr);
    if (!v.valid) missingList.push({ date: r.date, staff: r.staff, reason: v.reason });
  });
  return missingList;
}

// ===== テストデータ生成（決定的な擬似乱数）=====
function makeRecords(seed, days, staffN) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out = [];
  const base = new Date();
  for (let d = 1; d <= days; d++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() - d);
    const ds = dt.getFullYear() + "-" + (dt.getMonth() + 1 < 10 ? "0" : "") + (dt.getMonth() + 1)
      + "-" + (dt.getDate() < 10 ? "0" : "") + dt.getDate();
    for (let i = 0; i < staffN; i++) {
      const r = rnd();
      if (r < 0.12) continue;                                   // 出勤しない日
      const nm = "職員" + i;
      const ts = ds + "T00:30:00.000Z";
      out.push({ id: "in" + d + "_" + i, staff: nm, date: ds, type: "clockIn", time: "09:30", timestamp: ts,
                 workFacility: (i % 3 === 0 ? "ナナイロ" : (i % 3 === 1 ? "ハルイロ" : "")) });
      if (r < 0.20) continue;                                   // 退勤漏れ
      out.push({ id: "out" + d + "_" + i, staff: nm, date: ds, type: "clockOut",
                 time: (r < 0.24 ? "" : "18:30"), timestamp: ds + "T09:30:00.000Z" });
      if (r > 0.95) out.push({ id: "del" + d + "_" + i, staff: nm, date: ds, type: "clockIn",
                              time: "09:00", timestamp: ts, deleted: true });
    }
  }
  return out;
}
function makeApprovals(records, ratio, seed) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const ap = {}, seen = {};
  records.forEach((r) => {
    const k = r.date + "__" + r.staff;
    if (seen[k]) return; seen[k] = true;
    if (rnd() < ratio) ap[k] = true;
  });
  return ap;
}

const today = (() => { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1 < 10 ? "0" : "")
  + (d.getMonth() + 1) + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate(); })();
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1);
  return d.getFullYear() + "-" + (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1)
  + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate(); })();

section("1. 承認漏れサマリーの基本仕様");
{
  const recs = [
    { id: "a", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z", workFacility: "ナナイロ" },
    { id: "b", staff: "山田", date: yesterday, type: "clockOut", time: "18:00", timestamp: yesterday + "T09:00:00.000Z" },
    { id: "c", staff: "佐藤", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z", facilityName: "ハルイロ" },
    { id: "d", staff: "鈴木", date: today, type: "clockIn", time: "09:00", timestamp: today + "T00:00:00.000Z", workFacility: "ナナイロ" }
  ];
  const c = makeCtx({ records: recs, approvals: {} });
  const s1 = c.getUnapprovedSummary();
  check("過去日の未承認を検出する（2組）", s1.total === 2);
  check("人数を数える", s1.people === 2);
  check("★ 当日は承認漏れに数えない", !Object.keys(s1.byFacility).length || s1.total === 2);
  check("施設別の内訳を持つ", s1.byFacility["ナナイロ"] === 1 && s1.byFacility["ハルイロ"] === 1);

  const c2 = makeCtx({ records: recs, approvals: { [yesterday + "__山田"]: true } });
  check("承認済みを誤検出しない", c2.getUnapprovedSummary().total === 1);

  const c3 = makeCtx({ records: recs, approvals: { [yesterday + "__山田"]: true, [yesterday + "__佐藤"]: true } });
  check("すべて承認済みなら 0 件", c3.getUnapprovedSummary().total === 0);

  const c4 = makeCtx({ records: [], approvals: {} });
  check("★ 打刻が無い日を承認漏れにしない（打刻ゼロ＝0件）", c4.getUnapprovedSummary().total === 0);

  const c5 = makeCtx({ records: [{ id: "x", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z", deleted: true }] });
  check("削除済み打刻だけの日を承認漏れにしない", c5.getUnapprovedSummary().total === 0);

  const c6 = makeCtx({ records: [{ id: "y", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" }] });
  check("施設が無い打刻は「施設不明」へ入れる", c6.getUnapprovedSummary().byFacility["施設不明"] === 1);
}

section("2. 打刻漏れ判定（従来仕様から変えない）");
{
  const mk = (arr) => makeCtx({ records: arr, approvals: {} }).getNotificationCounts()._missingList;
  const inRec = { id: "i", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" };
  const outRec = { id: "o", staff: "山田", date: yesterday, type: "clockOut", time: "18:00", timestamp: yesterday + "T09:00:00.000Z" };
  check("出勤のみ＝退勤漏れ", mk([inRec]).length === 1 && mk([inRec])[0].reason === "退勤漏れ");
  check("退勤のみ＝出勤漏れ", mk([outRec]).length === 1 && mk([outRec])[0].reason === "出勤漏れ");
  check("出勤・退勤そろっていれば打刻漏れではない", mk([inRec, outRec]).length === 0);
  check("時刻が空＝データ不足",
    mk([inRec, { ...outRec, time: "" }])[0].reason === "データ不足");
  check("退勤が出勤より前＝勤務時間異常",
    mk([inRec, { ...outRec, timestamp: yesterday + "T00:00:00.000Z" }])[0].reason === "勤務時間異常");
  check("承認済みの日は打刻漏れとして数えない",
    makeCtx({ records: [inRec], approvals: { [yesterday + "__山田"]: true } })
      .getNotificationCounts()._missingList.length === 0);
}

section("3. ★ 索引版が素朴版と同じ結果を返す（高速化で判定を変えていない）");
{
  let same = true, cases = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const recs = makeRecords(seed * 7919, 40, 26);              // 26名 × 40日
    const ap = makeApprovals(recs, seed % 4 === 0 ? 0.0 : 0.7, seed * 104729);
    const c = makeCtx({ records: recs, approvals: ap });
    const got = c.getNotificationCounts()._missingList;
    const want = refNotificationCounts(c);
    cases++;
    if (JSON.stringify(got) !== JSON.stringify(want)) { same = false; console.log("    差分 seed=" + seed); }
  }
  check("素朴版（records 全件 filter）と完全一致（" + cases + "パターン）", same);

  // 未承認件数の恒等性（notifyIds の全走査を getUnapprovedSummary().total へ置き換えた分）
  let idSame = true, totalSame = true;
  for (let seed = 1; seed <= 8; seed++) {
    const recs = makeRecords(seed * 7919, 40, 26);
    const ap = makeApprovals(recs, seed % 4 === 0 ? 0.0 : 0.7, seed * 104729);
    const c = makeCtx({ records: recs, approvals: ap,
      correctionRequests: [{ status: "pending" }, { status: "approved" }],
      paidLeaveRequests: [{ status: "pending" }] });
    const n = c.getNotificationCounts();
    if (n.unapproved !== refNotifyUnapproved(c)) idSame = false;
    if (n.total !== refNotifyUnapproved(c) + 1 + 1) totalSame = false;
  }
  check("★ 未承認件数が変更前の notifyIds 全走査と恒等（8パターン）", idSame);
  check("★ 通知合計 = 未承認 + 修正申請 + 有給（変更前と同じ数え方。8パターン）", totalSame);

  // 30日窓の外の打刻を索引から外しても打刻漏れ判定が変わらないこと
  {
    const old = { id: "old", staff: "山田", date: "2020-01-05", type: "clockIn", time: "09:00", timestamp: "2020-01-05T00:00:00.000Z" };
    const recent = { id: "r1", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" };
    const c3 = makeCtx({ records: [old, recent], approvals: {} });
    check("★ 30日より古い打刻があっても打刻漏れ判定は素朴版と一致",
      JSON.stringify(c3.getNotificationCounts()._missingList) === JSON.stringify(refNotificationCounts(c3)));
    check("30日より古い未承認は「未承認」には数える（対象期間を狭めていない）",
      c3.getUnapprovedSummary().total === 2);
  }

  // 同姓同名でない別人・日付境界がまざっても取り違えない
  const recs2 = [
    { id: "1", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" },
    { id: "2", staff: "山田__", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" },
    { id: "3", staff: "__山田", date: yesterday, type: "clockOut", time: "18:00", timestamp: yesterday + "T09:00:00.000Z" }
  ];
  const c2 = makeCtx({ records: recs2, approvals: {} });
  check("氏名に区切り文字が入っていても素朴版と一致",
    JSON.stringify(c2.getNotificationCounts()._missingList) === JSON.stringify(refNotificationCounts(c2)));
}

section("4. 通知件数の合計");
{
  const recs = [
    { id: "a", staff: "山田", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" },
    { id: "b", staff: "佐藤", date: yesterday, type: "clockIn", time: "09:00", timestamp: yesterday + "T00:00:00.000Z" }
  ];
  const c = makeCtx({
    records: recs, approvals: {},
    correctionRequests: [{ status: "pending" }, { status: "approved" }],
    paidLeaveRequests: [{ status: "pending" }, { status: "pending" }, { status: "rejected" }]
  });
  const n = c.getNotificationCounts();
  check("未承認 2 件", n.unapproved === 2);
  check("修正申請の未対応 1 件", n.pendingCorrectionRequests === 1);
  check("有給申請の未対応 2 件", n.pendingPaidLeave === 2);
  check("合計は 未承認 + 修正申請 + 有給（打刻漏れは含めない）", n.total === 2 + 1 + 2);
}

section("5. 集計は正本を書き換えない");
{
  const recs = makeRecords(31, 20, 10);
  const ap = makeApprovals(recs, 0.5, 77);
  const c = makeCtx({ records: recs, approvals: ap });
  const beforeR = JSON.stringify(c.records), beforeA = JSON.stringify(c.approvals);
  c.getUnapprovedSummary(); c.getNotificationCounts();
  check("records を書き換えない", JSON.stringify(c.records) === beforeR);
  check("approvals を書き換えない", JSON.stringify(c.approvals) === beforeA);
  check("集計ブロックが通信・保存を行わない",
    !/authFetch|fetchJson|_lsSet|localStorage/.test(CODE));
}

section("6. 26名規模の処理量");
{
  const recs = makeRecords(4242, 180, 26);                      // 約半年・26名
  const ap = makeApprovals(recs, 0.0, 5);                       // 全件未承認（最悪ケース）
  const c = makeCtx({ records: recs, approvals: ap });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) c.getNotificationCounts();
  const fastMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) refNotificationCounts(c);
  const slowMs = Date.now() - t1;
  console.log("    打刻 " + recs.length + "件 / 20回: 索引版 " + fastMs + "ms / 素朴版 " + slowMs + "ms");
  check("★ 索引版が素朴版より遅くならない（最悪ケースで悪化させない）", fastMs <= slowMs);
}

console.log("\n────────────────────────────");
console.log("  PASS " + pass + " / FAIL " + fail);
console.log("────────────────────────────");
process.exit(fail ? 1 : 0);
