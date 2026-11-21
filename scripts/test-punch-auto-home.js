/**
 * 打刻画面の自動復帰（PUNCH-AUTO-HOME）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-punch-auto-home.js
 *
 * 背景: 2026-11-20 ミュゲ春木。前の人が開いたままにした打刻画面で別の人が退勤を押し、
 *       前の人の退勤として記録された（docs/features/punch-auto-home.md）。
 *
 * 固定すること:
 *   1. 打刻が終わったら PUNCH_AUTO_HOME_MS（5秒）後に一覧へ戻る。
 *   2. 確認画面（月次書類の温度・保存食・衛生）・ダイアログの表示中、保存中は戻らない。閉じてから数え直す。
 *   3. 打刻せずに開いたままなら最後の操作から PUNCH_IDLE_HOME_MS（60秒）で戻る。触れる・入力するたびに数え直す。
 *   4. 有給申請・書類・移動距離の入力中、文字の入力中は戻らない（選択肢を選んだだけでは止めない）。
 *   5. 戻ったら前の人の staffName・入力・選択・打刻結果を残さない（「もどる」と同じ goHome の片付け）。
 *   6. スタッフテスト画面・管理者デモ・閲覧用 URL・管理画面では動かない（従来の1.5秒の復帰のまま）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
function block(start, end) {
  const s = html.indexOf(start), e = html.indexOf(end, s);
  if (s < 0 || e < 0) { console.error("ERROR: 抽出できません: " + start); process.exit(1); }
  return html.slice(s, e + end.length);
}
function fnSrc(head, nextHead) {
  const s = html.indexOf(head), e = html.indexOf(nextHead, s + head.length);
  if (s < 0 || e < 0) { console.error("ERROR: 関数を抽出できません: " + head); process.exit(1); }
  return html.slice(s, e);
}
const AUTO = block("// ===== PUNCH-AUTO-HOME-BEGIN =====", "// ===== PUNCH-AUTO-HOME-END =====");
const GOHOME = fnSrc("function goHome(){", "// ===== PUNCH-AUTO-HOME-BEGIN =====");
const OVERLAY = fnSrc("function _appOverlayOpen(){", "// 入力欄にフォーカスがあるか");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 模擬の画面（DOM は判定に使う部分だけ） ─────────────────────
function makeEnv(opts) {
  opts = opts || {};
  let T = 1000000;
  const listeners = {};
  const dom = { mdoc: false, modal: false, active: null, inputs: [] };
  const document = {
    get activeElement() { return dom.active || document.body; },
    body: { tagName: "BODY" },
    querySelector(sel) { return sel === ".mdoc-ov" && dom.mdoc ? {} : null; },
    querySelectorAll(sel) {
      if (sel === "input,textarea") return dom.inputs;
      if (/fixed/.test(sel)) return dom.modal ? [{ id: "", style: { position: "fixed", display: "flex", inset: "0px" } }] : [];
      return [];
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
  const calls = { render: 0, mileageReset: 0, faceClose: 0, demoPicker: 0, intervals: 0 };
  const c = {
    console, document,
    Date: { now: () => T },
    setInterval: () => { calls.intervals++; return 7; }, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    screen: "punch", staffName: "田上", punchMsg: null, punchTimer: null,
    staffDemoMode: false, viewerMode: false, writePolicy: "full",
    punchOutboxEnabled: () => opts.outbox !== false,
    _punchSaving: false, _plChecking: false, savingCount: 0, plSubmitting: false,
    mileage: { busy: false, formOpen: false }, _fcModalOpen: false,
    showPaidLeaveForm: false, staffUploadFile: null, staffUploadMsg: null,
    selectedWorkFacility: "ミュゲ春木", workFacilityPicked: true, facilityChangeTo: "ナナイロ",
    plFormDate: "2026-11-20", plFormDates: ["2026-11-25"], plRangeStart: "2026-11-25", plRangeMode: true, plFormMonth: "2026-11",
    mealFormMonth: "2026-10",
    staffNotifOpen: true, staffPinInput: "1234", staffPinConfirm: "1234", staffPinError: true, staffPinStep: 2,
    faceCamClose: () => { calls.faceClose++; },
    openStaffDemoPicker: () => { calls.demoPicker++; },
    mileageResetSession: () => { calls.mileageReset++; },
    render: () => { calls.render++; if (c.screen === "punch") c.punchHomeWatch(); },
  };
  vm.createContext(c);
  vm.runInContext(OVERLAY + "\n" + GOHOME + "\n" + AUTO, c);
  return {
    c, dom, calls,
    at(ms) { T = 1000000 + ms; },
    tick(ms) { T = 1000000 + ms; c.punchHomeTick(T); },
    touch(ev, ms) { T = 1000000 + ms; (listeners[ev] || []).forEach((f) => f()); },
    listeners,
  };
}
// 打刻画面を開く（t=0）
function openPunch(e) { e.at(0); e.c.render(); }
// 打刻が終わった（打刻完了の表示）
function punched(e, ms) { e.at(ms); e.c.punchMsg = "退勤　15:03:00"; e.c.render(); }
const atHome = (e) => e.c.screen === "home" && e.c.staffName === null;

console.log("■ 定数");
check("PUNCH_AUTO_HOME_MS は 5000", /var PUNCH_AUTO_HOME_MS=5000;/.test(AUTO));
check("PUNCH_IDLE_HOME_MS は 60000", /var PUNCH_IDLE_HOME_MS=60000;/.test(AUTO));

console.log("■ 打刻後に一覧へ戻る");
{
  const e = makeEnv(); openPunch(e); punched(e, 2000);
  e.tick(2000 + 4999);
  check("打刻から5秒未満は打刻完了の表示のまま", e.c.screen === "punch" && e.c.punchMsg !== null);
  e.tick(2000 + 5000);
  check("打刻から5秒で一覧へ戻る", atHome(e));
  check("打刻完了の表示を消す", e.c.punchMsg === null);
  check("撮影表示を閉じる（goHome と同じ片付け）", e.calls.faceClose >= 1);
}
for (const t of ["出勤", "退勤", "休憩開始", "休憩終了", "施設変更"]) {
  const e = makeEnv(); openPunch(e); e.at(100); e.c.punchMsg = t + "　09:00:00"; e.c.render();
  e.tick(100 + 5000);
  check(t + "の後も5秒で戻る", atHome(e));
}
{
  const e = makeEnv(); openPunch(e); punched(e, 1000);
  e.touch("pointerdown", 4000);
  e.tick(1000 + 5000);
  check("打刻完了の表示中に触れても延びない", atHome(e));
}

console.log("■ 確認画面・ダイアログ・保存中は戻らない");
{
  const e = makeEnv(); openPunch(e); punched(e, 0);
  e.dom.mdoc = true; // 朝の温度など月次書類の確認画面
  e.tick(5000); e.tick(30000); e.tick(600000);
  check("月次書類の確認画面の表示中は戻らない", e.c.screen === "punch" && e.c.staffName === "田上");
  e.dom.mdoc = false;
  e.tick(600000 + 500);
  e.tick(600000 + 4999);
  check("閉じてから5秒たつまでは戻らない", e.c.screen === "punch");
  e.tick(600000 + 5000);
  check("閉じてから5秒で戻る", atHome(e));
}
{
  const e = makeEnv(); openPunch(e); punched(e, 0);
  e.dom.modal = true; // お知らせ・確認ダイアログ（showModal）
  e.tick(5000); e.tick(20000);
  check("確認ダイアログの表示中は戻らない", e.c.screen === "punch");
  e.dom.modal = false; e.tick(20500); e.tick(25500);
  check("ダイアログを閉じてから5秒で戻る", atHome(e));
}
{
  const e = makeEnv(); openPunch(e);
  e.c._punchSaving = true; e.at(0); e.c.render(); // 確認画面の回答待ち・端末保存中
  e.tick(70000);
  check("打刻の保存中（確認画面の回答待ちを含む）は戻らない", e.c.screen === "punch");
  e.c._punchSaving = false; punched(e, 70000);
  e.tick(74999);
  check("保存が終わってから数える（5秒未満は戻らない）", e.c.screen === "punch");
  e.tick(75000);
  check("保存が終わって5秒で戻る", atHome(e));
}
for (const [label, set] of [
  ["有給の確認待ち", (c) => { c._plChecking = true; }],
  ["保存の通信中", (c) => { c.savingCount = 1; }],
  ["有給申請の送信中", (c) => { c.plSubmitting = true; }],
  ["移動距離の送信中", (c) => { c.mileage.busy = true; }],
  ["施設変更の確認中", (c) => { c._fcModalOpen = true; }],
]) {
  const e = makeEnv(); openPunch(e); punched(e, 0); set(e.c);
  e.tick(5000); e.tick(120000);
  check(label + "は戻らない", e.c.screen === "punch");
}

for (const [label, set] of [
  ["有給申請", (c) => { c.showPaidLeaveForm = true; }],
  ["移動距離", (c) => { c.mileage.formOpen = true; }],
]) {
  const e = makeEnv(); openPunch(e); set(e.c); punched(e, 0);
  e.tick(5000);
  check(label + "の入力を開いたまま打刻しても5秒で戻る（打刻完了中は入力を出さない）", atHome(e) && e.c.showPaidLeaveForm === false);
}

console.log("■ 打刻せずに放置したら60秒で戻る");
{
  const e = makeEnv(); openPunch(e);
  e.tick(59999);
  check("60秒未満は打刻画面のまま", e.c.screen === "punch" && e.c.staffName === "田上");
  e.tick(60000);
  check("何も押さずに60秒で一覧へ戻る", atHome(e));
}
for (const ev of ["pointerdown", "touchstart", "keydown", "input"]) {
  const e = makeEnv(); openPunch(e);
  e.touch(ev, 30000);
  e.tick(60000);
  check(ev + " で数え直す（最初から60秒では戻らない）", e.c.screen === "punch");
  e.tick(89999);
  check(ev + " から60秒未満は戻らない", e.c.screen === "punch");
  e.tick(90000);
  check(ev + " から60秒で戻る", atHome(e));
}
for (const [label, set] of [
  ["有給申請の入力中", (c) => { c.showPaidLeaveForm = true; }],
  ["書類のアップロードの選択中", (c) => { c.staffUploadFile = { name: "a.pdf" }; }],
  ["移動距離の入力中", (c) => { c.mileage.formOpen = true; }],
  ["ダイアログ表示中", (c, d) => { d.modal = true; }],
  ["文字の入力欄にフォーカス", (c, d) => { d.active = { tagName: "INPUT", type: "text" }; }],
  ["入力欄の値を変えたまま", (c, d) => { d.inputs = [{ tagName: "INPUT", type: "text", value: "ab", defaultValue: "", getClientRects: () => [1] }]; }],
]) {
  const e = makeEnv(); openPunch(e); set(e.c, e.dom);
  e.tick(60000); e.tick(600000);
  check(label + "は放置でも戻らない", e.c.screen === "punch");
}
{
  const e = makeEnv(); openPunch(e);
  e.dom.active = { tagName: "SELECT" };
  e.dom.inputs = [{ tagName: "INPUT", type: "checkbox", value: "on", defaultValue: "", getClientRects: () => [1] },
                  { tagName: "INPUT", type: "text", value: "x", defaultValue: "", getClientRects: () => [] }];
  e.tick(60000);
  check("出勤先の選択（select）・非表示の入力欄では止めない", atHome(e));
}
{
  const e = makeEnv(); openPunch(e);
  e.c.showPaidLeaveForm = true; e.tick(100000);
  e.c.showPaidLeaveForm = false; e.tick(100500);
  e.tick(159999);
  check("入力を閉じてから60秒たつまでは戻らない", e.c.screen === "punch");
  e.tick(160000);
  check("入力を閉じてから60秒で戻る", atHome(e));
}
{
  const e = makeEnv(); openPunch(e);
  e.tick(50000);
  e.at(50000); e.c.staffName = "大城"; e.c.render(); // 別の人の画面に替わった
  e.tick(100000);
  check("人が替わったら数え直す", e.c.screen === "punch" && e.c.staffName === "大城");
  e.tick(110000);
  check("替わった人の画面も60秒で戻る", atHome(e));
}

console.log("■ 戻ったら前の人の情報を残さない");
{
  const e = makeEnv(); openPunch(e); punched(e, 0); e.tick(5000);
  const c = e.c;
  check("staffName を残さない", c.staffName === null);
  check("選んだ出勤先・施設変更先を残さない", c.selectedWorkFacility === null && c.workFacilityPicked === false && c.facilityChangeTo === null);
  check("有給申請の入力を残さない", c.showPaidLeaveForm === false && c.plFormDates.length === 0 && c.plRangeStart === "" && c.plRangeMode === false && c.plFormMonth === "" && c.plFormDate === "");
  check("通知の展開を残さない", c.staffNotifOpen === false);
  check("PIN の入力値を残さない", c.staffPinInput === "" && c.staffPinConfirm === "" && c.staffPinError === false && c.staffPinStep === 1);
  check("書類・賄いの表示月を残さない", c.staffUploadFile === null && c.staffUploadMsg === null && c.mealFormMonth === "");
  check("移動距離の申請内容を捨てる", e.calls.mileageReset >= 1);
  check("打刻完了の表示を残さない", c.punchMsg === null && c.punchTimer === null);
}
{
  const e = makeEnv(); openPunch(e); e.tick(60000);
  check("放置で戻ったときも staffName を残さない", e.c.staffName === null && e.c.staffPinInput === "");
}
{
  const e = makeEnv(); openPunch(e);
  e.c.goHome(); // 「← もどる」
  check("「もどる」でも同じ片付け（PIN・打刻結果を残さない）", e.c.staffName === null && e.c.staffPinInput === "" && e.c.punchMsg === null);
  const ivBefore = e.calls.intervals;
  e.tick(70000);
  check("一覧へ戻った後は何もしない", e.c.screen === "home" && e.calls.intervals === ivBefore);
}

console.log("■ 対象外の画面では動かない");
for (const [label, set] of [
  ["スタッフテスト画面・管理者デモ（staffDemoMode）", (c) => { c.staffDemoMode = true; }],
  ["閲覧用 URL（viewerMode）", (c) => { c.viewerMode = true; }],
  ["端末キューを使わない打刻（punchOutboxEnabled 偽）", null],
  ["管理画面", (c) => { c.screen = "admin"; }],
]) {
  const e = makeEnv(set ? {} : { outbox: false }); if (set) set(e.c);
  e.at(0); e.c.punchHomeWatch();
  e.tick(5000); e.tick(600000);
  check(label + "では戻さない", e.c.staffName === "田上" && e.calls.intervals === 0 && e.calls.demoPicker === 0);
}

console.log("■ 組み込み");
const EXEC = fnSrc("async function _execPunch(type,d,meal){", "function doPunch(type){");
check("render の打刻画面で見張りを始める", /if\(screen==="punch"\)\{\s*\n\s*punchOutboxFlush\("punchScreen"\);[^\n]*\n\s*punchHomeWatch\(\);/.test(html));
check("端末キューを使う打刻では従来の1.5秒の復帰を使わない", /punchTimer=null;[\s\S]{0,300}if\(!punchOutboxEnabled\(\)\)punchTimer=setTimeout\(function\(\)\{/.test(EXEC));
check("従来の復帰（スタッフテスト画面・管理者デモ）は1.5秒のまま", /\},1500\);/.test(EXEC));
check("打刻完了の表示中は申請・カード類を出さない",
  /\+histHTML\+'<\/div>'\n[^\n]*\n\s*\+\(punchMsg\?"":\(""\n/.test(html) && /\+_monthHtml\n\s*\)\)\n\s*\+'<\/div>';/.test(html));
check("goHome は見張りを止める", /punchHomeStop\(\);\s*\n\s*screen="home";render\(\);/.test(GOHOME));
check("サンドボックス（管理者デモ）は従来どおり選択画面へ戻す", /if\(staffDemoMode\)\{openStaffDemoPicker\(\);return;\}/.test(GOHOME));

// _execPunch を実際に動かして、端末キューの打刻で1.5秒の復帰を予約しないこと
async function runExec(outbox) {
  const timers = [];
  const c = {
    console: { log() {}, warn() {}, error() {} },
    viewerMode: false, staffName: "田上", facilityName: "ミュゲ春木", facilityChangeTo: null,
    staffList: [{ name: "田上", location: "ミュゲ春木" }], masterLocs: ["ミュゲ春木"],
    selectedWorkFacility: null, records: [], punchMsg: null, punchTimer: null, screen: "punch",
    TYPE_LABEL: { clockIn: "出勤", clockOut: "退勤" }, PUNCH_LEAVE_MSG: "",
    punchOutboxEnabled: () => outbox, punchLeaveWaitFresh: () => null, _plChecking: false, _punchSaving: false,
    punchLeaveBlocked: () => false, punchOutboxCommit: async () => true, punchOutboxFlush: () => {},
    saveRecord: () => {}, showAlert: () => {}, render: () => {}, faceCamAfterPunch: () => {},
    mealClockOutCommit: () => {}, faceCamClose: () => {}, generateRecordId: () => "ev-1",
    fmtDateKey: (d) => d.toISOString().slice(0, 10), fmtTime: () => "15:03", fmtTimeSec: () => "15:03:00",
    getCurrentWorkFacility: () => "ミュゲ春木", _lsSet: () => {}, mdocActive: () => false,
    setTimeout: (fn, ms) => { timers.push(ms); return 1; }, clearTimeout: () => {},
  };
  vm.createContext(c);
  vm.runInContext(EXEC, c);
  await c._execPunch("clockOut", new Date("2026-11-20T06:03:00Z"));
  return { c, timers };
}
(async () => {
  const a = await runExec(true);
  check("端末キューの打刻：打刻完了の表示を出す", a.c.punchMsg === "退勤　15:03:00" && a.c.records.length === 1);
  check("端末キューの打刻：1.5秒の復帰を予約しない（見張りが5秒で戻す）", a.timers.indexOf(1500) < 0 && a.c.punchTimer === null);
  const b = await runExec(false);
  check("端末キューを使わない打刻：従来どおり1.5秒で戻す", b.timers.indexOf(1500) >= 0);
  console.log("\n" + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
