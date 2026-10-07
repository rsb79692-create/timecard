/**
 * 承認済み有給の日の本人打刻禁止（PUNCH-LEAVE-GUARD）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-punch-leave-guard.js
 *
 * 固定すること:
 *   1. 承認済み（status==="approved"）の取得日だけが打刻禁止。申請中・却下・取消・引戻は打刻できる。
 *   2. 複数日申請は対象日すべてが禁止。対象外の日は従来どおり。
 *   3. 本人の突き合わせは有給取得履歴（plBuildLeaveHistory）と同じ（社員番号優先・同姓同名を混ぜない）。
 *   4. 止めるのは端末保存（punchOutboxCommit）の前。禁止時は端末キューにも records にも残らない。
 *   5. 打刻の全種類（出勤・退勤・休憩開始・休憩終了・施設変更）が止まる。
 *   6. 管理者の勤怠修正（saveRecord / patchRecord）はこの判定を通らない。
 *   7. 有給申請の鮮度（PUNCH-LEAVE-FRESH）: 未取得または60秒超で取得中のときだけ最大2秒待つ・通信断では待たない・
 *      世代つき・待つ間は「確認しています」・待つ間に離脱したら保存しない・ログインごとに取り直す。
 *   8. 端末キュー（PUNCH-OUTBOX）は有給判定を参照しない（承認前に保存済みの打刻はそのまま送る）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
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
const HIST = block("// ===== PL-HISTORY-BEGIN =====", "// ===== PL-HISTORY-END =====");
const GUARD = block("// ===== PUNCH-LEAVE-GUARD-BEGIN =====", "// ===== PUNCH-LEAVE-GUARD-END =====");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 純関数 ─────────────────────────────────────────────
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(HIST + "\n" + GUARD, ctx);
const on = ctx.punchLeaveApprovedOn;
const getDates = (r) => (r.leaveDates && r.leaveDates.length ? r.leaveDates : (r.date ? [r.date] : []));
const getSid = (r) => r.staffId || "";
const q = (reqs, sid, nm, d) => on(reqs, sid, nm, d, getDates, getSid);

console.log("■ 状態ごとの判定");
const base = { staffId: "E1", staffName: "山田" };
check("承認済み当日は禁止", q([{ ...base, status: "approved", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === true);
check("申請中は打刻可能", q([{ ...base, status: "pending", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
check("却下は打刻可能", q([{ ...base, status: "rejected", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
check("取消（canceled）は打刻可能", q([{ ...base, status: "canceled", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
check("引戻（withdrawn）は打刻可能", q([{ ...base, status: "withdrawn", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
check("未知の status は禁止しない", q([{ ...base, status: "xxx", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);

console.log("■ 連続有給・対象外の日");
const multi = [{ ...base, status: "approved", leaveDates: ["2026-10-06", "2026-10-07", "2026-10-08"] }];
check("連続有給の初日は禁止", q(multi, "E1", "山田", "2026-10-06"));
check("連続有給の中日は禁止", q(multi, "E1", "山田", "2026-10-07"));
check("連続有給の最終日は禁止", q(multi, "E1", "山田", "2026-10-08"));
check("前日は打刻可能", q(multi, "E1", "山田", "2026-10-05") === false);
check("翌日は打刻可能", q(multi, "E1", "山田", "2026-10-09") === false);
check("旧形式（date のみ）の承認も禁止", q([{ ...base, status: "approved", date: "2026-10-05" }], "E1", "山田", "2026-10-05"));
check("申請が無ければ打刻可能", q([], "E1", "山田", "2026-10-05") === false);
check("日付が空なら禁止しない", q(multi, "E1", "山田", "") === false);

console.log("■ 本人の突き合わせ");
check("同姓同名の別人（社員番号違い）の承認では止まらない",
  q([{ staffId: "E2", staffName: "山田", status: "approved", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
check("社員番号が無い旧データは氏名で突き合わせる",
  q([{ staffName: "山田", status: "approved", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05"));
check("社員番号が無い職員は氏名で突き合わせる",
  q([{ staffId: "E1", staffName: "山田", status: "approved", leaveDates: ["2026-10-05"] }], null, "山田", "2026-10-05"));
check("他人の承認では止まらない",
  q([{ staffId: "E3", staffName: "佐藤", status: "approved", leaveDates: ["2026-10-05"] }], "E1", "山田", "2026-10-05") === false);
const reqs = [{ ...base, status: "approved", leaveDates: ["2026-10-05"] }];
const snap = JSON.stringify(reqs);
q(reqs, "E1", "山田", "2026-10-05");
check("判定は正本の配列を書き換えない", JSON.stringify(reqs) === snap);

// ── _execPunch を実際に動かす（端末保存の前で止まること） ───────────
console.log("■ _execPunch（端末保存の前で止まる）");
const EXEC = fnSrc("var _punchSaving=false;", "function doPunch(type){");
async function runExec(type, leaveApproved, opts) {
  opts = opts || {};
  const calls = { commit: 0, save: 0, alert: [], flush: 0 };
  const c = {
    console: { log() {}, warn() {}, error() {} },
    viewerMode: false, staffName: "山田", facilityName: "本店", facilityChangeTo: "支店",
    staffList: [{ name: "山田", location: "本店", canSupportWork: true }], masterLocs: ["本店", "支店"],
    selectedWorkFacility: null, records: [], punchMsg: null, punchTimer: null, screen: "punch",
    TYPE_LABEL: { clockIn: "出勤", clockOut: "退勤", breakStart: "休憩開始", breakEnd: "休憩終了", facilityChange: "施設変更" },
    PUNCH_LEAVE_MSG: "この日は有給休暇が承認されているため、打刻できません。",
    punchOutboxEnabled: () => opts.outbox !== false,
    punchLeaveWaitFresh: () => (opts.wait ? opts.wait(c) : null), _plChecking: false,
    punchLeaveBlocked: (n, d) => leaveApproved && n === "山田" && d === "2026-10-05",
    punchOutboxCommit: async () => { calls.commit++; return true; },
    punchOutboxFlush: () => { calls.flush++; },
    saveRecord: () => { calls.save++; },
    showAlert: (m) => { calls.alert.push(m); },
    render: () => {}, faceCamAfterPunch: () => {}, faceCamClose: () => {},
    generateRecordId: () => "ev-1", fmtDateKey: (d) => d.toISOString().slice(0, 10),
    fmtTime: () => "09:00", fmtTimeSec: () => "09:00:00", getCurrentWorkFacility: () => "本店",
    _lsSet: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    mdocActive: () => false, // 月次書類の確認（穂乃味の機能。ここでは有給の判定だけを見る）
  };
  vm.createContext(c);
  vm.runInContext(EXEC, c);
  await c._execPunch(type, new Date("2026-10-05T00:00:00Z"));
  return { calls, c };
}
(async () => {
  for (const t of ["clockIn", "clockOut", "breakStart", "breakEnd", "facilityChange"]) {
    const r = await runExec(t, true);
    check(t + "：承認済み有給の日は端末へ保存しない", r.calls.commit === 0 && r.calls.flush === 0);
    check(t + "：records に積まない（端末に未送信打刻が残らない）", r.c.records.length === 0);
    check(t + "：案内文を出す", r.calls.alert.length === 1 && r.calls.alert[0] === "この日は有給休暇が承認されているため、打刻できません。");
    const ok = await runExec(t, false);
    check(t + "：有給でない日は従来どおり保存・送信する", ok.calls.commit === 1 && ok.c.records.length === 1 && ok.calls.flush === 1);
  }
  // 取得待ちの間に承認が届いたら止まる／待つ間に画面を離れたら保存しない
  {
    let approved = false;
    const r = await runExec("clockIn", false, { wait: (c) => { c.punchLeaveBlocked = () => approved; return Promise.resolve().then(() => { approved = true; }); } });
    check("取得待ちの間に届いた承認で止まる", r.calls.commit === 0 && r.calls.alert.length === 1);
    const r2 = await runExec("clockIn", false, { wait: (c) => Promise.resolve().then(() => { c.staffName = null; }) });
    check("待つ間に画面を離れたら保存しない", r2.calls.commit === 0 && r2.c.records.length === 0);
    let seen = null;
    const r3 = await runExec("clockIn", false, { wait: (c) => { return Promise.resolve().then(() => { seen = c._plChecking; }); } });
    check("待つ間は「確認しています」状態にし、終われば戻す", seen === true && r3.c._plChecking === false && r3.calls.commit === 1);
  }
  const fc = await runExec("facilityChange", true);
  check("施設変更の選択を持ち越さない", fc.c.facilityChangeTo === null);
  const demo = await runExec("clockIn", true, { outbox: false });
  check("スタッフテスト画面等（キュー無効）は従来経路のまま", demo.calls.save === 1 && demo.calls.alert.length === 0);

  // ── 鮮度管理（PUNCH-LEAVE-FRESH） ───────────────────────
  console.log("■ 打刻前の待機（PUNCH-LEAVE-FRESH）");
  const FRESH = block("// ===== PUNCH-LEAVE-FRESH-BEGIN =====", "// ===== PUNCH-LEAVE-FRESH-END =====");
  function freshCtx(online) {
    const timers = [];
    const f = { console, Promise, Date, navigator: { onLine: online !== false },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
    vm.createContext(f);
    vm.runInContext(FRESH, f);
    f.timers = timers;
    return f;
  }
  {
    const f = freshCtx();
    check("取得中でなければ待たない", f.punchLeaveWaitFresh() === null);
    let res; const p = new Promise((r) => { res = r; });
    f.plTrackFetch(p);
    const w = f.punchLeaveWaitFresh();
    check("未取得で取得中なら待つ", w !== null);
    check("待ちの上限は2秒", f.timers.length === 1 && f.timers[0].ms === 2000);
    let done = false; w.then(() => { done = true; });
    await Promise.resolve(); await Promise.resolve();
    check("取得が終わるまでは待ち続ける", done === false);
    res(); await p; await new Promise((r) => setImmediate(r));
    check("取得が終われば待ちを抜ける", done === true);
    check("取得が終われば取得中の印が消える", f.punchLeaveWaitFresh() === null);
  }
  {
    const f = freshCtx();
    f.plTrackFetch(new Promise(() => {}));
    vm.runInContext("_plFetchedAt=Date.now();", f);
    check("60秒以内に取得済みなら（別スタッフの取得でも）待たない", f.punchLeaveWaitFresh() === null);
    vm.runInContext("_plFetchedAt=Date.now()-61000;", f);
    check("60秒を過ぎていれば取得中は待つ", f.punchLeaveWaitFresh() !== null);
  }
  {
    const f = freshCtx(false);
    f.plTrackFetch(new Promise(() => {}));
    check("通信断では待たない", f.punchLeaveWaitFresh() === null);
  }
  {
    const f = freshCtx();
    let resA; const a = new Promise((r) => { resA = r; });
    f.plTrackFetch(a);
    f.plTrackFetch(new Promise(() => {}));
    resA(); await a; await new Promise((r) => setImmediate(r));
    check("古い取得の完了が新しい取得中の印を消さない", f.punchLeaveWaitFresh() !== null);
  }
  check("スタッフを選ぶたびに本人向けデータを取り直す（selStaff）",
    /staffName=s;\s*\/\/[^\n]*\n\s*_staffDataPromise=null;_staffDataFor="";/.test(html));
  check("打刻画面の描画では有給を取り直さない（送信中の申請を上書きしない）",
    html.indexOf("refreshPunchLeave") < 0 && !/STAFF_DATA_TTL_MS/.test(html));
  check("本番の判定は getLeaveDates / getReqStaffId / resolveStaffId を使う（有給取得履歴と同じ突き合わせ）",
    /punchLeaveApprovedOn\(paidLeaveRequests,resolveStaffId\(name\),name,dateKey,getLeaveDates,getReqStaffId\)/.test(GUARD));
  check("端末キュー（PUNCH-OUTBOX）は有給判定を参照しない（承認前に保存済みの打刻は再送する）",
    (() => { const o = block("// ===== PUNCH-OUTBOX-BEGIN =====", "// ===== PUNCH-OUTBOX-END ====="); return !/punchLeave|paidLeave/.test(o); })());
  check("有給申請の取得は空ノードも成功として扱い、最新の世代だけ反映する",
    /\.then\(function\(v\)\{return \{v:v\};\}\)/.test(html) && /if\(r\[0\]&&_plGen===_plSeq\)\{/.test(html));
  check("確認中は打刻ボタン・顔撮影の枠を消さない（画面下に重ねて表示）",
    !/if\([^)]*_plChecking[^)]*\)\{ci=false/.test(html) && /var _plCheckHtml=_plChecking\s*\?'<div style="position:fixed;/.test(html));
  check("打刻の待機は必要なときだけ（null なら待たない）",
    /var _plWait=punchLeaveWaitFresh\(\);\s*if\(_plWait\)\{/.test(html));

  // ── 静的な境界 ───────────────────────────────────────
  console.log("■ 入口と管理者修正の境界");
  const execBody = fnSrc("async function _execPunch(type,d){", "function doPunch(type){");
  check("_execPunch は判定を端末保存より前に置く",
    execBody.indexOf("punchLeaveBlocked(") > 0 && execBody.indexOf("punchLeaveBlocked(") < execBody.indexOf("punchOutboxCommit("));
  const doPunchBody = fnSrc("function doPunch(type){", "// ===== 施設変更 =====");
  check("doPunch でも先に案内する", doPunchBody.indexOf("punchLeaveBlocked(") > 0);
  const fcModal = fnSrc("function openFacilityChangeModal(){", "\nfunction ");
  check("施設変更の入口でも案内する", fcModal.indexOf("punchLeaveBlocked(") > 0);
  for (const f of ["function saveRecord(", "function patchRecord("]) {
    const s = html.indexOf(f);
    if (s < 0) { check(f + " が存在する", false); continue; }
    const body = html.slice(s, html.indexOf("\nfunction ", s + 10));
    check(f.replace("function ", "").replace("(", "") + "（管理者修正）は有給判定を通らない", body.indexOf("punchLeave") < 0);
  }
  check("打刻画面は承認済み有給の日にボタンを無効化する",
    /var _plBlock=punchOutboxEnabled\(\)&&punchLeaveBlocked\(staffName,dk\);\s*if\(_plBlock\)\{ci=false;co=false;cbs=false;cbe=false;cfc=false;\}/.test(html));
  check("有給判定を独自に再実装しない（ガードは plBuildLeaveHistory を使う）",
    GUARD.indexOf("plBuildLeaveHistory(") > 0 &&
    GUARD.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").indexOf('"approved"') < 0);

  console.log("\n" + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
