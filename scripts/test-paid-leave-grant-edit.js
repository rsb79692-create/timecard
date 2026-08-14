/**
 * 有給「付与日数の修正」の残日数再計算テスト（依存パッケージなし・送信なし・本番データ非アクセス）
 *
 * 実行: node scripts/test-paid-leave-grant-edit.js
 *
 * 目的:
 *   付与日数を修正したときの残日数を「現在の残日数 ＋ 付与日数の増減分」で求めることを固定する。
 *
 *   旧実装は remainDays = grantedDays - usedDays で再計算していた。
 *   しかし usedDays は「このシステムで承認して消化した累計」でしかなく、
 *   有給付与登録モーダルは付与日数と別に残日数を入力できる（運用開始前にすでに取得済みの分を
 *   残日数だけ減らして登録する）。その付与行では
 *       grantedDays - usedDays - remainDays = 登録時点ですでに消化していた日数（carryIn）
 *   の差が恒久的に残る。2026-08-14 の本番実測では 40 付与行中 14 行がこの状態だった。
 *   旧式で再計算すると carryIn が残日数として復活し、取得済みの有給が戻ってしまう。
 *   （実例: 付与7 / システム上の消化3 / 残2 の行を 付与8 へ修正 → 旧式は残5、正しくは残3）
 *
 *   あわせて「確認ダイアログに出した残日数」と「実際に保存した残日数」が同じ値であること、
 *   usedDays・他の付与行・FIFO 割当を書き換えないことを固定する。
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
// 抽出はモーダルを開く処理から。プレビュー（管理者が保存前に読む数字）も同じ式で出していることを
// 実際に動かして確かめるため、_plBalEditValidate だけを切り出さない。
const START = "function openPaidLeaveBalEditModal(balId){";
const END = "// ===== 有給「管理者代理申請」モーダル";

const html = fs.readFileSync(SRC, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END, s);
if (s < 0 || e < 0) {
  console.error("ERROR: index.html から付与日数修正ブロックを抽出できませんでした。");
  console.error("       index.html 側のマーカーコメントを変更した場合は、本テストの START/END も合わせてください。");
  process.exit(1);
}
const CODE = html.slice(s, e);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

/**
 * テスト用コンテキスト。
 * rows: 付与行の配列（本番と同じ形）。target: 操作対象の id。
 * server: Firebase から取り直したときに返す行（省略時は rows と同じ内容＝競合なし）。
 */
function makeCtx(rows, targetId, server, opts) {
  opts = opts || {};
  const state = {
    patches: [],          // patchPaidLeaveBalance(id, partial) の記録
    alerts: [],
    confirms: [],
    renders: 0,
    reopened: 0,
    fetched: [],
    els: {}               // モーダル内の要素（表示文言の検証用）
  };
  // モーダル内の要素スタブ。id ごとに1つ作り、textContent / value / min を記録する。
  function el(id) {
    if (!state.els[id]) state.els[id] = { id: id, textContent: "", value: "", min: "", disabled: false, style: {}, appendChild: function () { }, focus: function () { }, select: function () { } };
    return state.els[id];
  }
  const ctx = {
    console: console,
    Promise: Promise,
    Date: Date,
    Math: Math,
    JSON: JSON,
    parseFloat: parseFloat,
    isNaN: isNaN,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    encodeURIComponent: encodeURIComponent,
    FB_URL: "https://example.invalid/honomi",
    viewerMode: !!opts.viewerMode,
    uiMode: "normal",
    paidLeaveBalanceSaving: !!opts.saving,
    paidLeaveBalanceDirty: false,
    _paidLeaveRenderGuard: true,
    _plBalEditId: targetId,
    paidLeaveBalances: rows.map(function (r) { return Object.assign({}, r); }),
    _t: state,
    _plBalEditModalOpen: false,
    demoWriteBlocked: function () { return !!opts.demoBlocked; },
    // モーダル DOM の生成と「第N回」算出は本テストの対象外（表示専用）
    ensurePaidLeaveBalEditModal: function () { return { style: {} }; },
    _plGrantNoOfBal: function () { return 1; },
    // 未来日の承認済み取得（表示上戻す日数）。既定は無し。
    buildFutureApprovedLeaveMap: function () { return { byLot: opts.futureByLot || {}, bySid: {} }; },
    todayDateStr: function () { return "2026-08-14"; },
    // 本物の normalizePaidLeaveBalance は staffList / resolveStaffId に依存するため、
    // 本テストでは残日数の既定値補完（remainDays 未定義なら granted-used）だけを再現する。
    normalizePaidLeaveBalance: function (b) {
      const nb = Object.assign({}, b);
      if (nb.remainDays === undefined || nb.remainDays === null) {
        nb.remainDays = Math.round(((nb.grantedDays || 0) - (nb.usedDays || 0)) * 10) / 10;
      }
      return nb;
    },
    render: function () { state.renders++; },
    showAlert: function (msg) { state.alerts.push(String(msg)); },
    showConfirm: function (msg, onOk) { state.confirms.push(String(msg)); onOk(); },
    openPaidLeaveBalEditModal: function () { state.reopened++; },
    closePaidLeaveBalEditModal: function () { },
    patchPaidLeaveBalance: function (id, partial) {
      state.patches.push({ id: id, partial: partial });
      return Promise.resolve(true);
    },
    authFetch: function (url) {
      state.fetched.push(url);
      const row = (server === undefined)
        ? rows.find(function (r) { return r.id === targetId; })
        : server;
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(row ? Object.assign({}, row) : null); }
      });
    },
    document: {
      getElementById: function (id) { return el(id); },
      createElement: function () { return { style: {}, textContent: "", appendChild: function () { } }; },
      createTextNode: function () { return {}; }
    }
  };
  ctx.document.getElementById("pl-bal-edit-granted"); // 入力欄を先に用意しておく
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  ctx._el = el;
  return ctx;
}

/** モーダルを開き、付与日数欄へ newGranted を入力してプレビューまで進める */
function openAndType(rows, targetId, newGranted, opts) {
  const ctx = makeCtx(rows, targetId, undefined, opts);
  ctx.openPaidLeaveBalEditModal(targetId);
  const inp = ctx._el("pl-bal-edit-granted");
  inp.value = String(newGranted);
  inp.oninput();      // 実画面と同じ経路でプレビューを更新する
  return ctx;
}

/** 付与日数を newGranted に修正する操作を最後まで流す */
async function edit(rows, targetId, newGranted, server, opts) {
  const ctx = makeCtx(rows, targetId, server, opts);
  ctx.openPaidLeaveBalEditModal(targetId);
  ctx._el("pl-bal-edit-granted").value = String(newGranted);
  // 以降の「開き直し」（正本が動いていた場合）を数える
  const origOpen = ctx.openPaidLeaveBalEditModal;
  ctx.openPaidLeaveBalEditModal = function (id) { ctx._t.reopened++; return origOpen(id); };
  ctx.savePaidLeaveBalGrantedDays();
  // 非同期（authFetch → patch）の解決を待つ
  for (let i = 0; i < 10; i++) await new Promise(function (r) { setImmediate(r); });
  return ctx._t;
}

// 本番実測（2026-08-14）と同じ形の付与行。
// 付与7 / システム上の消化3 / 残2 → 登録時点ですでに 2日 消化済み（carryIn=2）
const ROW_CARRY = { id: "plb_A", staffId: "100001", staffName: "テスト太郎", grantDate: "2025-06-12", expiresAt: "2027-06-11", grantedDays: 7, usedDays: 3, remainDays: 2 };
// carryIn のない通常行（granted - used === remain）
const ROW_PLAIN = { id: "plb_B", staffId: "100002", staffName: "テスト花子", grantDate: "2025-05-01", expiresAt: "2027-04-30", grantedDays: 10, usedDays: 4, remainDays: 6 };
// 一度も消化していない行
const ROW_FRESH = { id: "plb_C", staffId: "100003", staffName: "テスト次郎", grantDate: "2025-11-01", expiresAt: "2027-10-31", grantedDays: 10, usedDays: 0, remainDays: 10 };

function lastPatch(t) { return t.patches.length ? t.patches[t.patches.length - 1].partial : null; }

async function main() {
  console.log("=== 有給 付与日数修正: 残日数の再計算 ===\n");

  // --- 1. 付与7 / 残2（消化3＋登録時2）→ 付与8 ⇒ 残3 ---
  {
    const t = await edit([ROW_CARRY, ROW_PLAIN], "plb_A", 8);
    const p = lastPatch(t);
    check("1. 付与7→8（残2・消化済み合計5）で 残3 を保存する", !!p && p.remainDays === 3, p ? "remainDays=" + p.remainDays : "patchなし");
    check("1. 旧式の granted-used=5 を保存しない（取得済みを復活させない）", !!p && p.remainDays !== 5, p ? "remainDays=" + p.remainDays : "patchなし");
    check("1. grantedDays は 8 で保存する", !!p && p.grantedDays === 8, p ? "grantedDays=" + p.grantedDays : "patchなし");
    check("1. 確認ダイアログに「2日 → 3日」を出す", t.confirms.length === 1 && t.confirms[0].indexOf("2日 → 3日") >= 0, t.confirms[0]);
    check("1. 確認の表示値と保存値が一致する", !!p && t.confirms[0].indexOf(p.remainDays + "日 になります") >= 0, t.confirms[0]);
  }

  // --- 2. 付与7 / 残2 → 付与6 ⇒ 残1 ---
  {
    const t = await edit([ROW_CARRY], "plb_A", 6);
    const p = lastPatch(t);
    check("2. 付与7→6 で 残1 を保存する", !!p && p.remainDays === 1, p ? "remainDays=" + p.remainDays : "patchなし");
    check("2. 旧式の granted-used=3 を保存しない", !!p && p.remainDays !== 3, p ? "remainDays=" + p.remainDays : "patchなし");
  }

  // --- 3. 付与日数を変更しない → 残不変（保存しない） ---
  {
    const t = await edit([ROW_CARRY], "plb_A", 7);
    check("3. 同値なら保存しない", t.patches.length === 0, "patches=" + t.patches.length);
    check("3. 同値なら確認ダイアログも出さない", t.confirms.length === 0, "confirms=" + t.confirms.length);
    check("3. 理由を伝える（無言で止めない）", t.alerts.length === 1 && t.alerts[0].indexOf("変わっていません") >= 0, t.alerts.join(" / "));
  }

  // --- 4. 修正後残が負になる変更は拒否（消化済み合計 5日 を下回れない） ---
  {
    const t = await edit([ROW_CARRY], "plb_A", 4);
    check("4. 消化済み合計(5日)未満へは変更できない", t.patches.length === 0, "patches=" + t.patches.length);
    check("4. 下限は usedDays(3日) ではなく消化済み合計(5日)", t.alerts.length === 1 && t.alerts[0].indexOf("5日取得済み") >= 0, t.alerts.join(" / "));
    // 境界: ちょうど 5 なら残0で保存できる
    const t2 = await edit([ROW_CARRY], "plb_A", 5);
    const p2 = lastPatch(t2);
    check("4. 境界（付与＝消化済み合計）は残0で保存できる", !!p2 && p2.remainDays === 0, p2 ? "remainDays=" + p2.remainDays : "patchなし");
  }

  // --- 5. 消化済み日数・FIFO 割当は変更しない ---
  {
    const t = await edit([ROW_CARRY], "plb_A", 8);
    const p = lastPatch(t);
    check("5. patch に usedDays を含めない", !!p && !Object.prototype.hasOwnProperty.call(p, "usedDays"), p ? Object.keys(p).join(",") : "patchなし");
    check("5. patch に consumedSnapshot / 申請側の項目を含めない",
      !!p && !Object.prototype.hasOwnProperty.call(p, "consumedSnapshot") && !Object.prototype.hasOwnProperty.call(p, "leaveDates"),
      p ? Object.keys(p).join(",") : "patchなし");
    check("5. 付与日・有効期限を書き換えない",
      !!p && !Object.prototype.hasOwnProperty.call(p, "grantDate") && !Object.prototype.hasOwnProperty.call(p, "expiresAt"),
      p ? Object.keys(p).join(",") : "patchなし");
  }

  // --- 6. 未来取得予定がある場合（承認済みで usedDays に入っている） ---
  //     未来分は usedDays を上限に表示側で戻している。usedDays を変えない以上、
  //     残日数の増減は付与日数の増減分と完全に一致しなければならない。
  {
    const t = await edit([ROW_PLAIN], "plb_B", 12);   // 付与10→12（残6・消化4）
    const p = lastPatch(t);
    check("6. carryIn 無しの行では従来どおり 残6+2=8（＝granted-used と一致）", !!p && p.remainDays === 8, p ? "remainDays=" + p.remainDays : "patchなし");
  }

  // --- 7. 取消・撤回済み申請がある場合 ---
  //     引戻し（reverseFifoConsumption）は usedDays と remainDays を同じ量だけ戻すため、
  //     carryIn は変わらない。戻し済みの行でも増減分だけが乗ること。
  {
    const t = await edit([ROW_FRESH], "plb_C", 12);
    const p = lastPatch(t);
    check("7. 消化0の行は 残10+2=12", !!p && p.remainDays === 12, p ? "remainDays=" + p.remainDays : "patchなし");
  }

  // --- 8. 複数付与行があっても対象行以外を変更しない ---
  {
    const t = await edit([ROW_CARRY, ROW_PLAIN, ROW_FRESH], "plb_A", 8);
    check("8. patch は1回だけ", t.patches.length === 1, "patches=" + t.patches.length);
    check("8. patch 先は対象行のみ", t.patches.length === 1 && t.patches[0].id === "plb_A", t.patches.map(function (x) { return x.id; }).join(","));
  }

  // --- 9. 表示中に別操作が入ったら保存しない（残日数の食い違いも検知する） ---
  {
    // 画面表示中に承認が走り、used 3→4 / remain 2→1 になったケース
    const t = await edit([ROW_CARRY], "plb_A", 8, Object.assign({}, ROW_CARRY, { usedDays: 4, remainDays: 1 }));
    check("9. 正本が動いていたら保存しない", t.patches.length === 0, "patches=" + t.patches.length);
    check("9. 最新値で開き直す", t.reopened === 1, "reopened=" + t.reopened);
    // remain だけが動いたケース（used は同じ）も検知すること
    const t2 = await edit([ROW_CARRY], "plb_A", 8, Object.assign({}, ROW_CARRY, { remainDays: 1 }));
    check("9. remainDays だけの食い違いも検知する", t2.patches.length === 0, "patches=" + t2.patches.length);
  }

  // --- 10. 消化済み合計の定義 ---
  {
    const ctx = makeCtx([ROW_CARRY], "plb_A");
    check("10. 消化済み合計 = 付与 − 残（usedDays ではない）", ctx._plBalEditConsumedTotal(7, 2) === 5, String(ctx._plBalEditConsumedTotal(7, 2)));
    const v = ctx._plBalEditValidate("8", 7, 2);
    check("10. validate は remain=3 / delta=+1 を返す", v.ok === true && v.remain === 3 && v.delta === 1, JSON.stringify(v));
    const v2 = ctx._plBalEditValidate("8.3", 7, 2);
    check("10. 0.5日単位以外は拒否", v2.ok === false && v2.msg.indexOf("0.5日単位") >= 0, JSON.stringify(v2));
    const v3 = ctx._plBalEditValidate("41", 7, 2);
    check("10. 40日超は拒否", v3.ok === false, JSON.stringify(v3));
    const v4 = ctx._plBalEditValidate("", 7, 2);
    check("10. 空欄は empty 扱い（エラー色にしない）", v4.ok === false && v4.empty === true, JSON.stringify(v4));
    const v5 = ctx._plBalEditValidate("7.5", 7, 2);
    check("10. 0.5日刻みの増加も可（残2.5）", v5.ok === true && v5.remain === 2.5, JSON.stringify(v5));
  }

  // --- 12. プレビュー（管理者が保存前に読む数字）も同じ式で出す ---
  //     ここが旧式のままだと「残5日になります」と出して残3日を保存する食い違いになる。
  {
    const ctx = openAndType([ROW_CARRY], "plb_A", 8);
    const prev = ctx._el("pl-bal-edit-preview").textContent;
    check("12. プレビューに 3日 を出す", prev.indexOf("= 3日") >= 0, prev);
    check("12. プレビューに旧式の 5日 を出さない", prev.indexOf("= 5日") < 0, prev);
    check("12. プレビューに消化済み合計 5日 を明示する", prev.indexOf("消化済み合計 5日") >= 0, prev);
    check("12. 消化済み合計の表示に carryIn の内訳を出す",
      ctx._el("pl-bal-edit-used").textContent === "5日（うちシステム上の消化 3日）", ctx._el("pl-bal-edit-used").textContent);
    check("12. 現在の残日数は正本の 2日", ctx._el("pl-bal-edit-cur-remain").textContent === "2日", ctx._el("pl-bal-edit-cur-remain").textContent);
    check("12. 入力欄の下限は消化済み合計（usedDays ではない）", ctx._el("pl-bal-edit-granted").min === "5", ctx._el("pl-bal-edit-granted").min);
    check("12. 登録時点の消化分を注記する",
      ctx._el("pl-bal-edit-note").textContent.indexOf("登録時点ですでに 2日") >= 0, ctx._el("pl-bal-edit-note").textContent);
    // 減額側
    const ctx2 = openAndType([ROW_CARRY], "plb_A", 6);
    check("12. 減額のプレビューも増減分で計算する（残1日）", ctx2._el("pl-bal-edit-preview").textContent.indexOf("= 1日") >= 0, ctx2._el("pl-bal-edit-preview").textContent);
    // 保存できない入力ではボタンを押させない
    const ctx3 = openAndType([ROW_CARRY], "plb_A", 4);
    check("12. 消化済み合計未満の入力では保存ボタンを無効化する", ctx3._el("btn-pl-bal-edit-save").disabled === true);
    // carryIn の無い行では注記を出さない
    const ctx4 = openAndType([ROW_PLAIN], "plb_B", 12);
    check("12. carryIn 無しの行では消化済みの内訳注記を出さない",
      ctx4._el("pl-bal-edit-used").textContent === "4日" && ctx4._el("pl-bal-edit-note").textContent === "",
      ctx4._el("pl-bal-edit-used").textContent + " / " + ctx4._el("pl-bal-edit-note").textContent);
  }

  // --- 13. フェイルクローズ（画面に出さないことだけを認可にしない） ---
  {
    const t1 = await edit([ROW_CARRY], "plb_A", 8, undefined, { viewerMode: true });
    check("13. 閲覧専用（労務士）は保存しない", t1.patches.length === 0, "patches=" + t1.patches.length);
    const t2 = await edit([ROW_CARRY], "plb_A", 8, undefined, { demoBlocked: true });
    check("13. デモモードは保存しない", t2.patches.length === 0, "patches=" + t2.patches.length);
    const t3 = await edit([ROW_CARRY], "plb_A", 8, undefined, { saving: true });
    check("13. 他の有給処理の実行中は保存しない", t3.patches.length === 0, "patches=" + t3.patches.length);
    check("13. 実行中は理由を伝える（無言で止めない）",
      t3.alerts.length === 1 && t3.alerts[0].indexOf("他の有給処理を実行中") >= 0, t3.alerts.join(" / "));
  }

  // --- 14. 未来日の取得予定がある付与行でも、残日数の再計算は増減分だけ ---
  {
    const t = await edit([ROW_PLAIN], "plb_B", 12, undefined, { futureByLot: { plb_B: 2 } });
    const p = lastPatch(t);
    check("14. 取得予定があっても 残6+2=8（表示用の戻し分を混ぜない）", !!p && p.remainDays === 8, p ? "remainDays=" + p.remainDays : "patchなし");
  }

  // --- 16. 消化済み合計が0.5の倍数でない付与行（残に端数がある行） ---
  //     案内文・input の min・実際に保存できる最小値の3つを食い違わせない。
  {
    const ODD = { id: "plb_D", staffId: "100004", staffName: "テスト三郎", grantDate: "2025-07-01", expiresAt: "2027-06-30", grantedDays: 7, usedDays: 3, remainDays: 2.3 }; // 消化済み合計 4.7
    const ctx = makeCtx([ODD], "plb_D");
    check("16. 消化済み合計は 4.7", ctx._plBalEditConsumedTotal(7, 2.3) === 4.7, String(ctx._plBalEditConsumedTotal(7, 2.3)));
    // 0.5日単位の判定を先に行う（入力できない 4.7 を「入れてよい値」として通さない）
    const vOdd = ctx._plBalEditValidate("4.7", 7, 2.3);
    check("16. 4.7 は 0.5日単位で拒否する", vOdd.ok === false && vOdd.msg.indexOf("0.5日単位") >= 0, JSON.stringify(vOdd));
    // 下限を下回る値の案内は、実際に入力できる最小値（5日）で示す
    const vLow = ctx._plBalEditValidate("4.5", 7, 2.3);
    check("16. 下限未満の案内に入力できない 4.7日 を出さない",
      vLow.ok === false && vLow.msg.indexOf("5日未満には変更できません") >= 0, JSON.stringify(vLow));
    // 実際に受理される最小値が 5（残0.3）
    const vMin = ctx._plBalEditValidate("5", 7, 2.3);
    check("16. 最小受理値は 5日（残0.3日）", vMin.ok === true && vMin.remain === 0.3, JSON.stringify(vMin));
    // input の min 属性も 5（step=0.5 の基点が min になるため切り上げる）
    const ctxOdd = openAndType([ODD], "plb_D", 8);
    check("16. input の min は 5（4.7 を出さない）", ctxOdd._el("pl-bal-edit-granted").min === "5", ctxOdd._el("pl-bal-edit-granted").min);
    check("16. 端数のある行でも残の計算は増減分のみ（2.3+1=3.3）",
      ctxOdd._el("pl-bal-edit-preview").textContent.indexOf("= 3.3日") >= 0, ctxOdd._el("pl-bal-edit-preview").textContent);
  }

  // --- 15. データ異常（remain > granted）でも減額の下限を壊さない ---
  {
    const ctx = makeCtx([{ id: "plb_X", grantedDays: 5, usedDays: 3, remainDays: 6 }], "plb_X");
    check("15. 消化済み合計は負にならない", ctx._plBalEditConsumedTotal(5, 6) === 0, String(ctx._plBalEditConsumedTotal(5, 6)));
    const v = ctx._plBalEditValidate("6", 5, 6);
    check("15. 増減分は加算される（残7）", v.ok === true && v.remain === 7, JSON.stringify(v));
  }

  // --- 11. 表示ロジックと保存ロジックが同じ式を使っている（ソース上の固定） ---
  {
    check("11. プレビューは (granted, remain) を渡している",
      /_plBalEditValidate\(\(inp&&inp\.value\)\|\|"",granted,remain\)/.test(CODE), "renderPreview");
    check("11. 保存前検証は (granted, remain) を渡している",
      /_plBalEditValidate\(raw,shownGranted,shownRemain\)/.test(CODE), "savePaidLeaveBalGrantedDays");
    check("11. 確定時検証も (granted, remain) を渡している",
      /_plBalEditValidate\(raw,granted,remain\)/.test(CODE), "_plBalEditCommit");
    check("11. 保存する remainDays は検証結果そのもの",
      /remainDays:v2\.remain/.test(CODE), "_plBalEditCommit");
    // 残日数の再計算そのものが usedDays に依存していないこと。
    // （remainDays 欠落時の既定値補完 granted-used は normalizePaidLeaveBalance と同じ規則なので対象外）
    const vsrc = CODE.slice(CODE.indexOf("function _plBalEditValidate"));
    const vbody = vsrc.slice(0, vsrc.indexOf("\n}") + 2).replace(/\/\/[^\n]*/g, "");
    check("11. 残日数の再計算関数が usedDays を参照していない",
      vbody.indexOf("used") < 0, "参照あり");
  }

  console.log("\n=== 結果: " + pass + " PASS / " + fail + " FAIL ===");
  if (fail > 0) process.exit(1);
}

main().catch(function (e) {
  console.error("ERROR", e);
  process.exit(1);
});
