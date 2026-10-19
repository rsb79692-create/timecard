/**
 * 打刻漏れの修正（候補の時刻ボタン・打刻漏れまとめ画面・数字4桁入力）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-punch-miss-fix.js
 *
 * 固定すること:
 *   ・時刻入力の読み取り（「1800」「930」「18:00」「18」→ HH:MM、正しくない値は null）
 *   ・候補時刻の計算（本人の過去60日の同じ種類 → 同じ施設 → 既定値。15分丸め・回数順・最大3つ・
 *     退勤は出勤より後／出勤は退勤より前・削除済みを数えない）
 *   ・未打刻の出勤・退勤を埋めるときは理由を選ばせず {reason:"miss",label:"打刻漏れ"} で保存する
 *     （既存の時刻の変更は従来どおり理由を選ぶ）
 *   ・候補ボタンも時刻セルと同じ保存処理（adminApplyTimeEdit）を通る（自動承認・ロールバック）
 *   ・「元に戻す」は埋めた打刻を論理削除し、同時に付いた自動承認を1回の多パス更新で外す
 *   ・打刻漏れまとめ画面の対象（過去14日〜前日・当日を含めない・承認済みを除く・施設の絞り込み・新しい順）
 *
 * 方式: index.html の該当ブロックだけを抜き出して vm で評価し、DOM・通信をモックする。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function slice(startMark, endMark) {
  const s = html.indexOf(startMark);
  const e = s < 0 ? -1 : html.indexOf(endMark, s + startMark.length);
  if (s < 0 || e < 0) { console.error("ERROR: index.html から抽出できません: " + startMark); process.exit(1); }
  return html.slice(s, e);
}
const VALIDATE_CODE = slice("function validateAttendanceRecord(nm,date,sr){", "function findOpenClockInAcrossFacilities(");
const HANDLER_CODE = slice("// ===== 時刻セル インライン編集ハンドラー（勤怠一覧・個人別共通） =====", "// ===== 朝出勤確認ヘルパー =====");
const SAVE_REGION = slice("// ===== ADMIN-APPROVE-SAVE-BEGIN =====", "// ===== ADMIN-APPROVE-SAVE-END =====");

function makeNode(tag) {
  const node = {
    tagName: tag, className: "", title: "", type: "", value: "", style: {}, children: [], dataset: {},
    _handlers: {}, _text: "", _attrs: {},
    appendChild: function (c) { this.children.push(c); return c; },
    addEventListener: function (ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    focus: function () { }, select: function () { },
    getAttribute: function (k) { return k === "style" ? (this._attrs.style || "") : (this._attrs[k] || null); },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    querySelector: function (sel) {
      if (sel !== "input") return null;
      const walk = function (n) { for (const c of n.children) { if (c.tagName === "input") return c; const d = walk(c); if (d) return d; } return null; };
      return walk(this);
    },
    fire: function (ev, e) { (this._handlers[ev] || []).forEach(function (fn) { fn(e || { preventDefault() { }, stopPropagation() { } }); }); }
  };
  Object.defineProperty(node, "textContent", { get() { return this._text; }, set(v) { this._text = String(v); this.children = []; } });
  return node;
}
const TODAY = "2026-10-19";
function makeCtx(o) {
  o = o || {};
  const st = { saved: [], plain: [], apv: [], alerts: [], modals: 0, renders: 0, deleted: [], undo: [], patches: [] };
  const ctx = {
    console: { log() { }, error() { }, warn() { } },
    records: o.records || [], approvals: o.approvals || {}, staffList: o.staffList || [], recFacFilter: o.recFacFilter || "",
    TYPE_LABEL: { clockIn: "出勤", clockOut: "退勤", breakStart: "休憩開始", breakEnd: "休憩終了" },
    pad: function (n) { return (n < 10 ? "0" : "") + n; },
    esc: function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },
    recToday: function () { return TODAY; },
    _recDayShift: function (n) { const d = new Date(Date.UTC(2026, 9, 19 + n)); return d.toISOString().slice(0, 10); },
    recordsRangeCovers: function () { return o.known !== false; },
    parseJstDateTime: function (d, t) { return new Date(d + "T" + t + ":00+09:00"); },
    generateRecordId: (function () { let i = 0; return function () { return "new" + (++i); }; })(),
    saveRecord: function (r) { st.saved.push(JSON.parse(JSON.stringify(r))); st.plain.push(r.id); },
    saveRecordWithApproval: function (r, key, onFail, val) { st.saved.push(JSON.parse(JSON.stringify(r))); st.apv.push({ id: r.id, key: key, val: val, onFail: onFail }); },
    softDeleteRecord: function (id) { st.deleted.push(id); },
    _lsSet: function () { },
    apvSaveBusy: function () { return !!o.busy; },
    showAlert: function (m) { st.alerts.push(m); },
    showConfirm: function (m, y) { y(); },
    showAdjustReasonModal: function (ok) { st.modals++; ok({ reason: "late", label: "遅刻", comment: "" }); },
    render: function () { st.renders++; },
    document: { createElement: makeNode, querySelectorAll: function (sel) { return (ctx.__dom[sel] || []); } },
    __dom: {}
  };
  vm.createContext(ctx);
  vm.runInContext(VALIDATE_CODE + HANDLER_CODE, ctx);
  ctx.__st = st;
  return ctx;
}

// ============================================================================
console.log("\n[1] 時刻入力の読み取り（parseAdminTimeInput）");
{
  const c = makeCtx();
  const P = c.parseAdminTimeInput;
  const ok = { "1800": "18:00", "930": "09:30", "18:00": "18:00", "18": "18:00", "9": "09:00", "0930": "09:30", "0000": "00:00",
    "23:59": "23:59", "8:05": "08:05", " 1800 ": "18:00", "１８００": "18:00", "１８：００": "18:00", "0": "00:00" };
  Object.keys(ok).forEach(function (k) { check("「" + k + "」→ " + ok[k], P(k) === ok[k], String(P(k))); });
  check("空欄は \"\"（削除・取り消しの判定に使う）", P("") === "" && P("   ") === "" && P(null) === "");
  ["2400", "2460", "99:99", "1860", "24", "abc", "18:5", "12345", "18-00", "1:2:3", "７５"].forEach(function (k) {
    check("「" + k + "」は正しくない値（null）", P(k) === null, String(P(k)));
  });
}

// ============================================================================
console.log("\n[2] 候補時刻の計算（pmSuggestTimes）");
{
  const c = makeCtx();
  check("15分単位に丸める（17:53→18:00 / 17:52→17:45 / 08:07→08:00 / 08:08→08:15）",
    c.pmRound15("17:53") === "18:00" && c.pmRound15("17:52") === "17:45" && c.pmRound15("08:07") === "08:00" && c.pmRound15("08:08") === "08:15");
  check("23:53 は日付をまたがせず 23:45", c.pmRound15("23:53") === "23:45");
  const D = "2026-10-15";
  const R = function (staff, type, date, time, extra) { return Object.assign({ staff: staff, type: type, date: date, time: time }, extra || {}); };
  const recs = [
    R("A", "clockOut", "2026-10-14", "17:58"), R("A", "clockOut", "2026-10-13", "18:03"), R("A", "clockOut", "2026-10-10", "18:01"),
    R("A", "clockOut", "2026-10-09", "17:29"), R("A", "clockOut", "2026-10-08", "17:31"),
    R("A", "clockOut", "2026-10-07", "16:00"),
    R("A", "clockOut", "2026-10-06", "19:00", { deleted: true }), R("A", "clockOut", "2026-10-05", "19:00", { deleted: true }),
    R("A", "clockOut", "2026-10-04", "19:00", { deleted: true }),
    R("A", "clockOut", "2026-08-01", "20:00"), R("A", "clockOut", "2026-08-02", "20:00"), // 60日より前
    R("A", "clockOut", "2026-10-16", "21:00"), R("A", "clockOut", "2026-10-17", "21:00"), // 対象日以降
    R("A", "clockIn", "2026-10-14", "08:30"), R("B", "clockOut", "2026-10-14", "15:00")
  ];
  const t = c.pmSuggestTimes(recs, "A", "clockOut", D, ["A", "B"], "08:30");
  check("本人の回数の多い順に最大3つ（18:00×3 → 17:30×2 → 16:00×1）", JSON.stringify(t) === JSON.stringify(["18:00", "17:30", "16:00"]), JSON.stringify(t));
  check("削除済み・60日より前・対象日以降・別の種類・他人は数えない", t.indexOf("19:00") < 0 && t.indexOf("20:00") < 0 && t.indexOf("21:00") < 0 && t.indexOf("08:30") < 0 && t.indexOf("15:00") < 0);
  const t2 = c.pmSuggestTimes(recs, "A", "clockOut", D, ["A", "B"], "17:00");
  check("退勤の候補は出勤より後のものだけ（出勤 17:00 → 18:00・17:30 のみ＋施設で補う）",
    t2.every(function (x) { return x > "17:00"; }) && t2[0] === "18:00" && t2[1] === "17:30", JSON.stringify(t2));
  // 本人のデータが足りない → 同じ施設の全職員で補う
  const peers = [R("B", "clockIn", "2026-10-14", "07:58"), R("B", "clockIn", "2026-10-13", "08:01"), R("C", "clockIn", "2026-10-13", "09:02"),
    R("D", "clockIn", "2026-10-13", "06:00"), R("A", "clockIn", "2026-10-12", "10:00")];
  const t3 = c.pmSuggestTimes(peers, "A", "clockIn", D, ["A", "B", "C"], "");
  check("足りない分は同じ施設の全職員の傾向で補う（本人 10:00 → 施設 08:00・09:00。他施設の 06:00 は使わない）",
    JSON.stringify(t3) === JSON.stringify(["10:00", "08:00", "09:00"]), JSON.stringify(t3));
  const t4 = c.pmSuggestTimes(peers, "A", "clockIn", D, ["A", "B", "C"], "09:30");
  check("出勤の候補は退勤より前のものだけ", t4.every(function (x) { return x < "09:30"; }) && t4.indexOf("10:00") < 0, JSON.stringify(t4));
  check("データが無ければ退勤は 18:00 / 17:00", JSON.stringify(c.pmSuggestTimes([], "Z", "clockOut", D, [], "")) === '["18:00","17:00"]');
  check("データが無ければ出勤は 09:00 / 08:00", JSON.stringify(c.pmSuggestTimes([], "Z", "clockIn", D, [], "")) === '["09:00","08:00"]');
  check("既定値も出勤・退勤の前後関係で絞る（出勤 17:30 → 退勤の既定は 18:00 だけ）",
    JSON.stringify(c.pmSuggestTimes([], "Z", "clockOut", D, [], "17:30")) === '["18:00"]');
  check("当てはまる候補が無ければ空（「その他」だけになる）", c.pmSuggestTimes([], "Z", "clockOut", D, [], "19:00").length === 0);
}

// ============================================================================
console.log("\n[3] 打刻漏れの判定（pmMissType）と候補ボタンの描画");
{
  const c = makeCtx({ staffList: [{ name: "A", location: "ナナイロ" }] });
  const cin = { staff: "A", type: "clockIn", date: "2026-10-18", time: "08:30" };
  check("前日の退勤漏れ → clockOut", c.pmMissType("A", "2026-10-18", [cin]) === "clockOut");
  check("出勤漏れ → clockIn", c.pmMissType("A", "2026-10-18", [{ staff: "A", type: "clockOut", date: "2026-10-18", time: "17:00" }]) === "clockIn");
  check("当日の退勤漏れは対象外（勤務中のため）", c.pmMissType("A", TODAY, [Object.assign({}, cin, { date: TODAY })]) === null);
  check("両方そろっている日は対象外", c.pmMissType("A", "2026-10-18", [cin, { staff: "A", type: "clockOut", date: "2026-10-18", time: "17:00", timestamp: "2026-10-18T08:00:00Z" }]) === null);
  c.records.push(cin);
  const h = c.pmSuggestHtml("A", "2026-10-18", "clockOut");
  check("候補ボタン（pm-btn）と「その他」（pm-other）を出す",
    /class="pm-btn"[^>]*data-time="18:00"/.test(h) && /class="pm-other"/.test(h) && />その他</.test(h), h);
  check("候補ボタンに職員・日付・種類が入る", /data-nm="A"/.test(h) && /data-date="2026-10-18"/.test(h) && /data-type="clockOut"/.test(h), h);
}

// ============================================================================
console.log("\n[4] 候補ボタン1タップで保存（理由は自動で「打刻漏れ」・自動承認・元に戻す）");
{
  const cin = { id: "rin", staff: "A", type: "clockIn", date: "2026-10-18", time: "08:30", timestamp: "2026-10-17T23:30:00.000Z" };
  const c = makeCtx({ records: [cin], staffList: [{ name: "A", location: "ナナイロ" }] });
  const btn = makeNode("button"); btn.dataset = { nm: "A", date: "2026-10-18", type: "clockOut", time: "18:00" };
  c.__dom[".pm-btn"] = [btn];
  c.attachTimeCellHandlers();
  btn.onclick({ stopPropagation() { } });
  const st = c.__st, sv = st.saved[0];
  check("押しただけで保存される（理由を選ぶ画面を出さない）", st.saved.length === 1 && st.modals === 0, JSON.stringify(st.saved));
  check("保存値は退勤 18:00・理由「打刻漏れ」・コメント空",
    sv && sv.type === "clockOut" && sv.time === "18:00" && sv.adjustReason === "miss" && sv.adjustReasonLabel === "打刻漏れ" && sv.adjustComment === "", JSON.stringify(sv));
  check("修正後の時刻（correctedClockOut）と修正前（originalClockOut 空）が残る（修正履歴・CSV の元）",
    sv && sv.correctedClockOut === "18:00" && sv.correctedClockIn === "08:30" && sv.originalClockOut === "" && sv.editedByAdmin === true && sv.manualAdd === true, JSON.stringify(sv));
  check("出勤・退勤がそろうので時刻セルと同じく自動承認する（多パス更新）",
    st.apv.length === 1 && st.apv[0].key === "2026-10-18__A" && c.approvals["2026-10-18__A"] === true && st.apv[0].val === undefined, JSON.stringify(st.apv));
  // 元に戻す
  const rec = c.records.find(function (r) { return r.id === sv.id; });
  const ok = c.pmUndoFill(rec, false);
  check("元に戻す：打刻を論理削除する", ok === true && rec.deleted === true && c.records.length === 2);
  check("元に戻す：自動承認も外す（承認キーを null にする多パス更新を1回）",
    !c.approvals["2026-10-18__A"] && st.apv.length === 2 && st.apv[1].val === null && st.apv[1].id === rec.id && st.apv[1].key === "2026-10-18__A", JSON.stringify(st.apv.map(function (a) { return a.val; })));
  st.apv[1].onFail();
  check("元に戻すの保存失敗：打刻と承認を戻す", rec.deleted !== true && c.approvals["2026-10-18__A"] === true);
}
{
  // 承認されない埋め方（出勤も退勤も無い日の出勤だけ等）→ 元に戻すは論理削除だけ
  const c = makeCtx({ records: [] });
  const r = c.adminFillMissing("A", "2026-10-18", "clockIn", "09:00");
  check("承認できない日の埋め方は時刻だけ保存（従来と同じ）", c.__st.plain.length === 1 && c.__st.apv.length === 0 && !!r);
  c.pmUndoFill(r, false);
  check("元に戻す：論理削除（softDeleteRecord）だけ", r.deleted === true && c.__st.deleted[0] === r.id && c.__st.apv.length === 0);
}
{
  // すでに打刻がある欄には候補ボタンで書かない（画面が古い場合）
  const cout = { id: "rout", staff: "A", type: "clockOut", date: "2026-10-18", time: "17:00" };
  const c = makeCtx({ records: [cout] });
  const r = c.adminFillMissing("A", "2026-10-18", "clockOut", "18:00");
  check("すでに打刻がある欄は上書きしない", r === null && cout.time === "17:00" && c.__st.saved.length === 0 && c.__st.alerts.length === 1);
}
{
  // 保存中（同じ日・同じ職員）は止める
  const c = makeCtx({ records: [], busy: true });
  check("保存中は保存しない（apvSaveBusy）", c.adminFillMissing("A", "2026-10-18", "clockOut", "18:00") === null && c.__st.saved.length === 0);
}

// ============================================================================
console.log("\n[5] 数字入力（type=text・inputmode=numeric・4桁で即確定）");
function openCell(c, data, text) {
  const cell = makeNode("span"); cell.dataset = data; cell.textContent = text; cell._attrs.style = "color:#c8ccd2;";
  c.__dom[".time-cell"] = [cell];
  c.attachTimeCellHandlers();
  cell.onclick();
  const wrap = cell.children[0];
  return { cell: cell, inp: wrap.children[0], ok: wrap.children[1] };
}
{
  const c = makeCtx({ records: [{ id: "rin", staff: "A", type: "clockIn", date: "2026-10-18", time: "08:30", timestamp: "2026-10-17T23:30:00.000Z" }] });
  const o = openCell(c, { id: "", nm: "A", type: "clockOut", date: "2026-10-18" }, "--:--");
  check("入力欄は数字専用（type=text・inputmode=numeric。time 型は使わない）",
    o.inp.type === "text" && o.inp._attrs.inputmode === "numeric", o.inp.type + " " + o.inp._attrs.inputmode);
  o.inp.value = "180"; o.inp.fire("input");
  check("3桁の途中では保存しない", c.__st.saved.length === 0);
  o.inp.value = "1800"; o.inp.fire("input");
  check("「1800」の4桁で Enter なしに保存へ進む（未打刻なので理由なし）",
    c.__st.saved.length === 1 && c.__st.saved[0].time === "18:00" && c.__st.saved[0].adjustReason === "miss" && c.__st.modals === 0, JSON.stringify(c.__st.saved));
}
{
  const c = makeCtx({ records: [] });
  const o = openCell(c, { id: "", nm: "A", type: "clockIn", date: "2026-10-18" }, "--:--");
  o.inp.value = "930"; o.inp.fire("keydown", { key: "Enter", preventDefault() { } });
  check("「930」＋Enter → 09:30 で保存", c.__st.saved.length === 1 && c.__st.saved[0].time === "09:30");
}
{
  const c = makeCtx({ records: [] });
  const o = openCell(c, { id: "", nm: "A", type: "clockIn", date: "2026-10-18" }, "--:--");
  o.inp.value = "18"; o.ok.fire("click");
  check("「18」＋設定ボタン → 18:00", c.__st.saved.length === 1 && c.__st.saved[0].time === "18:00");
}
{
  const c = makeCtx({ records: [] });
  const o = openCell(c, { id: "", nm: "A", type: "clockIn", date: "2026-10-18" }, "--:--");
  o.inp.value = "2599"; o.inp.fire("input");
  check("正しくない4桁は保存せず、今と同じエラーメッセージを出す",
    c.__st.saved.length === 0 && c.__st.alerts.length === 1 && c.__st.alerts[0] === "時刻が正しくありません（例：08:30）", JSON.stringify(c.__st.alerts));
}
{
  // 既存の時刻の変更は理由選択画面へ進む
  const cin = { id: "rin", staff: "A", type: "clockIn", date: "2026-10-18", time: "08:30", timestamp: "2026-10-17T23:30:00.000Z" };
  const c = makeCtx({ records: [cin] });
  const o = openCell(c, { id: "rin", nm: "A", type: "clockIn", date: "2026-10-18" }, "08:30");
  check("既存の時刻は入力欄の初期値になる", o.inp.value === "08:30");
  o.inp.value = "0815"; o.inp.fire("input");
  check("既存の時刻の変更は理由選択画面に進み、選んだ理由で保存する",
    c.__st.modals === 1 && cin.time === "08:15" && cin.adjustReason === "late" && cin.editedFrom === "08:30", JSON.stringify(cin));
}
{
  // 休憩の未打刻欄は従来どおり理由を選ぶ（自動の「打刻漏れ」は出勤・退勤だけ）
  const c = makeCtx({ records: [{ id: "bs", staff: "A", type: "breakStart", date: "2026-10-18", time: "12:00" }] });
  const o = openCell(c, { id: "", nm: "A", type: "breakEnd", date: "2026-10-18" }, "--:--");
  o.inp.value = "1300"; o.inp.fire("input");
  check("休憩の欄は従来どおり理由選択画面を出す・承認しない", c.__st.modals === 1 && c.__st.apv.length === 0 && c.__st.plain.length === 1);
}

// ============================================================================
console.log("\n[6] 打刻漏れまとめ画面の対象（pmMissList）");
{
  const S = [{ name: "A", yomi: "あ", location: "ナナイロ" }, { name: "B", yomi: "い", location: "ココラ" }, { name: "C", yomi: "う", location: "ナナイロ", status: "退職" }];
  const R = function (staff, type, date, time) { return { id: staff + type + date, staff: staff, type: type, date: date, time: time, timestamp: date + "T00:00:00Z" }; };
  const recs = [
    R("A", "clockIn", "2026-10-18", "08:30"),                       // 前日の退勤漏れ → 対象
    R("A", "clockOut", "2026-10-10", "17:00"),                      // 出勤漏れ → 対象
    R("B", "clockIn", "2026-10-12", "08:00"),                       // 施設ココラ → 対象（全施設のとき）
    R("A", "clockIn", TODAY, "08:00"),                              // 当日 → 対象外
    R("A", "clockIn", "2026-10-04", "08:00"),                       // 15日前 → 対象外
    R("A", "clockIn", "2026-10-11", "08:00"),                       // 承認済み → 対象外
    R("C", "clockIn", "2026-10-15", "08:00"),                       // 退職者 → 対象外
    R("A", "clockIn", "2026-10-16", "08:00"), R("A", "clockOut", "2026-10-16", "17:00") // そろっている → 対象外
  ];
  const c = makeCtx({ records: recs, staffList: S, approvals: { "2026-10-11__A": true } });
  const l = c.pmMissList();
  check("過去14日〜前日の退勤漏れ・出勤漏れだけを新しい日付順に出す",
    JSON.stringify(l.map(function (x) { return x.date + ":" + x.staff + ":" + x.type; })) === JSON.stringify(["2026-10-18:A:clockOut", "2026-10-12:B:clockOut", "2026-10-10:A:clockIn"]),
    JSON.stringify(l.map(function (x) { return x.date + ":" + x.staff + ":" + x.type; })));
  check("各行に施設・出勤・退勤の時刻を持つ", l[0].loc === "ナナイロ" && l[0].cin === "08:30" && l[0].cout === "" && l[2].cout === "17:00");
  c.recFacFilter = "ナナイロ";
  check("勤怠一覧で選んでいる施設に絞る", c.pmMissList().every(function (x) { return x.loc === "ナナイロ"; }) && c.pmMissList().length === 2);
  check("ボタンに件数を出す", /⚠ 打刻漏れ 2件/.test(c.pmSummaryButtonHtml()) && /pm-sum-on/.test(c.pmSummaryButtonHtml()));
  // 保存すると一覧から消える（records に退勤が入るため）
  c.adminFillMissing("A", "2026-10-18", "clockOut", "18:00");
  check("保存した行は一覧から消え、件数が減る", c.pmMissList().length === 1 && /⚠ 打刻漏れ 1件/.test(c.pmSummaryButtonHtml()));
  c.recFacFilter = "__none__";
  check("0件のときは目立たない表示", /打刻漏れ 0件/.test(c.pmSummaryButtonHtml()) && !/pm-sum-on/.test(c.pmSummaryButtonHtml()));
  const u = makeCtx({ records: recs, staffList: S, known: false });
  check("期間を取得し終えるまでは件数を断定しない（集計中）", /集計中/.test(u.pmSummaryButtonHtml()) && !/0件/.test(u.pmSummaryButtonHtml()));
}

// ============================================================================
console.log("\n[7] saveRecordWithApproval：承認キーを消す多パス更新（元に戻す用）");
{
  const calls = [];
  const ctx = { console: { log() { }, error() { } }, FB_URL: "https://example.invalid/honomi", records: [], approvals: {}, savingCount: 0,
    demoWriteBlocked: function () { return false; }, _lsSet: function () { }, showAlert: function () { },
    authFetch: function (u, o) { calls.push(JSON.parse(o.body)); return Promise.resolve({ ok: true }); } };
  vm.createContext(ctx);
  vm.runInContext(SAVE_REGION + "\nsaveRecordWithApproval({id:'r1',deleted:true},'2026-10-18__A',function(){},null);saveRecordWithApproval({id:'r2'},'2026-10-18__B',function(){});", ctx);
  check("null を渡すと承認キーを null（削除）で書く", calls[0] && calls[0]["tc5_approvals/2026-10-18__A"] === null && calls[0]["tc5_records/r1"].deleted === true, JSON.stringify(calls[0]));
  check("省略時は従来どおり承認（true）", calls[1] && calls[1]["tc5_approvals/2026-10-18__B"] === true);
}

// ============================================================================
console.log("\n[8] 画面への組み込み");
{
  check("勤怠一覧（日別）の未打刻セルに候補ボタンを出す", /\+\(!rec&&_pmT===type\?pmSuggestHtml\(nm,selDate,type\):""\)/.test(html));
  check("個人別画面の出勤・退勤セルに候補ボタンを出す",
    /tCell\(cin,"clockIn"\)\+\(_pmT==="clockIn"\?pmSuggestHtml\(nm,dk,"clockIn"\):""\)/.test(html) && /tCell\(cout,"clockOut"\)\+\(_pmT==="clockOut"\?pmSuggestHtml\(nm,dk,"clockOut"\):""\)/.test(html));
  check("個人別画面は未取得の月・承認済みでは候補を出さない", /var _pmT=\(!locked2&&monthKnown&&hasData\)\?pmMissType\(nm,dk,dr\):null;/.test(html));
  check("勤怠一覧の操作行に「打刻漏れ」ボタンを置く", /\+pmSummaryButtonHtml\(\)/.test(html) && /btn-pm-summary"\);\s*\n\s*if\(pmSumBtn\)pmSumBtn\.onclick=openPunchMissSummary;/.test(html));
  check("勤怠一覧を開いたら過去14日〜前日を取得する", /if\(adminTab==="records"\)need\.push\(\[_recDayShift\(-14\),_recDayShift\(-1\)\]\);/.test(html));
  check("render() のたびにまとめ画面を作り直す", /_renderInner\(\);\n\s*if\(_pmSummaryRefresh\)_pmSummaryRefresh\(\);/.test(html));
  check("管理者デモでは候補ボタン・まとめ画面を押せない", /"#btn-pm-summary",".pm-btn",".pm-other"/.test(html));
  check("候補ボタン・その他は高さ36px以上", /\.pm-btn,\.pm-other\{min-height:36px;/.test(html) && /\.pm-sum-btn\{min-height:36px;/.test(html));
  check("時刻の保存処理は1か所（showAdjustReasonModal の確定は adminApplyTimeEdit を呼ぶだけ）",
    /showAdjustReasonModal\(function\(adj\)\{el\.textContent=newTime;adminApplyTimeEdit\(snm,date,type,id,newTime,adj,cancel\);\}/.test(html)
      && (html.match(/saveRecordWithApproval\(r,_apvKey,/g) || []).length === 1);
}

console.log("\n================================ PASS " + pass + " / FAIL " + fail + " ================================");
process.exit(fail ? 1 : 0);
