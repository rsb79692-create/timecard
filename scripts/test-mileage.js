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

console.log("\n[13] 応援打刻からの自動集計（サーバ側の共通ロジック）");
const AU = require("../api/_lib/mileage-auto.js");

// 地点マスタ（打刻の施設名と対応づける）
const AP = [
  { id: "p_nana", name: "ナナイロ", facility: "ナナイロ", active: true },
  { id: "p_haru", name: "ハルイロ", facility: "ハルイロ", active: true },
  { id: "p_myu", name: "ミュゲ春木", facility: "", active: true },   // 地点名＝施設名で自動対応
];
// ★ 方向別。往復で距離が違う実データがあるため、往路の値を復路へ流用しない。
const ALEG = {
  "p_nana__p_haru": 5.0, "p_haru__p_nana": 6.0,
  "p_haru__p_myu": 3.0, "p_myu__p_nana": 8.0,
};
const ACTX = { placeByFacility: AU.placeMap(AP), legs: ALEG };

eq("施設名→地点は facility 指定で対応づく", ACTX.placeByFacility["ナナイロ"], "p_nana");
eq("facility 未指定でも地点名が一致すれば対応づく", ACTX.placeByFacility["ミュゲ春木"], "p_myu");
eq("対応の無い施設は未対応のまま", ACTX.placeByFacility["貝塚"], undefined);
{
  const dup = AU.placeMap([
    { id: "p_a", name: "A", facility: "ナナイロ", active: true },
    { id: "p_b", name: "B", facility: "ナナイロ", active: true },
  ]);
  eq("同じ施設を2地点へ割り当てたら推測せず未対応にする", dup["ナナイロ"], undefined);
}

function pr(type, hhmm, extra) {
  return Object.assign({
    staff: "山田 太郎", date: "2026-08-03", type: type, time: hhmm,
    timestamp: "2026-08-03T" + hhmm + ":00.000+09:00",
  }, extra || {});
}

// A. 正常：ナナイロで出勤 → ハルイロへ応援 → ハルイロで退勤
const dayA = [
  pr("clockIn", "08:00", { workFacility: "ナナイロ", homeFacility: "ナナイロ" }),
  pr("breakStart", "12:00"), pr("breakEnd", "12:45"),
  pr("facilityChange", "13:00", { fromFacility: "ナナイロ", workFacility: "ハルイロ" }),
  pr("clockOut", "17:00", { facilityName: "ハルイロ" }),
];
const rA = AU.dayRoute(dayA, ACTX);
eq("起点はその日の出勤施設", AU.routeText(rA.routes), "ナナイロ → ハルイロ → ナナイロ");
eq("退勤が応援先でも最後は起点へ戻す（5.0+6.0）", rA.totalKm, 11);
eq("正常な日は自動計算済み", rA.status, "auto");
eq("経路の指紋が残る（確定後差異の検知に使う）", rA.sig, "ナナイロ>ハルイロ>ナナイロ");

// 複数施設を回る日
const dayB = [
  pr("clockIn", "08:00", { workFacility: "ナナイロ" }),
  pr("facilityChange", "10:00", { fromFacility: "ナナイロ", workFacility: "ハルイロ" }),
  pr("facilityChange", "14:00", { fromFacility: "ハルイロ", workFacility: "ミュゲ春木" }),
  pr("clockOut", "18:00"),
];
eq("複数施設は時系列順に並ぶ", AU.routeText(AU.dayRoute(dayB, ACTX).routes),
  "ナナイロ → ハルイロ → ミュゲ春木 → ナナイロ");
eq("複数施設の合計（5.0+3.0+8.0）", AU.dayRoute(dayB, ACTX).totalKm, 16);

// 配列の順序ではなく timestamp 順で判定する（Firebase はキー順＝時系列ではない）
const dayBShuffled = [dayB[3], dayB[1], dayB[0], dayB[2]];
eq("レコードの配列順に依存しない", AU.dayRoute(dayBShuffled, ACTX).sig, AU.dayRoute(dayB, ACTX).sig);

// B. 出勤打刻忘れ：起点が確定できない → 推測しない
const dayNoIn = [
  pr("facilityChange", "13:00", { fromFacility: "ナナイロ", workFacility: "ハルイロ" }),
  pr("clockOut", "17:00"),
];
eq("出勤打刻が無ければ起点未確定", AU.dayRoute(dayNoIn, ACTX).status, "no_origin");
eq("起点未確定の日は距離を確定しない", AU.dayRoute(dayNoIn, ACTX).totalKm, 0);
ok("起点未確定でも応援打刻から起点を推測しない",
  AU.dayRoute(dayNoIn, ACTX).routes.length === 0);

const dayEmptyOrigin = [
  pr("clockIn", "08:00", {}),   // workFacility も facilityName も無い旧データ
  pr("facilityChange", "13:00", { workFacility: "ハルイロ" }),
  pr("clockOut", "17:00"),
];
eq("出勤施設が記録されていなければ起点未確定", AU.dayRoute(dayEmptyOrigin, ACTX).status, "no_origin");

// 移動が無い日は行を作らない
eq("施設変更が無い日は対象外",
  AU.dayRoute([pr("clockIn", "08:00", { workFacility: "ナナイロ" }), pr("clockOut", "17:00")], ACTX).status,
  "none");

// C. 未登録区間・未対応施設は 0km にしない
{
  const ctxNoLeg = { placeByFacility: ACTX.placeByFacility, legs: { "p_nana__p_haru": 5.0 } };
  const r = AU.dayRoute(dayA, ctxNoLeg);
  eq("復路が未登録なら距離未登録", r.status, "missing_leg");
  eq("未登録区間を明示する", r.missingLegs.length, 1);
  eq("未登録区間は合計へ加算しない（0km にもしない）", r.legs[1].km, null);
}
{
  const dayKaizuka = [
    pr("clockIn", "08:00", { workFacility: "ナナイロ" }),
    pr("facilityChange", "13:00", { fromFacility: "ナナイロ", workFacility: "貝塚" }),
    pr("clockOut", "17:00"),
  ];
  const r = AU.dayRoute(dayKaizuka, ACTX);
  eq("地点マスタに無い施設は距離未登録", r.status, "missing_leg");
  eq("未対応の施設名を返す", r.missingPlaces.join(","), "貝塚");
}

// 退勤打刻が無くても帰りの移動は業務ルールどおり起点へ戻す
{
  const r = AU.dayRoute([
    pr("clockIn", "08:00", { workFacility: "ナナイロ" }),
    pr("facilityChange", "13:00", { fromFacility: "ナナイロ", workFacility: "ハルイロ" }),
  ], ACTX);
  eq("未退勤でも起点へ戻す", r.sig, "ナナイロ>ハルイロ>ナナイロ");
  ok("未退勤は注記として残す", r.notes.indexOf("no_clockout") >= 0);
}
// 削除済みレコードは無視する
{
  const r = AU.dayRoute(dayA.concat([
    Object.assign(pr("facilityChange", "15:00", { fromFacility: "ハルイロ", workFacility: "ミュゲ春木" }), { deleted: true }),
  ]), ACTX);
  eq("削除済みの打刻は経路に含めない", r.sig, "ナナイロ>ハルイロ>ナナイロ");
}

console.log("\n[14] 手入力・打刻修正との突き合わせ（確定できる日／できない日）");
{
  const auto = AU.month(dayA, "2026-08", ACTX);
  eq("月次集計に対象日が入る", auto.dates.join(","), "2026-08-03");

  const m0 = AU.merge(auto.days, {}, {});
  eq("正常な日は合計に入る", m0.totalKm, 11);
  eq("正常な日は要確認にならない", m0.blockers.length, 0);

  // 承認済みの手入力はその日の自動集計より優先する（例外運用）
  const m1 = AU.merge(auto.days, { "2026-08-03": { status: "approved", totalKm: 30, routeText: "手入力" } }, {});
  eq("承認済みの手入力が自動集計より優先される", m1.totalKm, 30);
  eq("手入力の日は source=manual", m1.rows[0].source, "manual");

  // 未処理の手入力がある日は確定できない
  const m2 = AU.merge(auto.days, { "2026-08-03": { status: "pending", totalKm: 30 } }, {});
  eq("未処理の手入力は要確認", m2.rows[0].status, "pending_request");
  eq("未処理の手入力は合計に入れない", m2.totalKm, 0);

  // 却下された手入力は無効。自動集計へ戻す
  const m3 = AU.merge(auto.days, { "2026-08-03": { status: "rejected", totalKm: 30 } }, {});
  eq("却下された手入力は自動集計へ戻る", m3.totalKm, 11);

  // 打刻修正が未処理の日は確定できない
  const m4 = AU.merge(auto.days, {}, { "2026-08-03": true });
  eq("打刻修正待ちは要確認", m4.rows[0].status, "pending_correction");
  eq("打刻修正待ちは合計に入れない", m4.totalKm, 0);

  // 移動の無い日の打刻修正は移動距離に無関係なので要確認にしない
  const m5 = AU.merge({}, {}, { "2026-08-10": true });
  eq("移動が無い日の打刻修正待ちは対象外", m5.rows.length, 0);

  // 起点未確定・距離未登録は要確認
  const m6 = AU.merge(AU.month(dayNoIn, "2026-08", ACTX).days, {}, {});
  eq("起点未確定は要確認として残る", m6.blockers[0].status, "no_origin");
}

console.log("\n[15] 月次確定後の差異検知（自動では書き換えない）");
{
  const snap = [{ date: "2026-08-03", km: 11, source: "auto", sig: "ナナイロ>ハルイロ>ナナイロ" }];
  eq("経路も距離も同じなら差異なし",
    AU.diff(snap, [{ date: "2026-08-03", km: 11, sig: "ナナイロ>ハルイロ>ナナイロ", source: "auto", status: "auto" }]).length, 0);
  const d1 = AU.diff(snap, [{ date: "2026-08-03", km: 16, sig: "ナナイロ>ハルイロ>ミュゲ春木>ナナイロ", source: "auto", status: "auto" }]);
  eq("確定後に経路が変われば差異として出す", d1.length, 1);
  eq("差異は確定時と現在の両方を返す", d1[0].beforeKm + "→" + d1[0].afterKm, "11→16");
  eq("確定済みの日が消えたら差異として出す",
    AU.diff(snap, []).length, 1);
  // ★ 確定は「要確認0件」でしか通らない。確定後に要確認の日が現れたなら、それは確定後の変化であり
  //   支給されていない移動が発生している可能性がある。黙って通してはならない。
  eq("確定後に新しく発生した要確認の日は差異として出す",
    AU.diff([], [{ date: "2026-08-04", km: 0, sig: "", source: "auto", status: "no_origin" }]).length, 1);
  eq("そもそも集計対象にならない日（移動なし）は差異にしない",
    AU.diff([], [{ date: "2026-08-04", km: 0, sig: "", source: "auto", status: "none" }]).length, 0);
}

console.log("\n[15-2] 打刻の不整合を「正常」として確定しない");
{
  // 移動先が記録されていない施設変更（管理者の手編集や直接書き込みで起こりうる）
  const broken = [
    pr("clockIn", "08:00", { workFacility: "ナナイロ" }),
    pr("facilityChange", "10:00", { fromFacility: "ナナイロ" }),          // workFacility 無し
    pr("facilityChange", "14:00", { fromFacility: "ミュゲ春木", workFacility: "ハルイロ" }),
    pr("clockOut", "18:00"),
  ];
  const r = AU.dayRoute(broken, ACTX);
  // ★ 区間が1本欠けたまま 11km を「自動計算済」にすると、実際と違う金額が黙って確定する
  eq("移動先が空の施設変更がある日は確定しない", r.status, "broken_punch");
  eq("欠けた経路で距離を確定しない", r.totalKm, 0);
  const m = AU.merge(AU.month(broken, "2026-08", ACTX).days, {}, {});
  eq("打刻不整合は要確認として残る", m.blockers[0].status, "broken_punch");
  eq("打刻不整合は合計に入れない", m.totalKm, 0);

  // 後編集で経路の連続性が壊れた日は、確定は止めないが管理者へ提示する
  const mismatch = [
    pr("clockIn", "08:00", { workFacility: "ナナイロ" }),
    pr("facilityChange", "13:00", { fromFacility: "ミュゲ春木", workFacility: "ハルイロ" }),
    pr("clockOut", "17:00"),
  ];
  const rm = AU.dayRoute(mismatch, ACTX);
  eq("変更前施設の食い違いは注意として立てる", rm.attention, true);
  ok("変更前施設の食い違いは注記に残る", rm.notes.indexOf("route_mismatch") >= 0);

  // 同時刻（手動追加は秒が 0）でも順序が決まること
  const sameTime = [
    Object.assign(pr("facilityChange", "08:00", { fromFacility: "ナナイロ", workFacility: "ハルイロ" }), { id: "b" }),
    Object.assign(pr("clockIn", "08:00", { workFacility: "ナナイロ" }), { id: "a" }),
    pr("clockOut", "17:00"),
  ];
  eq("同時刻は id で決定的に並べる（配列順に依存しない）",
    AU.dayRoute(sameTime, ACTX).sig, AU.dayRoute(sameTime.slice().reverse(), ACTX).sig);
}

console.log("\n[15-3] 外部データ由来のキーでプロトタイプを汚染しない");
{
  // ★ /honomi は匿名認証で書けるため、氏名 "__proto__" の打刻・修正申請を1件混ぜられる。
  //   素の {} で索引を作ると Object.prototype が汚染され、全職員の集計が壊れる（確定の妨害）。
  const polluted = AU.month([
    Object.assign(pr("clockIn", "08:00", { workFacility: "ナナイロ" }), { date: "__proto__" }),
  ], "2026-08", ACTX);
  eq("日付キーが __proto__ でも汚染されない", ({}).polluted, undefined);
  eq("不正な日付キーは集計に入れない", polluted.dates.length, 0);
  const mp = AU.placeMap([{ id: "p_x", name: "__proto__", facility: "__proto__", active: true }]);
  eq("施設名が __proto__ でも Object.prototype を汚染しない", ({}).p_x, undefined);
  ok("プロトタイプ由来のキーを対応表として拾わない", mp.toString === undefined || typeof mp.toString !== "function");
  eq("索引ヘルパは prototype を持たない辞書を返す", Object.getPrototypeOf(AU.dict()), null);
  eq("特殊キーは索引に使わせない", AU.safeKey("__proto__"), false);
  eq("通常のキーは使える", AU.safeKey("山田 太郎"), true);
}

console.log("\n[16] クライアントとサーバが同一ソースを共有している");
const SB = "// ==== SHARED-AUTO-BEGIN ====", SE = "// ==== SHARED-AUTO-END ====";
const autoSrc = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "mileage-auto.js"), "utf8");
const sbS = autoSrc.indexOf(SB), sbE = autoSrc.indexOf(SE);
const hbS = html.indexOf(SB), hbE = html.indexOf(SE);
if (sbS < 0 || sbE < 0 || hbS < 0 || hbE < 0) {
  fail++;
  console.log("  FAIL  共有ブロック（SHARED-AUTO）のマーカーが見つかりません");
} else {
  const serverBlock = autoSrc.slice(sbS, sbE + SE.length);
  const clientBlock = html.slice(hbS, hbE + SE.length);
  // ★ 表示（クライアント）と確定（サーバ）で計算が食い違うと、画面の金額と支給額がずれる。
  //   コピーではなく「1文字も違わないこと」を機械的に固定する。
  ok("共有ブロックがサーバと index.html で完全一致する", serverBlock === clientBlock,
    "server=" + serverBlock.length + " client=" + clientBlock.length);

  // 実際に評価して、同じ入力から同じ結果になることも確認する
  const ctxC = {};
  vm.createContext(ctxC);
  vm.runInContext(clientBlock, ctxC);
  const cCtx = { placeByFacility: ctxC.mileageAutoPlaceMap(AP), legs: ALEG };
  eq("クライアントの経路生成がサーバと一致（正常日）",
    JSON.stringify(ctxC.mileageAutoDayRoute(dayA, cCtx)), JSON.stringify(rA));
  eq("クライアントの経路生成がサーバと一致（複数施設）",
    JSON.stringify(ctxC.mileageAutoDayRoute(dayB, cCtx)), JSON.stringify(AU.dayRoute(dayB, ACTX)));
  eq("クライアントも出勤打刻が無ければ起点未確定",
    ctxC.mileageAutoDayRoute(dayNoIn, cCtx).status, "no_origin");
  eq("クライアントの月次突き合わせがサーバと一致",
    JSON.stringify(ctxC.mileageAutoMerge(ctxC.mileageAutoMonth(dayA, "2026-08", cCtx).days, {}, {})),
    JSON.stringify(AU.merge(AU.month(dayA, "2026-08", ACTX).days, {}, {})));
}

console.log("\n[17] 打刻データ（/honomi）への触り方を限定する");
// 「実際のコード」だけを見る（説明コメントに書かれた名前を検出しないよう除去する）
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const punchSrc = stripComments(fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "mileage-punch.js"), "utf8"));
const apiCode = stripComments(apiSrc);
// ★ 打刻は読むだけ。書き込み経路を1つも持たせない（勤怠データを壊さない保証）。
ok("mileage-punch.js は書き込み関数を一切呼ばない",
  !/dbPut|dbPatch|dbPatchRoot|dbRequest/.test(punchSrc));
ok("mileage-punch.js が参照するのは tc5_records と tc5_correction_requests だけ",
  [...new Set(punchSrc.match(/tc5_[a-z_]+/g) || [])].sort().join(",") === "tc5_correction_requests,tc5_records",
  JSON.stringify(punchSrc.match(/tc5_[a-z_]+/g)));
// ★ 本人特定に tc5_staff を使うと成りすましが成立する（誰でも書ける領域のため）。
ok("打刻の読み取り層も tc5_staff / tc5_pins を参照しない",
  !/tc5_staff|tc5_pins/.test(punchSrc));
ok("api/mileage.js は打刻を直接読まず mileage-punch 経由にする",
  /require\("\.\/_lib\/mileage-punch"\)/.test(apiCode) && !/tc5_[a-z_]+/.test(apiCode));
ok("自動集計の共通ロジックは通信・DBに触れない（純粋計算）",
  !/require\(/.test(autoSrc.slice(autoSrc.indexOf(SB))) && !/dbGet|fetch\(/.test(autoSrc));

console.log("\n[18] 自動集計の権限と確定条件");
ok("autoCheck は管理者(a)のみ", ACTIONS.autoCheck && ACTIONS.autoCheck.length === 1 && ACTIONS.autoCheck[0] === "a",
  JSON.stringify(ACTIONS.autoCheck));
ok("autoCheck は読み取り専用（書込上限リストに入れない）", !/autoCheck: 1/.test(apiSrc));
ok("月次確定は要確認が残っていたら拒否する（unresolved）",
  /error: "unresolved"/.test(apiSrc) && /comp\.unresolved > 0/.test(apiSrc));
ok("月次確定は画面の数値ではなくサーバで打刻から計算し直す",
  /const comp = await computeAutoMonth\(ym\)/.test(apiSrc));
ok("確定スナップショットに日別内訳と経路の指紋を残す（差異検知のため）",
  /days: days,/.test(apiSrc) && /sig: r\.sig \|\| ""/.test(apiSrc));
ok("確定後差異は報告するだけで、確定済みの金額を自動で書き換えない",
  /out\.drift = drift;/.test(apiSrc) && !/monthly\/" \+ s\.employeeId \+ "\/" \+ ym\] = null/.test(apiSrc));
ok("自動集計の対象は利用ONの職員だけ（OFFは手入力分のみ）",
  /t\.auto && t\.staffName/.test(apiSrc));
ok("労務士の明細は確定済みスナップショットから作る",
  /Array\.isArray\(snap\.days\)/.test(apiSrc));
ok("職員画面は自動集計を主画面にする（申請操作を必須にしない）",
  /応援（施設変更）の打刻から自動で集計しています。申請は不要です。/.test(html));
ok("管理画面に「要確認の日だけ表示」がある", /要確認の日だけ表示/.test(html));
ok("要確認が残っている月は確定ボタンを押せない",
  /要確認が残っているため確定できません/.test(html));
ok("同じ施設を複数地点へ割り当てられない（duplicate_facility）",
  /duplicate_facility/.test(apiSrc) && /duplicate_facility/.test(html));

console.log("\n[19] 確定を通す条件（人が確認した内容だけを確定する）");
// ★ 自動集計には日ごとの承認工程が無い。確認 → 確定の間に内容が変わっていないことを
//   指紋で突き合わせることが、唯一の「人が見て承認した」証跡になる。
ok("確定は autoCheck が返した確認指紋の一致を必須にする",
  /function confirmDigest\(/.test(apiSrc)
  && /H\.str\(body\.confirmToken, 64\) !== expected/.test(apiSrc)
  && /stale_confirmation/.test(apiSrc));
ok("クライアントは確定前に必ずサーバで再集計してから確認を出す",
  /mileageApi\("autoCheck",\{ym:ym\},30000\)/.test(html) && /confirmToken:chk\.confirmToken/.test(html));
ok("打刻を取得できなかった月は確定しない（0件を「移動なし」と扱わない）",
  /punch_unavailable/.test(apiSrc) && /totalRecords/.test(punchSrc));
ok("氏名を解決できない利用ON職員は要確認にする（黙って支給漏れにしない）",
  /name_unresolved/.test(apiSrc) && /name_unresolved/.test(html));
ok("打刻の読み取り層もプロトタイプ汚染を防ぐ",
  /Object\.create\(null\)/.test(punchSrc) && /__proto__/.test(punchSrc));
ok("確定は打刻の全件取得を伴うため明示タイムアウトを渡す",
  /mileageAdminDo\("closeMonth",\{ym:ym,confirmToken:chk\.confirmToken\},[^)]*30000\)/.test(html));
ok("autoCheck にも読み取り上限がある（全件取得の連打を防ぐ）",
  /READ_LIMIT_ADMIN/.test(apiSrc));
ok("確定済みの月は職員画面も確定額を表示する（再計算値を出さない）",
  /r\.snapshot = \{/.test(apiSrc) && /mileage\.mySnapshot/.test(html));

console.log("\n[20] レビュー指摘の再発防止（2026-08-14 の review / security / performance / ui-print）");

// ★ 打刻修正の承認は時刻しか書かず workFacility を付けないため、承認しても no_origin は解消しない。
//   「打刻を修正してください」と案内すると、解消できない要確認で月全体の確定が止まったままになる。
ok("no_origin の案内が「打刻修正では直らない」ことと手入力での復旧を示す",
  /no_origin:"[^"]*打刻修正申請を承認しても解消しません/.test(html)
  && /no_origin:"[^"]*手入力（例外）/.test(html));
ok("no_origin の案内に「打刻を修正してください」を復活させない",
  !/no_origin:"[^"]*打刻を修正してください/.test(html));
ok("確定できないときのエラー文も手入力での復旧を案内する",
  /「起点未確定」は打刻修正の承認では解消しません/.test(html));

// ★ overlay は position:fixed + align-items:center で自身をスクロールできない。
//   カードが画面より高いと下端の OK / キャンセルが押せなくなる（月次確定の確認は最大20行）。
ok("確認モーダルは画面より高くなってもボタンへ到達できる",
  /max-height:calc\(100vh - 32px\);overflow-y:auto/.test(html));

// ★ 再集計の結果が「差異あり」のときしか出ないと、押しても効かないのか差異が無いのか区別できず、
//   確定後差異の唯一の検知手段を見落とす。
ok("サーバ再集計は差異が無くても結果を必ず表示する",
  /サーバ側の再集計：/.test(html) && /確定後の差異はありません。/.test(html));
ok("再集計の結果は要確認の件数で色を切り替える",
  /Number\(chk\.unresolved\)>0\?"#b91c1c":"#166534"/.test(html));
ok("打刻を読み取れなかったことが管理画面に出る",
  /chkFresh&&chk\.punchUnavailable/.test(html));

// ★ closedBy は監査用 actor。管理者トークンに t クレームが付く実装を入れた瞬間、
//   労務士がトークンハッシュを読めるようになる（/mileage/audit を返さない取り決めと同じ理由）。
ok("労務士へ返す closing は欄を列挙し、closedBy を含めない",
  /closing: \{\s*\n\s*closedAt:/.test(apiSrc) && !/closing: closingsRaw\[ym\]/.test(apiSrc));

// ★ 正規表現だけでは __proto__ / constructor を通してしまう。素の {} の索引キーに使われるため、
//   placeById["constructor"] が存在検査を通り、enabled["__proto__"]=true は黙って無視される
//   （＝要確認にもならず自動集計から消える。フェイルサイレントな支給漏れ）。
ok("社員番号・IDはプロトタイプ特殊キーを拒否する",
  M.isEmployeeId("E001") === true && M.isEmployeeId("__proto__") === false
  && M.isEmployeeId("constructor") === false && M.isEmployeeId("prototype") === false
  && M.isId("p1") === true && M.isId("__proto__") === false && M.isId("constructor") === false);

// ★ closeMonth も autoCheck と同じ全件取得を行い、要確認が残る月では 409 を返すまでに必ず到達する。
ok("closeMonth にも打刻全件取得の読み取り上限が掛かる",
  /action === "autoCheck" \|\| action === "closeMonth"/.test(apiSrc));

// ★ /mileage/monthly は全職員×全月の1ノードで、日別内訳 days[] を持つぶん肥大する。
//   労務士画面は「一覧 → 対象月」の2回呼ぶため、ym が空の回で取って捨てない。
ok("確定済み月の一覧だけを返すときは monthly を取得しない",
  /ym \? G\.dbGet\(ROOT \+ "\/monthly"\) : Promise\.resolve\(null\)/.test(apiSrc));

console.log("\n================ 結果 ================");
console.log("PASS: " + pass + " / FAIL: " + fail);
if (fail > 0) process.exit(1);
