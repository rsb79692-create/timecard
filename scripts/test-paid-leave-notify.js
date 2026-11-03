/**
 * test-paid-leave-notify.js — 有給の付与日 LINE通知の回帰テスト（docs/features/paid-leave-grant-notify.md）
 *
 * 依存パッケージなし・送信なし・本番データ非アクセス（合成データのみ。https は模擬に差し替える）。
 *
 * 実行: node scripts/test-paid-leave-notify.js
 *
 * 方式:
 *   scripts/paid-leave-notify.js の純粋関数を直接呼ぶ。
 *   index.html の calcPaidLeaveSchedule / getPaidLeaveUnregistered（と normalizePaidLeaveBalance・resolveStaffId）を
 *   抜き出して vm で動かし、通知側の判定と同じ結果になることを検査する（片方だけ直すとここで落ちる）。
 */
"use strict";
// index.html の付与日の算出は端末の時刻（運用は JST）で動くので、比較の基準は JST に固定する。
process.env.TZ = "Asia/Tokyo";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const https = require("https");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "paid-leave-notify.js");
const N = require(SCRIPT);
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const WF = fs.readFileSync(path.join(ROOT, ".github", "workflows", "paid-leave-notify.yml"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function slice(a, b) {
  const s = html.indexOf(a), e = s < 0 ? -1 : html.indexOf(b, s);
  if (s < 0 || e < 0) { console.error("ERROR: index.html から抽出できませんでした: " + a); process.exit(1); }
  return html.slice(s, e);
}

// ===== index.html の実物を vm で動かす =====
const SCHED = slice("function parsePaidLeaveHireDate(dateStr){", "// 週所定労働日数（5日以上=5,4,3,2,1");
const FMT = slice("function fmtDateKey(d){", "\n");
const UNREG = slice("function getPaidLeaveUnregistered(){", "function calcMs(");
// 関数の終わり（行頭の "}"）まで。index.html は CRLF。
function sliceFn(a) {
  const s = html.indexOf(a);
  const m = s < 0 ? null : /\r?\n\}\r?\n/.exec(html.slice(s));
  if (!m) { console.error("ERROR: index.html から抽出できませんでした: " + a); process.exit(1); }
  return html.slice(s, s + m.index + m[0].length);
}
const NORM = sliceFn("function normalizePaidLeaveBalance(b){");
const RESOLVE = sliceFn("function resolveStaffId(staffName) {");

// 「今日」を固定した Date（引数なしの new Date() だけ差し替える）
function fixedDate(todayYmd) {
  const fixed = new Date(todayYmd + "T12:00:00+09:00").getTime();
  return class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
}
function htmlCtx(todayYmd) {
  const c = vm.createContext({ Date: fixedDate(todayYmd), String, Object, Array, JSON, Math, parseInt, isNaN, console });
  vm.runInContext(
    "function pad(n){return String(n).padStart(2,'0');}\n" + FMT + "\n" + SCHED + "\n" + NORM + "\n" + RESOLVE + "\n" + UNREG +
    "\nvar staffList=[],paidLeaveBalances=[],records=[];" +
    "\nfunction calcExpiresAt(g){return '';}" +
    "\nfunction calculatePaidLeaveGrantDays(){return null;}" +
    "\nfunction calcAutoGrantFromAttendance(){return null;}" +
    "\nthis.run=function(staff,bal){staffList=staff;paidLeaveBalances=bal.filter(Boolean).map(function(x){return normalizePaidLeaveBalance(x);});" +
    "return getPaidLeaveUnregistered();};this.sched=calcPaidLeaveSchedule;",
    c);
  return c;
}
const pick = (g) => ({ staffId: g.staffId, staffName: g.staffName, grantNum: g.grantNum, grantDate: g.grantDate, expiresAt: g.expiresAt });

console.log("■ 付与日の一覧は index.html の calcPaidLeaveSchedule と一致する");
{
  const hires = [
    "2015-04-01", "2020-01-31", "2020-02-29", "2019-08-31", "2024-12-31", "2026-03-01", "2010-07-15", "2025-04-30",
    "2019-02-28", "2023-08-29", "2023-08-30", "2025-05-03", "2026-05-03", "2026-05-04",
    "2015/04/01", "2015.4.1", "20150401", "2015-4-1", " 2015-04-01 ", "2019-02-30", "2019-04-31",
    "2026-11-03", "2027-01-01", "1999-12-31",
  ];
  const todays = ["2026-11-03", "2026-11-02", "2024-02-29", "2026-12-31", "2027-01-01"];
  let all = true, bad = "";
  todays.forEach((t) => {
    const c = htmlCtx(t);
    hires.forEach((h) => {
      const a = JSON.stringify(N.calcGrantSchedule(h, t)), b = JSON.stringify(c.sched(h));
      if (a !== b) { all = false; bad += `\n    今日=${t} 入社=${JSON.stringify(h)}: ${a} vs ${b}`; }
    });
  });
  check("入社日 " + hires.length + " 通り × 今日 " + todays.length + " 通りで付与日・期限が同じ", all, bad);
  // 読めない形は通知側では空（index.html も空になるもの）
  const c = htmlCtx("2026-11-03");
  ["", null, undefined, "abc", "2015-13-01", "2015-02-32", "2015-00-10"].forEach((h) => {
    check("読めない入社日 " + JSON.stringify(h) + " は付与なし（index.html も同じ）",
      N.calcGrantSchedule(h, "2026-11-03").length === 0 && c.sched(h).length === 0);
  });
}

console.log("■ 月末・閏年・付与日の当日");
{
  const s = (h, t) => N.calcGrantSchedule(h, t).map((x) => x.grantNum + ":" + x.grantDate + ":" + x.expiresAt).join(",");
  check("1/31 入社 → 第1回 7/31（7月は31日まである）", s("2026-01-31", "2026-07-31") === "1:2026-07-31:2028-07-30", s("2026-01-31", "2026-07-31"));
  check("8/31 入社 → 第1回は 2/31 が無いので 3/3（平年）", s("2026-08-31", "2027-03-03") === "1:2027-03-03:2029-03-02", s("2026-08-31", "2027-03-03"));
  check("8/31 入社 → 閏年は 3/2", s("2023-08-31", "2024-03-02") === "1:2024-03-02:2026-03-01", s("2023-08-31", "2024-03-02"));
  check("2/29 入社 → 第1回 8/29・第2回 翌年 8/29", s("2024-02-29", "2025-08-29") === "1:2024-08-29:2026-08-28,2:2025-08-29:2027-08-28", s("2024-02-29", "2025-08-29"));
  check("8/29 入社 → 第1回は閏年の 2/29", s("2023-08-29", "2024-02-29") === "1:2024-02-29:2026-02-28");
  check("付与日の前日はまだ含めない", s("2026-05-03", "2026-11-02") === "");
  check("付与日の当日は含める", s("2026-05-03", "2026-11-03") === "1:2026-11-03:2028-11-02");
  check("期限は2年後の前日（月初の付与は前月末）", s("2026-03-01", "2026-09-01") === "1:2026-09-01:2028-08-31");
}

console.log("■ タイムゾーンに依存しない（Actions は UTC で動く）");
{
  const code = "const N=require(" + JSON.stringify(SCRIPT) + ");" +
    "process.stdout.write(JSON.stringify(['2020-01-31','2019-08-31','2024-02-29','2015/04/01','20230829'].map(h=>N.calcGrantSchedule(h,'2026-11-03')))" +
    "+'|'+N.jstYmd(Date.UTC(2026,10,2,15,0,0))+'|'+N.isMondayYmd('2026-11-02'));";
  const outs = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"].map((tz) =>
    spawnSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ: tz }), encoding: "utf8" }).stdout);
  check("JST・UTC・西側・東側の TZ で同じ結果", outs[0] && outs.every((o) => o === outs[0]), outs.join("\n"));
}

console.log("■ JST の日付境界と曜日");
{
  check("2026-11-01 14:59:59 UTC は JST 11/1 23:59:59", N.jstYmd(Date.UTC(2026, 10, 1, 14, 59, 59)) === "2026-11-01");
  check("2026-11-01 15:00:00 UTC は JST 11/2", N.jstYmd(Date.UTC(2026, 10, 1, 15, 0, 0)) === "2026-11-02");
  check("cron 22:40 UTC は JST の翌日 7:40", N.jstYmd(Date.UTC(2026, 10, 2, 22, 40, 0)) === "2026-11-03");
  check("年末の境界 12/31 15:00 UTC は JST 1/1", N.jstYmd(Date.UTC(2026, 11, 31, 15, 0, 0)) === "2027-01-01");
  check("2026-11-02 は月曜", N.isMondayYmd("2026-11-02") === true);
  check("2026-11-03 は月曜ではない", N.isMondayYmd("2026-11-03") === false);
  check("2026-11-01（日）は月曜ではない", N.isMondayYmd("2026-11-01") === false);
  check("不正な日付は月曜扱いしない", N.isMondayYmd("2026-11-2") === false && N.isMondayYmd("") === false);
  check("TARGET_DATE の検証: 実在しない日は不可", N.isValidYmd("2026-02-29") === false && N.isValidYmd("2024-02-29") === true && N.isValidYmd("2026-1-1") === false);
}

// 合成スタッフ（実在の人物ではない）
const TODAY = "2026-11-03";   // 火曜
const MONDAY = "2026-11-02";
const STAFF = [
  { name: "山田太郎", employeeId: "1001", hireDate: "2026-05-03", status: "在籍" },        // 第1回 2026-11-03（今日）
  { name: "佐藤花子", employeeId: "1002", hireDate: "2025/05/03", status: "在籍" },        // 第1回 2025-11-03（登録済み）・第2回 2026-11-03（今日）
  { name: "鈴木一郎", employeeId: "", hireDate: "2026-05-03", status: "在籍" },            // 社員番号なし
  { name: "高橋次郎", employeeId: "1004", hireDate: "", status: "在籍" },                  // 入社日なし
  { name: "伊藤四郎", employeeId: "1006", hireDate: "2026-05-03", status: "退職" },        // 退職
  { name: "渡辺五郎", employeeId: "1007", hireDate: "2026-05-03", status: "在籍" },        // 社員番号重複
  { name: "中村六郎", employeeId: "1007", hireDate: "2026-05-03", status: "在籍" },        // 社員番号重複
  { name: "小林七子", employeeId: " 1009 ", hireDate: "2026-04-15", status: "在籍" },      // 第1回 2026-10-15（過ぎて未登録）
  { name: "加藤八子", employeeId: "1010", hireDate: "2018-05-03", status: "在籍" },        // 古い回は期限切れ・第8回 2026-11-03 は旧形式（氏名）で登録済み
  { name: "吉田九子", employeeId: "1011", hireDate: "2026-05-02", status: "在籍" },        // 第1回 2026-11-02（昨日・月曜）
  { name: "退職十郎", employeeId: "1012", hireDate: "2026-05-03", status: "退職" },
  { name: "未来一郎", employeeId: "1013", hireDate: "2026-05-04", status: "在籍" },        // 第1回 2026-11-04（明日）
  null,
];
const BAL = [
  { staffId: "1002", staffName: "佐藤花子", grantDate: "2025-11-03", grantedDays: 10, usedDays: 0, remainDays: 10 },
  { staffId: "加藤八子", staffName: "加藤八子", grantDate: "2026-11-03", grantedDays: 20, usedDays: 0, remainDays: 20 }, // 旧形式
  { staffId: "1010", grantDate: "2025-11-03" },
];

console.log("■ 未登録の判定は index.html の getPaidLeaveUnregistered と一致する");
{
  [TODAY, MONDAY, "2026-11-04", "2027-05-03"].forEach((t) => {
    const mine = N.findUnregisteredGrants(STAFF, BAL, t);
    const theirs = htmlCtx(t).run(STAFF.filter(Boolean), BAL);
    const a = JSON.stringify(mine.grants.map(pick)), b = JSON.stringify(theirs.grants.map(pick));
    check("今日=" + t + " の未登録一覧が同じ（" + mine.grants.length + "件）", a === b, a + "\n    vs " + b);
    check("今日=" + t + " の社員番号重複が同じ", JSON.stringify(mine.dupIds) === JSON.stringify(theirs.dupIds));
    check("今日=" + t + " の社員番号なしの人数が同じ", mine.noIdCount === theirs.noIdList.length);
  });
  // 乱数の合成データ（固定シード）でも一致する
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const names = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const ids = ["", "1", "2", "3", "4", "5", "6", " 7", "8"];
  const hires = ["2019-08-31", "2020-02-29", "2021-01-31", "2023-05-15", "2025-11-30", "2026-05-03", "2026/04/01", "", "x"];
  const sts = ["在籍", "在籍", "在籍", "退職", "休職", undefined];
  let allSame = true, bad = "";
  for (let k = 0; k < 300; k++) {
    const staff = [];
    const ns = 1 + rnd(7);
    for (let i = 0; i < ns; i++) staff.push({ name: names[rnd(names.length)], employeeId: ids[rnd(ids.length)], hireDate: hires[rnd(hires.length)], status: sts[rnd(sts.length)] });
    const bal = [];
    const nb = rnd(6);
    for (let i = 0; i < nb; i++) {
      const s = staff[rnd(staff.length)];
      const sch = N.calcGrantSchedule(s.hireDate, TODAY);
      if (!sch.length) continue;
      const g = sch[rnd(sch.length)];
      bal.push({ staffId: rnd(3) === 0 ? s.name : String(s.employeeId).trim(), staffName: s.name, grantDate: g.grantDate });
    }
    const t = ["2026-11-03", "2026-11-02", "2027-03-01"][rnd(3)];
    const a = JSON.stringify(N.findUnregisteredGrants(staff, bal, t).grants.map(pick));
    const b = JSON.stringify(htmlCtx(t).run(staff, bal).grants.map(pick));
    if (a !== b) { allSame = false; bad = JSON.stringify({ staff, bal, t }) + "\n    " + a + "\n    vs " + b; break; }
  }
  check("合成データ300通りで未登録一覧が同じ", allSame, bad);
  check("付与行がオブジェクト形（RTDB の push キー）でも読める",
    N.findUnregisteredGrants(STAFF, { a: BAL[0], b: BAL[1], c: BAL[2] }, TODAY).grants.length === N.findUnregisteredGrants(STAFF, BAL, TODAY).grants.length);
  check("スタッフも付与行も空なら0件", N.findUnregisteredGrants(null, null, TODAY).grants.length === 0);
}

console.log("■ 対象から外す人・登録済み");
{
  const u = N.findUnregisteredGrants(STAFF, BAL, TODAY);
  const who = (n) => u.grants.filter((g) => g.staffName === n).map((g) => g.grantNum + ":" + g.grantDate);
  check("退職者は載らない", who("伊藤四郎").length === 0 && who("退職十郎").length === 0);
  check("社員番号なしは載らない（人数だけ数える）", who("鈴木一郎").length === 0 && u.noIdCount === 1);
  check("社員番号重複は載らない", who("渡辺五郎").length === 0 && who("中村六郎").length === 0 && u.dupIds.join() === "1007");
  check("入社日なしは載らない", who("高橋次郎").length === 0);
  check("登録済みの回は載らず、未登録の回だけ載る", who("佐藤花子").join() === "2:2026-11-03");
  check("旧形式（staffId=氏名）で登録済みの回は載らない", who("加藤八子").indexOf("8:2026-11-03") < 0, who("加藤八子").join());
  check("社員番号の前後の空白は詰めて照合する", u.grants.some((g) => g.staffId === "1009"));
  check("明日が付与日の人は載らない", who("未来一郎").length === 0);
}

console.log("■ 送るかどうか（毎日・月曜）");
{
  const u = N.findUnregisteredGrants(STAFF, BAL, TODAY);
  const p = N.planNotification(u, TODAY);
  check("火曜: 今日が付与日の未登録があれば「付与日のお知らせ」", p && p.kind === "today");
  check("火曜: 今日の分だけ（過ぎた分は載せない）", p && p.today.map((g) => g.staffName).join() === "佐藤花子,山田太郎" && p.overdue.length === 0, p && JSON.stringify(p.today.map(pick)));
  const uWed = N.findUnregisteredGrants(STAFF, BAL, "2026-11-04");
  const pWed = N.planNotification(uWed, "2026-11-04");
  check("水曜: 今日の未登録（未来一郎）だけ", pWed && pWed.kind === "today" && pWed.today.map((g) => g.staffName).join() === "未来一郎");
  const uThu = N.findUnregisteredGrants(STAFF, BAL, "2026-11-05");
  check("木曜: 今日が付与日の人がいなければ、過ぎた未登録が残っていても送らない", N.planNotification(uThu, "2026-11-05") === null && uThu.grants.length > 0);
  const uMon = N.findUnregisteredGrants(STAFF, BAL, MONDAY);
  const pMon = N.planNotification(uMon, MONDAY);
  check("月曜: まとめ通知（1通）", pMon && pMon.kind === "weekly");
  check("月曜: 今日が付与日（吉田九子）", pMon && pMon.today.map((g) => g.staffName).join() === "吉田九子");
  check("月曜: 過ぎて未登録・期限内（小林七子 第1回）", pMon && pMon.overdue.some((g) => g.staffName === "小林七子" && g.grantDate === "2026-10-15"));
  check("月曜: 期限切れは載せず件数だけ", pMon && pMon.overdue.every((g) => g.expiresAt >= MONDAY) && pMon.expiredCount > 0
    && pMon.expiredCount === uMon.grants.filter((g) => g.expiresAt < MONDAY).length);
  check("月曜: 社員番号の未設定・重複があることを知らせる", pMon && pMon.idIssueCount === 2);
  check("月曜: 未登録が無ければ送らない", N.planNotification({ grants: [], dupIds: [], noIdCount: 0 }, MONDAY) === null);
  check("月曜: 期限切れだけなら送らない",
    N.planNotification({ grants: [{ staffName: "x", grantNum: 1, grantDate: "2020-01-01", expiresAt: "2021-12-31" }], dupIds: [], noIdCount: 0 }, MONDAY) === null);
  check("火曜: 未登録が無ければ送らない", N.planNotification({ grants: [], dupIds: [], noIdCount: 0 }, TODAY) === null);
  check("載せるものが無い計画からは本文を作らない", N.buildMessage({ kind: "weekly", today: [], overdue: [], expiredCount: 5, idIssueCount: 1 }, "穂乃味タイムカード", MONDAY) === "");
}

console.log("■ 本文");
{
  const u = N.findUnregisteredGrants(STAFF, BAL, TODAY);
  const m = N.buildMessage(N.planNotification(u, TODAY), "穂乃味タイムカード", TODAY);
  const expect = "【穂乃味タイムカード】\n有給の付与日です（2026年11月3日）\n\n" +
    "・佐藤花子　第2回（付与日 2026-11-03）\n・山田太郎　第1回（付与日 2026-11-03）\n\n" +
    "管理画面の「有給管理」→「付与予定（未登録）」から登録してください。";
  check("付与日のお知らせの本文", m === expect, "\n" + m);
  const uMon = N.findUnregisteredGrants(STAFF, BAL, MONDAY);
  const mm = N.buildMessage(N.planNotification(uMon, MONDAY), "穂乃味タイムカード", MONDAY);
  check("月曜の本文: 見出し・2つの区分・案内・期限切れの注記", /^【穂乃味タイムカード】\n有給付与の登録待ち（毎週月曜のお知らせ・2026年11月2日）\n/.test(mm)
    && /▼今日が付与日（1件）\n・吉田九子　第1回（付与日 2026-11-02）/.test(mm)
    && /▼付与日を過ぎて未登録（\d+件）\n/.test(mm) && /・小林七子　第1回（付与日 2026-10-15）/.test(mm)
    && /「付与予定（未登録）」から登録してください。/.test(mm) && /期限切れの付与回 \d+ 件は登録不要/.test(mm)
    && /社員番号が未設定・重複/.test(mm), "\n" + mm);
  check("付与日数は載せない", !/日分|付与日数|\d+日（/.test(m + mm));
  check("管理者用URL（トークン）は載せない", !/https?:|token=/.test(m + mm));
  check("社員番号・入社日は載せない", !/1009|2026-04-15|1010/.test(mm));
  // 氏名への改行・制御文字の注入
  const LS = String.fromCharCode(0x2028);
  const inj = N.buildMessage({ kind: "today", today: [{ staffName: "悪意\n▼偽の見出し" + LS + "\u0007x", grantNum: 1, grantDate: TODAY }], overdue: [], expiredCount: 0, idIssueCount: 0 }, "穂乃味タイムカード", TODAY);
  check("氏名の改行・制御文字は空白にする（行を偽装できない）", inj.split("\n").length === expect.split("\n").length - 1 && /・悪意 ▼偽の見出し x　第1回/.test(inj), inj);
  check("長い氏名は切り詰める", N.safeName("あ".repeat(100)).length === 41);
  // 件数が多いとき
  const many = [];
  for (let i = 0; i < 100; i++) many.push({ staffName: "職員" + String(i).padStart(3, "0") + "あ".repeat(40), grantNum: 30, grantDate: "2026-10-01", expiresAt: "2028-09-30" });
  const big = N.buildMessage({ kind: "weekly", today: many.slice(0, 50), overdue: many, expiredCount: 3, idIssueCount: 1 }, "マンテール タイムカード", MONDAY);
  check("1区分は " + N.MAX_LINES_PER_SECTION + " 行まで＋「他 N 件」", (big.match(/^・/mg) || []).length === 2 * N.MAX_LINES_PER_SECTION && /他 20 件/.test(big) && /他 70 件/.test(big));
  check("LINE の上限（5000文字）を超えない", big.length < 5000, String(big.length));
  check("会社名は会社ごと（マンテール）", big.indexOf("【マンテール タイムカード】") === 0);
}

console.log("■ 会社（テナント）と Secrets");
{
  const base = { FIREBASE_DATABASE_URL: "https://example-db.invalid/honomi", FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "a@b", private_key: "k" }), LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_TO_ID: "Uxxx" };
  const run = (env) => spawnSync(process.execPath, [SCRIPT], { env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || "" }, env), encoding: "utf8", timeout: 20000 });
  const r1 = run(Object.assign({}, base, { TENANT_ID: "unknown" }));
  check("未登録の会社IDは止まる", r1.status === 1 && /未登録の TENANT_ID/.test(r1.stderr));
  const r2 = run(Object.assign({}, base, { TENANT_ID: "mantel" }));
  check("マンテールは __MANTEL の LINE 宛先が無ければ止まる（穂乃味の宛先へ倒さない）", r2.status === 1 && /LINE_CHANNEL_ACCESS_TOKEN__MANTEL/.test(r2.stderr) && /LINE_TO_ID__MANTEL/.test(r2.stderr), r2.stderr);
  const r3 = run(Object.assign({}, base, { LINE_TO_ID: "temp" }));
  check("LINE_TO_ID が temp なら止まる", r3.status === 1 && /LINE_TO_ID/.test(r3.stderr));
  const r4 = run({ DRY_RUN: "true", TEST_NOTIFY: "true" });
  check("dryRun のテスト通知は Secrets なしで本文だけ出す（送らない）", r4.status === 0 && /テスト通知/.test(r4.stdout) && /送信スキップ/.test(r4.stdout), r4.stderr);
  const r5 = run(Object.assign({}, base, { TARGET_DATE: "2026-02-30" }));
  check("実在しない TARGET_DATE は止まる", r5.status === 1 && /TARGET_DATE/.test(r5.stderr));
  const r6 = run(Object.assign({}, base, { FIREBASE_SERVICE_ACCOUNT_KEY: "{bad", LINE_CHANNEL_ACCESS_TOKEN: "SECRET-TOKEN-VALUE" }));
  check("Secrets の値をログへ出さない", r6.status === 1 && !/SECRET-TOKEN-VALUE|Uxxx|example-db/.test(r6.stdout + r6.stderr));
  check("会社一覧は notify-check.js と同じ", (function () {
    const nc = fs.readFileSync(path.join(ROOT, "scripts", "notify-check.js"), "utf8");
    return Object.keys(N.TENANTS).every((k) => new RegExp("\\n  " + k + ": \\{").test(nc)) && /honomi/.test(Object.keys(N.TENANTS).join());
  })());
}

// ===== 実行全体（https を模擬に差し替える。本番には一切つながない）=====
function installFakeHttps(handler, log) {
  const orig = https.request;
  https.request = function (opts, cb) {
    const req = new EventEmitter();
    let body = "";
    req.setTimeout = () => req;
    req.write = (d) => { body += d; };
    req.destroy = (e) => { req.emit("error", e); };
    req.end = () => {
      setImmediate(() => {
        const call = { host: opts.hostname, path: opts.path, method: opts.method, headers: opts.headers, body };
        log.push(call);
        let r;
        try { r = handler(call); } catch (e) { req.emit("error", e); return; }
        if (r && r.error) { req.emit("error", Object.assign(new Error("net"), { code: r.error })); return; }
        const res = new EventEmitter();
        res.statusCode = r.status;
        res.setEncoding = () => {};
        cb(res);
        res.emit("data", typeof r.body === "string" ? r.body : JSON.stringify(r.body));
        res.emit("end");
      });
    };
    return req;
  };
  return () => { https.request = orig; };
}
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const FAKE_SA = JSON.stringify({ client_email: "job@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

async function runMain(env, lineResponses) {
  const log = [], out = [];
  const lr = (lineResponses || [{ status: 200, body: {} }]).slice();
  const restore = installFakeHttps((c) => {
    if (c.host === "oauth2.googleapis.com") return { status: 200, body: { access_token: "AT-SECRET" } };
    if (c.host === "db.example.invalid") {
      if (c.method !== "GET") return { status: 403, body: "write" };
      if (/\/tc5_staff\.json$/.test(c.path)) return { status: 200, body: STAFF };
      if (/\/tc5_paid_leave_balances\.json$/.test(c.path)) return { status: 200, body: { k1: BAL[0], k2: BAL[1], k3: BAL[2] } };
      return { status: 404, body: null };
    }
    if (c.host === "api.line.me") return lr.length > 1 ? lr.shift() : lr[0];
    throw new Error("想定外の接続先");
  }, log);
  const saved = Object.assign({}, process.env);
  const keys = ["TENANT_ID", "DRY_RUN", "TEST_NOTIFY", "TARGET_DATE", "GITHUB_ACTIONS", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO_ID", "FIREBASE_DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT_KEY"];
  keys.forEach((k) => { delete process.env[k]; });
  Object.assign(process.env, { FIREBASE_DATABASE_URL: "https://db.example.invalid/honomi", FIREBASE_SERVICE_ACCOUNT_KEY: FAKE_SA, LINE_CHANNEL_ACCESS_TOKEN: "LINE-TOKEN-SECRET", LINE_TO_ID: "Cgroup-secret" }, env);
  const ol = console.log, ow = console.warn, oe = console.error;
  console.log = console.warn = console.error = (...a) => { out.push(a.join(" ")); };
  let err = null;
  try { await N.main(); } catch (e) { err = e; }
  finally {
    console.log = ol; console.warn = ow; console.error = oe;
    keys.forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
    restore();
  }
  return { log, out: out.join("\n"), err };
}

(async function () {
  console.log("■ 実行全体（模擬の https）");
  {
    const r = await runMain({ TARGET_DATE: TODAY });
    const line = r.log.filter((c) => c.host === "api.line.me");
    check("付与日のある日は LINE を1通送る", !r.err && line.length === 1, r.err && r.err.message);
    const sent = line[0] && JSON.parse(line[0].body);
    check("宛先は LINE_TO_ID・本文は付与日のお知らせ", sent && sent.to === "Cgroup-secret" && /有給の付与日です/.test(sent.messages[0].text) && /山田太郎/.test(sent.messages[0].text));
    check("retry key を付けて送る", line[0] && /^[0-9a-f-]{36}$/.test(line[0].headers["X-Line-Retry-Key"]));
    check("RTDB へは GET だけ（書き込まない）", r.log.filter((c) => c.host === "db.example.invalid").every((c) => c.method === "GET")
      && r.log.filter((c) => c.host === "db.example.invalid").length === 2);
    check("読むのは tc5_staff と tc5_paid_leave_balances だけ（穂乃味は /honomi 配下）",
      r.log.filter((c) => c.host === "db.example.invalid").map((c) => c.path).join() === "/honomi/tc5_staff.json,/honomi/tc5_paid_leave_balances.json");
    check("ログに氏名・トークン・宛先・DB の URL を出さない", !/山田|佐藤|小林|AT-SECRET|LINE-TOKEN-SECRET|Cgroup-secret|db\.example/.test(r.out), r.out);
  }
  {
    const r = await runMain({ TARGET_DATE: "2026-11-05" });
    check("付与日の人がいない平日は送らない", !r.err && r.log.filter((c) => c.host === "api.line.me").length === 0 && /通知対象なし/.test(r.out));
  }
  {
    const r = await runMain({ TARGET_DATE: MONDAY });
    const line = r.log.filter((c) => c.host === "api.line.me");
    check("月曜はまとめを1通", !r.err && line.length === 1 && /毎週月曜のお知らせ/.test(JSON.parse(line[0].body).messages[0].text));
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY, DRY_RUN: "true", GITHUB_ACTIONS: "true", LINE_CHANNEL_ACCESS_TOKEN: "", LINE_TO_ID: "" });
    check("dryRun は送らない（LINE の Secrets が無くても動く）", !r.err && r.log.filter((c) => c.host === "api.line.me").length === 0 && /送信スキップ/.test(r.out), r.err && r.err.message);
    check("Actions 上の dryRun は氏名・回・付与日を伏せる（入社日を逆算させない）", /・＊＊＊（氏名・回・付与日は伏せています）/.test(r.out) && !/山田|佐藤|第d+回|付与日 20/.test(r.out), r.out);
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY, DRY_RUN: "true", LINE_CHANNEL_ACCESS_TOKEN: "", LINE_TO_ID: "" });
    check("手元の dryRun は実名の本文を出す", /・山田太郎　第1回/.test(r.out));
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY, TENANT_ID: "mantel", LINE_CHANNEL_ACCESS_TOKEN__MANTEL: "M-TOK", LINE_TO_ID__MANTEL: "M-TO" });
    const db = r.log.filter((c) => c.host === "db.example.invalid").map((c) => c.path);
    const line = r.log.filter((c) => c.host === "api.line.me");
    check("マンテールは /tenants/mantel を読み、マンテールの宛先へ送る", !r.err && db.every((p) => p.indexOf("/tenants/mantel/") === 0)
      && line.length === 1 && JSON.parse(line[0].body).to === "M-TO" && line[0].headers.Authorization === "Bearer M-TOK"
      && /【マンテール タイムカード】/.test(JSON.parse(line[0].body).messages[0].text), r.err && r.err.message);
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN__MANTEL; delete process.env.LINE_TO_ID__MANTEL;
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY }, [{ status: 500, body: {} }, { status: 200, body: {} }]);
    const line = r.log.filter((c) => c.host === "api.line.me");
    check("LINE の 5xx は同じ retry key で再送する", !r.err && line.length === 2 && line[0].headers["X-Line-Retry-Key"] === line[1].headers["X-Line-Retry-Key"]);
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY }, [{ status: 400, body: { message: "bad" } }]);
    const line = r.log.filter((c) => c.host === "api.line.me");
    check("LINE の 4xx は再送せず失敗にする（ジョブが赤くなる）", r.err && line.length === 1);
  }
  {
    const r = await runMain({ TARGET_DATE: TODAY }, [{ status: 409, body: {} }]);
    check("LINE の 409（受付済み）は成功扱い", !r.err && r.log.filter((c) => c.host === "api.line.me").length === 1);
  }

  console.log("■ 静的な確認（ソース・ワークフロー）");
  {
    check("RTDB へ書く処理が無い（PUT / PATCH / DELETE を使わない）", !/method:\s*"(PUT|PATCH|DELETE)"/.test(SRC));
    check("index.html の付与日の式と同じ（6 + (n-1)*12 か月・30回まで）", /const off = 6 \+ \(n - 1\) \* 12;/.test(SRC) && /for \(let n = 1; n <= 30; n\+\+\)/.test(SRC)
      && /var offsetM=6\+\(n-1\)\*12;/.test(html) && /for\(var n=1;n<=30;n\+\+\)\{/.test(html));
    const crons = WF.match(/^\s*-\s*cron:\s*"([^"]+)"/mg) || [];
    check("cron は1本だけ（通知記録を持たないので起動元を増やさない）", crons.length === 1, crons.join());
    const cm = /cron:\s*"(\d+) (\d+) \* \* \*"/.exec(WF);
    check("cron は JST の朝（5〜9時）に起動する", cm && (function () { const h = (+cm[2] + 9) % 24; return h >= 5 && h <= 9; })());
    check("ワークフローは scripts/paid-leave-notify.js を実行する", /run: node scripts\/paid-leave-notify\.js/.test(WF));
    check("Secrets は既存の名前だけ", (WF.match(/secrets\.([A-Z_]+)/g) || []).every((s) => ["secrets.LINE_CHANNEL_ACCESS_TOKEN", "secrets.LINE_TO_ID", "secrets.FIREBASE_DATABASE_URL", "secrets.FIREBASE_SERVICE_ACCOUNT_KEY"].indexOf(s) >= 0));
    check("GITHUB_TOKEN は読み取りだけ", /permissions:\s*\n\s*contents: read/.test(WF));
    check("手動実行の dryRun は既定で ON", /dryRun:[\s\S]*?default: true/.test(WF));
    check("入力値はシェルへ埋め込まず env で渡す", !/run:[^\n]*\$\{\{/.test(WF));
  }

  console.log("\n==================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("==================================");
  if (fail) { console.log(failures.join("\n")); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
