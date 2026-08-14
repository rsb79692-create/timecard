/**
 * 移動距離申請のテスト（依存パッケージなし・送信なし・本番データ非アクセス）
 *
 * 実行: node scripts/test-mileage.js
 *
 * 目的:
 *   1. 金額計算（km単価・端数処理・スナップショット）を固定する。給与に直結するため。
 *   2. 未登録区間を 0km として保存しないことを固定する。
 *   3. 権限マトリクス（ACTIONS）に労務士(v)の書込系が入り込まないことを固定する。
 *   4. クライアント側の距離計算がサーバ側と一致することを固定する（表示と確定の食い違い防止）。
 *
 * 方式:
 *   サーバ側は api/_lib/mileage.js と api/mileage.js を require する（ネットワークは呼ばない）。
 *   クライアント側は index.html の該当ブロックを vm で評価する。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const M = require("../api/_lib/mileage.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
}

console.log("\n[1] 金額計算（現行Excelの実測値に基づく）");
// 現行Excel（■移動距離申請（谷村）.xlsm）: J5 = 16 円/km、金額は日別 = 単価×距離 の単純合計。
// 丸め関数（ROUND/ROUNDDOWN/ROUNDUP/INT/TRUNC）は0件 → "none" が Excel と同じ挙動。
eq("既定単価は 16 円/km（Excel J5）", M.DEFAULT_RATE, 16);
// ★ Excel は日別・月合計とも1円未満を丸めずに保持している（実測）。既定はそれに合わせる。
eq("既定の端数処理は「丸めない」（Excelと同じ）", M.DEFAULT_ROUND, "none");
// 現行Excelの月合計金額の実測値を、既定設定で再現できること
eq("Excel 202602: 41.5km → 664", M.monthlyAmount(41.5, 16, M.DEFAULT_ROUND), 664);
eq("Excel 202603: 86.2km → 1379.2", M.monthlyAmount(86.2, 16, M.DEFAULT_ROUND), 1379.2);
eq("Excel 202604: 161.9km → 2590.4", M.monthlyAmount(161.9, 16, M.DEFAULT_ROUND), 2590.4);
eq("Excel 202605: 146.2km → 2339.2", M.monthlyAmount(146.2, 16, M.DEFAULT_ROUND), 2339.2);
eq("Excel 202606: 111.4km → 1782.4", M.monthlyAmount(111.4, 16, M.DEFAULT_ROUND), 1782.4);
eq("Excel 202607: 162.8km → 2604.8", M.monthlyAmount(162.8, 16, M.DEFAULT_ROUND), 2604.8);
eq("Excel 202608: 62km → 992", M.monthlyAmount(62, 16, M.DEFAULT_ROUND), 992);
// 浮動小数の誤差（Excelの保存値 2590.3999999999996）を持ち回らない
eq("浮動小数の誤差を残さない", M.monthlyAmount(161.89999999999998, 16, "none"), 2590.4);
eq("Excel 相当（丸めなし）41.5km × 16 = 664", M.monthlyAmount(41.5, 16, "none"), 664);
eq("四捨五入 642.3km × 16 = 10277", M.monthlyAmount(642.3, 16, "round"), 10277);
eq("切り捨て 642.3km × 16 = 10276", M.monthlyAmount(642.3, 16, "floor"), 10276);
eq("切り上げ 642.3km × 16 = 10277", M.monthlyAmount(642.3, 16, "ceil"), 10277);
eq("単価を変えれば金額も変わる（20円/km）", M.monthlyAmount(642.3, 20, "round"), 12846);
// 浮動小数の誤差を持ち回らない
eq("6.2 + 4.4 = 10.6（誤差を残さない）", M.round1(6.2 + 4.4), 10.6);
eq("18.2 + 6.4 + 0.5 = 25.1", M.round1(M.round1(M.round1(0 + 18.2) + 6.4) + 0.5), 25.1);

console.log("\n[2] 経路の組み立てと未登録区間");
const places = [
  { id: "p_honsha", name: "本社" },
  { id: "p_nanairo", name: "ナナイロ" },
  { id: "p_haruiro", name: "ハルイロ" },
  { id: "p_new", name: "新施設" },
];
const placeById = {};
places.forEach((p) => { placeById[p.id] = p; });
// ★ 方向別。現行Excelの baseT には非対称な組（ハーベスト→貝塚 5.3 / 貝塚→ハーベスト 11.9）がある。
const legs = {
  "p_honsha__p_nanairo": 4.4,
  "p_nanairo__p_haruiro": 18.2,
  "p_haruiro__p_honsha": 7.4,
  "p_nanairo__p_honsha": 9.9,   // 逆方向は別の値（方向別が正本であることの確認）
};

const r1 = M.buildRoute(["p_honsha", "p_nanairo", "p_haruiro", "p_honsha"], legs, placeById);
eq("3区間の合計距離 4.4+18.2+7.4 = 30", r1.totalKm, 30);
eq("区間は自動生成される（3区間）", r1.legs.length, 3);
eq("未登録区間なし", r1.missing.length, 0);
eq("地点名がスナップショットされる", r1.legs[0].fromName + "→" + r1.legs[0].toName, "本社→ナナイロ");

const rRev = M.buildRoute(["p_nanairo", "p_honsha"], legs, placeById);
eq("方向別: ナナイロ→本社 は 9.9（逆方向 4.4 を流用しない）", rRev.totalKm, 9.9);

const r2 = M.buildRoute(["p_nanairo", "p_new"], legs, placeById);
eq("未登録区間は km=null（0km にしない）", r2.legs[0].km, null);
eq("未登録区間は missing に入る", r2.missing.length, 1);
eq("未登録区間は合計へ加算されない", r2.totalKm, 0);

console.log("\n[3] 経路の検証");
eq("地点1つは不可", M.validateRoute(["p_honsha"], placeById).error, "route_too_short");
eq("同じ地点の連続は不可", M.validateRoute(["p_honsha", "p_honsha"], placeById).error, "duplicate_consecutive_place");
eq("未知の地点IDは不可", M.validateRoute(["p_honsha", "p_zzz"], placeById).error, "unknown_place");
ok("正しい経路は通る", M.validateRoute(["p_honsha", "p_nanairo"], placeById).ok === true);
eq("地点数の上限を超えたら不可",
  M.validateRoute(new Array(M.MAX_PLACES + 1).fill("p_honsha"), placeById).error, "route_too_long");

console.log("\n[4] 入力検証");
eq("存在しない日付は不可 2026-02-31", M.isDate("2026-02-31"), false);
eq("存在する日付は可 2026-02-28", M.isDate("2026-02-28"), true);
eq("年月の形式", M.isYm("2026-08"), true);
eq("年月の形式（月13は不可）", M.isYm("2026-13"), false);
eq("距離0は不可", M.normKm(0), null);
eq("距離マイナスは不可", M.normKm(-5), null);
eq("距離は0.1km刻みへ丸める", M.normKm(18.24), 18.2);
eq("単価0は不可", M.normRate(0), null);
eq("制御文字は落とす", M.normText("a\u0000b\nc", 50), "a b c");
eq("社員番号にRTDBキー禁止文字は不可", M.isEmployeeId("100022/x"), false);
eq("社員番号は英数字なら可", M.isEmployeeId("100022"), true);

console.log("\n[5] 権限マトリクス（労務士は完全読み取り専用）");
const apiSrc = fs.readFileSync(path.join(__dirname, "..", "api", "mileage.js"), "utf8");
const actionsBlock = apiSrc.slice(apiSrc.indexOf("const ACTIONS = {"), apiSrc.indexOf("};", apiSrc.indexOf("const ACTIONS = {")) + 2);
const ACTIONS = vm.runInNewContext("(" + actionsBlock.replace("const ACTIONS = ", "") .replace(/;\s*$/, "") + ")");
const WRITE_ACTIONS = ["saveRequest", "deleteRequest", "setEnabled", "savePlace", "deletePlace",
  "saveLeg", "deleteLeg", "setSettings", "approveRequest", "rejectRequest", "reopenRequest",
  "closeMonth", "reopenMonth"];
WRITE_ACTIONS.forEach(function (a) {
  ok("書込 " + a + " に労務士(v)が含まれない", Array.isArray(ACTIONS[a]) && ACTIONS[a].indexOf("v") < 0,
    JSON.stringify(ACTIONS[a]));
});
["monthlyReport", "bootstrap"].forEach(function (a) {
  ok("読取 " + a + " は労務士(v)が可", ACTIONS[a].indexOf("v") >= 0);
});
["setEnabled", "savePlace", "saveLeg", "setSettings", "closeMonth", "reopenMonth",
 "approveRequest", "rejectRequest", "adminMonth"].forEach(function (a) {
  ok("管理系 " + a + " は管理者(a)のみ", ACTIONS[a].length === 1 && ACTIONS[a][0] === "a", JSON.stringify(ACTIONS[a]));
});
["myMonth", "saveRequest", "deleteRequest"].forEach(function (a) {
  ok("職員系 " + a + " は職員(s)のみ", ACTIONS[a].length === 1 && ACTIONS[a][0] === "s", JSON.stringify(ACTIONS[a]));
});
// 匿名・デモ・サンドボックスのロールがどこにも現れないこと
const allRoles = new Set();
Object.keys(ACTIONS).forEach(function (a) { ACTIONS[a].forEach(function (r) { allRoles.add(r); }); });
ok("許可ロールは s / a / v のみ", [...allRoles].sort().join(",") === "a,s,v", [...allRoles].join(","));

console.log("\n[6] r:\"a\" を特権として扱う経路が adminSessionValid を通る");
ok("api/mileage.js が adminSessionValid 経由の判定（isValidAdmin）を呼ぶ",
  /isValidAdmin\(ident\)/.test(apiSrc));
ok("_lib/mileage.js の isValidAdmin が S.adminSessionValid を使う",
  /adminSessionValid\(ident\.claims\)/.test(fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "mileage.js"), "utf8")));

console.log("\n[7] データは /honomi の外（ルール未定義＝既定拒否）へ置く");
const googleSrc = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "google.js"), "utf8");
ok("dbRequest のルート直下ルーティングに mileage が含まれる",
  /\^\(authz\|ratelimit\|mileage\)/.test(googleSrc));
ok("dbPatchRoot の許可トップに mileage が含まれる",
  /"authz",\s*"ratelimit",\s*"mileage"/.test(googleSrc));
eq("データルートは mileage", M.ROOT, "mileage");

console.log("\n[8] クライアント側の計算がサーバ側と一致する");
// index.html の移動距離モジュールから計算関数だけを切り出して評価する
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const START = "// ---- 計算（表示用。金額の正本はサーバのスナップショット）----";
const END = "/** 職員がよく使う地点";
const cs = html.indexOf(START), ce = html.indexOf(END, cs);
if (cs < 0 || ce < 0) {
  fail++;
  console.log("  FAIL  index.html から移動距離の計算ブロックを抽出できませんでした（マーカーコメントを変更した場合は本テストも合わせてください）");
} else {
  const ctx = { mileage: { places: places, legs: legs } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(cs, ce), ctx);
  eq("クライアント round1", ctx.mileageRound1(6.2 + 4.4), M.round1(6.2 + 4.4));
  eq("クライアント金額（四捨五入）", ctx.mileageAmount(642.3, 16, "round"), M.monthlyAmount(642.3, 16, "round"));
  eq("クライアント金額（丸めなし）", ctx.mileageAmount(41.5, 16, "none"), M.monthlyAmount(41.5, 16, "none"));
  eq("クライアント金額（切り捨て）", ctx.mileageAmount(642.3, 16, "floor"), M.monthlyAmount(642.3, 16, "floor"));
  const cr = ctx.mileageBuildRoute(["p_honsha", "p_nanairo", "p_haruiro", "p_honsha"]);
  eq("クライアント合計距離がサーバと一致", cr.totalKm, r1.totalKm);
  const cr2 = ctx.mileageBuildRoute(["p_nanairo", "p_new"]);
  eq("クライアントも未登録区間を0kmにしない", cr2.legs[0].km, null);
  eq("クライアントも未登録区間を合計へ加算しない", cr2.totalKm, 0);
  eq("クライアントも方向別（ナナイロ→本社 = 9.9）", ctx.mileageBuildRoute(["p_nanairo", "p_honsha"]).totalKm, 9.9);
}

console.log("\n[9] CSV（Excelで開ける形式・インジェクション無効化）");
const CSTART = "function mileageCsvCell(v){";
const CEND = "// ---- 管理者側 ----";
const ks = html.indexOf(CSTART), ke = html.indexOf(CEND, ks);
if (ks < 0 || ke < 0) {
  fail++;
  console.log("  FAIL  index.html から CSV ブロックを抽出できませんでした");
} else {
  const ctx2 = {};
  vm.createContext(ctx2);
  vm.runInContext(html.slice(ks, ke), ctx2);
  eq("カンマを含む値は引用符で囲む", ctx2.mileageCsvCell("a,b"), '"a,b"');
  eq("引用符は二重化する", ctx2.mileageCsvCell('a"b'), '"a""b"');
  eq("数式始まりは無効化する", ctx2.mileageCsvCell("=1+1"), "\"'=1+1\"");
  eq("行は CRLF 区切り", ctx2.mileageCsvRows([["a"], ["b"]]), '"a"\r\n"b"');
}
ok("dlCSV が BOM を付ける（Windows版Excelで日本語が化けない）",
  /function dlCSV\(csv,fname\)\{\s*var bom="\\uFEFF"|function dlCSV\(csv,fname\)\{\s*var bom="\uFEFF"/.test(html));

console.log("\n[10] 既存機能へ書き込まないこと（静的確認）");
const mlgClientStart = html.indexOf("// ===== 移動距離申請（独立モジュール）=====");
const mlgClientEnd = html.indexOf("// ===== \\u6709\\u7D66\\u7533\\u8ACB\\u30E6\\u30FC\\u30C6\\u30A3\\u30EA\\u30C6\\u30A3 =====");
const mlgClient = html.slice(mlgClientStart, mlgClientEnd > mlgClientStart ? mlgClientEnd : mlgClientStart + 60000);
ok("移動距離モジュールが authFetch（/honomi 直接書込）を使わない", mlgClient.indexOf("authFetch(") < 0);
ok("移動距離モジュールが saveData/saveToFirebase を使わない",
  mlgClient.indexOf("saveData(") < 0 && mlgClient.indexOf("saveToFirebase(") < 0);
// ★ /honomi 配下（tc5_*）へは読み書きとも一切触れない。
//   tc5_staff は誰でも書けるため、そこから社員番号を引くと成りすましが成立する。
ok("api/mileage.js が tc5_* を一切参照しない", !/tc5_[a-z_]+"/.test(apiSrc));
const libSrc2 = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "mileage.js"), "utf8");
ok("api/_lib/mileage.js が tc5_* を一切参照しない", !/dbGet\("tc5_/.test(libSrc2));

console.log("\n[11] 認証サブジェクト→社員番号の対応表（成りすまし対策）");
ok("resolveStaff は /mileage/identity だけを見る",
  /dbGet\(ROOT \+ "\/identity\/" \+ subject\)/.test(libSrc2));
ok("resolveStaff が employeeId の形式検証を通す",
  /if \(!isEmployeeId\(eid\)\) return null;/.test(libSrc2));
ok("setEnabled が identity と staff と enabled を1回のマルチパス更新で書く",
  /ROOT \+ "\/identity\/" \+ subject\]/.test(apiSrc)
  && /ROOT \+ "\/staff\/" \+ employeeId\]/.test(apiSrc)
  && /ROOT \+ "\/enabled\/" \+ employeeId\]/.test(apiSrc)
  && /dbPatchRoot\(patch\)/.test(apiSrc));
ok("同じ氏名に別の社員番号を割り当てようとしたら拒否する（identity_conflict）",
  /identity_conflict/.test(apiSrc));
ok("setEnabled は氏名を必須にする（bad_staff_name）", /bad_staff_name/.test(apiSrc));
// ★ 社員番号の訂正は「旧番号OFF → 新番号ON」の2回に分けない。
//   分けると片方だけ成功して「OFFになったが有効化できない」復旧不能な状態が残る。
ok("社員番号の付け替えは rebindFrom で1回の更新にまとめる",
  /rebindFrom/.test(apiSrc) && /rebindFrom/.test(html));
ok("付け替え時は旧番号の enabled と staff も同じ更新で消す",
  /patch\[ROOT \+ "\/enabled\/" \+ prevEid\] = null/.test(apiSrc)
  && /patch\[ROOT \+ "\/staff\/" \+ prevEid\] = null/.test(apiSrc));
ok("クライアントは setEnabled を2回に分けて呼ばない",
  (html.match(/mileageApi\("setEnabled"/g) || []).length === 1);
ok("実在するログイン（/authz/pins）にしか社員番号を割り当てない",
  /S\.AUTHZ \+ "\/pins\/" \+ subject/.test(apiSrc) && /pin_not_registered/.test(apiSrc));
ok("サブジェクト導出用の氏名正規化は trim しない（ログイン側と食い違わせない）",
  /function normName\(v, max\)/.test(libSrc2) && !/normName[\s\S]{0,400}\.trim\(\)/.test(libSrc2));
ok("デモ発行元トークンIDの形式検証がある（share.js と揃える）",
  /A-Za-z0-9_-\]\{1,64\}\$\/\.test\(String\(rec\.issuedByDemoTokenId\)\)/.test(libSrc2));
ok("監査ログの actor に事実と違う経路ラベルを書かない", !/"admin:pin"/.test(apiSrc));
ok("労務士セッションは呼び出しごとに viewerTokens の有効性を引き直す",
  /dbGet\("viewerTokens"\)/.test(libSrc2) && /rec\.enabled !== true/.test(libSrc2));
ok("1日1件は日付から決定的に導出した ID で冪等にする（TOCTOU 対策）",
  /const id = "d_" \+ date\.replace/.test(apiSrc));
ok("km単価が未設定なら月次確定を拒否する", /rate_not_configured/.test(apiSrc));
ok("書込系にハード上限がある（監査ログの無制限増加を防ぐ）",
  /WRITE_ACTIONS/.test(apiSrc) && /rate_limited/.test(apiSrc));

console.log("\n[12] クライアント側の世代管理（共有端末での取り違え防止）");
ok("mileageResetSession が世代を進める", /mileage\.gen\+\+/.test(html));
ok("取得結果は世代一致時のみ反映する（mileageStale）",
  (html.match(/mileageStale\(g\)/g) || []).length >= 6);
ok("bootstrap の氏名と画面のスタッフ名を突き合わせる",
  /got===who/.test(html) || /got === who/.test(html));
ok("職員側の取得失敗を0件として見せない（myError）", /mileage\.myError=true/.test(html));
ok("管理者のマスタ入力中はポーリング再描画を止める",
  /function mileageAdminEditing\(\)/.test(html) && /mileageBlocksRerender\(\)/.test(html));
// ★ 月末の一括承認を1件ずつ往復させない（往復数が数百になり、書込上限にも当たる）
ok("一括承認はサーバ側で1リクエストにまとめる",
  /approveAll: \["a"\]/.test(apiSrc) && /handleApproveAll/.test(apiSrc)
  && /mileageApi\("approveAll"/.test(html));
ok("一括承認でも未登録区間の申請は承認しない",
  /skipped\.push\(\{ id: id, date: String\(rec\.date \|\| ""\), reason: "missing_leg" \}\)/.test(apiSrc));
ok("未許可の職員にも本人照合用の氏名を返す（前の職員の応答を取り違えない）",
  /enabled: false, staffName: staff\.name/.test(apiSrc));
ok("職員ロール以外の応答を本人一致として扱わない",
  /res\.data\.role!=="s"/.test(html));
// ★ 改名時は pin-set の付け替えと本APIが並行するため、PIN実在検査を掛けると
//   事実と違う失敗になり、当人が無言で利用不可になる。
// 改名では pin-set の付け替えと本APIが並行する。新旧どちらかのログインがあれば通し、
// 「どこにもログインが無い氏名」への割り当てだけを止める。
ok("改名では新旧どちらかのログインがあれば通す",
  /for \(const k of staleSubjects\) \{/.test(apiSrc) && /S\.AUTHZ \+ "\/pins\/" \+ k/.test(apiSrc));
ok("利用を止める操作（OFF）は PIN 実在検査で止めない", /if \(on && !pinExists\) \{/.test(apiSrc));
ok("付け替えた旧社員番号は再利用禁止にする（前任者のデータが混ざらない）",
  /employee_id_retired/.test(apiSrc) && /ROOT \+ "\/retired\/" \+ prevEid\]/.test(apiSrc));
// ★ 氏名と社員番号を同時に変えるとサブジェクトも変わるため curEid は空になる。
//   そこを取りこぼすと旧サブジェクトの対応表と enabled が残り、第三者に乗っ取られる。
ok("氏名と社員番号の同時変更でも「前の番号」を特定して後始末する",
  /if \(!prevEid && M\.isEmployeeId\(rebindFrom\) && rebindFrom !== employeeId\) prevEid = rebindFrom;/.test(apiSrc));
ok("新旧いずれかの番号に紐づく別サブジェクトの対応表を必ず外す",
  /e === employeeId \|\| \(!!prevEid && e === prevEid\)/.test(apiSrc));
ok("改名でも「どこかに実在するログイン」であることは必ず要求する",
  /if \(on && !pinExists && isRename\)/.test(apiSrc) && /if \(on && !pinExists\) \{/.test(apiSrc));
ok("直前の付け替えを元へ戻せる（復旧不能な行き止まりを作らない）",
  /revertRetired/.test(apiSrc) && /String\(retired\.replacedBy \|\| ""\) === prevEid/.test(apiSrc));
ok("退役済み番号のエラーが利用者向け文言になっている",
  /c==="employee_id_retired"/.test(html));
ok("利用設定の送信に失敗したら次回保存で必ず再送する",
  /mileage\.syncFailed\[eid\]=true/.test(html) && /mustResend/.test(html));
ok("移動距離を使わない職員の改名では利用設定を送らない",
  /if\(!want&&!mileage\.modalWas\)return;/.test(html));
ok("スタッフ情報の保存を先に確定させる",
  /saveData\("tc5_staff",staffList\);\s*\n\s*mileageSaveStaffModal\(newN\);/.test(html));

console.log("\n================ 結果 ================");
console.log("PASS: " + pass + " / FAIL: " + fail);
if (fail > 0) process.exit(1);
