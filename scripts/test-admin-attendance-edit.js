/**
 * 管理者の勤怠編集（未打刻でも編集・新規作成できること）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-admin-attendance-edit.js
 *
 * 目的:
 *   出勤・退勤の打刻が無い日でも、管理者が時刻を入力して勤怠レコードを作成できることを固定する。
 *
 *   旧実装では、スタッフ別詳細（月別の職員別勤怠画面）が
 *       hasData = その日の打刻レコードが1件以上あること
 *   を出勤・退勤セルの編集可否の条件にしていたため、
 *   1件も打刻が無い日は編集用の time-cell 自体が描画されず、管理者が入力できなかった。
 *   また片方だけ未打刻の日は time-cell は出ていたものの、下線が transparent で
 *   「−」1文字ぶんの当たり判定しかなく、クリックできることが分からなかった。
 *
 *   ★ 打刻レコードは「1打刻＝1ノード」（/tc5_records/{id}）であり、
 *     打刻が無い日はレコードが1件も存在しない。したがって未打刻の保存は
 *     既存レコードの更新ではなく新規作成でなければ成立しない。
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、該当ブロックだけを抜き出して
 *   vm コンテキストで評価し、DOM・通信をモックする。本番データへは一切アクセスしない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(SRC, "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function slice(startMark, endMark, from) {
  const s = html.indexOf(startMark, from || 0);
  const e = s < 0 ? -1 : html.indexOf(endMark, s + startMark.length);
  if (s < 0 || e < 0) {
    console.error("ERROR: index.html から該当ブロックを抽出できませんでした: " + startMark);
    console.error("       index.html 側のマーカーを変更した場合は、本テストの抽出条件も合わせてください。");
    process.exit(1);
  }
  return html.slice(s, e);
}

// ============================================================================
// 1. スタッフ別詳細の時刻セル描画（tCell）
//    未打刻でも time-cell として描画されること／承認済みは読み取り専用のままであること
// ============================================================================
const DETAIL_ANCHOR = "  // ── スタッフ詳細 ──";
const detailStart = html.indexOf(DETAIL_ANCHOR);
if (detailStart < 0) { console.error("ERROR: スタッフ詳細ブロックが見つかりません。"); process.exit(1); }
const TCELL_CODE = slice("      function tCell(rec,type){", "      function brkPairDisp(", detailStart);
// dayRows の描画（出勤・休憩・退勤セルの td）
const DAYROW_CODE = slice("      return'<tr style=\"border-bottom:1px solid #e9ecef;background:'+bgRow+';\">", "    }).join(\"\");", detailStart);

const TEST_TODAY = "2026-09-10";   // テスト内の「当日」。実行日に依存させない
function renderCell(rec, type, locked2, monthKnown, dk) {
  const ctx = {
    locked2: !!locked2,
    // この月の打刻を取得できているか。未取得のあいだは未打刻セルを編集させない（フェイルクローズ）
    monthKnown: monthKnown === undefined ? true : !!monthKnown,
    recToday: function () { return TEST_TODAY; },
    nm: "山田 太郎",
    dk: dk || "2026-09-01",
    esc: function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },
    escJs: function (v) { return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); },
    out: null
  };
  vm.createContext(ctx);
  vm.runInContext(TCELL_CODE + "\nout=tCell(rec,type);", Object.assign(ctx, { rec: rec, type: type }));
  return ctx.out;
}

console.log("\n[1] スタッフ別詳細：時刻セルの描画");

const emptyIn = renderCell(null, "clockIn", false);
check("未打刻（出勤）でも time-cell として描画される", /class="time-cell"/.test(emptyIn), emptyIn);
check("未打刻セルの data-id は空（＝新規作成の入口）", /data-id=""/.test(emptyIn), emptyIn);
check("未打刻セルに data-type / data-date / data-nm が入る",
  /data-type="clockIn"/.test(emptyIn) && /data-date="2026-09-01"/.test(emptyIn) && /data-nm="山田 太郎"/.test(emptyIn), emptyIn);
check("未打刻セルの表示文字は「--:--」（attachTimeCellHandlers が空欄として扱う2文字のうちの一方）",
  />--:--<\/span>/.test(emptyIn), emptyIn);
check("未打刻セルはクリックできると分かる（下線がある）",
  /border-bottom:1px solid #adb5bd/.test(emptyIn), emptyIn);
check("未打刻セルの表現が勤怠一覧（日別）とそろっている（独自の min-width / inline-block を持たない）",
  !/min-width/.test(emptyIn) && !/display:inline-block/.test(emptyIn) && !/dashed/.test(emptyIn), emptyIn);
check("未打刻セルに cursor:pointer がある", /cursor:pointer/.test(emptyIn), emptyIn);

const emptyOut = renderCell(null, "clockOut", false);
check("未打刻（退勤）でも time-cell として描画される",
  /class="time-cell"/.test(emptyOut) && /data-type="clockOut"/.test(emptyOut), emptyOut);

const filled = renderCell({ id: "rec-1", time: "08:30" }, "clockIn", false);
check("打刻済みセルは従来どおり time-cell で、値と id を持つ",
  /class="time-cell"/.test(filled) && /data-id="rec-1"/.test(filled) && />08:30</.test(filled), filled);
check("打刻済みセルにも下線がある（未打刻とは表示値で見分ける）",
  /border-bottom:1px solid #adb5bd/.test(filled), filled);
check("打刻済みと未打刻は文字色で区別する", /color:#0f172a/.test(filled) && /color:#c8ccd2/.test(emptyIn), filled);

const lockedEmpty = renderCell(null, "clockIn", true);
const lockedFilled = renderCell({ id: "rec-1", time: "08:30" }, "clockIn", true);
check("承認済み（locked）の未打刻セルは編集できない", !/time-cell/.test(lockedEmpty), lockedEmpty);
check("承認済み（locked）の打刻済みセルは編集できない", !/time-cell/.test(lockedFilled), lockedFilled);

// ── 未取得の月では未打刻セルを編集させない（フェイルクローズ）──────────────
// この月の打刻をまだ取得できていないと、サーバに打刻がある日も「−」に見える。
// そこで入力すると save() の重複判定（メモリ上の records 検索）が空振りし、
// 同じ日に2つ目の打刻ノードができて calcMs() の実働時間＝賃金の基礎が変わる。
console.log("\n[1-b] スタッフ別詳細：この月の打刻を取得できていないとき");

const unknownEmpty = renderCell(null, "clockIn", false, false);
check("未取得の月では未打刻セルを編集できない", !/time-cell/.test(unknownEmpty), unknownEmpty);
// 「--:--」＋下線＝入力できる / 「−」＝入力できない、の区別を崩さない
check("未取得の月の未打刻セルは下線の無い「−」（入力できないと分かる）",
  />−</.test(unknownEmpty) && !/border-bottom/.test(unknownEmpty), unknownEmpty);
check("承認済みの未打刻セルも下線の無い「−」", !/border-bottom/.test(lockedEmpty), lockedEmpty);
const unknownFilled = renderCell({ id: "rec-1", time: "08:30" }, "clockIn", false, false);
check("未取得の月でも打刻済みセルは編集できる（data-id があるので重複しない）",
  /class="time-cell"/.test(unknownFilled) && /data-id="rec-1"/.test(unknownFilled), unknownFilled);
check("取得済みの月では未打刻セルを編集できる（フェイルクローズが常時ONになっていない）",
  /class="time-cell"/.test(renderCell(null, "clockIn", false, true)), "monthKnown=true");

const DETAIL_BODY = html.slice(detailStart, detailStart + 20000);
check("monthKnown を recordsMonthKnown(selMonth) から取っている",
  /var monthKnown=recordsMonthKnown\(selMonth\);/.test(DETAIL_BODY), "monthKnown");
check("未取得の月であることを画面に出す（打刻0件と誤認させない）",
  /monthKnown\?"":'<div style="background:#fee2e2/.test(DETAIL_BODY), "banner");

// 当月の「明日〜月末」と未来月は recMonthEnd() の丸めによりどの経路でも取得されない。
// monthKnown が真でも未取得なので、未来日の未打刻セルも編集させない。
check("当日より後の日は未打刻セルを編集できない（monthKnown が真でも未取得のため）",
  !/time-cell/.test(renderCell(null, "clockIn", false, true, "2026-09-11")), "future");
check("当日の未打刻セルは編集できる（境界：当日は取得済み）",
  /class="time-cell"/.test(renderCell(null, "clockIn", false, true, TEST_TODAY)), "today");
check("当日より前の未打刻セルは編集できる",
  /class="time-cell"/.test(renderCell(null, "clockIn", false, true, "2026-09-09")), "past");
check("未来日でも打刻済みセルは編集できる（data-id があるので重複しない）",
  /class="time-cell"/.test(renderCell({ id: "rec-f", time: "08:30" }, "clockIn", false, true, "2026-09-11")), "future filled");
// 赤バナーはサマリーバーより上に置く。数字を先に読ませると部分集計を確定値と受け取る。
check("未取得の月の赤バナーはサマリーバーより上にある",
  DETAIL_BODY.indexOf('monthKnown?"":') >= 0 &&
  DETAIL_BODY.indexOf('monthKnown?"":') < DETAIL_BODY.indexOf("// ② サマリーバー"), "banner order");
check("バナーが集計値も未確定であることを伝えている",
  /総実働時間[^']*確定値ではありません/.test(DETAIL_BODY), "banner text");
check("未来日のガードは recToday() と比較している",
  /dk>recToday\(\)/.test(DETAIL_BODY), "recToday");

console.log("\n[2] スタッフ別詳細：日行の出勤・退勤セルが hasData で塞がれていないこと");
check("出勤セルが hasData で条件分岐していない",
  /\+tCell\(cin,"clockIn"\)\+/.test(DAYROW_CODE) && !/hasData\?tCell\(cin/.test(DAYROW_CODE), "dayRows");
check("退勤セルが hasData で条件分岐していない",
  /\+tCell\(cout,"clockOut"\)\+/.test(DAYROW_CODE) && !/hasData\?tCell\(cout/.test(DAYROW_CODE), "dayRows");

// 休憩列の hasData ガードを外したのは実質 no-op（打刻ゼロの日は dBrkPairs が空なので
// 従来どおり非編集の「−」になる）。将来ここへ編集セルを足したときに、
// 打刻ゼロの日まで編集可になったことを検知できるよう固定しておく。
const BRK_CODE = slice("      function brkPairDisp(bsR,beR){", "      var approveBtn=", detailStart);
function renderBreak(pairs, locked2, monthKnown) {
  const ctx = {
    locked2: !!locked2,
    monthKnown: monthKnown === undefined ? true : !!monthKnown,
    recToday: function () { return TEST_TODAY; },
    nm: "山田 太郎", dk: "2026-09-01",
    dBrkPairs: pairs,
    bs: pairs[0] ? pairs[0].start : null, be: pairs[0] ? pairs[0].end : null,
    bs2d: pairs[1] ? pairs[1].start : null, be2d: pairs[1] ? pairs[1].end : null,
    hasBreak3d: pairs.length > 2,
    esc: function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); },
    out: null
  };
  vm.createContext(ctx);
  vm.runInContext(TCELL_CODE + "\n" + BRK_CODE + "\nout=brkDisplay;", ctx);
  return ctx.out;
}
const brkNone = renderBreak([]);
check("休憩打刻が無い日は休憩セルが編集可にならない（hasData 除去は no-op）",
  !/time-cell/.test(brkNone), brkNone);
check("休憩打刻が無い日は「−」を表示する", />−</.test(brkNone), brkNone);
const brkOne = renderBreak([{ start: { id: "bs1", time: "12:00" }, end: { id: "be1", time: "13:00" } }]);
check("休憩打刻がある日は従来どおり編集できる",
  /class="time-cell"/.test(brkOne) && /data-type="breakStart"/.test(brkOne) && /data-type="breakEnd"/.test(brkOne), brkOne);
// approveBtn の式そのものを対象にする（12000文字のどこかに hasData? があれば通る、では固定にならない）
const APPROVE_CODE = slice("      var approveBtn=approved2", "      return'<tr style=", detailStart);
check("承認ボタンは従来どおり打刻がある日だけ（承認の条件は変えていない）",
  /:\(hasData\?/.test(APPROVE_CODE), APPROVE_CODE.slice(0, 200));
check("承認ボタンの引き戻しは承認済みの日だけ（変えていない）",
  /^\s*var approveBtn=approved2\s*\n?\s*\?'<button class="btn-withdraw"/.test(APPROVE_CODE), APPROVE_CODE.slice(0, 120));

// ============================================================================
// 3. 時刻セルの保存処理（attachTimeCellHandlers）
//    未打刻セルからの新規作成・既存更新・補完しないこと
// ============================================================================
// 承認前の検査は実装の関数をそのまま使う（承認ボタンと同じ判定であることを固定する）
const VALIDATE_CODE = slice("function validateAttendanceRecord(nm,date,sr){", "function findOpenClockInAcrossFacilities(");
const HANDLER_CODE = slice(
  "// ===== 時刻セル インライン編集ハンドラー（勤怠一覧・個人別共通） =====",
  "// ===== 朝出勤確認ヘルパー ====="
);

// ── 最小限の DOM モック ────────────────────────────────────────────────
function makeNode(tag) {
  const node = {
    tagName: tag,
    className: "",
    title: "",
    type: "",
    value: "",
    style: {},
    children: [],
    _handlers: {},
    _text: "",
    _attrs: {},
    appendChild: function (c) { this.children.push(c); return c; },
    addEventListener: function (ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    focus: function () { }, select: function () { },
    getAttribute: function (k) { return k === "style" ? (this._attrs.style || "") : (this._attrs[k] || null); },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    querySelector: function (sel) {
      if (sel !== "input") return null;
      function walk(n) {
        for (let i = 0; i < n.children.length; i++) {
          if (n.children[i].tagName === "input") return n.children[i];
          const d = walk(n.children[i]); if (d) return d;
        }
        return null;
      }
      return walk(this);
    },
    fire: function (ev, e) {
      (this._handlers[ev] || []).forEach(function (fn) { fn(e || { preventDefault: function () { }, stopPropagation: function () { } }); });
    }
  };
  Object.defineProperty(node, "textContent", {
    get: function () { return this._text; },
    // 実DOMと同じく、代入すると子ノードは消える
    set: function (v) { this._text = String(v); this.children = []; }
  });
  return node;
}
function makeCell(data, text) {
  const el = makeNode("span");
  el.dataset = data;
  el.textContent = text;
  el._attrs.style = "color:#c8ccd2;";
  return el;
}

/**
 * 1セルぶんのシナリオを実行する。
 * opts: { records, cell, input, key, cancelReason, useOkButton }
 * 戻り: { saved:[...], records, alerts, confirms, deleted:[...] }
 */
let newIdSeq = 0;   // 実装の generateRecordId は毎回ユニークな id を返す（crypto.randomUUID）
function runCell(opts) {
  const state = { saved: [], alerts: [], confirms: [], deleted: [], renders: 0, reasonCancelled: 0, plainSaved: [], approvedWrites: [], onFail: null, ls: {} };
  const approvals = opts.approvals || {};
  const records = opts.records;
  const cell = opts.cell;
  const ctx = {
    console: { log: function () { }, error: function () { }, warn: function () { } },
    records: records,
    TYPE_LABEL: { clockIn: "出勤", clockOut: "退勤", breakStart: "休憩開始", breakEnd: "休憩終了" },
    pad: function (n) { return (n < 10 ? "0" : "") + n; },
    parseJstDateTime: function (date, time) { return new Date(date + "T" + time + ":00+09:00"); },
    generateRecordId: function () { return "new-" + (++newIdSeq); },
    saveRecord: function (rec) { state.saved.push(JSON.parse(JSON.stringify(rec))); state.plainSaved.push(rec.id); },
    // 出勤・退勤の管理者修正は、時刻と承認を1回の多パス更新で書く経路を通る
    saveRecordWithApproval: function (rec, key, onFail) {
      state.saved.push(JSON.parse(JSON.stringify(rec)));
      state.approvedWrites.push({ id: rec.id, key: key, approvedInMemory: approvals[key] === true });
      state.onFail = onFail;
    },
    approvals: approvals,
    _lsSet: function (k, v) { state.ls[k] = v; },
    apvSaveBusy: function () { return false; },   // 保存中の競合は [9] で実装そのものを使って確認する
    softDeleteRecord: function (id) { state.deleted.push(id); },
    showAlert: function (m) { state.alerts.push(m); },
    showConfirm: function (m, onYes, onNo) { state.confirms.push(m); if (opts.confirmDelete) onYes(); else if (onNo) onNo(); },
    showAdjustReasonModal: function (onConfirm, onCancel) {
      if (opts.cancelReason) { state.reasonCancelled++; if (onCancel) onCancel(); return; }
      onConfirm({ reason: "forgot", label: "打刻忘れ", comment: "" });
    },
    render: function () { state.renders++; },
    document: {
      createElement: function (tag) { return makeNode(tag); },
      querySelectorAll: function () { return [cell]; }   // NodeList.forEach 相当（配列で代用）
    }
  };
  vm.createContext(ctx);
  vm.runInContext(VALIDATE_CODE + HANDLER_CODE + "\nattachTimeCellHandlers();", ctx);

  cell.onclick();                                   // セルをクリック → 入力欄が出る
  const wrap = cell.children[0];
  const inp = wrap.children[0], btnOk = wrap.children[1], btnCnl = wrap.children[2];
  if (opts.input !== undefined) inp.value = opts.input;
  if (opts.pressCancel) btnCnl.fire("click");
  else if (opts.useOkButton) btnOk.fire("click");
  else if (opts.pressEscape) inp.fire("keydown", { key: "Escape", preventDefault: function () { } });
  else if (opts.noCommit) { /* 何も押さない */ }
  else inp.fire("keydown", { key: "Enter", preventDefault: function () { } });

  return Object.assign(state, { records: records, cell: cell, input: inp, approvals: approvals });
}

console.log("\n[3] 保存処理：未打刻セルからの新規作成");

// (a) 出勤・退勤とも未打刻 → 出勤を新規作成
{
  const recs = [];
  const r = runCell({
    records: recs,
    cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−")
  , input: "08:30" });
  const nr = r.saved[0];
  check("両方未打刻：出勤を入力すると1件だけ保存される", r.saved.length === 1, JSON.stringify(r.saved));
  check("両方未打刻：新規レコードが records へ積まれる（保存した内容と同じ）",
    recs.length === 1 && recs[0].id === nr.id && recs[0].type === "clockIn" && recs[0].time === "08:30",
    JSON.stringify(recs));
  check("両方未打刻：保存値が管理者の入力どおり",
    !!nr && nr.staff === "山田 太郎" && nr.date === "2026-09-01" && nr.time === "08:30" && nr.type === "clockIn",
    JSON.stringify(nr));
  check("両方未打刻：timestamp が JST の入力時刻",
    !!nr && nr.timestamp === new Date("2026-09-01T08:30:00+09:00").toISOString(), nr && nr.timestamp);
  check("両方未打刻：id が採番される（＝新規ノード）", !!nr && !!nr.id, nr && nr.id);
  check("両方未打刻：管理者修正として記録される",
    !!nr && nr.editedByAdmin === true && nr.manualAdd === true && nr.adjustReason === "forgot", JSON.stringify(nr));
  check("両方未打刻：退勤を勝手に補完しない",
    r.saved.filter(function (x) { return x.type === "clockOut"; }).length === 0, JSON.stringify(r.saved));
}

// (b) 出勤・退勤とも未打刻 → 退勤も続けて新規作成できる
{
  const recs = [];
  runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:30" });
  const r2 = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "−"), input: "17:00" });
  check("両方未打刻：出勤・退勤の2件が別レコードとして作られる",
    recs.length === 2 && recs[0].id !== recs[1].id, JSON.stringify(recs.map(function (x) { return x.id + ":" + x.type; })));
  check("両方未打刻：退勤の保存値が入力どおり",
    r2.saved.length === 1 && r2.saved[0].type === "clockOut" && r2.saved[0].time === "17:00", JSON.stringify(r2.saved));
  check("両方未打刻：先に作った出勤を書き換えない",
    recs[0].type === "clockIn" && recs[0].time === "08:30", JSON.stringify(recs[0]));
}

// (c) 出勤済み・退勤未打刻 → 退勤だけを新規作成
{
  const cin = { id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:02", timestamp: "2026-08-31T21:02:00.000Z", workFacility: "ナナイロ" };
  const recs = [cin];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "−"), input: "15:03" });
  check("片方未打刻（退勤なし）：退勤を新規作成できる",
    r.saved.length === 1 && r.saved[0].type === "clockOut" && r.saved[0].time === "15:03", JSON.stringify(r.saved));
  check("片方未打刻（退勤なし）：既存の出勤を書き換えない",
    cin.time === "06:02" && cin.timestamp === "2026-08-31T21:02:00.000Z" && cin.workFacility === "ナナイロ" && !cin.editedByAdmin,
    JSON.stringify(cin));
  check("片方未打刻（退勤なし）：レコードは2件になる", recs.length === 2, String(recs.length));
}

// (d) 出勤未打刻・退勤済み → 出勤だけを新規作成
{
  const cout = { id: "rec-out", staff: "山田 太郎", type: "clockOut", date: "2026-09-01", time: "15:03", timestamp: "2026-09-01T06:03:00.000Z" };
  const recs = [cout];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "06:02" });
  check("片方未打刻（出勤なし）：出勤を新規作成できる",
    r.saved.length === 1 && r.saved[0].type === "clockIn" && r.saved[0].time === "06:02", JSON.stringify(r.saved));
  check("片方未打刻（出勤なし）：既存の退勤を書き換えない",
    cout.time === "15:03" && !cout.editedByAdmin, JSON.stringify(cout));
  check("片方未打刻（出勤なし）：修正前の退勤時刻がスナップショットされる",
    r.saved[0].originalClockOut === "15:03" && r.saved[0].correctedClockIn === "06:02", JSON.stringify(r.saved[0]));
}

console.log("\n[4] 保存処理：既存の打刻を壊さない");

// (e) 打刻済みセル（id あり）→ 既存レコードを更新し、新規作成しない
{
  const cin = { id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "08:30", timestamp: "2026-08-30T23:30:00.000Z", workFacility: "ナナイロ" };
  const recs = [cin];
  const r = runCell({ records: recs, cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "08:30"), input: "08:00" });
  check("両方打刻済み：既存レコードを更新する（従来どおり）",
    recs.length === 1 && cin.time === "08:00" && cin.id === "rec-in", JSON.stringify(cin));
  check("両方打刻済み：新規レコードを作らない", r.saved.length === 1 && r.saved[0].id === "rec-in", JSON.stringify(r.saved));
  check("両方打刻済み：修正履歴と修正前時刻が残る",
    cin.editedFrom === "08:30" && Array.isArray(cin.editHistory) && cin.editHistory.length === 1, JSON.stringify(cin.editHistory));
  check("両方打刻済み：workFacility を消さない", cin.workFacility === "ナナイロ", String(cin.workFacility));
}

// (f) id は空だが同種の既存レコードがある → 二重登録せず既存を更新
{
  const cin = { id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "08:30", timestamp: "2026-08-30T23:30:00.000Z" };
  const recs = [cin];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "07:00" });
  check("id 空でも同じ日・同じ種別の既存レコードがあれば更新する（二重登録しない）",
    recs.length === 1 && cin.time === "07:00", JSON.stringify(recs));
  check("id 空の既存更新でも1件しか保存しない", r.saved.length === 1, JSON.stringify(r.saved));
}

// (g) 他の職員・他の日のレコードを巻き込まない
{
  const other = { id: "rec-other", staff: "佐藤 花子", type: "clockIn", date: "2026-09-01", time: "09:00", timestamp: "2026-09-01T00:00:00.000Z" };
  const otherDay = { id: "rec-day", staff: "山田 太郎", type: "clockIn", date: "2026-09-02", time: "09:30", timestamp: "2026-09-01T00:30:00.000Z" };
  const recs = [other, otherDay];
  runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:00" });
  check("他の職員のレコードを書き換えない", other.time === "09:00" && !other.editedByAdmin, JSON.stringify(other));
  check("他の日のレコードを書き換えない", otherDay.time === "09:30" && !otherDay.editedByAdmin, JSON.stringify(otherDay));
  check("追加は1件だけ", recs.length === 3, String(recs.length));
}

// (h) 削除済みレコードは「既存」として拾わず、新規作成する
{
  const del = { id: "rec-del", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "08:30", timestamp: "2026-08-30T23:30:00.000Z", deleted: true };
  const recs = [del];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:00" });
  check("削除済みレコードは復活させず、新規作成する",
    recs.length === 2 && del.time === "08:30" && del.deleted === true, JSON.stringify(recs));
  check("削除済みレコードを再保存しない", r.saved.length === 1 && r.saved[0].id !== "rec-del", JSON.stringify(r.saved));
}

console.log("\n[5] 保存処理：勝手に保存しない（誤操作の防止）");

// (i) 未入力のまま確定 → 何も保存しない
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "" });
  check("未入力のまま確定しても保存しない", r.saved.length === 0 && recs.length === 0, JSON.stringify(r.saved));
  check("未入力のまま確定すると元の表示へ戻る", r.cell.textContent === "−", r.cell.textContent);
}

// (j) 修正理由モーダルをキャンセル → 保存しない
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:30", cancelReason: true });
  check("修正理由をキャンセルすると保存しない", r.saved.length === 0 && recs.length === 0, JSON.stringify(r.saved));
  check("修正理由をキャンセルすると元の表示へ戻る", r.cell.textContent === "−", r.cell.textContent);
}

// (k) Enter / 設定ボタン以外では保存しない
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:30", noCommit: true });
  check("入力しただけ（Enter も設定ボタンも押していない）では保存しない", r.saved.length === 0 && recs.length === 0, JSON.stringify(r.saved));
}
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:30", pressCancel: true });
  check("✕ボタンでは保存しない", r.saved.length === 0 && recs.length === 0, JSON.stringify(r.saved));
}
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "08:30", useOkButton: true });
  check("設定ボタンでは保存する", r.saved.length === 1 && recs.length === 1, JSON.stringify(r.saved));
}

// (l) 不正な時刻は保存しない
{
  const recs = [];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "99:99" });
  check("不正な時刻は保存せず警告する", r.saved.length === 0 && recs.length === 0 && r.alerts.length === 1, JSON.stringify(r.alerts));
}

console.log("\n[6] 空欄プレースホルダの解釈");

// (m) 「−」「--:--」はどちらも空欄として扱われる（既存値として拾わない）
{
  const recs = [];
  const r1 = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), noCommit: true });
  check("「−」は空欄として扱われ、入力欄に持ち込まれない", r1.input.value === "", r1.input.value);
  check("実際に描画される未打刻セルの文字が、空欄として扱われる2文字のいずれかである",
    /(--:--|−)/.test(String(emptyIn.match(/>([^<]*)<\/span>/) || [])), emptyIn);
  const r2 = runCell({ records: [], cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "--:--"), noCommit: true });
  check("「--:--」は空欄として扱われ、入力欄に持ち込まれない", r2.input.value === "", r2.input.value);
  const r3 = runCell({ records: [], cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "08:30"), noCommit: true });
  check("打刻済みの値は入力欄の初期値になる", r3.input.value === "08:30", r3.input.value);
}

// ============================================================================
// 7. 勤怠一覧（日別）側は従来どおり全職員ぶんの編集セルを描画していること
// ============================================================================
console.log("\n[7] 勤怠一覧（日別）：打刻が無い職員も編集できる（既存挙動の固定）");
const dailyBlock = slice("      var dRecs=records.filter(function(r){return r.date===selDate;})", "+'<tbody>'+sumRows+", 0);
check("日別一覧は在籍者全員ぶん行を作る（打刻の有無で絞っていない）",
  /var allStaffSorted=allActiveStaff;/.test(dailyBlock) && /allStaffSorted\.map/.test(dailyBlock), "sumRows");
check("日別一覧の時刻セルは hasPunch で条件分岐していない",
  !/hasPunch\?tCell/.test(dailyBlock), "tCell");
check("日別一覧の未打刻セルは data-id 空で描画される（＝新規作成の入口）",
  /data-id="'\+esc\(rec\?rec\.id:""\)/.test(dailyBlock), "tCell");

// ============================================================================
// 8. 管理者が出勤・退勤を修正・入力して確定したら、同時に承認済みにする
//    （時刻と承認を1回の多パス更新で書く。休憩・削除・キャンセルは従来どおり）
// ============================================================================
console.log("\n[8] 管理者の出勤・退勤修正と同時承認");
{
  // (a) 既存の出勤打刻を修正 → 同じ更新で承認される／監査情報が残る
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:05", timestamp: "2026-08-31T21:05:00.000Z" },
    { id: "rec-out", staff: "山田 太郎", type: "clockOut", date: "2026-09-01", time: "15:00", timestamp: "2026-09-01T06:00:00.000Z" }];
  const other = { "2026-09-02__山田 太郎": true, "2026-09-01__佐藤 花子": true };
  const r = runCell({ records: recs, approvals: Object.assign({}, other),
    cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "06:05"), input: "06:00" });
  const w = r.approvedWrites[0], sv = r.saved[0];
  check("既存出勤の修正：承認付きの保存が1回だけ呼ばれる", r.approvedWrites.length === 1 && r.plainSaved.length === 0, JSON.stringify(r.approvedWrites));
  check("既存出勤の修正：承認キーはその日・その職員（日付__氏名）", !!w && w.key === "2026-09-01__山田 太郎" && w.id === "rec-in", JSON.stringify(w));
  check("既存出勤の修正：保存時点でメモリ上も承認済み", !!w && w.approvedInMemory === true && r.approvals["2026-09-01__山田 太郎"] === true);
  check("既存出勤の修正：他の日・他の職員の承認に触れない",
    r.approvals["2026-09-02__山田 太郎"] === true && r.approvals["2026-09-01__佐藤 花子"] === true && Object.keys(r.approvals).length === 3,
    JSON.stringify(r.approvals));
  check("既存出勤の修正：時刻は 06:00 で保存される", !!sv && sv.time === "06:00" && sv.timestamp === new Date("2026-09-01T06:00:00+09:00").toISOString(), JSON.stringify(sv));
  check("既存出勤の修正：修正理由・修正前の時刻・編集履歴が残る",
    !!sv && sv.adjustReason === "forgot" && sv.adjustReasonLabel === "打刻忘れ" && sv.editedFrom === "06:05" &&
    Array.isArray(sv.editHistory) && sv.editHistory[0].time === "06:05" && sv.editedByAdmin === true && sv.adjustedBy === "管理者",
    JSON.stringify(sv));
  check("既存出勤の修正：同時承認した時刻を記録する", !!sv && typeof sv.adjustApprovedAt === "string" && sv.adjustApprovedAt === sv.adjustedAt, JSON.stringify(sv));
  check("既存出勤の修正：id を採り直さない（上書き更新）", recs.length === 2 && sv.id === "rec-in");
  check("既存出勤の修正：承認できたときは案内を出さない", r.alerts.length === 0, JSON.stringify(r.alerts));
}
{
  // (b) 未打刻の退勤を新規入力 → 新規作成と同時に承認
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:00", timestamp: "2026-08-31T21:00:00.000Z" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "--:--"), input: "15:00" });
  const sv = r.saved[0];
  check("未打刻退勤の新規入力：新規レコードを承認付きで保存する",
    r.approvedWrites.length === 1 && r.plainSaved.length === 0 && recs.length === 2 && !!sv && sv.type === "clockOut" && sv.time === "15:00" && sv.manualAdd === true,
    JSON.stringify(r.saved));
  check("未打刻退勤の新規入力：その日が承認済みになる", r.approvals["2026-09-01__山田 太郎"] === true && r.approvedWrites[0].id === sv.id);
  check("未打刻退勤の新規入力：修正理由が記録される", sv.adjustReason === "forgot" && sv.adjustReasonLabel === "打刻忘れ");
}
{
  // (c) 出勤・退勤とも無い日：出勤だけ入れた時点では承認しない（承認ボタンと同じく退勤漏れは承認不可）
  //     続けて退勤を入れた時点で、その保存と同時に承認される
  const recs = [], apv = {};
  const r = runCell({ records: recs, approvals: apv, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "−"), input: "06:00" });
  check("出勤だけ入力：時刻は保存し、承認はしない（退勤漏れ）",
    r.plainSaved.length === 1 && r.approvedWrites.length === 0 && recs.length === 1 && !apv["2026-09-01__山田 太郎"], JSON.stringify(r.approvedWrites));
  check("出勤だけ入力：承認していない理由を短く伝える", r.alerts.length === 1 && /退勤漏れ/.test(r.alerts[0]), JSON.stringify(r.alerts));
  const r2 = runCell({ records: recs, approvals: apv, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "−"), input: "15:00" });
  check("続けて退勤を入力：保存と同時に承認される（別途の承認操作は不要）",
    r2.approvedWrites.length === 1 && r2.plainSaved.length === 0 && recs.length === 2 && apv["2026-09-01__山田 太郎"] === true, JSON.stringify(apv));
}
{
  // (c2) 退勤が出勤以前になる修正は承認しない（勤務時間異常）
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:00", timestamp: "2026-08-31T21:00:00.000Z" },
    { id: "rec-out", staff: "山田 太郎", type: "clockOut", date: "2026-09-01", time: "15:00", timestamp: "2026-09-01T06:00:00.000Z" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "rec-out", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "15:00"), input: "05:00" });
  check("勤務時間異常になる修正：時刻だけ保存し承認しない",
    r.plainSaved.length === 1 && r.approvedWrites.length === 0 && !r.approvals["2026-09-01__山田 太郎"] && /勤務時間異常/.test(r.alerts[0] || ""), JSON.stringify(r.alerts));
}
{
  // (d) 休憩の修正は従来どおり承認しない
  const recs = [{ id: "rec-bs", staff: "山田 太郎", type: "breakStart", date: "2026-09-01", time: "12:00" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "rec-bs", nm: "山田 太郎", type: "breakStart", date: "2026-09-01" }, "12:00"), input: "12:10" });
  check("休憩の修正：従来の保存だけで承認しない",
    r.plainSaved.length === 1 && r.approvedWrites.length === 0 && !r.approvals["2026-09-01__山田 太郎"], JSON.stringify(r.approvals));
}
{
  // (e) 修正理由をキャンセル → 保存も承認もしない
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:05" }];
  const r = runCell({ records: recs, cancelReason: true, cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "06:05"), input: "06:00" });
  check("理由キャンセル：保存も承認もしない", r.saved.length === 0 && Object.keys(r.approvals).length === 0 && recs[0].time === "06:05");
}
{
  // (f) 削除（空欄で確定）は承認しない
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:05" }];
  const r = runCell({ records: recs, confirmDelete: true, cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "06:05"), input: "" });
  check("削除：承認しない", r.deleted.length === 1 && r.approvedWrites.length === 0 && Object.keys(r.approvals).length === 0);
}
{
  // (g) 保存失敗時は承認も時刻も元へ戻す（「時刻・承認とも保存されていません」と画面を一致させる）
  const inRec = { id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:05", timestamp: "2026-08-31T21:05:00.000Z" };
  const before = JSON.stringify(inRec);
  const recs = [inRec, { id: "rec-out", staff: "山田 太郎", type: "clockOut", date: "2026-09-01", time: "15:00", timestamp: "2026-09-01T06:00:00.000Z" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "rec-in", nm: "山田 太郎", type: "clockIn", date: "2026-09-01" }, "06:05"), input: "06:00" });
  check("保存失敗の前提：承認付き保存が呼ばれている", r.approvedWrites.length === 1 && inRec.time === "06:00");
  r.onFail();
  check("保存失敗：メモリ上の承認を取り消す", !r.approvals["2026-09-01__山田 太郎"], JSON.stringify(r.approvals));
  check("保存失敗：修正した打刻を修正前の内容へ戻す（同じオブジェクトのまま）",
    recs[0] === inRec && JSON.stringify(inRec) === before && recs.length === 2, JSON.stringify(inRec));
  check("保存失敗：端末保存（records・approvals）も戻した内容で書き直す",
    typeof r.ls.tc5_records === "string" && JSON.parse(r.ls.tc5_records)[0].time === "06:05" && JSON.parse(r.ls.tc5_approvals)["2026-09-01__山田 太郎"] === undefined, JSON.stringify(r.ls));
}
{
  // (g2) 新規入力の保存失敗：積んだ新規レコードを取り除く
  const recs = [{ id: "rec-in", staff: "山田 太郎", type: "clockIn", date: "2026-09-01", time: "06:00", timestamp: "2026-08-31T21:00:00.000Z" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "", nm: "山田 太郎", type: "clockOut", date: "2026-09-01" }, "−"), input: "15:00" });
  check("新規入力の前提：レコードが積まれている", recs.length === 2 && r.approvedWrites.length === 1);
  r.onFail();
  check("新規入力の保存失敗：新規レコードを取り除き、既存の出勤は残す",
    recs.length === 1 && recs[0].id === "rec-in" && recs[0].time === "06:00" && !r.approvals["2026-09-01__山田 太郎"], JSON.stringify(recs));
}
{
  // (h) RTDB のキーに使えない文字を含む氏名は、時刻だけ保存しない（片方だけ成功させない）
  const recs = [{ id: "rec-in", staff: "J.Smith", type: "clockIn", date: "2026-09-01", time: "06:05" }];
  const r = runCell({ records: recs, cell: makeCell({ id: "rec-in", nm: "J.Smith", type: "clockIn", date: "2026-09-01" }, "06:05"), input: "06:00" });
  check("キーに使えない氏名：保存せず警告する", r.saved.length === 0 && r.alerts.length === 1 && recs[0].time === "06:05", JSON.stringify(r.alerts));
}

// ── saveRecordWithApproval 本体：1回の PATCH で時刻と承認キー1件だけを書く ──
{
  const FN = slice("// ===== ADMIN-APPROVE-SAVE-BEGIN =====", "// ===== ADMIN-APPROVE-SAVE-END =====");
  function runSave(ok) {
    const st = { calls: [], alerts: [], failed: 0, saving: 0 };
    const ctx = {
      console: { log: function () { }, error: function () { } },
      FB_URL: "https://example.invalid/honomi", records: [], approvals: {},
      demoWriteBlocked: function () { return false; }, _lsSet: function () { },
      showAlert: function (m) { st.alerts.push(m); },
      authFetch: function (url, o) {
        st.calls.push({ url: url, method: o.method, body: JSON.parse(o.body) });
        return ok ? Promise.resolve({ ok: true }) : Promise.resolve({ ok: false, status: 500, text: function () { return Promise.resolve(""); } });
      },
      savingCount: 0
    };
    vm.createContext(ctx);
    vm.runInContext(FN + "\nsaveRecordWithApproval({id:'r1',time:'06:00'},'2026-09-01__山田 太郎',function(){failedCb();});", Object.assign(ctx, { failedCb: function () { st.failed++; } }));
    st.ctx = ctx;
    return st;
  }
  const okRun = runSave(true);
  const c = okRun.calls[0];
  check("同時保存：通信は1回だけ", okRun.calls.length === 1);
  check("同時保存：会社のルート（FB_URL）への PATCH（多パス更新）", !!c && c.method === "PATCH" && c.url === "https://example.invalid/honomi.json", c && (c.method + " " + c.url));
  check("同時保存：本文は打刻1件と承認キー1件だけ（承認ノード全体を上書きしない）",
    !!c && Object.keys(c.body).length === 2 && c.body["tc5_records/r1"].time === "06:00" && c.body["tc5_approvals/2026-09-01__山田 太郎"] === true && !("tc5_approvals" in c.body),
    c && JSON.stringify(c.body));
  const badCtx = { calls: 0, failed: 0, alerts: 0 };
  {
    const ctx = { console: { log: function () { }, error: function () { } }, FB_URL: "https://example.invalid/honomi", records: [], approvals: {},
      demoWriteBlocked: function () { return false; }, _lsSet: function () { }, showAlert: function () { badCtx.alerts++; },
      authFetch: function () { badCtx.calls++; return Promise.resolve({ ok: true }); }, savingCount: 0, fcb: function () { badCtx.failed++; } };
    vm.createContext(ctx);
    vm.runInContext(FN + "\n['', null, undefined, 'a/b', 'x.y'].forEach(function(id){saveRecordWithApproval({id:id},'2026-09-01__山田 太郎',fcb);});", ctx);
  }
  check("同時保存：id が空・不正なら通信せず失敗扱い（tc5_records 全体を置き換えない）",
    badCtx.calls === 0 && badCtx.failed === 5 && badCtx.alerts === 5, JSON.stringify(badCtx));
  const badKey = { calls: 0, failed: 0 };
  {
    const ctx = { console: { log: function () { }, error: function () { } }, FB_URL: "https://example.invalid/honomi", records: [], approvals: {},
      demoWriteBlocked: function () { return false; }, _lsSet: function () { }, showAlert: function () { },
      authFetch: function () { badKey.calls++; return Promise.resolve({ ok: true }); }, savingCount: 0, fcb: function () { badKey.failed++; } };
    vm.createContext(ctx);
    vm.runInContext(FN + "\n['', null, '2026-09-01__a/b', '2026-09-01__a.b'].forEach(function(k){saveRecordWithApproval({id:'r1'},k,fcb);});", ctx);
  }
  check("同時保存：承認キーが空・不正（/ . など）なら通信せず失敗扱い", badKey.calls === 0 && badKey.failed === 4, JSON.stringify(badKey));
  const ngRun = runSave(false);
  setTimeout(function () {
    check("同時保存の失敗：失敗コールバックと警告が1回ずつ", ngRun.failed === 1 && ngRun.alerts.length === 1, JSON.stringify(ngRun));
    check("同時保存：保存中カウンタが戻る（成功・失敗とも）", okRun.ctx.savingCount === 0 && ngRun.ctx.savingCount === 0);
    check("同時保存：完了後は同じ日の保存中ロックが外れる（成功・失敗とも）",
      okRun.ctx._apvBusyCount === 0 && ngRun.ctx._apvBusyCount === 0 && Object.keys(okRun.ctx._apvBusy).length === 0);
    runRaceTests().then(finish, function (e) { check("競合テストが例外なく完了する", false, e && e.stack); finish(); });
  }, 20);
}

// ============================================================================
// 9. 保存中の多重操作（競合）：画面の表示とサーバの保存結果が必ず一致すること
//    実装の同時保存・承認保存・時刻セル処理をそのまま評価し、サーバを模した状態と突き合わせる
// ============================================================================
function runRaceTests() {
  console.log("\n[9] 保存中の多重操作：画面とサーバの一致");
  const SAVE_REGION = slice("// ===== ADMIN-APPROVE-SAVE-BEGIN =====", "// ===== ADMIN-APPROVE-SAVE-END =====");
  const SAVE_APPROVALS = slice("function saveApprovals(approvalsObj) {", "\n// ===== tc5_correction_requests 書込ヘルパー =====");
  const clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  const TSX = function (d, t) { return new Date(d + "T" + t + ":00+09:00").toISOString(); };
  const flush = async function () { for (let i = 0; i < 30; i++) await new Promise(function (r) { setImmediate(r); }); };
  const D = "2026-09-01", A = "山田 太郎", B = "佐藤 花子", KA = D + "__" + A;

  function makeWorld() {
    let seq = 0;
    const server = { records: {}, approvals: {} };
    const pending = [];
    const w = { server: server, alerts: [], puts: [], reconcileFail: 0, ls: {} };
    const ctx = {
      console: { log: function () { }, error: function () { }, warn: function () { } },
      FB_URL: "https://example.invalid/honomi", records: [], approvals: {}, approvalsLoaded: true, savingCount: 0,
      demoWriteBlocked: function () { return false; },
      _lsSet: function (k, v) { w.ls[k] = v; },
      showAlert: function (m) { w.alerts.push(m); },
      render: function () { },
      setTimeout: function (fn) { Promise.resolve().then(fn); },
      TYPE_LABEL: { clockIn: "出勤", clockOut: "退勤", breakStart: "休憩開始", breakEnd: "休憩終了" },
      pad: function (n) { return (n < 10 ? "0" : "") + n; },
      parseJstDateTime: function (date, time) { return new Date(date + "T" + time + ":00+09:00"); },
      generateRecordId: function () { return "n" + (++seq); },
      showAdjustReasonModal: function (onConfirm) { onConfirm({ reason: "miss", label: "打刻漏れ", comment: "" }); },
      showConfirm: function (m, yes) { yes(); },
      saveRecord: function (rec) { server.records[rec.id] = clone(rec); },
      softDeleteRecord: function (id) { if (server.records[id]) server.records[id].deleted = true; },
      punchOutboxMergeInto: function () { w.outboxMerges = (w.outboxMerges || 0) + 1; },
      fetchRecordsRange: function (from, to) {
        if (w.reconcileFail > 0) { w.reconcileFail--; return Promise.resolve(null); }
        const o = {};
        Object.keys(server.records).forEach(function (k) { const r = server.records[k]; if (r.date >= from && r.date <= to) o[k] = clone(r); });
        return Promise.resolve(o);
      },
      authFetch: function (url, o) {
        o = o || {};
        if (o.method === "PATCH") return new Promise(function (res, rej) { pending.push({ body: JSON.parse(o.body), res: res, rej: rej }); });
        if (o.method === "PUT" && /\/tc5_approvals\.json$/.test(url)) {
          const b = JSON.parse(o.body); server.approvals = clone(b); w.puts.push(b); return Promise.resolve({ ok: true });
        }
        if (!o.method && /\/tc5_approvals\.json$/.test(url)) {
          const snap = clone(server.approvals);             // 送った時点のサーバの内容
          const resp = { ok: true, json: function () { return Promise.resolve(snap); } };
          if (w.holdGets) return new Promise(function (res) { (w.heldGets = w.heldGets || []).push(function () { res(resp); }); });
          return Promise.resolve(resp);
        }
        const m = url.match(/\/tc5_approvals\/(.+)\.json$/);
        if (m) {
          const k = decodeURIComponent(m[1]);
          return Promise.resolve({ ok: true, json: function () { return Promise.resolve(server.approvals[k] === undefined ? null : server.approvals[k]); } });
        }
        return Promise.reject(new Error("unexpected " + url));
      },
      document: { createElement: function (tag) { return makeNode(tag); }, querySelectorAll: function () { return []; } }
    };
    vm.createContext(ctx);
    vm.runInContext(VALIDATE_CODE + SAVE_REGION + SAVE_APPROVALS + HANDLER_CODE, ctx);
    function apply(body) {
      Object.keys(body).forEach(function (p) {
        const i = p.indexOf("/"), top = p.slice(0, i), k = p.slice(i + 1);
        if (top === "tc5_records") server.records[k] = clone(body[p]);
        else if (top === "tc5_approvals") server.approvals[k] = body[p];
      });
    }
    w.ctx = ctx;
    w.pendingCount = function () { return pending.length; };
    w.ok = function () { const p = pending.shift(); apply(p.body); p.res({ ok: true }); };
    w.httpFail = function () { const p = pending.shift(); p.res({ ok: false, status: 500, text: function () { return Promise.resolve(""); } }); };
    w.netFail = function (applied) { const p = pending.shift(); if (applied) apply(p.body); p.rej(new Error("network")); };
    w.seed = function (recs, apv) {
      recs.forEach(function (r) { server.records[r.id] = clone(r); ctx.records.push(clone(r)); });
      Object.keys(apv || {}).forEach(function (k) { server.approvals[k] = apv[k]; ctx.approvals[k] = apv[k]; });
    };
    // 時刻セルを開く（開けたら入力欄を返す。保存中で開けなければ null）
    w.open = function (data, text) {
      const cell = makeCell(data, text);
      ctx.document.querySelectorAll = function () { return [cell]; };
      ctx.attachTimeCellHandlers();
      cell.onclick();
      return cell.children[0] ? cell.children[0].children[0] : null;
    };
    w.enter = function (inp, v) { inp.value = v; inp.fire("keydown", { key: "Enter", preventDefault: function () { } }); };
    w.edit = function (data, text, v) { const inp = w.open(data, text); if (!inp) return false; w.enter(inp, v); return true; };
    // その職員・その日について、画面（メモリ）とサーバの打刻・承認が一致しているか
    w.consistent = function (staff, date) {
      const pick = function (arr) {
        return arr.filter(function (r) { return r.staff === staff && r.date === date && !r.deleted; })
          .map(function (r) { return r.id + ":" + r.type + ":" + r.time; }).sort().join("|");
      };
      const local = pick(ctx.records), srv = pick(Object.keys(server.records).map(function (k) { return server.records[k]; }));
      const key = date + "__" + staff;
      const la = ctx.approvals[key] === true, sa = server.approvals[key] === true;
      return { ok: local === srv && la === sa, local: local, server: srv, localApproved: la, serverApproved: sa };
    };
    return w;
  }
  const baseDay = function (staff, idp) {
    return [
      { id: idp + "in", staff: staff, type: "clockIn", date: D, time: "06:05", timestamp: TSX(D, "06:05") },
      { id: idp + "out", staff: staff, type: "clockOut", date: D, time: "15:00", timestamp: TSX(D, "15:00") }
    ];
  };

  return (async function () {
    // (a) 1回目保存中は同じ日の次の編集を始めさせない → 1回目失敗 → 画面は元へ戻りサーバと一致
    //     → 2回目を編集できるようになり、成功すればサーバと一致
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a").concat(baseDay(B, "b")));
      check("競合(a)：1回目（出勤 06:05→06:00）の保存が始まる", w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00") && w.pendingCount() === 1);
      const blocked = !w.edit({ id: "aout", nm: A, type: "clockOut", date: D }, "15:00", "14:30");
      check("競合(a)：保存中は同じ日・同じ職員の次の編集を開けない", blocked && w.pendingCount() === 1 && /保存が完了していません/.test(w.alerts[w.alerts.length - 1] || ""), JSON.stringify(w.alerts));
      check("競合(a)：別の職員の同じ日は編集できる（ロックは職員単位）", w.edit({ id: "bin", nm: B, type: "clockIn", date: D }, "06:05", "06:10") && w.pendingCount() === 2);
      w.httpFail(); await flush();
      const c1 = w.consistent(A, D);
      check("競合(a)：1回目失敗後、画面とサーバが一致（出勤 06:05・未承認）", c1.ok && /ain:clockIn:06:05/.test(c1.local) && !c1.localApproved, JSON.stringify(c1));
      check("競合(a)：失敗後は同じ日の編集ロックが外れる", !w.ctx._apvBusy[KA]);
      check("競合(a)：2回目（退勤 15:00→14:30）を編集できる", w.edit({ id: "aout", nm: A, type: "clockOut", date: D }, "15:00", "14:30") && w.pendingCount() === 2);
      w.ok(); w.ok(); await flush();
      const c2 = w.consistent(A, D), cb = w.consistent(B, D);
      check("競合(a)：2回目成功後、画面とサーバが一致（出勤 06:05・退勤 14:30・承認済み）",
        c2.ok && /aout:clockOut:14:30/.test(c2.local) && /ain:clockIn:06:05/.test(c2.local) && c2.localApproved, JSON.stringify(c2));
      check("競合(a)：別職員の保存結果も画面とサーバが一致", cb.ok && cb.localApproved && /bin:clockIn:06:10/.test(cb.local), JSON.stringify(cb));
      check("競合(a)：保存中カウンタ・ロックがすべて戻る", w.ctx.savingCount === 0 && w.ctx._apvBusyCount === 0);
    }
    // (b) 入力欄を開いた後に同じ日の保存が始まった場合、その入力欄は確定させない
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      const early = w.open({ id: "aout", nm: A, type: "clockOut", date: D }, "15:00");
      check("競合(b)：先に退勤の入力欄を開ける", !!early);
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.enter(early, "14:00");
      check("競合(b)：保存中に確定しても保存しない（控えが古くなるため）", w.pendingCount() === 1 && w.ctx.records.find(function (r) { return r.id === "aout"; }).time === "15:00");
      w.httpFail(); await flush();
      check("競合(b)：1回目失敗後、画面とサーバが一致", w.consistent(A, D).ok, JSON.stringify(w.consistent(A, D)));
    }
    // (c) 通信エラー（応答なし）でサーバには保存されていた → サーバから読み直して一致
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.netFail(true); await flush();
      const c = w.consistent(A, D);
      check("競合(c)：通信エラーでもサーバに届いていれば、画面は 06:00・承認済みに合わせる", c.ok && /ain:clockIn:06:00/.test(c.local) && c.localApproved, JSON.stringify(c));
      check("競合(c)：読み直した旨を伝え、ロックを外す", /読み直しました/.test(w.alerts.join("")) && !w.ctx._apvBusy[KA], JSON.stringify(w.alerts));
    }
    // (d) 通信エラーでサーバに届いていなかった → 読み直して元の状態で一致
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.netFail(false); await flush();
      const c = w.consistent(A, D);
      check("競合(d)：通信エラーで未保存なら、画面は 06:05・未承認のまま一致", c.ok && /ain:clockIn:06:05/.test(c.local) && !c.localApproved, JSON.stringify(c));
    }
    // (e) 通信エラー後にサーバを読み直せない → 操作を止めたまま再読み込みを案内（推測で表示を確定しない）
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.reconcileFail = 4;                                  // 初回＋再試行3回がすべて失敗する
      w.netFail(true); await flush();
      check("競合(e)：読み直せなければ再読み込みを案内する", /確認できませんでした/.test(w.alerts.join("")), JSON.stringify(w.alerts));
      check("競合(e)：その日は「未確認」になり、保存中の件数は残さない（他の職員・他の日の承認保存を黙って止めない）",
        !!w.ctx._apvUnknown[KA] && w.ctx._apvBusyCount === 0 && !w.ctx._apvBusy[KA]);
      w.reconcileFail = 100;                                // 操作のたびに走る再試行も失敗させ、止めたままにする
      const nAlert = w.alerts.length;
      check("競合(e)：未確認の間は同じ日の編集を止め、再読み込みを案内する",
        !w.edit({ id: "aout", nm: A, type: "clockOut", date: D }, "15:00", "14:00") && /再読み込み/.test(w.alerts[nAlert] || ""), JSON.stringify(w.alerts.slice(nAlert)));
      await flush();
      check("競合(e)：未確認の間は別の日の承認ボタンも止める（全体PUTで未確認のキーを書かない）",
        w.ctx.apvApprovalBlocked("2026-09-02__" + A) === true && w.ctx.apvApprovalBlocked() === true);
      w.ctx.approvals["2026-09-03__" + B] = true;
      const nPut = w.puts.length, nA2 = w.alerts.length;
      w.ctx.saveApprovals(w.ctx.approvals);
      check("競合(e)：未確認の間は承認の全体PUTを書かず、後回しにもせず、その旨を表示する（黙って止めない）",
        w.puts.length === nPut && w.ctx._apvPutDeferred === false && /再読み込み/.test(w.alerts[nA2] || ""), JSON.stringify(w.alerts.slice(nA2)));
      await flush();
      check("競合(e)：保存しなかった承認は画面からも戻す（画面の承認＝サーバ）",
        w.ctx.approvals["2026-09-03__" + B] === undefined && JSON.stringify(w.ctx.approvals) === JSON.stringify(w.server.approvals), JSON.stringify(w.ctx.approvals));
      check("競合(e)：別の職員の同じ日は編集できる", w.edit({ id: "", nm: B, type: "breakStart", date: D }, "−", "12:00") === true);
      await flush();
      // 通信が戻って読み直せた → 未確認を解除し、画面をサーバへ合わせ、後回しにした全体PUTを1回書く
      w.reconcileFail = 0;
      w.ctx._apvRetryUnknown(); await flush();
      const c = w.consistent(A, D);
      check("競合(e)：通信が戻って読み直せたら未確認を解除し、画面とサーバが一致", !w.ctx._apvUnknown[KA] && c.ok && /ain:clockIn:06:00/.test(c.local) && c.localApproved, JSON.stringify(c));
      check("競合(e)：確認後も古い内容で全体PUTを書かない／画面とサーバの承認が一致",
        w.puts.length === nPut && JSON.stringify(w.ctx.approvals) === JSON.stringify(w.server.approvals), JSON.stringify([w.ctx.approvals, w.server.approvals]));
      check("競合(e)：読み直しでも未送信打刻のマージ（punchOutboxMergeInto）を通す", (w.outboxMerges || 0) >= 1);
      check("競合(e)：解除後は同じ日を編集できる", !!w.open({ id: "aout", nm: A, type: "clockOut", date: D }, "15:00"));
    }
    // (e4) 保存中に別の日を承認（全体PUTを後回し）→ 通信エラーで読み直せない
    //      → 後回しの全体PUTは書かずに取り消し、保存されていないと伝え、画面の承認をサーバへ戻す（無期限に待たない）
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"), { ["2026-08-31__" + A]: true });
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.ctx.approvals["2026-09-02__" + B] = true;
      w.ctx.saveApprovals(w.ctx.approvals);
      check("競合(e4)：保存中は別の日の承認を後回しにする", w.ctx._apvPutDeferred === true && w.puts.length === 0);
      w.reconcileFail = 100;
      w.netFail(true); await flush();
      check("競合(e4)：読み直せなければ後回しの全体PUTを取り消し、書かない", w.ctx._apvPutDeferred === false && w.puts.length === 0);
      check("競合(e4)：この間の承認が保存されていないことをはっきり伝える", /保存されていません/.test(w.alerts.join("")), JSON.stringify(w.alerts));
      check("競合(e4)：画面の承認をサーバへ戻す（保存していない承認を表示し続けない）",
        w.ctx.approvals["2026-09-02__" + B] === undefined && JSON.stringify(w.ctx.approvals) === JSON.stringify(w.server.approvals), JSON.stringify([w.ctx.approvals, w.server.approvals]));
      w.ctx._apvRetryUnknown(); await flush();
      check("競合(e4)：その後の再試行でも全体PUTを書かない", w.puts.length === 0);
    }
    // (e5) 承認の全体PUTが送信中の間は、同時保存を始めさせない（サーバで PUT が後に着いて自動承認を消さないため）
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.ctx.approvals["2026-09-02__" + A] = true;
      w.ctx.saveApprovals(w.ctx.approvals);
      check("全体PUT送信中：時刻セルの編集を始めさせない", !w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00") && w.pendingCount() === 0);
      await flush();
      check("全体PUT完了後：編集・同時保存できる", w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00") && w.pendingCount() === 1 && w.ctx._apvPutInFlight === 0);
      w.ok(); await flush();
      const c = w.consistent(A, D);
      check("全体PUT完了後：自動承認が残り、画面とサーバが一致", c.ok && c.localApproved && w.server.approvals["2026-09-02__" + A] === true, JSON.stringify(c));
    }
    // (e6) 同時保存の完了前に送った承認データの取得（取り直し）の応答が、完了後に届いても使わない
    //      （書込み前の古い内容で画面の自動承認を消し、次の全体PUTでサーバからも消すのを防ぐ）
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.holdGets = true;
      w.ctx._apvResyncApprovals();                          // 取得を送る（保存前のサーバ＝未承認）
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.ok(); await flush();                                 // 同時保存が完了（サーバ・画面とも承認済み）
      w.heldGets.forEach(function (f) { f(); }); await flush();   // 古い応答が届く
      const c = w.consistent(A, D);
      check("古い応答(e6)：保存完了前に送った取得の応答では画面の承認を戻さない", c.ok && c.localApproved && c.serverApproved, JSON.stringify(c));
      w.holdGets = false;
      w.ctx.approvals["2026-09-02__" + A] = true;           // 続けて別の日を承認（全体PUT）
      w.ctx.saveApprovals(w.ctx.approvals); await flush();
      check("古い応答(e6)：続く全体PUTでも自動承認を消さない", w.server.approvals[KA] === true && w.server.approvals["2026-09-02__" + A] === true, JSON.stringify(w.server.approvals));
      w.ctx._apvResyncApprovals(); await flush();           // 書込み後に送った取得の応答は使う
      check("古い応答(e6)：書込み後に送った取得の応答は反映する（画面＝サーバ）", JSON.stringify(w.ctx.approvals) === JSON.stringify(w.server.approvals));
    }
    // (e3) 保存中は、同じ日の承認・引き戻しボタンを止める（別の日は止めない）
    {
      const w = makeWorld();
      w.seed(baseDay(A, "a"));
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      check("保存中：同じ日の承認・引き戻しは止める", w.ctx.apvApprovalBlocked(KA) === true);
      check("保存中：別の日の承認・一括承認は止めない（保存後に書く）", w.ctx.apvApprovalBlocked("2026-09-02__" + A) === false && w.ctx.apvApprovalBlocked() === false);
      w.ok(); await flush();
      check("保存後：同じ日の承認・引き戻しを再び操作できる", w.ctx.apvApprovalBlocked(KA) === false);
    }
    // (f) 保存中に承認・一括承認（全体PUT）が押された → 保存完了後に、確定した状態で書く
    for (const mode of ["fail", "ok"]) {
      const w = makeWorld();
      w.seed(baseDay(A, "a"), { ["2026-08-31__" + A]: true });
      w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00");
      w.ctx.approvals["2026-09-02__" + A] = true;         // 別の日を承認ボタンで承認した
      w.ctx.saveApprovals(w.ctx.approvals);
      check("競合(f-" + mode + ")：保存中は承認の全体PUTを後回しにする", w.puts.length === 0 && w.ctx._apvPutDeferred === true);
      if (mode === "fail") w.httpFail(); else w.ok();
      await flush();
      const c = w.consistent(A, D);
      check("競合(f-" + mode + ")：保存完了後に全体PUTを1回だけ書く", w.puts.length === 1 && w.ctx._apvPutDeferred === false);
      check("競合(f-" + mode + ")：全体PUTの内容は確定後の状態（別の日の承認を含み、この日は保存結果どおり）",
        w.server.approvals["2026-09-02__" + A] === true && w.server.approvals["2026-08-31__" + A] === true && (w.server.approvals[KA] === true) === (mode === "ok"),
        JSON.stringify(w.server.approvals));
      check("競合(f-" + mode + ")：画面とサーバが一致", c.ok && JSON.stringify(w.ctx.approvals) === JSON.stringify(w.server.approvals), JSON.stringify(c));
    }
    // (g) 保存中でなければ承認の全体PUTは従来どおりすぐ書く（一括承認・承認ボタンの既存挙動）
    {
      const w = makeWorld();
      w.ctx.approvals["2026-09-02__" + A] = true;
      w.ctx.saveApprovals(w.ctx.approvals);
      check("通常時：承認の全体PUTはすぐ書く", w.puts.length === 1 && w.server.approvals["2026-09-02__" + A] === true);
    }
    // (h) 同じ日を続けて編集（1回目成功→2回目成功）も一致
    {
      const w = makeWorld();
      w.seed([{ id: "ain", staff: A, type: "clockIn", date: D, time: "06:05", timestamp: TSX(D, "06:05") }]);
      w.edit({ id: "", nm: A, type: "clockOut", date: D }, "−", "15:00");     // 退勤を新規入力 → 承認付き保存
      w.ok(); await flush();
      check("連続(h)：1回目成功後に一致（承認済み）", w.consistent(A, D).ok && w.consistent(A, D).localApproved, JSON.stringify(w.consistent(A, D)));
      w.ctx.approvals = {}; w.ctx.saveApprovals(w.ctx.approvals); await flush();   // 引き戻し
      check("連続(h)：引き戻し後に2回目を編集できる", w.edit({ id: "ain", nm: A, type: "clockIn", date: D }, "06:05", "06:00") && w.pendingCount() === 1);
      w.ok(); await flush();
      const c = w.consistent(A, D);
      check("連続(h)：2回目成功後も一致（出勤 06:00・退勤 15:00・承認済み）", c.ok && /ain:clockIn:06:00/.test(c.local) && /clockOut:15:00/.test(c.local) && c.localApproved, JSON.stringify(c));
    }

    // (i) 他の管理者操作（打刻管理の時刻変更・保存・削除・打刻追加・修正申請の承認）も保存中は止める
    const guardSites = [
      ["打刻管理：時・分セレクト", /var d=parseJstDateTime\(date,hv\+":"\+mv\);\n\s*if\(apvSaveBusy\(nm,date\)\)\{render\(\);return;\}/],
      ["打刻管理：時・分セレクト（既存打刻）", /if\(rec&&apvSaveBusy\(rec\.staff,rec\.date\)\)\{render\(\);return;\}/],
      ["修正申請の承認", /if\(!req\)return;\n\s*if\(apvSaveBusy\(req\.staff,req\.date\)\)return;\n\s*b\.disabled=true;/],
      ["打刻を追加", /showAlert\("全て入力してください"\);return;\}\n\s*if\(apvSaveBusy\(staff,date\)\)return;/],
      ["打刻管理：時刻保存", /if\(!rec\)return;\n\s*if\(apvSaveBusy\(rec\.staff,rec\.date\)\)return;\n\s*if\(!rec\.editedFrom\)/],
      ["打刻管理：削除", /if\(rec&&apvSaveBusy\(rec\.staff,rec\.date\)\)return;\n\s*if\(rec\)\{rec\.deleted=true;softDeleteRecord/],
      ["承認データの定期取得（保存中・全体PUTの後回し中・取得後に書込みがあったときは差し替えない）", /if\(savingCount!==0 \|\| _apvG!==_apvGen \|\| _apvBusyCount!==0 \|\| _apvPutDeferred\)return;\n\s*approvalsLoaded=true;/],
      ["承認データの定期取得（エラー応答を取り込まない）", /authFetch\(FB_URL \+ "\/tc5_approvals\.json"\)\n[^\n]*\n\s*\.then\(function\(r\)\{if\(!r\.ok\)throw new Error\("HTTP "\+r\.status\);return r\.json\(\);\}\)/],
      ["承認データの定期取得（使わなかった応答では読込済みにしない）", function () {
        const i = html.indexOf("var _apvG=_apvGen;\n    authFetch(FB_URL + \"/tc5_approvals.json\")");
        const blk = i < 0 ? "" : html.slice(i, html.indexOf("}).catch(function(){});", i));
        return !!blk && (blk.match(/approvalsLoaded=true/g) || []).length === 1 && blk.indexOf("approvalsLoaded=true") > blk.indexOf("_apvPutDeferred)return;");
      }],
      ["承認ボタン（2画面とも）", function () { return (html.match(/var _nm=b\.dataset\.nm,_dk=b\.dataset\.dk;\n\s*if\(apvApprovalBlocked\(_dk\+"__"\+_nm\)\)return;/g) || []).length === 2; }],
      ["引き戻し（2画面とも）", function () { return (html.match(/if\(apvApprovalBlocked\(b\.dataset\.dk\+"__"\+b\.dataset\.nm\)\)return;\n\s*(b\.disabled=true;\n\s*)?delete approvals\[b\.dataset\.dk\+"__"\+b\.dataset\.nm\]/g) || []).length === 2; }],
      ["一括承認（3か所とも）", function () { return (html.match(/if\(apvApprovalBlocked\(\)\)return;\n\s*(var unapprovedDates|if\(!unapvList\.length\)|if\(!targets\.length\))/g) || []).length === 3; }],
      ["管理画面の初回読込は、取得中に承認の書込みがあった応答を使わない", /var _apvFresh=\(_apvG===_apvGen&&!_apvPutDeferred&&_apvPutInFlight===0\);[^\n]*\n\s*if\(_apvFresh&&r\[0\]&&typeof r\[0\]==="object"\)[\s\S]{0,2000}?if\(_apvFresh&&r\[0\]!==null\)approvalsLoaded=true;/],
      ["承認データの書込みの開始・完了で世代を進める（同時保存・全体PUT）", function () {
        return /_apvBusyCount\+\+;\n\s*_apvGen\+\+;/.test(html) && /function _apvRelease\(key\)\{\n\s*_apvGen\+\+;/.test(html) &&
          /_apvGen\+\+;\n\s*_apvPutInFlight\+\+;/.test(html) && (html.match(/_apvPutInFlight--;\n\s*_apvGen\+\+;/g) || []).length === 2;
      }],
      ["管理画面の初回読込で、同時保存中の日の承認を消さない", /approvals=r\[0\];Object\.keys\(_apvBusy\)\.forEach\(function\(k\)\{approvals\[k\]=true;\}\);/],
      ["通信が戻ったら（online）未確認の日を読み直す", /window\.addEventListener\("online",function\(\)\{_apvRetryUnknown\(\);\}\)/],
      ["未確認の記録は保存中ロックを外す前に行う（後回しの全体PUTを未確認のまま書かない）", /_apvUnknown\[approvalKey\]=\{[^}]*\};[\s\S]{0,700}?_apvRelease\(approvalKey\);/],
      ["読み直しは他の保存の完了を待つ（最大約30秒）", /if\(savingCount>0&&st\.wait<60\)/],
      ["職員の改名", /if\(_apvBusyCount>0\)\{showAlert\("勤怠の保存が完了していません。\\n少し待ってから保存してください。"\);return;\}\n\s*if\(apvApprovalBlocked\(\)\)return;/]
    ];
    guardSites.forEach(function (g) { check("保存中の停止：" + g[0], typeof g[1] === "function" ? g[1]() : g[1].test(html)); });
  })();
}

function finish() {
console.log("\n================================");
console.log("PASS " + pass + " / FAIL " + fail);
console.log("================================");
process.exit(fail ? 1 : 0);
}
