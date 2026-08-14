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

console.log("\n[22] 施設マスタ取り込み・旧施設名・標準区間距離（7施設42方向）");
const STD = require("../api/_lib/mileage-standard.js");
const libSrcForPlaces = fs.readFileSync(path.join(__dirname, "..", "api", "_lib", "mileage.js"), "utf8");

// ── 標準データそのもの ──
eq("標準区間は42方向", STD.STANDARD_LEGS.length, 42);
eq("標準データの施設は7件", STD.standardFacilities().length, 7);
ok("標準区間に 0km 以下が無い", STD.STANDARD_LEGS.every(function (s) { return s.km > 0; }));
(function () {
  const seen = Object.create(null);
  let dup = 0;
  for (const s of STD.STANDARD_LEGS) { const k = s.from + ">" + s.to; if (seen[k]) dup++; seen[k] = 1; }
  eq("標準区間に同じ方向の重複が無い", dup, 0);
})();
const G42 = Object.create(null);
for (const s of STD.STANDARD_LEGS) G42[s.from + ">" + s.to] = s.km;
(function () {
  const F = STD.standardFacilities(), missing = [];
  for (const a of F) for (const b of F) if (a !== b && G42[a + ">" + b] === undefined) missing.push(a + "→" + b);
  ok("7施設の全方向（7×6＝42）が揃っている", missing.length === 0, missing.join(","));
  ok("自分自身への区間（0km になる組）を持たない",
    !F.some(function (a) { return G42[a + ">" + a] !== undefined; }));
})();

// ── Excel 由来の非対称を維持する（対称へ均さない）──
eq("ハーベスト→ミュゲ貝塚 = 5.3（Excel実測）", G42["ハーベスト>ミュゲ貝塚"], 5.3);
eq("ミュゲ貝塚→ハーベスト = 11.9（逆方向は別の値）", G42["ミュゲ貝塚>ハーベスト"], 11.9);
eq("ハーベスト→ミュゲ春木 = 11.9（Excel実測）", G42["ハーベスト>ミュゲ春木"], 11.9);
eq("ミュゲ春木→ハーベスト = 13.9（逆方向は別の値）", G42["ミュゲ春木>ハーベスト"], 13.9);
ok("非対称な2組を対称へ均していない",
  G42["ハーベスト>ミュゲ貝塚"] !== G42["ミュゲ貝塚>ハーベスト"]
  && G42["ハーベスト>ミュゲ春木"] !== G42["ミュゲ春木>ハーベスト"]);

// ── ハルイロ12方向（ユーザー確認値）──
const HAL = { "ナナイロ": 3.2, "ココラ": 0.8, "ハーベスト": 3.7, "ミュゲ貝塚": 5.7, "ミュゲ春木": 14.0, "ミュゲの泉": 6.7 };
for (const k of Object.keys(HAL)) {
  eq("ハルイロ→" + k + " = " + HAL[k], G42["ハルイロ>" + k], HAL[k]);
  eq(k + "→ハルイロ = " + HAL[k], G42[k + ">ハルイロ"], HAL[k]);
}
ok("ハルイロの往復は A→B と B→A を別レコードで持つ",
  STD.STANDARD_LEGS.filter(function (s) { return s.from === "ハルイロ" || s.to === "ハルイロ"; }).length === 12);

// ── 標準データを登録した世界での実際の集計 ──
function buildStdWorld(exclude) {
  const F = STD.standardFacilities().filter(function (nm) { return nm !== exclude; });
  const places = F.map(function (nm, i) {
    return { id: "p" + (i + 1), name: nm, facility: nm, facilities: [nm], aliases: [], order: i + 1, active: true };
  });
  const byFac = Object.create(null);
  places.forEach(function (p) { byFac[p.facility] = p.id; });
  const legs = Object.create(null);
  for (const s of STD.STANDARD_LEGS) {
    if (!byFac[s.from] || !byFac[s.to]) continue;
    legs[byFac[s.from] + "__" + byFac[s.to]] = s.km;
  }
  return { places: places, legs: legs, byFac: byFac };
}
const W = buildStdWorld("");
const WCTX = { placeByFacility: AU.placeMap(W.places), legs: W.legs };
const dayHal = [
  { id: "r1", type: "clockIn", date: "2026-08-20", timestamp: "2026-08-20T00:00:00.000Z", workFacility: "ナナイロ" },
  { id: "r2", type: "facilityChange", date: "2026-08-20", timestamp: "2026-08-20T02:00:00.000Z", fromFacility: "ナナイロ", workFacility: "ハルイロ" },
  { id: "r3", type: "clockOut", date: "2026-08-20", timestamp: "2026-08-20T08:00:00.000Z" },
];
const rHal = AU.dayRoute(dayHal, WCTX);
eq("応援打刻の経路が 起点→応援先→起点 になる", AU.routeText(rHal.routes), "ナナイロ → ハルイロ → ナナイロ");
eq("ナナイロ → ハルイロ → ナナイロ = 6.4km", rHal.totalKm, 6.4);
eq("42方向が揃っていれば要確認にならない", rHal.status, "auto");

// ★ 片方向だけ登録されている状態を「0km で確定」にしない
(function () {
  const partial = Object.create(null);
  partial[W.byFac["ナナイロ"] + "__" + W.byFac["ハルイロ"]] = 3.2;
  const r = AU.dayRoute(dayHal, { placeByFacility: AU.placeMap(W.places), legs: partial });
  eq("帰りの区間が未登録なら距離未登録にする", r.status, "missing_leg");
  ok("未登録区間を 0km として合計に入れない", r.totalKm === 3.2 && r.missingLegs.length === 1);
})();

// ── 旧施設名（alias）──
(function () {
  const pAlias = [
    { id: "p1", name: "ナナイロ", facility: "ナナイロ", facilities: ["ナナイロ"], active: true },
    { id: "p2", name: "ミュゲ貝塚", facility: "ミュゲ貝塚", facilities: ["ミュゲ貝塚", "貝塚"], aliases: ["貝塚"], active: true },
  ];
  const mapA = AU.placeMap(pAlias);
  eq("現在の施設名が地点へ対応する", mapA["ミュゲ貝塚"], "p2");
  eq("旧施設名も同じ地点へ対応する（過去打刻を拾える）", mapA["貝塚"], "p2");
  // サーバが facilities を組み立てる前の形（facility + aliases）でも動くこと
  eq("facilities が無くても facility+aliases から対応する",
    AU.placeMap([{ id: "p2", name: "ミュゲ貝塚", facility: "ミュゲ貝塚", aliases: ["貝塚"], active: true }])["貝塚"], "p2");
  // 後方互換：aliases を持たない既存データ
  eq("aliases が無い既存データも従来どおり対応する",
    AU.placeMap([{ id: "p1", name: "ナナイロ", facility: "ナナイロ", active: true }])["ナナイロ"], "p1");
  eq("facility 未設定なら地点名一致で対応する（従来どおり）",
    AU.placeMap([{ id: "p1", name: "ナナイロ", facility: "", active: true }])["ナナイロ"], "p1");
  // 同一地点内の重複で「同名の地点が2つ」と誤判定しない
  eq("同じ地点内で名前が重複しても未対応にならない",
    AU.placeMap([{ id: "p1", name: "X", facilities: ["ナナイロ", "ナナイロ"], active: true }])["ナナイロ"], "p1");
  // 別々の地点が同じ施設名 → 推測せず未対応
  ok("2つの地点が同じ施設名なら推測せず未対応にする",
    AU.placeMap([{ id: "p1", name: "A", facilities: ["ナナイロ"], active: true },
                 { id: "p2", name: "B", facilities: ["ナナイロ"], active: true }])["ナナイロ"] === undefined);
  // 改名した施設の過去打刻（旧名）が集計できること
  const pl = [{ id: "p1", name: "ナナイロ", facilities: ["ナナイロ"], active: true },
              { id: "p2", name: "ミュゲ貝塚", facilities: ["ミュゲ貝塚", "貝塚"], active: true }];
  const lg = Object.create(null);
  lg["p1__p2"] = 6.2; lg["p2__p1"] = 6.2;
  const dayOld = [
    { id: "a", type: "clockIn", date: "2026-05-02", timestamp: "2026-05-02T00:00:00.000Z", workFacility: "ナナイロ" },
    { id: "b", type: "facilityChange", date: "2026-05-02", timestamp: "2026-05-02T02:00:00.000Z", fromFacility: "ナナイロ", workFacility: "貝塚" },
  ];
  const rOld = AU.dayRoute(dayOld, { placeByFacility: AU.placeMap(pl), legs: lg });
  eq("旧施設名で記録された過去打刻も距離が出る", rOld.totalKm, 12.4);
})();

// ── 取り込み計画（既存値の保護と冪等性）──
(function () {
  const plan0 = STD.planLegImport(W.places, {});
  eq("何も登録されていなければ42件すべて新規", plan0.counts.new, 42);
  eq("新規以外は0件", plan0.counts.same + plan0.counts.conflict + plan0.counts.no_place, 0);

  const plan1 = STD.planLegImport(W.places, W.legs);
  eq("取り込み後に再実行しても新規は0件（冪等）", plan1.counts.new, 0);
  eq("取り込み後は42件すべて登録済み扱い", plan1.counts.same, 42);

  const legsMod = Object.assign(Object.create(null), W.legs);
  legsMod[W.byFac["ナナイロ"] + "__" + W.byFac["ハルイロ"]] = 9.9;
  const plan2 = STD.planLegImport(W.places, legsMod);
  eq("既存値が違う区間は conflict になる", plan2.counts.conflict, 1);
  eq("conflict があっても new にはしない（自動上書きしない）", plan2.counts.new, 0);
  ok("conflict 行は現在値と標準値の両方を報告する",
    plan2.rows.some(function (r) { return r.status === "conflict" && r.currentKm === 9.9 && r.km === 3.2; }));

  const W2 = buildStdWorld("ハルイロ");
  const plan3 = STD.planLegImport(W2.places, {});
  eq("地点が無い施設の区間は no_place（12方向）", plan3.counts.no_place, 12);
  ok("no_place の施設名を管理者へ報告する", plan3.missingFacilities.indexOf("ハルイロ") >= 0);
  ok("no_place には理由コードが付く", plan3.rows.filter(function (r) { return r.status === "no_place"; })
    .every(function (r) { return r.reason === "missing_place"; }));
  // 2つの施設名が同じ地点に対応している場合（fromId===toId）は missingFacilities に出ないため、
  // 理由コードが無いと「地点が未対応 N件」の数字だけが出て原因が分からなくなる
  (function () {
    const merged = [{ id: "p1", name: "統合", facilities: ["ナナイロ", "ココラ"], active: true }];
    const p = STD.planLegImport(merged, {});
    ok("同じ地点へ2施設名が対応している区間は same_place として理由が出る",
      p.rows.some(function (r) { return r.status === "no_place" && r.reason === "same_place"; }));
  })();
  // ★ 同じ key へ複数の標準区間が落ちる場合は「1件目だけ書く」をしない（定義順で距離が決まってしまう）
  (function () {
    const dup = [
      { id: "p1", name: "起点", facilities: ["ナナイロ"], active: true },
      // ミュゲ貝塚とミュゲ春木を1つの地点へ寄せると、ナナイロ→両者 が同じ key になる
      { id: "p2", name: "統合先", facilities: ["ミュゲ貝塚", "ミュゲ春木"], active: true },
    ];
    const p = STD.planLegImport(dup, {});
    const dupRows = p.rows.filter(function (r) { return r.reason === "dup_key"; });
    ok("key が衝突した区間は1本も書かない（全行 no_place）", dupRows.length >= 2
      && dupRows.every(function (r) { return r.status === "no_place" && r.key === ""; }),
      "dup_key rows=" + dupRows.length);
    const patch = STD.buildLegImportPatch(p, "/mileage/legs", "T", "a");
    ok("衝突した key は patch に1つも入らない",
      !Object.keys(patch).some(function (k) { return k.indexOf("p1__p2") >= 0 || k.indexOf("p2__p1") >= 0; }),
      Object.keys(patch).join(","));
  })();
  ok("no_place の行には書き込み用 key を作らない",
    plan3.rows.filter(function (r) { return r.status === "no_place"; }).every(function (r) { return r.key === ""; }));

  // 手動で作った地点（打刻施設に対応しない本社など）を壊さない
  const withManual = W.places.concat([{ id: "pManual", name: "本社", facility: "", facilities: [], aliases: [], order: 99, active: true }]);
  const plan4 = STD.planLegImport(withManual, W.legs);
  eq("打刻施設に対応しない手動地点があっても標準取り込みは影響を受けない", plan4.counts.same, 42);
  eq("手動地点を巻き込んで新規区間を作らない", plan4.counts.new, 0);
})();

// ── 施設名の「暗黙の対応」を奪えないこと（金額が警告なく変わる経路の封鎖）──
// 明示指定（facility/aliases）は地点名一致より優先される。したがって、地点名だけで暗黙に
// 対応している施設名を、別地点の旧施設名として登録できてしまうと、409 も要確認も出ないまま
// その施設の打刻が別地点の距離で計算される＝支給額が黙って変わる。
eq("明示指定は地点名一致より優先される（だから重複検査が必要）",
  AU.placeMap([{ id: "pA", name: "A", facilities: ["X"], active: true },
               { id: "pB", name: "X", facilities: [], active: true }])["X"], "pA");
ok("duplicate_facility は地点名で暗黙に対応している地点も検査する",
  /fl\.length === 0 && String\(p\.name \|\| ""\)\.trim\(\) === nm/.test(apiSrc));
ok("重複検査は現在名と旧名の両方を対象にする",
  /const mine = \(facility \? \[facility\] : \[\]\)\.concat\(aliases\);/.test(apiSrc));
ok("地点の施設名は trim して保持する（重複検査と placeMap の規則を揃える）",
  /p\.facility\.trim\(\)/.test(libSrcForPlaces));

// ── サーバ実装が「書かない」ことを固定する ──
// ★ 文字列一致では守れない。ガード行を残したまま別ループを足すだけで既存値を上書きでき、
//   実際にその変異はテストを素通りした。書き込む patch そのものを検査する。
(function () {
  const rows = [
    { status: "new", key: "a__b", km: 1.1 },
    { status: "same", key: "c__d", km: 2.2 },
    { status: "conflict", key: "e__f", km: 3.3 },
    { status: "no_place", key: "", km: 4.4 },
    { status: "new", key: "g__h", km: 5.5 },
  ];
  const patch = STD.buildLegImportPatch({ rows: rows }, "/mileage/legs", "T", "admin");
  const keys = Object.keys(patch).sort();
  eq("書き込む patch は new の区間だけ", JSON.stringify(keys),
    JSON.stringify(["/mileage/legs/a__b", "/mileage/legs/g__h"]));
  ok("same の区間を patch に含めない", keys.indexOf("/mileage/legs/c__d") < 0);
  ok("conflict の区間を patch に含めない（既存値を巻き戻さない）", keys.indexOf("/mileage/legs/e__f") < 0);
  ok("no_place の区間を patch に含めない", !keys.some(function (k) { return k.indexOf("__") < 0; }));
  eq("patch の中身は km と更新者", JSON.stringify(patch["/mileage/legs/a__b"]),
    JSON.stringify({ km: 1.1, updatedAt: "T", updatedBy: "admin" }));
  eq("書き込む区間が無ければ patch は空", Object.keys(STD.buildLegImportPatch({ rows: [rows[1], rows[2]] }, "/x", "T", "a")).length, 0);
  // 42方向すべて新規の計画からは、ちょうど42キーが出ること
  eq("全件新規なら patch は42キー",
    Object.keys(STD.buildLegImportPatch(STD.planLegImport(W.places, {}), "/mileage/legs", "T", "a")).length, 42);
  // 取り込み済みの状態からは1キーも出ないこと（冪等）
  eq("取り込み済みなら patch は0キー（冪等）",
    Object.keys(STD.buildLegImportPatch(STD.planLegImport(W.places, W.legs), "/mileage/legs", "T", "a")).length, 0);
})();
ok("ハンドラは patch 生成を純粋関数へ委ね、独自の書き込みループを持たない",
  /STD\.buildLegImportPatch\(plan, ROOT \+ "\/legs"/.test(apiSrc)
  && !/patch\[ROOT \+ "\/legs\/" \+ r\.key\]/.test(apiSrc));
ok("importLegs は apply=false のとき一切書き込まない",
  /if \(!apply\) \{[\s\S]{0,240}applied: false/.test(apiSrc));
ok("importLegs は管理者のみ", /importLegs: \["a"\]/.test(apiSrc));
ok("importLegs は書込系として回数制限の対象", /saveLeg: 1, deleteLeg: 1, importLegs: 1/.test(apiSrc));
ok("サーバは施設マスタ（/honomi/master/locations）を読まない", !/master\/locations/.test(apiSrc));

// ── 管理画面の導線 ──
ok("「施設マスタから取り込む」がある",
  /施設マスタから取り込む/.test(html) && /function mileageImportFacilities\(/.test(html));
ok("取り込み対象は未対応の施設だけ（同じ施設を二重に作らない）",
  /function mileageFacilityLinkState\(/.test(html) && /unlinked:unlinked,conflict:conflict/.test(html));
ok("取り込み判定は集計と同じ mileageAutoFacilitiesOf を使う",
  /function mileageFacilityLinkState\(\)\{[\s\S]{0,900}mileageAutoFacilitiesOf/.test(html));
ok("複数地点が同じ施設名を持つ場合は「取り込み済み」と扱わず競合として出す（行き止まりを作らない）",
  /ids\.length!==1\)conflict\.push/.test(html) && /集計で未対応/.test(html));
ok("施設マスタ未取得を「未登録なし」と断定しない",
  /if\(!facilitiesLoaded\)\{showAlert/.test(html) && /施設マスタ未取得/.test(html));
ok("取り込み件数に上限があり、429 で中断する",
  /MILEAGE_IMPORT_MAX/.test(html) && /res\.status===429/.test(html));
ok("取り込みの details は開閉状態を保持する（押した瞬間に閉じない）",
  /mileage\.importOpen\?' open':''/.test(html) && /ontoggle="mileageSetImportOpen/.test(html));
ok("セッションリセットで取り込み状態も捨てる（確認中で固着しない）",
  /mileage\.importPlan=null;mileage\.importLoading=false;mileage\.importOpen=false;/.test(html));
ok("地点・区間を変更したら取り込み差分を捨てる（古い警告を残さない）",
  /action==="savePlace"\|\|action==="deletePlace"\|\|action==="saveLeg"\|\|action==="deleteLeg"\)mileage\.importPlan=null/.test(html));
ok("旧施設名の入力中がポーリング再描画で消えない",
  /"mlg-place-facility","mlg-place-aliases"/.test(html));
ok("単価が未設定のときは入力欄に既定値を描画しない（設定済みに見せない）",
  /st2\.configured\?esc\(st2\.ratePerKm\):""/.test(html));
ok("no_place の理由を画面に出す", /MILEAGE_IMPORT_REASON/.test(html) && /same_place/.test(html));
ok("旧施設名だけの保存を拒否する（地点名フォールバックが黙って外れるため）",
  /alias_without_facility/.test(apiSrc) && /alias_without_facility/.test(html));
ok("重複検査は非アクティブな地点を対象外にする（placeMap と規則を揃える）",
  /if \(p\.active === false\) return false;/.test(apiSrc));
ok("duplicate_facility はどの施設名が衝突したかを返し、暗黙一致を書き分ける",
  /implicit: \(fdup\.facilities \|\| \[\]\)\.length === 0/.test(apiSrc) && /_d\.implicit/.test(html));
ok("地点一覧の「打刻の施設」表示は判定と同じ根拠から出す",
  /\+\(mileageAutoFacilitiesOf\(p\)\.length[\s\S]{0,700}地点名が一致/.test(html));
// ★ 対応表だけで判定すると、打刻施設でない地点名（本社など）にも「（地点名が一致）」が出る。
//   施設マスタに実在する名前であることを必ず併せて確認する。
ok("「地点名が一致」は施設マスタに実在する名前かつ対応表がこの地点を指すときだけ",
  /masterLocs\.indexOf\(p\.name\)>=0\s*\n?\s*\?\(mileageAutoHas\(pmapNow,p\.name\)&&pmapNow\[p\.name\]===p\.id/.test(html));
ok("他地点が同名を握っている地点は「対応なし」と出す（対応済みと嘘をつかない）",
  /対応なし（同じ名前を他の地点が使っています）/.test(html));
ok("summary に display:block を付けない（開閉マーカーが消えるため）",
  !/<summary style="[^"]*display:block/.test(html));
ok("取り込み完了の通知は再確認より先に出す（エラーを上書きしない）",
  /showAlert\("標準区間距離を取り込みました。"\);\s*\n\s*await mileageImportLegsCheck\(\);/.test(html));
// テストの WRITE_ACTIONS 一覧がサーバと同期していること（次に書込 action を足したとき静かに漏れない）
(function () {
  const m = apiSrc.match(/const WRITE_ACTIONS = \{([\s\S]*?)\};/);
  const server = m ? (m[1].match(/(\w+)\s*:/g) || []).map(function (s) { return s.replace(":", "").trim(); }).sort() : [];
  ok("サーバの WRITE_ACTIONS に importLegs が含まれる", server.indexOf("importLegs") >= 0);
  // ★ ACTIONS は上で vm 評価済みのオブジェクトを使う。正規表現で再パースすると、
  //   インデントや配列の折り返しを変えただけで偽 FAIL になる。
  ok("書込系 action に労務士(v)が1つも含まれない（サーバ定義から機械的に検査）",
    server.length > 0 && server.every(function (a) {
      return Array.isArray(ACTIONS[a]) && ACTIONS[a].indexOf("v") < 0;
    }), "server=" + server.join(","));
})();
ok("手動での地点追加を残している", /mileageSavePlaceFromForm\(\)/.test(html));
ok("「標準区間距離を取り込む」がある", /標準区間距離を取り込む/.test(html));
ok("取り込み前に差分を確認させる（いきなり書かない）",
  /function mileageImportLegsCheck\(/.test(html) && /"importLegs",\{apply:false\}/.test(html));
ok("旧施設名を編集時に読み込む（保存で黙って消えない）",
  /mlg-place-aliases[\s\S]{0,400}p\.aliases/.test(html));
ok("旧施設名を保存時に送る", /aliases:aliases/.test(html));
ok("単価未設定のときは標準値を提案するだけで自動保存しない",
  /function mileageFillStandardSettings\(/.test(html) && /内容を確認して「保存」を押してください/.test(html));

console.log("\n[23] 労務士・閲覧用（未確定月を「取得失敗」にしない）");
// 関数を1本だけ切り出して評価する（ネットワーク・環境変数に触らない）。
function extractFn(src, sig) {
  const s = src.indexOf(sig);
  if (s < 0) return "";
  let depth = 0, started = false;
  for (let j = src.indexOf("{", s); j < src.length; j++) {
    const c = src[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) return src.slice(s, j + 1); }
  }
  return "";
}
const reportSrc = extractFn(apiSrc, "async function handleMonthlyReport(body) {");
let reportTests = Promise.resolve();
if (!reportSrc) {
  fail++;
  console.log("  FAIL  api/mileage.js から handleMonthlyReport を抽出できませんでした");
} else {
  const runReport = function (store, body) {
    const calls = [];
    const ctx = {
      M: M, ROOT: "mileage", console: console,
      G: { dbGet: async function (p) { calls.push(p); return Object.prototype.hasOwnProperty.call(store, p) ? store[p] : null; } },
      H: { str: function (v, n) { return typeof v === "string" ? v.slice(0, n) : ""; } },
      reqPath: function (ym) { return "mileage/requests/" + ym; },
      listRequests: function () { return []; },
    };
    vm.createContext(ctx);
    vm.runInContext(reportSrc, ctx);
    return ctx.handleMonthlyReport(body).then(function (r) { return { r: r, calls: calls }; });
  };
  const closedStore = {
    "mileage/closings": {
      "2026-07": { closedAt: "2026-08-01T02:00:00.000Z", closedBy: "admin:0123456789abcdef", ratePerKm: 16, roundMode: "none", staffCount: 1, source: "auto" },
    },
    "mileage/monthly": {
      "100022": {
        "2026-07": {
          employeeId: "100022", staffName: "テスト職員", totalKm: 6.4, ratePerKm: 16,
          roundMode: "none", amount: 102.4, dayCount: 1,
          days: [{ date: "2026-07-10", km: 6.4, source: "auto", sig: "ナナイロ>ハルイロ>ナナイロ", route: "ナナイロ → ハルイロ → ナナイロ" }],
        },
      },
    },
  };
  // 未確定月（本番の 2026-08 と同じ状態）
  reportTests = runReport(closedStore, { ym: "2026-08", withDetail: true }).then(function (o) {
    eq("未確定月でも HTTP 200", o.r.status, 200);
    eq("未確定月でも ok:true（エラーにしない）", o.r.ok, true);
    eq("未確定月は closed:false", o.r.closed, false);
    ok("未確定月は error を返さない", o.r.error === undefined, JSON.stringify(o.r.error));
    ok("未確定月の rows は空（未確定の数値を出さない）", Array.isArray(o.r.rows) && o.r.rows.length === 0);
    ok("未確定月でも確定済み月の一覧は返す", Array.isArray(o.r.closedMonths) && o.r.closedMonths.indexOf("2026-07") >= 0);
    ok("未確定月は日別明細を返さない（ダウンロード対象にしない）", o.r.detail === undefined);
  // 対象月なし（一覧取得だけ）
  }).then(function () { return runReport(closedStore, { ym: "" }); }).then(function (o) {
    eq("対象月なしでも 200 / ok", String(o.r.status) + ":" + String(o.r.ok), "200:true");
    ok("対象月なしでは /mileage/monthly を読まない（無駄な取得をしない）", o.calls.indexOf("mileage/monthly") < 0, o.calls.join(","));
  // 確定済み月
  }).then(function () { return runReport(closedStore, { ym: "2026-07", withDetail: true }); }).then(function (o) {
    eq("確定済み月は closed:true", o.r.closed, true);
    eq("確定済み月の行数", o.r.rows.length, 1);
    eq("確定済みスナップショットの金額をそのまま返す", o.r.rows[0].amount, 102.4);
    eq("日別明細は確定済みスナップショットから作る", o.r.detail.length, 1);
    eq("日別明細の経路", o.r.detail[0].route, "ナナイロ → ハルイロ → ナナイロ");
    ok("closing に closedBy（監査用 actor）を含めない", o.r.closing.closedBy === undefined);
  // 形式不正
  }).then(function () { return runReport(closedStore, { ym: "2026-13" }); }).then(function (o) {
    eq("年月の形式が不正なら 400 bad_ym", String(o.r.status) + ":" + String(o.r.error), "400:bad_ym");
  }).catch(function (e) {
    fail++;
    console.log("  FAIL  handleMonthlyReport の評価に失敗しました → " + (e && e.message));
  });
}
// 権限（緩めていないこと）
ok("monthlyReport は管理者(a)と労務士(v)だけ", ACTIONS.monthlyReport.slice().sort().join(",") === "a,v",
  JSON.stringify(ACTIONS.monthlyReport));
ok("monthlyReport に職員(s)を含めない", ACTIONS.monthlyReport.indexOf("s") < 0);
["d", "x", ""].forEach(function (r) {
  ok("デモ/サンドボックス/匿名 role \"" + r + "\" はどの action にも含まれない",
    Object.keys(ACTIONS).every(function (a) { return ACTIONS[a].indexOf(r) < 0; }));
});
ok("未認証・役割不一致はハンドラ入口で 403（フェイルクローズ）",
  /if \(!ident \|\| allowed\.indexOf\(ident\.role\) < 0\)/.test(apiSrc) && /H\.fail\(res, 403, "forbidden"\)/.test(apiSrc));
ok("労務士セッションは action ごとに有効性を引き直す",
  /ident\.role === "v" && !\(await M\.isValidViewer\(ident\)\)/.test(apiSrc));

// クライアント: 役割トークン（r:"v"）の確立を待ってから /api/mileage を呼ぶ
ok("elevateShareSession が昇格 Promise を公開する", /_shareElevatePromise=\(async function\(\)\{/.test(html));
const bootViewerSrc = extractFn(html, "function mileageBootForViewer(){");
ok("mileageBootForViewer が共有URLの役割確立を待つ（匿名トークンで叩かない）",
  /_shareElevatePromise/.test(bootViewerSrc), bootViewerSrc.slice(0, 200));
ok("再試行では役割トークンから取り直す",
  /function mileageViewerRetry\(\)/.test(html) && /_authRole!=="v"&&viewerParam/.test(html));

// クライアント: 「未確定」と「取得失敗」を混同しない
const viewCardSrc = extractFn(html, "function mileageViewerCardHtml(){");
ok("閲覧用カードに未確定の表示がある", /の移動距離は未確定です/.test(viewCardSrc));
ok("閲覧用カードに取得失敗の表示が別にある", /データを取得できませんでした。/.test(viewCardSrc));
(function () {
  const s = viewCardSrc.indexOf("if(mileage.viewData.closed!==true){");
  const dl = viewCardSrc.indexOf("mileageDownloadCsv()");
  ok("未確定の分岐はダウンロードボタンより前で return する（未確定月はダウンロードさせない）",
    s > 0 && dl > s, "closed分岐=" + s + " download=" + dl);
  const branch = s > 0 ? extractFn(viewCardSrc.slice(s), "if(mileage.viewData.closed!==true){") : "";
  ok("未確定の分岐にダウンロードボタンを置かない", branch.length > 0 && branch.indexOf("mileageDownload") < 0);
})();
ok("ダウンロードは確定済み（closed）のみ",
  (html.match(/if\(!d\|\|!d\.closed/g) || []).length === 2);
ok("closed:false の応答を取得失敗として扱わない（viewData へ入れる）",
  /if\(res\.ok&&res\.data\)\{\s*mileage\.viewData=res\.data;/.test(html));
ok("未確定の月も対象月として選べる（当月を候補へ入れる）",
  /if\(months\.indexOf\(curYm\)<0\)months\.push\(curYm\);/.test(html));

// ★ [23] の一部は非同期（handleMonthlyReport は async）。集計はその完了後に行う。
reportTests.then(function () {
  console.log("\n================ 結果 ================");
  console.log("PASS: " + pass + " / FAIL: " + fail);
  if (fail > 0) process.exit(1);
});
