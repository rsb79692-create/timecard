/**
 * 退勤時の賄い確認（mealAskAfterClockOut）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-meal-clockout.js
 *
 * 固定すること:
 *   1. 「賄い 要」のスタッフの退勤だけで聞く。賄い不要・閲覧用・賄いデータ未取得・社員番号なし/不正・既にONの日は聞かない。
 *   2. 「はい」でその日だけを取得ありにし、tc5_meals/{社員番号} へ PUT する（他の日は保持）。
 *   3. 「いいえ」・枠外タップでは何も書かない。
 *   4. 呼ぶのは _execPunch の端末保存・画面の打刻済みの後で、退勤のときだけ（打刻の条件にしない・待たない）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function fnSrc(head, nextHead) {
  const s = html.indexOf(head), e = html.indexOf(nextHead, s + head.length);
  if (s < 0 || e < 0) { console.error("ERROR: 関数を抽出できません: " + head); process.exit(1); }
  return html.slice(s, e);
}
const SRC = fnSrc("function mealAskAfterClockOut(", "// 出勤日を全選択");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

function mk(opts) {
  opts = opts || {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    viewerMode: !!opts.viewerMode,
    mealsLoaded: opts.mealsLoaded !== false,
    staffList: opts.staffList || [{ name: "山田", employeeId: "E1", mealRequired: true }, { name: "佐藤", employeeId: "E2", mealRequired: false }],
    mealsData: opts.mealsData || {},
    modals: [], saved: [], renders: 0,
  };
  ctx.resolveStaffId = (n) => { const s = ctx.staffList.find((x) => x.name === n); return s ? s.employeeId : ""; };
  ctx.mealStaffNameById = (e) => { const s = ctx.staffList.find((x) => x.employeeId === e); return s ? s.name : ""; };
  ctx.mealEditable = (ym) => ym <= "2026-10";
  ctx.showModal = (o) => ctx.modals.push(o);
  ctx.mealSaveEntry = (e) => ctx.saved.push(JSON.parse(JSON.stringify({ eid: e, v: ctx.mealsData[e] })));
  ctx.render = () => { ctx.renders++; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

console.log("■ 聞く・聞かない");
let c = mk(); c.mealAskAfterClockOut("山田", "2026-10-12");
check("賄い要のスタッフの退勤で聞く", c.modals.length === 1);
check("ボタンは はい／いいえ", c.modals[0] && c.modals[0].okLabel === "はい" && c.modals[0].cancelLabel === "いいえ" && c.modals[0].alertOnly === false);
check("文言に日付が入る", c.modals[0] && /10月12日/.test(c.modals[0].message));
c = mk(); c.mealAskAfterClockOut("佐藤", "2026-10-12");
check("賄い不要のスタッフには聞かない", c.modals.length === 0);
c = mk({ viewerMode: true }); c.mealAskAfterClockOut("山田", "2026-10-12");
check("閲覧用では聞かない", c.modals.length === 0);
c = mk({ mealsLoaded: false }); c.mealAskAfterClockOut("山田", "2026-10-12");
check("賄いデータ未取得なら聞かない（全体PUTで他の日を消さない）", c.modals.length === 0);
c = mk({ staffList: [{ name: "山田", employeeId: "", mealRequired: true }] }); c.mealAskAfterClockOut("山田", "2026-10-12");
check("社員番号なしなら聞かない", c.modals.length === 0);
c = mk({ staffList: [{ name: "山田", employeeId: "E/1", mealRequired: true }] }); c.mealAskAfterClockOut("山田", "2026-10-12");
check("社員番号に不正文字があれば聞かない", c.modals.length === 0);
c = mk({ mealsData: { E1: { staffId: "E1", staffName: "山田", dates: { "2026-10-12": { taken: true } } } } }); c.mealAskAfterClockOut("山田", "2026-10-12");
check("その日が既に取得ありなら聞かない", c.modals.length === 0);
c = mk(); c.mealAskAfterClockOut("山田", "2026-11-01");
check("編集できない月（未来月）なら聞かない", c.modals.length === 0);

console.log("■ 回答");
c = mk({ mealsData: { E1: { staffId: "E1", staffName: "山田", dates: { "2026-10-01": { taken: true, updatedAt: "x" } } } } });
c.mealAskAfterClockOut("山田", "2026-10-12"); c.modals[0].onOK();
check("「はい」で1回だけ保存する", c.saved.length === 1 && c.saved[0].eid === "E1");
check("「はい」でその日が取得ありになる", c.saved[0] && c.saved[0].v.dates["2026-10-12"] && c.saved[0].v.dates["2026-10-12"].taken === true);
check("他の日は保持する", c.saved[0] && c.saved[0].v.dates["2026-10-01"] && c.saved[0].v.dates["2026-10-01"].updatedAt === "x");
c = mk(); c.mealAskAfterClockOut("山田", "2026-10-12"); c.modals[0].onOK();
check("賄い記録が無いスタッフでも作って保存する", c.saved.length === 1 && c.saved[0].v.staffId === "E1" && c.saved[0].v.dates["2026-10-12"].taken === true);
c = mk(); c.mealAskAfterClockOut("山田", "2026-10-12"); c.modals[0].onCancel();
check("「いいえ」では何も書かない", c.saved.length === 0 && !c.mealsData.E1);
c = mk(); c.mealAskAfterClockOut("山田", "2026-10-12"); c.mealsLoaded = false; c.modals[0].onOK();
check("回答時に賄いデータが無効なら書かない", c.saved.length === 0);

console.log("■ 呼び出し位置（_execPunch）");
const exec = fnSrc("async function _execPunch(", "function doPunch(");
const iCall = exec.indexOf('if(type==="clockOut")mealAskAfterClockOut(nr.staff,nr.date);');
check("退勤のときだけ呼ぶ", iCall > 0);
check("端末保存（punchOutboxCommit）の後", iCall > exec.indexOf("punchOutboxCommit(nr)"));
check("画面を打刻済みにした後（records.push の後）", iCall > exec.indexOf("records.push(nr)"));
check("送信開始の後", iCall > exec.indexOf('punchOutboxFlush("punch")'));
check("await しない", !/await\s+mealAskAfterClockOut/.test(exec));
check("showModal は cancelLabel を受け付ける", /cnl\.textContent=opts\.cancelLabel\|\|"キャンセル"/.test(html));

console.log("\n" + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
