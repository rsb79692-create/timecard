/**
 * 人別明細CSV（dlStaffDetailCSV）の有給行の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-staff-detail-csv.js
 *
 * 目的:
 *   1. 承認済み有給は getLeaveDates()（leaveDates の全日）で取得日ごとに展開されること
 *      （r.date＝先頭日だけを見ると、複数日申請の2日目以降の行が消える）。
 *   2. 対象月（引数 month）以外の取得日が混入しないこと。
 *   3. pending / rejected を有給として出さないこと。
 *   4. 通常の打刻日の行・打刻も有給も無い日の扱いを変えないこと。
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、本番と同じ関数を関数名で抜き出して
 *   vm コンテキストで評価する。dlCSV は呼ばれた本文を捕まえるだけ（ダウンロードしない）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// "function NAME(" から波括弧の対応で関数全体を抜き出す。
// ★ 文字列・正規表現の中の { } は考慮しない（対象の関数には現状無い）。入れた場合は抽出がずれて FAIL になる。
function extractFn(name) {
  const head = "\nfunction " + name + "(";
  const s = html.indexOf(head);
  if (s < 0) throw new Error("index.html に function " + name + " が見つかりません");
  const open = html.indexOf("{", s);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return html.slice(s + 1, i + 1); }
  }
  throw new Error("function " + name + " の終端が見つかりません");
}

const FNS = ["pad", "monthKey", "toHM", "calcMs", "getBreakPairs", "sumBreakMs",
  "validateAttendanceRecord", "getLeaveDates", "dlStaffDetailCSV"];
const CODE = FNS.map(extractFn).join("\n") + "\nvar paidLeaveRequests=[];";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// 1回分のCSVを生成し、データ行を {name,date,status,remark,cin,cout,net} の配列で返す
function run(month, requests, recs, staffArr, approvals) {
  const ctx = { console, out: null };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "index.html:dlStaffDetailCSV" });
  ctx.dlCSV = function (body) { ctx.out = body; };
  ctx.paidLeaveRequests = requests;
  ctx.dlStaffDetailCSV(month, recs, staffArr, approvals || {});
  const lines = String(ctx.out || "").split("\n");
  return lines.slice(1).filter(Boolean).map(function (l) {
    const c = l.split(",");
    return { name: c[0], date: c[3], cin: c[5], cout: c[6], net: c[8], status: c[10], missing: c[11], remark: c[12] };
  });
}

function punch(staff, date, type, hm) {
  return { staff, date, type, time: hm, timestamp: date + "T" + hm + ":00+09:00" };
}
function workDay(staff, date) {
  return [punch(staff, date, "clockIn", "09:00"), punch(staff, date, "breakStart", "12:00"),
    punch(staff, date, "breakEnd", "13:00"), punch(staff, date, "clockOut", "18:00")];
}

const A = { name: "テスト一郎", location: "施設A" };
const B = { name: "テスト二郎", location: "施設B" };
const M = "2026-09";
const rowsOf = (rows, nm) => rows.filter(r => r.name === nm);
const datesOf = (rows, nm) => rowsOf(rows, nm).map(r => r.date);

console.log("[1] 1日だけの承認済み有給");
{
  const rows = run(M, [{ staffName: A.name, date: "2026-09-10", leaveDates: ["2026-09-10"], status: "approved" }], [], [A]);
  check("1行だけ出る", rows.length === 1, JSON.stringify(rows));
  check("承認状態・備考が有給", rows[0] && rows[0].status === "有給" && rows[0].remark === "有給");
  // 旧形式（leaveDates なし・date のみ）も従来どおり
  const old = run(M, [{ staffName: A.name, date: "2026-09-11", status: "approved" }], [], [A]);
  check("旧形式（date のみ）も1行「有給」", old.length === 1 && old[0].date === "2026-09-11" && old[0].status === "有給");
}

console.log("[2] 2日以上の承認済み有給（打刻0件）");
{
  const rows = run(M, [{ staffName: A.name, date: "2026-09-19", leaveDates: ["2026-09-19", "2026-09-20"], status: "approved" }], [], [A]);
  check("leaveDates の全日が行になる", JSON.stringify(datesOf(rows, A.name)) === JSON.stringify(["2026-09-19", "2026-09-20"]), JSON.stringify(rows));
  check("各日の承認状態が有給", rows.length === 2 && rows.every(r => r.status === "有給" && r.remark === "有給"));
  const three = run(M, [{ staffName: A.name, date: "2026-09-01", leaveDates: ["2026-09-01", "2026-09-02", "2026-09-03"], status: "approved" }], [], [A]);
  check("3日申請も3行", three.length === 3 && three.every(r => r.status === "有給"));
}

console.log("[3] 複数日有給の2日目に打刻がある");
{
  const rows = run(M, [{ staffName: A.name, date: "2026-09-19", leaveDates: ["2026-09-19", "2026-09-20"], status: "approved" }],
    workDay(A.name, "2026-09-20"), [A]);
  const d20 = rowsOf(rows, A.name).filter(r => r.date === "2026-09-20");
  check("2日目の行は1行だけ（重複しない）", d20.length === 1, JSON.stringify(rows));
  check("2日目も承認状態が有給", d20[0] && d20[0].status === "有給" && d20[0].remark === "有給");
  check("2日目の打刻値は残る", d20[0] && d20[0].cin === "09:00" && d20[0].cout === "18:00" && d20[0].net === "8:00");
  check("合計2行", rows.length === 2);
}

console.log("[4] 対象月外の承認済み有給");
{
  const rows = run(M, [
    { staffName: A.name, date: "2026-08-20", leaveDates: ["2026-08-20"], status: "approved" },
    { staffName: A.name, date: "2026-10-05", leaveDates: ["2026-10-05", "2026-10-06"], status: "approved" },
  ], [], [A]);
  check("対象月外は出ない", rows.length === 0, JSON.stringify(rows));
}

console.log("[5] 月をまたぐ複数日有給");
{
  const req = [{ staffName: A.name, date: "2026-09-29", leaveDates: ["2026-09-29", "2026-09-30", "2026-10-01"], status: "approved" }];
  const sep = run("2026-09", req, [], [A]);
  check("9月分は 9/29・9/30 だけ", JSON.stringify(datesOf(sep, A.name)) === JSON.stringify(["2026-09-29", "2026-09-30"]), JSON.stringify(sep));
  const oct = run("2026-10", req, [], [A]);
  check("10月分は 10/1 だけ（先頭日が前月でも出る）", JSON.stringify(datesOf(oct, A.name)) === JSON.stringify(["2026-10-01"]), JSON.stringify(oct));
}

console.log("[5b] 年をまたぐ複数日有給");
{
  const req = [{ staffName: A.name, date: "2026-12-31", leaveDates: ["2026-12-31", "2027-01-01"], status: "approved" }];
  check("2026-12 は 12/31 だけ", JSON.stringify(datesOf(run("2026-12", req, [], [A]), A.name)) === JSON.stringify(["2026-12-31"]));
  check("2027-01 は 1/1 だけ", JSON.stringify(datesOf(run("2027-01", req, [], [A]), A.name)) === JSON.stringify(["2027-01-01"]));
}

console.log("[6] pending / rejected");
{
  const rows = run(M, [
    { staffName: A.name, date: "2026-09-05", leaveDates: ["2026-09-05", "2026-09-06"], status: "pending" },
    { staffName: A.name, date: "2026-09-07", leaveDates: ["2026-09-07"], status: "rejected" },
  ], workDay(A.name, "2026-09-06"), [A], { ["2026-09-06__" + A.name]: true });
  check("打刻の無い申請日は行にならない", JSON.stringify(datesOf(rows, A.name)) === JSON.stringify(["2026-09-06"]), JSON.stringify(rows));
  check("打刻のある申請中の日は有給にならない", rows[0] && rows[0].status === "承認済" && rows[0].remark === "");
}

console.log("[7] 通常の打刻日");
{
  const recs = workDay(A.name, "2026-09-02").concat(workDay(A.name, "2026-09-03")).concat([punch(B.name, "2026-09-02", "clockIn", "10:00")]);
  const rows = run(M, [{ staffName: B.name, date: "2026-09-10", leaveDates: ["2026-09-10", "2026-09-11"], status: "approved" }],
    recs, [A, B], { ["2026-09-02__" + A.name]: true });
  const a = rowsOf(rows, A.name);
  check("打刻日ごとに1行", JSON.stringify(a.map(r => r.date)) === JSON.stringify(["2026-09-02", "2026-09-03"]));
  check("承認済/未承認の判定は従来どおり", a[0].status === "承認済" && a[1].status === "未承認");
  check("時刻・実働・休憩", a[0].cin === "09:00" && a[0].cout === "18:00" && a[0].net === "8:00");
  check("他人の有給が混ざらない", a.every(r => r.remark === ""));
  const b = rowsOf(rows, B.name);
  check("退勤漏れの日は打刻漏れ・備考が従来どおり", b[0].date === "2026-09-02" && b[0].missing === "有" && b[0].remark === "退勤漏れ");
  check("別スタッフの複数日有給は本人の行にだけ出る", JSON.stringify(b.map(r => r.date)) === JSON.stringify(["2026-09-02", "2026-09-10", "2026-09-11"]));
  check("全体の行数は5（A 2行・B 3行）", rows.length === 5);
}

console.log("[8] 打刻も有給も無い日");
{
  const rows = run(M, [], workDay(A.name, "2026-09-15"), [A, B]);
  check("打刻のある1日だけが行になる", rows.length === 1 && rows[0].date === "2026-09-15" && rows[0].name === A.name, JSON.stringify(rows));
  check("打刻も有給も無いスタッフは行が無い", rowsOf(rows, B.name).length === 0);
}

console.log("[9] 管理者画面と労務士画面が同じ関数を使う");
{
  const calls = html.match(/dlStaffDetailCSV\(/g) || [];
  check("呼び出しは定義＋2か所", calls.length === 3, String(calls.length));
  check("管理者画面は selMonth を渡す", /dlStaffDetailCSV\(selMonth,mR,buildCsvStaffList\(mR\),approvals\)/.test(html));
  check("労務士画面は reviewMonth を渡す", /dlStaffDetailCSV\(reviewMonth,vMRecs,buildCsvStaffList\(vMRecs\),approvals\)/.test(html));
}

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
