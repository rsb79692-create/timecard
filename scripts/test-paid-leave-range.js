/**
 * 有給申請の期間指定（スタッフの「期間で選ぶ」・管理者の代理申請の終了日）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-paid-leave-range.js
 *
 * 目的:
 *   1. 期間の展開（plAddDateRange）が両端を含み、月末・年跨ぎ・閏日・逆順・除外・重複で正しいこと。
 *      承認時の FIFO 消化は leaveDates.length 日で行われるので、展開の誤りはそのまま消化日数の誤りになる。
 *   2. 31日を超える期間を止めること（スタッフ・代理の両方）。
 *   3. 期間で選ぶの途中（開始日だけ押した状態）で申請しても、その日を黙って落とさないこと。
 *   4. 代理申請は2日以上なら承認待ちでも残日数で止め、保存前に日数を確認させること。
 *
 * 方式: index.html の PL-RANGE-BEGIN/END ブロックだけを vm で評価し、結線は文字列で確かめる。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const START = "// ===== PL-RANGE-BEGIN =====";
const END = "// ===== PL-RANGE-END =====";
const s = html.indexOf(START), e = html.indexOf(END, s);
if (s < 0 || e < 0) { console.error("ERROR: index.html から PL-RANGE ブロックを抽出できませんでした。"); process.exit(1); }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
const J = (v) => JSON.stringify(v);

const alerts = [];
const ctx = {
  console, plRangeStart: "", plFormDates: [], staffName: "山田 太郎", paidLeaveRequests: [],
  render() {}, showAlert(m) { alerts.push(m); },
  getLeaveDates(r) { return Array.isArray(r.leaveDates) ? r.leaveDates : (r.date ? [r.date] : []); },
};
vm.createContext(ctx);
vm.runInContext(html.slice(s, e + END.length), ctx, { filename: "index.html:PL-RANGE" });
const R = ctx.plAddDateRange;

console.log("── plAddDateRange（期間の展開）");
check("月跨ぎ（両端を含む）", J(R([], "2026-09-29", "2026-10-02", null)) === J(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]));
check("年跨ぎ", J(R([], "2026-12-30", "2027-01-01", null)) === J(["2026-12-30", "2026-12-31", "2027-01-01"]));
check("閏年は2/29を含む", J(R([], "2028-02-28", "2028-03-01", null)) === J(["2028-02-28", "2028-02-29", "2028-03-01"]));
check("平年は2/29を含まない", J(R([], "2027-02-28", "2027-03-01", null)) === J(["2027-02-28", "2027-03-01"]));
check("逆順は入れ替える", J(R([], "2026-10-03", "2026-10-01", null)) === J(["2026-10-01", "2026-10-02", "2026-10-03"]));
check("同じ日は1日", J(R([], "2026-10-05", "2026-10-05", null)) === J(["2026-10-05"]));
check("除外の日は足さない", J(R([], "2026-10-01", "2026-10-03", { "2026-10-02": true })) === J(["2026-10-01", "2026-10-03"]));
check("選択済みの日は二重に足さない・元の配列は変えない", (() => {
  const base = ["2026-10-02"]; const out = R(base, "2026-10-01", "2026-10-03", null);
  return J(base) === J(["2026-10-02"]) && out.length === 3 && new Set(out).size === 3;
})());
check("31日と32日の長さ", R([], "2026-10-01", "2026-10-31", null).length === 31 && R([], "2026-10-01", "2026-11-01", null).length === 32);
check("形の崩れた日付は足さない", R([], "20260-10-01", "2026-10-03", null).length === 0 && R(["2026-10-01"], "2026-10-01", "", null).length === 1);

console.log("── plRangeTap（スタッフの期間で選ぶ）");
ctx.plFormDates = []; ctx.plRangeStart = "";
ctx.paidLeaveRequests = [{ staffName: "山田 太郎", status: "pending", leaveDates: ["2026-10-07"] },
  { staffName: "山田 太郎", status: "rejected", leaveDates: ["2026-10-08"] },
  { staffName: "佐藤 花子", status: "approved", leaveDates: ["2026-10-09"] }];
ctx.plRangeTap("2026-10-06");
check("1回目は開始日だけ（まだ選択に入れない）", ctx.plRangeStart === "2026-10-06" && ctx.plFormDates.length === 0);
ctx.plRangeTap("2026-10-10");
check("2回目で間の日を加える（本人の申請中は除く・却下と他人の申請は除かない）",
  J(ctx.plFormDates.slice().sort()) === J(["2026-10-06", "2026-10-08", "2026-10-09", "2026-10-10"]) && ctx.plRangeStart === "", J(ctx.plFormDates));
ctx.plFormDates = []; ctx.plRangeTap("2026-10-12"); ctx.plRangeTap("2026-10-12");
check("同じ日を2回で1日だけ選ぶ", J(ctx.plFormDates) === J(["2026-10-12"]) && ctx.plRangeStart === "");
ctx.plFormDates = []; alerts.length = 0; ctx.plRangeTap("2026-10-01"); ctx.plRangeTap("2026-11-01");
check("32日の期間は止めて選択を変えない", ctx.plFormDates.length === 0 && ctx.plRangeStart === "" && /31日以内/.test(alerts[0] || ""));

console.log("── 表示");
check("plMd", ctx.plMd("2026-10-05") === "10/5");
check("連続した期間の表示", ctx.plDatesLabel(["2026-10-02", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]) === "9/28〜10/2（5日）");
check("飛び石の期間の表示は実数", ctx.plDatesLabel(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-02"]) === "9/28〜10/2のうち4日");
check("3日までは並べる", ctx.plDatesLabel(["2026-10-05", "2026-10-03"]) === "10/3、10/5（2日）");

console.log("── 結線（index.html）");
const submit = html.slice(html.indexOf('plSubmitBtn.onclick=async function(){'), html.indexOf('savePaidLeaveRequest(req).then(function(){});'));
check("スタッフ: 開始日だけの状態では申請を止める（確認画面・0日チェックより前）", (() => {
  const g = submit.search(/if\(plRangeMode&&plRangeStart\)\{showAlert\(/);
  return g >= 0 && g < submit.indexOf("if(plFormDates.length===0)") && g < submit.indexOf("showModal(");
})());
check("スタッフ: 確認画面に取得日と日数を出す", /message:"取得日："\+plDatesLabel\(plFormDates\)/.test(submit));
check("スタッフ: 送信前に最新の残日数で止める（従来どおり）", /validRemain<plFormDates\.length/.test(submit));
const proxy = html.slice(html.indexOf("function submitProxyLeaveRequest(){"), html.indexOf("// 有給付与登録モーダル・代理申請モーダル・付与日数修正モーダル"));
check("代理: 終了日が前なら止める", /dateEnd&&dateEnd<date/.test(proxy));
check("代理: 31日を超えたら止める", /dates\.length>31/.test(proxy));
check("代理: 申請済みの日を含めば止める", /plExistingLeaveDateSet\(name\)/.test(proxy) && /dupDates\.length>0/.test(proxy));
check("代理: 2日以上は承認待ちでも残日数で止める", /if\(doApprove\|\|dates\.length>1\)\{/.test(proxy) && /remain<dates\.length/.test(proxy));
check("代理: 2日以上は保存前に確認する", /if\(dates\.length>1\)\{\s*showConfirm\([^;]*plDatesLabel\(dates\)[^;]*,_save\);/.test(proxy));
check("代理: 日付が空になる入力は止める", /if\(dates\.length===0\)\{showAlert\(/.test(proxy));
check("代理: 保存直前に画面の開閉・重複・残日数をもう一度確かめる", (() => {
  const f = proxy.slice(proxy.indexOf("function _save(){"));
  const push = f.indexOf("paidLeaveRequests.push(req)");
  return push > 0 && [/if\(!_proxyLeaveModalOpen\)return;/, /plExistingLeaveDateSet\(name\)/, /getValidRemainDays\(staffId\)<dates\.length/]
    .every((re) => { const i = f.search(re); return i >= 0 && i < push; });
})());
check("代理: 保存形式は leaveDates 配列1件・date は先頭日", /leaveDates:dates,/.test(proxy) && /date:dates\[0\],/.test(proxy));
check("ログアウト・サンドボックスのリセットで期間モードも戻す", (html.match(/plFormDates=\[\];plRangeStart="";plRangeMode=false;/g) || []).length === 2);

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
