/**
 * 退勤前の賄い確認（MEAL-CLOCKOUT）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-meal-clockout.js
 *
 * 固定すること:
 *   1. 退勤ボタンを押したら打刻の前に聞き、はい／いいえに答えたら退勤を打刻する。「退勤をやめる」では打刻しない。
 *   2. 聞くのは「賄い 要」のスタッフだけ。賄い不要・閲覧用・賄いデータ未取得・社員番号なし/不正・既にONの日は聞かずにそのまま打刻する。
 *   3. 賄いの記録は退勤の端末保存が成功した後だけ（_execPunch の ⑥）。「はい」でその日だけを取得ありにし他の日を保持する。「いいえ」は書かない。
 *   4. 答えるまでに同じ人の退勤が届いていたら打刻しない。画面を離れていたら打刻しない。
 *   5. 出勤・休憩では聞かない。枠外タップで閉じない（誤タップで打刻しない）。
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
const SRC = fnSrc("// ===== 退勤前の賄い確認（MEAL-CLOCKOUT） =====", "// ===== MEAL-CLOCKOUT-END =====");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// 最小の DOM（ボタンの onclick を押せるだけ）
function mkDoc() {
  function El(tag) { this.tagName = tag; this.children = []; this.style = {}; this.parentNode = null; this.textContent = ""; }
  El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  El.prototype.removeChild = function (c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; };
  const body = new El("body");
  return { body, createElement: (t) => new El(t) };
}
function buttons(el, out) { out = out || []; if (el.tagName === "button") out.push(el); el.children.forEach((c) => buttons(c, out)); return out; }
function btn(ctx, label) { const ov = ctx.document.body.children[ctx.document.body.children.length - 1]; return ov && buttons(ov).find((b) => b.textContent === label); }

function mk(opts) {
  opts = opts || {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    viewerMode: !!opts.viewerMode,
    mealsLoaded: opts.mealsLoaded !== false,
    staffName: "山田",
    staffList: opts.staffList || [{ name: "山田", employeeId: "E1", mealRequired: true }, { name: "佐藤", employeeId: "E2", mealRequired: false }],
    mealsData: opts.mealsData || {},
    records: opts.records || [],
    document: mkDoc(),
    execs: [], saved: [], alerts: [],
  };
  ctx.resolveStaffId = (n) => { const s = ctx.staffList.find((x) => x.name === n); return s ? s.employeeId : ""; };
  ctx.mealStaffNameById = (e) => { const s = ctx.staffList.find((x) => x.employeeId === e); return s ? s.name : ""; };
  ctx.mealEditable = (ym) => ym <= "2026-10";
  ctx.fmtDateKey = (d) => d.toISOString().slice(0, 10);
  ctx.showAlert = (m) => ctx.alerts.push(m);
  ctx._execPunch = (t, d, meal) => ctx.execs.push({ t, meal });
  ctx.mealSaveEntry = (e) => ctx.saved.push(JSON.parse(JSON.stringify({ eid: e, v: ctx.mealsData[e] })));
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}
const D = new Date("2026-10-12T09:00:00Z");
const open = (c) => c.document.body.children.length;

console.log("■ 退勤ボタンの直後に聞く（打刻はまだ）");
let c = mk(); c.mealClockOutThenPunch("clockOut", D);
check("賄い要のスタッフの退勤で質問を出す", open(c) === 1);
check("答えるまで打刻しない", c.execs.length === 0);
check("はい／いいえ／退勤をやめる がある", !!btn(c, "はい") && !!btn(c, "いいえ") && !!btn(c, "退勤をやめる"));
check("枠外タップで閉じない（onclick なし）", !c.document.body.children[0].onclick);

console.log("■ 答えたら打刻");
c = mk(); c.mealClockOutThenPunch("clockOut", D); btn(c, "はい").onclick();
check("「はい」で退勤を打刻する", c.execs.length === 1 && c.execs[0].t === "clockOut");
check("「はい」の回答を打刻へ渡す", c.execs[0] && c.execs[0].meal && c.execs[0].meal.taken === true && c.execs[0].meal.eid === "E1" && c.execs[0].meal.ds === "2026-10-12");
check("質問を閉じる", open(c) === 0);
check("打刻前には賄いを書かない", c.saved.length === 0);
c = mk(); c.mealClockOutThenPunch("clockOut", D); btn(c, "いいえ").onclick();
check("「いいえ」でも退勤を打刻する", c.execs.length === 1 && c.execs[0].meal && c.execs[0].meal.taken === false);
c = mk(); c.mealClockOutThenPunch("clockOut", D); btn(c, "退勤をやめる").onclick();
check("「退勤をやめる」では打刻しない", c.execs.length === 0 && open(c) === 0);
c = mk(); c.mealClockOutThenPunch("clockOut", D); const b1 = btn(c, "はい"); b1.onclick(); b1.onclick();
check("連打しても打刻は1回", c.execs.length === 1);
c = mk(); c.mealClockOutThenPunch("clockOut", D); c.staffName = null; btn(c, "はい").onclick();
check("答える前に画面を離れていたら打刻しない", c.execs.length === 0);
c = mk(); c.mealClockOutThenPunch("clockOut", D); c.records.push({ staff: "山田", date: "2026-10-12", type: "clockOut", time: "18:00" }); btn(c, "はい").onclick();
check("答える間に退勤が届いていたら打刻しない（二重打刻防止）", c.execs.length === 0 && c.alerts.length === 1);

console.log("■ 聞かずにそのまま打刻");
for (const [name, o, staff] of [
  ["賄い不要のスタッフ", {}, "佐藤"],
  ["閲覧用", { viewerMode: true }],
  ["賄いデータ未取得", { mealsLoaded: false }],
  ["社員番号なし", { staffList: [{ name: "山田", employeeId: "", mealRequired: true }] }],
  ["社員番号に不正文字", { staffList: [{ name: "山田", employeeId: "E/1", mealRequired: true }] }],
  ["その日が既に取得あり", { mealsData: { E1: { dates: { "2026-10-12": { taken: true } } } } }],
]) {
  c = mk(o); if (staff) c.staffName = staff; c.mealClockOutThenPunch("clockOut", D);
  check(name + "：聞かずに打刻する", open(c) === 0 && c.execs.length === 1 && c.execs[0].meal === undefined);
}
for (const t of ["clockIn", "breakStart", "breakEnd"]) {
  c = mk(); c.mealClockOutThenPunch(t, D);
  check(t + " では聞かない", open(c) === 0 && c.execs.length === 1);
}

console.log("■ 打刻後の記録（mealClockOutCommit）");
c = mk({ mealsData: { E1: { staffId: "E1", staffName: "山田", dates: { "2026-10-01": { taken: true, updatedAt: "x" } } } } });
c.mealClockOutCommit({ eid: "E1", ds: "2026-10-12", taken: true }, "山田");
check("「はい」でその日を取得ありにして1回保存", c.saved.length === 1 && c.saved[0].v.dates["2026-10-12"].taken === true);
check("他の日は保持する", c.saved[0] && c.saved[0].v.dates["2026-10-01"].updatedAt === "x");
c = mk(); c.mealClockOutCommit({ eid: "E1", ds: "2026-10-12", taken: true }, "山田");
check("記録の無いスタッフでも作って保存", c.saved.length === 1 && c.saved[0].v.staffId === "E1");
c = mk(); c.mealClockOutCommit({ eid: "E1", ds: "2026-10-12", taken: false }, "山田");
check("「いいえ」は書かない", c.saved.length === 0 && !c.mealsData.E1);
c = mk(); c.mealsLoaded = false; c.mealClockOutCommit({ eid: "E1", ds: "2026-10-12", taken: true }, "山田");
check("賄いデータが無効なら書かない", c.saved.length === 0);

console.log("■ 結線（doPunch / _execPunch）");
const exec = fnSrc("async function _execPunch(", "function doPunch(");
const dp = fnSrc("function doPunch(", "// ===== 施設変更 =====");
const iC = exec.indexOf('if(type==="clockOut"&&meal)mealClockOutCommit(meal,nr.staff);');
check("_execPunch は回答を受け取る", /async function _execPunch\(type,d,meal\)/.test(exec));
check("賄いの記録は端末保存の後", iC > exec.indexOf("punchOutboxCommit(nr)"));
check("賄いの記録は打刻済みにした後（records.push の後）", iC > exec.indexOf("records.push(nr)"));
check("賄いの記録は保存失敗の return より後", iC > exec.indexOf("打刻を保存できませんでした"));
check("doPunch は _execPunch を直接呼ばない（必ず賄い確認を通る）", !/_execPunch\(/.test(dp));
check("doPunch の3か所（短時間警告2つ・通常）が賄い確認を通る", (dp.match(/mealClockOutThenPunch\(type,d\)/g) || []).length === 3);

console.log("■ 打刻画面の賄い入力欄・月初確認は非表示（2026-10-12 ユーザー指示）");
check("MEAL_PUNCH_CARD_VISIBLE は false", /var MEAL_PUNCH_CARD_VISIBLE=false;/.test(html));
check("打刻画面は MEAL_PUNCH_CARD_VISIBLE が真のときだけ賄い欄・月初確認を出す", /\+\(MEAL_PUNCH_CARD_VISIBLE\?_mealConfHtml\+_mealHtml:""\)/.test(html));
check("賄い欄・月初確認をそのまま連結する箇所が残っていない", !/\+_mealConfHtml\s*\n\s*\+_mealHtml/.test(html));
check("賄いデータは打刻画面で引き続き読む（退勤時の質問に必要）", /fetchJson\(FB_URL\+"\/tc5_meals\.json"\)/.test(fnSrc("function ensureStaffScopedData(", "plTrackFetch(_staffDataPromise);")));

console.log("\n" + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
