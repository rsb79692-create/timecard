/**
 * 有給取得履歴（管理者画面「有給管理」→ スタッフ詳細内）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-paid-leave-history.js
 *
 * 目的:
 *   1. 履歴は正本 tc5_paid_leave_requests からの「表示専用の組み立て」であること
 *      （履歴用データを二重保存しない／正本を書き換えない）。
 *   2. 実績（取得履歴）と未来日の取得予定を混同しないこと。
 *      境界は buildFutureApprovedLeaveMap（残日数表示）と同じ「JSTで今日以前＝消化済み」。
 *      ここが食い違うと、画面の残日数と履歴の日数が合わなくなる。
 *   3. pending を「取得済み」として出さないこと。
 *   4. 1申請で複数日を申請できるため、履歴は「取得日単位」に展開されること。
 *   5. 同姓同名の取り違えが起きないこと（社員番号が両方にあるときは番号一致だけを採用）。
 *   6. 未知の status を黙って捨てないこと（データ異常を隠さない）。
 *   7. 詳細を開いても追加の通信をしないこと（表示系ハンドラが書き込み/取得関数を呼ばない）。
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、PL-HISTORY-BEGIN/END ブロックだけを
 *   抜き出して vm コンテキストで評価する。本番データへは一切アクセスしない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.html");
const START = "// ===== PL-HISTORY-BEGIN =====";
const END = "// ===== PL-HISTORY-END =====";

const html = fs.readFileSync(SRC, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END, s);
if (s < 0 || e < 0) {
  console.error("ERROR: index.html から PL-HISTORY ブロックを抽出できませんでした。");
  console.error("       index.html 側のマーカーコメントを変更した場合は、本テストの START/END も合わせてください。");
  process.exit(1);
}
const CODE = html.slice(s, e + END.length);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 抽出したブロックを評価 ───────────────────────────────────────────
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(CODE, ctx, { filename: "index.html:PL-HISTORY" });
const build = ctx.plBuildLeaveHistory;
if (typeof build !== "function") {
  console.error("ERROR: plBuildLeaveHistory が定義されていません。");
  process.exit(1);
}

// index.html 本体と同じヘルパを与える（本体の getLeaveDates / getReqStaffId 相当）
const getDates = (r) =>
  (r.leaveDates && Array.isArray(r.leaveDates) && r.leaveDates.length > 0) ? r.leaveDates
    : (r.date ? [r.date] : []);
const getSid = (r) => (r.staffId || "");
const TODAY = "2026-08-30";

function run(requests, opts) {
  return build(requests, Object.assign(
    { staffId: "E001", staffName: "谷口清蔵", todayJst: TODAY, getDates, getSid },
    opts || {}
  ));
}
const dates = (list) => list.map((x) => x.date);

// ── 1. 履歴0件 ──────────────────────────────────────────────────────
console.log("\n[1] 履歴0件");
{
  const r0 = run([]);
  check("空配列で taken/planned/pending/other すべて空",
    r0.taken.length === 0 && r0.planned.length === 0 && r0.pending.length === 0 && r0.other.length === 0);
  check("合計日数が 0", r0.takenDays === 0 && r0.plannedDays === 0);
  const rNull = run(null);
  check("requests が null でも例外にならず空を返す", rNull.taken.length === 0);
  const rOther = run([{ id: "p1", staffId: "E999", staffName: "別人", leaveDates: ["2026-08-01"], status: "approved" }]);
  check("他スタッフの申請は含めない", rOther.taken.length === 0);
}

// ── 2. 履歴1件 ──────────────────────────────────────────────────────
console.log("\n[2] 履歴1件");
{
  const r = run([{ id: "p1", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-25"], status: "approved", createdAt: "2026-08-20T01:00:00.000Z", approvedAt: "2026-08-21T02:00:00.000Z" }]);
  check("承認済み・過去日は taken に入る", r.taken.length === 1 && r.taken[0].date === "2026-08-25");
  check("1日 = 1日分", r.taken[0].days === 1 && r.takenDays === 1);
  check("単日申請は groupSize=1", r.taken[0].groupSize === 1);
  check("申請日時・承認日時を持ち越す",
    r.taken[0].createdAt === "2026-08-20T01:00:00.000Z" && r.taken[0].approvedAt === "2026-08-21T02:00:00.000Z");
}

// ── 3. 履歴多数（降順・件数） ───────────────────────────────────────
console.log("\n[3] 履歴多数");
{
  const many = [];
  for (let i = 1; i <= 25; i++) {
    const d = "2026-07-" + String(i).padStart(2, "0");
    many.push({ id: "p" + i, staffId: "E001", staffName: "谷口清蔵", leaveDates: [d], status: "approved", createdAt: "2026-06-01T00:00:00.000Z" });
  }
  const r = run(many);
  check("25件すべて taken に入る", r.taken.length === 25 && r.takenDays === 25);
  check("新しい取得日が先頭（降順）", r.taken[0].date === "2026-07-25" && r.taken[24].date === "2026-07-01");
  const sorted = dates(r.taken).slice().sort().reverse();
  check("全体が降順で並んでいる", JSON.stringify(dates(r.taken)) === JSON.stringify(sorted));
  // 「さらに表示」は UI 側の slice。件数の意味だけを固定する
  check("初期10件で残り15件", r.taken.slice(0, 10).length === 10 && r.taken.length - 10 === 15);
}

// ── 4. 1申請に複数取得日 ────────────────────────────────────────────
console.log("\n[4] 1申請に複数取得日");
{
  const r = run([{ id: "p1", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-12", "2026-08-10", "2026-08-11"], status: "approved" }]);
  check("3日申請は3件へ展開される", r.taken.length === 3 && r.takenDays === 3);
  check("取得日単位で降順", JSON.stringify(dates(r.taken)) === JSON.stringify(["2026-08-12", "2026-08-11", "2026-08-10"]));
  check("各日 1日ずつ", r.taken.every((x) => x.days === 1));
  check("同一申請であることが分かる（groupSize=3・同一 reqId）",
    r.taken.every((x) => x.groupSize === 3 && x.reqId === "p1"));
  // 承認時の FIFO 消化は leaveDates.length 日で行われるため、履歴の合計と一致する
  check("履歴の合計日数 = 承認時に消化した日数（leaveDates.length）", r.takenDays === 3);
}

// ── 5. 未来日の承認済み（実績と予定を混同しない） ───────────────────
console.log("\n[5] 未来日の承認済み");
{
  const r = run([
    { id: "p1", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-29"], status: "approved" },
    { id: "p2", staffId: "E001", staffName: "谷口清蔵", leaveDates: [TODAY], status: "approved" },
    { id: "p3", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-31", "2026-09-02"], status: "approved" }
  ]);
  check("明日以降は planned へ（実績に混ぜない）",
    JSON.stringify(dates(r.planned)) === JSON.stringify(["2026-08-31", "2026-09-02"]));
  check("当日は実績（taken）側 ＝ buildFutureApprovedLeaveMap と同じ境界",
    dates(r.taken).indexOf(TODAY) >= 0);
  check("昨日以前は taken", dates(r.taken).indexOf("2026-08-29") >= 0);
  check("集計が分離されている", r.takenDays === 2 && r.plannedDays === 2);
  check("予定は近い日から（昇順）", r.planned[0].date === "2026-08-31");
  // 1申請が過去日と未来日にまたがる場合も日単位で振り分ける
  const r2 = run([{ id: "p9", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-29", "2026-09-01"], status: "approved" }]);
  check("同一申請でも日ごとに実績／予定へ振り分ける",
    r2.takenDays === 1 && r2.plannedDays === 1);
}

// ── 6. status ごとの扱い ────────────────────────────────────────────
console.log("\n[6] status ごとの扱い");
{
  const base = (id, st, d) => ({ id, staffId: "E001", staffName: "谷口清蔵", leaveDates: [d || "2026-08-20"], status: st });
  const r = run([
    base("a", "approved", "2026-08-20"),
    base("b", "pending", "2026-08-21"),
    base("c", "rejected", "2026-08-22"),
    base("d", "withdrawn", "2026-08-23"),
    base("e", "canceled", "2026-08-24"),
    base("f", "weird_status", "2026-08-19")
  ]);
  check("approved だけが taken", r.taken.length === 1 && r.taken[0].reqId === "a");
  check("pending は taken に入らない（取得済みと誤認させない）",
    r.pending.length === 1 && r.pending[0].reqId === "b" && dates(r.taken).indexOf("2026-08-21") < 0);
  check("pending は takenDays に加算しない", r.takenDays === 1);
  check("rejected / withdrawn / canceled は other", ["c", "d", "e"].every((id) => r.other.some((x) => x.reqId === id)));
  check("未知の status も other に残す（黙って捨てない）", r.other.some((x) => x.reqId === "f" && x.status === "weird_status"));
  check("other は日数集計に入らない", r.takenDays === 1 && r.plannedDays === 0);
  // 未来日の pending も「取得済み」にならない
  const rp = run([base("g", "pending", "2026-09-10")]);
  check("未来日の pending も taken/planned に入らない",
    rp.taken.length === 0 && rp.planned.length === 0 && rp.pending.length === 1);
}

// ── 7. スタッフの突き合わせ（同姓同名・旧データ） ───────────────────
console.log("\n[7] スタッフの突き合わせ");
{
  const r = run([
    { id: "p1", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-20"], status: "approved" },
    { id: "p2", staffId: "E002", staffName: "谷口清蔵", leaveDates: ["2026-08-21"], status: "approved" } // 同姓同名の別人
  ]);
  check("社員番号が両方にあるときは番号一致だけを採用（同姓同名を混ぜない）",
    r.taken.length === 1 && r.taken[0].reqId === "p1");

  // 旧形式: 申請に社員番号が無い（staffName のみ）
  const rOld = run([{ id: "p3", staffName: "谷口清蔵", leaveDates: ["2026-08-22"], status: "approved", date: "2026-08-22" }]);
  check("申請に社員番号が無い旧データは氏名で拾う", rOld.taken.length === 1);

  // 付与行グループ側に社員番号が無い場合も氏名で拾う
  const rNoGid = run([{ id: "p4", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-23"], status: "approved" }], { staffId: "" });
  check("付与行に社員番号が無い場合も氏名で拾う", rNoGid.taken.length === 1);

  // 氏名も社員番号も一致しないものは拾わない
  const rNone = run([{ id: "p5", staffName: "別人", leaveDates: ["2026-08-24"], status: "approved" }]);
  check("氏名も社員番号も一致しなければ拾わない", rNone.taken.length === 0);

  // 氏名が空のグループへ、氏名なし申請が紛れ込まない（フェイルクローズ）
  const rEmpty = run([{ id: "p6", leaveDates: ["2026-08-25"], status: "approved" }], { staffId: "", staffName: "" });
  check("グループ・申請ともに識別子が無い場合は拾わない", rEmpty.taken.length === 0);
}

// ── 8. 異常データ・旧形式 ───────────────────────────────────────────
console.log("\n[8] 異常データ・旧形式");
{
  const r = run([
    { id: "p1", staffId: "E001", staffName: "谷口清蔵", status: "approved" },                       // 取得日なし
    { id: "p2", staffId: "E001", staffName: "谷口清蔵", leaveDates: [], status: "approved" },        // 空配列
    { id: "p3", staffId: "E001", staffName: "谷口清蔵", date: "2026-08-18", status: "approved" },    // 旧形式 date のみ
    { id: "p4", staffId: "E001", staffName: "谷口清蔵", leaveDates: [null, "", "2026-08-17"], status: "approved" },
    null
  ]);
  check("取得日が無い申請は日数を推測しない（無視する）", !r.taken.some((x) => x.reqId === "p1" || x.reqId === "p2"));
  check("旧形式 date のみでも1日として拾う", r.taken.some((x) => x.reqId === "p3" && x.date === "2026-08-18"));
  check("不正な取得日は除外し、正しい日だけ残す",
    r.taken.filter((x) => x.reqId === "p4").length === 1 && r.taken.some((x) => x.date === "2026-08-17"));
  check("null 要素で落ちない", r.takenDays === 2);
}

// ── 9. 正本を書き換えない ───────────────────────────────────────────
console.log("\n[9] 正本を書き換えない");
{
  const input = [
    { id: "p1", staffId: "E001", staffName: "谷口清蔵", leaveDates: ["2026-08-12", "2026-08-10"], status: "approved", consumedSnapshot: [{ id: "b1", usedBefore: 0, usedAfter: 2 }] }
  ];
  const before = JSON.stringify(input);
  run(input);
  check("入力（tc5_paid_leave_requests のキャッシュ）を書き換えない", JSON.stringify(input) === before);
  check("leaveDates の並びを破壊しない（sort は複製に対して行う）",
    JSON.stringify(input[0].leaveDates) === JSON.stringify(["2026-08-12", "2026-08-10"]));
}

// ── 10. index.html 側の結線（通信を増やさない・正本を触らない） ─────
console.log("\n[10] index.html 側の結線");
{
  check("plBuildLeaveHistory を詳細表示から呼んでいる", /_plh\s*=\s*plBuildLeaveHistory\(paidLeaveRequests\s*,/.test(html));
  check("履歴は取得済みの paidLeaveRequests から作る（履歴専用の fetch を足していない）",
    !/plBuildLeaveHistory[\s\S]{0,400}?authFetch\(/.test(html.slice(html.indexOf("var _plh=plBuildLeaveHistory"), html.indexOf("var _plh=plBuildLeaveHistory") + 400)));
  check("getReqStaffId / getLeaveDates を渡している",
    /getDates:getLeaveDates,\s*getSid:getReqStaffId/.test(html));
  check("履歴用の新しい Firebase パスを作っていない",
    !/tc5_paid_leave_history|tc5_leave_history|\/mileage\/leave_history/.test(html));

  // ★ 履歴は付与明細の表（明細展開中は min-width:640px で横スクロール）の「外」へ出す。
  //   表の中に入れると 320px 幅で右端の文字が切れる（実測で発生）。
  check("履歴を表の外の plHistBlocks へ積んでいる", /plHistBlocks\+='<div /.test(html));
  check("plHistBlocks を </table> の後・「新規付与を追加」の前に差し込んでいる",
    /'<\/table>'[\s\S]{0,200}?\+plHistBlocks[\s\S]{0,200}?新規付与を追加/.test(html));
  check("どの職員の履歴か分かるよう見出しに氏名を出す", /有給取得履歴：'\+esc\(nm\)\+'/.test(html));

  // ★ 履歴は「付与明細を開いている職員だけ」に出す。
  //   plHistBlocks の加算を早期 return より前へ動かすと、閉じている職員の履歴まで全員分が並ぶ。
  const iGuard = html.indexOf('if(!_isOpen)return;');
  const iBlocks = html.indexOf("plHistBlocks+='<div ");
  check("plHistBlocks の加算が if(!_isOpen)return; より後にある（閉じている職員の履歴を出さない）",
    iGuard > 0 && iBlocks > 0 && iBlocks > iGuard, "guard=" + iGuard + " blocks=" + iBlocks);

  // ★ _plHistSidSeen は描画のたびに初期化する。グローバルへ巻き上げると2回目以降の描画で
  //   全グループが「重複」判定になり、履歴が黙って全部消える。
  const iInner = html.indexOf("function _renderInner(){");
  const iSeen = html.indexOf("var _plHistSidSeen={};");
  check("_plHistSidSeen を _renderInner 内で宣言している（毎描画で初期化）",
    iInner > 0 && iSeen > iInner && iSeen < iBlocks, "inner=" + iInner + " seen=" + iSeen);
  check("_plHistSidSeen をグローバル（行頭 var）に置いていない",
    !/^var _plHistSidSeen/m.test(html));
  check("_plHistSidSeen の宣言は1箇所だけ",
    (html.match(/var _plHistSidSeen\s*=/g) || []).length === 1);

  // ★ 履歴を付与明細テーブルの中へ戻さない／100vw からの引き算で幅を作らない（320px で文字が切れた）
  check("履歴の中身を plBalRows（表の行）へ積んでいない",
    !/plBalRows\+=[\s\S]{0,200}?_hSec\+_hPlan\+_hPend\+_hOther/.test(html));
  const histRegion = html.slice(html.indexOf("var _plh=plBuildLeaveHistory(paidLeaveRequests,{"), iBlocks + 400);
  // style 属性の中にビューポート幅単位が出ないこと（コメント中の言及は対象外）
  check("有給取得履歴の style にビューポート幅単位（vw）を使っていない",
    !/style="[^"]*\d\s*vw\b/.test(histRegion) && histRegion.indexOf("calc(100vw") < 0);
  check("有給取得履歴のブロックに position:sticky を使っていない", histRegion.indexOf("position:sticky") < 0);
  check("有給取得履歴のブロックが </td></tr> で閉じていない（表の外にある）",
    histRegion.indexOf("</td></tr>") < 0);

  // 表示系ハンドラが書き込み・取得をしないこと
  function fnBody(name) {
    const i = html.indexOf("function " + name + "(");
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let k = html.indexOf("{", i); k < html.length; k++) {
      if (html[k] === "{") { depth++; started = true; }
      else if (html[k] === "}") { depth--; if (started && depth === 0) return html.slice(i, k + 1); }
    }
    return null;
  }
  ["plHistMore", "plHistToggleVoid", "plToggleBalDetail"].forEach(function (fn) {
    const body = fnBody(fn);
    check(fn + " が存在する", !!body);
    if (body) {
      check(fn + " は通信しない（authFetch/fetch を呼ばない）", !/\b(authFetch|fetch)\s*\(/.test(body), body);
      check(fn + " は正本を書き換えない（save/patch/delete 系を呼ばない）",
        !/\b(savePaidLeave\w*|patchPaidLeave\w*|deletePaidLeaveBalance|saveData|saveToFirebase|applyFifoConsumption|reverseFifoConsumption)\s*\(/.test(body), body);
    }
  });

  // 残日数の正本定義・FIFO まわりへ手を入れていないこと
  check("remainDays の再計算式を足していない（grantedDays-usedDays での再計算は正規化の1箇所のみ）",
    (html.match(/grantedDays\|\|0\)-\(nb\.usedDays\|\|0\)/g) || []).length === 1);
  check("履歴の実績/予定の境界が残日数表示と同じ（JSTで今日以前＝消化済み）",
    /todayJst:plTodayJst/.test(html) && /plTodayJst=getTodayJSTStr\(\)/.test(html));
}

// ── 11. 誤読を防ぐ表示（レビュー指摘 M-1 / M-2 / M-3 / L-1 / L-2 の固定） ────
console.log("\n[11] 誤読を防ぐ表示");
{
  // M-1: 「実績 合計」は本システムで承認した分だけ。付与日数−残日数（carryIn 込み）とは一致しない。
  //      ここを一致させようと残日数を修正すると取得済みの有給が復活する（AGENTS.md の禁止事項）。
  check("M-1 実績合計に「本システムで承認した分のみ」と明記している",
    /実績 合計 '\+_plh\.takenDays\+'日（本システムで承認した分のみ／/.test(html));
  check("M-1 carryIn（運用開始前の消化分）が履歴に出ない旨の説明を持つ",
    /運用開始前にすでに消化していた分[\s\S]{0,120}?一致しません/.test(html));

  // M-2: サマリー行の「残 N日（M）」は付与行へ戻せる量で上限を切った値。履歴側は承認済み日数の実数。
  check("M-2 取得予定の見出しが「承認済・明日以降の取得日」であることを明示",
    /取得予定（承認済・明日以降の取得日）/.test(html));
  check("M-2 サマリーの括弧内と一致しないことがある旨を注記している",
    /括弧内は残日数の内数のため、この日数と一致しないことがあります/.test(html));

  // M-3: 改名で付与行が旧氏名・新氏名へ分裂しても、同じ履歴と合計日数を2回出さない
  check("M-3 同一社員番号のグループを記録する仕組みがある", /var _plHistSidSeen=\{\};/.test(html));
  check("M-3 2つ目以降は履歴を出さず参照先だけ示す",
    /_hDupOf/.test(html) && /同じ社員番号（'\+esc\(_hSidKey\)\+'）の履歴は/.test(html));
  check("M-3 重複グループでは予定・申請中・取消却下も出さない", /_hPlan=_hPend=_hOther="";/.test(html));

  // L-1 / L-2: 氏名・status は誰でも書ける値。プロトタイプ由来の値を拾わせない
  const own = fnBodyOf("_plOwn");
  check("L-1/L-2 _plOwn が hasOwnProperty で守っている",
    !!own && /Object\.prototype\.hasOwnProperty\.call\(map,key\)/.test(own), own || "(未定義)");
  ["plHistLimit,nm", "plHistVoid,nm", "plStatusColor,e.status", "plStatusBg,e.status", "plStatusLabel,e.status"]
    .forEach(function (args) {
      check("L-1/L-2 _plOwn(" + args + ") 経由で読んでいる",
        html.indexOf("_plOwn(" + args + ",") >= 0);
    });
  check("L-1/L-2 status を素のブラケットで色・ラベルに使っていない",
    !/plStatus(Color|Bg|Label)\[e\.status\]/.test(html));

  // _plOwn を実際に動かして確認（プロトタイプ汚染由来の値を返さない）
  const ownCtx = { console };
  vm.createContext(ownCtx);
  vm.runInContext(own, ownCtx, { filename: "index.html:_plOwn" });
  check("_plOwn は自前キーの値を返す", ownCtx._plOwn({ a: 3 }, "a", 9) === 3);
  check("_plOwn は constructor でも既定値を返す", ownCtx._plOwn({}, "constructor", 10) === 10);
  check("_plOwn は toString でも既定値を返す", ownCtx._plOwn({}, "toString", false) === false);
  check("_plOwn は値が false でも自前キーなら返す", ownCtx._plOwn({ x: false }, "x", true) === false);
}

// 関数本体の抽出（[10] のローカル関数と同じ処理。[11] からも使う）
function fnBodyOf(name) {
  const i = html.indexOf("function " + name + "(");
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let k = html.indexOf("{", i); k < html.length; k++) {
    if (html[k] === "{") { depth++; started = true; }
    else if (html[k] === "}") { depth--; if (started && depth === 0) return html.slice(i, k + 1); }
  }
  return null;
}

console.log("\n==== 結果: PASS " + pass + " / FAIL " + fail + " ====");
process.exit(fail === 0 ? 0 : 1);
