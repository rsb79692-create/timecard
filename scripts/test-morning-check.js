/**
 * test-morning-check.js — 朝出勤未確認 LINE通知「施設別の判定時刻」の回帰テスト
 *
 * 依存パッケージなし・送信なし・本番データ非アクセス。
 * scripts/morning-check.js の MORNING-CHECK-HOURS-BEGIN/END ブロックを抽出して検証する。
 *
 * 実行: node scripts/test-morning-check.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC_PATH = path.join(ROOT, "scripts", "morning-check.js");
const WF_PATH = path.join(ROOT, ".github", "workflows", "morning-check.yml");

const SRC = fs.readFileSync(SRC_PATH, "utf8");
const WF = fs.readFileSync(WF_PATH, "utf8");

// ===== 判定ブロックの抽出 =====
function extractBlock(src, beginMarker, endMarker) {
  const b = src.indexOf(beginMarker);
  const e = src.indexOf(endMarker);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`ブロックを抽出できません: ${beginMarker} … ${endMarker}`);
  }
  return src.slice(b + beginMarker.length, e);
}

// 改行コードを LF へ揃える（ソースは CRLF。差し替えによる検証で行末の差に引っかからないため）
const BLOCK = extractBlock(SRC, "// MORNING-CHECK-HOURS-BEGIN", "// MORNING-CHECK-HOURS-END")
  .split(String.fromCharCode(13) + String.fromCharCode(10))
  .join(String.fromCharCode(10));

// 二重通知防止ブロック（判定ブロックの関数を使うので、判定ブロックの後ろへ連結して読み込む）
const DEDUPE_BLOCK = extractBlock(SRC, "// MORNING-CHECK-DEDUPE-BEGIN", "// MORNING-CHECK-DEDUPE-END")
  .split(String.fromCharCode(13) + String.fromCharCode(10))
  .join(String.fromCharCode(10));

const mod = {};
// 判定ブロックは設定不正のときに console.error + process.exit(1) する。
// vm 側にも同名を用意して、その分岐を検証できるようにする。
function makeContext(target) {
  const c = {
    out: target,
    crypto: require("crypto"),
    URL,
    console: { log() {}, warn() {}, error() {} },
    process: { exit(code) { const e = new Error("__vm_exit__"); e.exitCode = code; throw e; } },
  };
  vm.createContext(c);
  return c;
}
const ctx = makeContext(mod);
vm.runInContext(
  BLOCK + "\n" + DEDUPE_BLOCK +
    "\nout.D = { DEDUPE_ROOT, DEDUPE_ANOMALY_SLOT, DEDUPE_LEASE_MS, DEDUPE_WAIT_MS, DEDUPE_MAX_ATTEMPTS," +
    " DEDUPE_RETRY_KEY_TTL_MS, LINE_SEND_TRIES, LINE_RETRY_DELAYS_MS, MAX_MESSAGE_LEN, dedupeBaseUrl, dedupeSlotKey, dedupePath," +
    " HTTP_TIMEOUT_MS, DEDUPE_CAS_TRIES, DEDUPE_IO_TRIES, DEDUPE_IO_RETRY_MS, DEDUPE_POLL_MS," +
    " classifyLineResult, planDedupe, finalizeDedupe, sendBatchWithRetry, buildMorningMessage," +
    " makeRtdbDedupeStore, makeLineSendOnce, notifyOnce, dedupeSelfTest };" +
    "\nout.DEFAULT_FACILITIES = DEFAULT_FACILITIES;" +
    "\nout.NOTIFY_EXCLUDE = NOTIFY_EXCLUDE;" +
    "\nout.expectedFacilityCountForHour = expectedFacilityCountForHour;" +
    "\nout.findMonitoringAnomalies = findMonitoringAnomalies;" +
    "\nout.DEFAULT_CHECK_HOUR = DEFAULT_CHECK_HOUR;" +
    "\nout.CHECK_HOURS = CHECK_HOURS;" +
    "\nout.LATE_CHECK_FACILITIES = LATE_CHECK_FACILITIES;" +
    "\nout.MAX_FACILITIES = MAX_FACILITIES;" +
    "\nout.MAX_FACILITY_NAME_LEN = MAX_FACILITY_NAME_LEN;" +
    "\nout.normalizeFacility = normalizeFacility;" +
    "\nout.facilityEntryName = facilityEntryName;" +
    "\nout.safeFacilityLabel = safeFacilityLabel;" +
    "\nout.isValidCheckHour = isValidCheckHour;" +
    "\nout.resolveCheckHour = resolveCheckHour;" +
    "\nout.selectFacilitiesForHour = selectFacilitiesForHour;" +
    "\nout.findMissingLateFacilities = findMissingLateFacilities;",
  ctx
);

const {
  DEFAULT_CHECK_HOUR,
  CHECK_HOURS,
  MAX_FACILITIES,
  MAX_FACILITY_NAME_LEN,
  facilityEntryName,
  safeFacilityLabel,
  resolveCheckHour,
  selectFacilitiesForHour,
  findMissingLateFacilities,
} = mod;

// ===== テストランナー =====
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function section(t) {
  console.log(`\n[${t}]`);
}

// 本番の施設マスタ（master/locations）と同じ形。token は検証に無関係なのでダミー。
const MASTER = [
  { name: "ナナイロ", token: "t1" },
  { name: "ココラ", token: "t2" },
  { name: "ハーベスト", token: "t3" },
  { name: "ミュゲ貝塚", token: "t4" },
  { name: "ミュゲ春木", token: "t5" },
  { name: "ミュゲの泉", token: "t6" },
  { name: "ハルイロ", token: "t7" },
];
const namesOf = (entries) => entries.map(facilityEntryName);

// ===== 1. 既定の判定時刻 =====
section("既定の判定時刻");
eq("既定は6時", DEFAULT_CHECK_HOUR, 6);
check("判定時刻の候補は 6 と 7 だけ", JSON.stringify(CHECK_HOURS) === JSON.stringify([6, 7]),
  `CHECK_HOURS=${JSON.stringify(CHECK_HOURS)}`);

// ===== 2. 施設別の判定時刻（必須確認 1〜3） =====
section("施設別の判定時刻");
eq("ハルイロ は7時", resolveCheckHour({ name: "ハルイロ", token: "t7" }), 7);
eq("ミュゲの泉 は7時", resolveCheckHour({ name: "ミュゲの泉", token: "t6" }), 7);
["ナナイロ", "ココラ", "ハーベスト", "ミュゲ貝塚", "ミュゲ春木"].forEach((n) => {
  eq(`${n} は従来どおり6時`, resolveCheckHour({ name: n, token: "x" }), 6);
});

const at6 = namesOf(selectFacilitiesForHour(MASTER, 6));
const at7 = namesOf(selectFacilitiesForHour(MASTER, 7));
check("6時の回に ハルイロ を含まない", !at6.includes("ハルイロ"), `at6=${at6.join(",")}`);
check("6時の回に ミュゲの泉 を含まない", !at6.includes("ミュゲの泉"), `at6=${at6.join(",")}`);
check("7時の回は ハルイロ / ミュゲの泉 だけ",
  at7.length === 2 && at7.includes("ハルイロ") && at7.includes("ミュゲの泉"), `at7=${at7.join(",")}`);
check("6時の回はその他5施設", at6.length === 5, `at6=${at6.join(",")}`);

// ===== 3. 二重通知しないこと（必須確認 4） =====
section("二重通知の不在");
const dup = at6.filter((n) => at7.includes(n));
check("6時と7時の対象施設が重複しない", dup.length === 0, `重複=${dup.join(",")}`);
check("全施設がどちらか一方に必ず属する", at6.length + at7.length === MASTER.length,
  `6時=${at6.length} 7時=${at7.length} マスタ=${MASTER.length}`);
CHECK_HOURS.forEach((h) => {
  const sel = namesOf(selectFacilitiesForHour(MASTER, h));
  const others = CHECK_HOURS.filter((x) => x !== h)
    .flatMap((x) => namesOf(selectFacilitiesForHour(MASTER, x)));
  check(`${h}時の対象が他の時刻と交差しない`, sel.every((n) => !others.includes(n)));
});
check("判定時刻でない時刻には1件も入らない",
  [0, 5, 8, 12, 23].every((h) => selectFacilitiesForHour(MASTER, h).length === 0));

// ===== 4. 判定時刻の正本はコード側であること（誰でも書ける施設マスタに従わない） =====
// master/locations は /honomi の .write を継承し、一般スタッフ（auth.token.r === 's'）でも書ける。
// そこへ判定時刻を置くと、回ごとに書き換えて当日の通知を丸ごと消せてしまう。
section("施設マスタの値で判定時刻を動かせないこと");
[
  { morningCheckHour: 7 },
  { morningCheckHour: "7" },
  { morningCheckHour: 6 },
  { morningCheckHour: 23 },
  { checkHour: 7 },
  { notifyHour: 7 },
  { hour: 7 },
].forEach((extra) => {
  eq(`ナナイロ + ${JSON.stringify(extra)} は6時のまま`,
    resolveCheckHour(Object.assign({ name: "ナナイロ", token: "t1" }, extra)), 6);
  eq(`ハルイロ + ${JSON.stringify(extra)} は7時のまま`,
    resolveCheckHour(Object.assign({ name: "ハルイロ", token: "t7" }, extra)), 7);
});
check("施設マスタ由来のフィールドを判定に使っていない",
  !/morningCheckHour|notifyHour|checkHour/.test(BLOCK),
  "MORNING-CHECK-HOURS ブロックにマスタ由来の判定時刻フィールドが残っている");
{
  // 全施設に細工をしても、6時と7時の分割は変わらない
  const tampered = MASTER.map((f) => Object.assign({}, f, { morningCheckHour: 7 }));
  eq("全施設へ morningCheckHour=7 を書かれても6時の対象は減らない",
    selectFacilitiesForHour(tampered, 6).length, 5);
  eq("全施設へ morningCheckHour=7 を書かれても7時の対象は増えない",
    selectFacilitiesForHour(tampered, 7).length, 2);
}

// ===== 5. 施設名の表記ゆれ・エントリ形式・重複 =====
section("施設名の正規化とエントリ形式");
eq("前後の空白を含む名前でも7時", resolveCheckHour({ name: " ハルイロ ", token: "t7" }), 7);
eq("全角空白を含む名前でも7時", resolveCheckHour({ name: "ハル　イロ", token: "t7" }), 7);
eq("文字列エントリ（DEFAULT_FACILITIES 相当）でも7時", resolveCheckHour("ミュゲの泉"), 7);
eq("文字列エントリのその他施設は6時", resolveCheckHour("ナナイロ"), 6);
eq("文字列エントリから施設名を取れる", facilityEntryName("ナナイロ"), "ナナイロ");
eq("オブジェクトエントリから施設名を取れる", facilityEntryName({ name: "ナナイロ" }), "ナナイロ");
[null, undefined, {}, { name: "" }, { name: 7 }, 123, ""].forEach((v) => {
  eq(`施設名を取れないエントリ ${JSON.stringify(v)} は空文字`, facilityEntryName(v), "");
});
check("施設名を取れないエントリは対象へ入らない",
  selectFacilitiesForHour([null, {}, { name: "" }, { name: "ナナイロ" }], 6).length === 1);

section("正規化後に同名となる重複エントリ");
{
  const dupMaster = [
    { name: "ハルイロ", token: "a" },
    { name: "ハル イロ", token: "b" },
    { name: "ハルイロ", token: "c" },
  ];
  eq("表記ゆれ重複は7時の対象へ1件だけ入る", selectFacilitiesForHour(dupMaster, 7).length, 1);
  eq("表記ゆれ重複は6時の対象へ入らない", selectFacilitiesForHour(dupMaster, 6).length, 0);
  const dupOther = [{ name: "ナナイロ" }, { name: "ナナ イロ" }, { name: "ナナイロ" }];
  eq("その他施設の重複も1件へ寄せる", selectFacilitiesForHour(dupOther, 6).length, 1);
}

section("プロトタイプ継承プロパティを判定に使わないこと");
["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].forEach((n) => {
  eq(`施設名 "${n}" は既定の6時`, resolveCheckHour({ name: n, token: "x" }), 6);
});
check("施設名 \"constructor\" は7時の対象へ入らない",
  selectFacilitiesForHour([{ name: "constructor" }], 7).length === 0);

// ===== 6. LINE 本文・ログ用の施設名サニタイズ =====
// 施設名は一般スタッフでも書き換えられ、そのまま LINE 通知の本文へ入る。
section("施設名のサニタイズ（LINE 本文への注入対策）");
const BSr = String.fromCharCode(92) + "r";
const BSn = String.fromCharCode(92) + "n";
const BSu = String.fromCharCode(92) + "u";
const LF  = String.fromCharCode(10);
const LS  = String.fromCharCode(0x2028);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
check("改行を落とす",
  !new RegExp("["+BSr+BSn+"]").test(safeFacilityLabel("ハルイロ" + LF + "【穂乃味】至急ここを開いてください https://example.com")),
  "改行が残っている");
check("行区切り文字(U+2028 / U+2029)を落とす",
  !new RegExp("["+BSu+"2028"+BSu+"2029]").test(safeFacilityLabel("ハルイロ" + LS + "偽メッセージ")));
check("制御文字を落とす",
  !new RegExp("["+BSu+"0000-"+BSu+"001f"+BSu+"007f]").test(safeFacilityLabel("ハルイロ" + BEL + ESC + DEL)));
check(`長い施設名を ${MAX_FACILITY_NAME_LEN} 文字＋省略記号まで詰める`,
  safeFacilityLabel("あ".repeat(500)).length === MAX_FACILITY_NAME_LEN + 1);
eq("通常の施設名はそのまま", safeFacilityLabel("ハルイロ"), "ハルイロ");
[null, undefined, 0, {}].forEach((v) => {
  check(`${JSON.stringify(v)} でも例外にならず文字列を返す`, typeof safeFacilityLabel(v) === "string");
});
check("施設マスタの件数上限が定義されている",
  Number.isInteger(MAX_FACILITIES) && MAX_FACILITIES > 0 && MAX_FACILITIES <= 200,
  `MAX_FACILITIES=${MAX_FACILITIES}`);
check("双方向制御文字（RLO 等）を落とす",
  !new RegExp("[" + BSu + "202a-" + BSu + "202e" + BSu + "2066-" + BSu + "2069]")
    .test(safeFacilityLabel("ハルイロ" + String.fromCharCode(0x202e) + "偽装")));
check("ゼロ幅文字を落とす",
  !new RegExp("[" + BSu + "200b-" + BSu + "200f" + BSu + "feff]")
    .test(safeFacilityLabel("ハル" + String.fromCharCode(0x200b) + "イロ")));
check("URL スキームを無害化する",
  !/https:\/\//.test(safeFacilityLabel("https://evil.example/pay")),
  safeFacilityLabel("https://evil.example/pay"));
check("切り詰めでサロゲートペアを割らない",
  !/[\uD800-\uDFFF]/.test(
    safeFacilityLabel("😀".repeat(MAX_FACILITY_NAME_LEN + 5)).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
  ),
  "孤立サロゲートが残っている");
eq("コードポイント単位で切り詰める",
  Array.from(safeFacilityLabel("😀".repeat(MAX_FACILITY_NAME_LEN + 5))).length,
  MAX_FACILITY_NAME_LEN + 1);

section("LATE_CHECK_FACILITIES のキー正規化");
check("判定側と検知側が同じ正規化を使う（未正規化キーでも齟齬が出ない）",
  /LATE_CHECK_BY_NORM/.test(BLOCK) &&
  /normalizeFacility\(k\)/.test(BLOCK),
  "resolveCheckHour と findMissingLateFacilities で正規化がずれている");
check("LATE_CHECK_FACILITIES のキーは正規化済みで書かれている",
  Object.keys(mod.LATE_CHECK_FACILITIES).every((k) => mod.normalizeFacility(k) === k),
  Object.keys(mod.LATE_CHECK_FACILITIES).join(" / "));
check("コード側の期待件数から判定時刻ごとの施設数を導ける",
  /expectedFacilityCountForHour/.test(BLOCK));

// ===== 7. 改名・表記ゆれの検出 =====
section("判定時刻の指定が施設マスタと食い違ったときの検出");
check("正しいマスタでは検出0件", findMissingLateFacilities(MASTER).length === 0,
  `missing=${findMissingLateFacilities(MASTER).join(",")}`);
const renamed = MASTER.filter((f) => f.name !== "ハルイロ").concat([{ name: "はるいろ", token: "t7" }]);
check("ハルイロ が改名されていたら検出する",
  findMissingLateFacilities(renamed).includes("ハルイロ"),
  `missing=${findMissingLateFacilities(renamed).join(",")}`);
check("改名された施設は7時側へ入らない",
  !namesOf(selectFacilitiesForHour(renamed, 7)).includes("はるいろ"));
check("文字列配列のマスタでも検出0件", findMissingLateFacilities(MASTER.map((f) => f.name)).length === 0);

// ===== 8. morning-check.js の結線 =====
section("morning-check.js の結線");
check("CHECK_HOUR を環境変数から受け取る", /process\.env\.CHECK_HOUR/.test(SRC));
check("この回の対象を selectFacilitiesForHour で絞る",
  /selectFacilitiesForHour\(facilityEntries,\s*CHECK_HOUR\)/.test(SRC));
check("無効な CHECK_HOUR では既定へ倒さず終了する",
  /is[Vv]alidCheckHour\(n\)\)\s*return n;[\s\S]{0,600}?process\.exit\(1\)/.test(SRC));
check("対象0件なら未打刻通知は送らず終了する",
  /facilities\.length === 0[\s\S]{0,300}?未打刻通知はスキップ[\s\S]{0,400}?return;/.test(SRC));
// ⚠ 監視が黙って落ちないこと。施設マスタから施設名を消す／改名するだけで
//   「対象0件 → 静かに正常終了」になると、その日の通知が消えたことを誰も知れない。
check("監視が成立していないときはログではなく LINE で知らせる",
  /findMonitoringAnomalies\(/.test(SRC) && /anomalySection/.test(SRC) &&
  /if \(anomalySection\) candidates\.push\(\{ slot: DEDUPE_ANOMALY_SLOT, kind: "anomaly" \}\)/.test(SRC) &&
  /return head \+ \(p\.anomalySection \|\| ""\) \+ section;/.test(SRC));
check("対象0件でも設定異常があれば LINE を送る",
  /facilities\.length === 0[\s\S]{0,300}?if \(anomalySection\)[\s\S]{0,120}?await deliver\(\[\]\)/.test(SRC));
check("未打刻0件でも設定異常があれば通知を止めない",
  /unconfirmed\.length === 0 && !anomalySection/.test(SRC));
// ⚠ LINE は1回の実行で最大1通。別送にすると送信失敗が未打刻通知を道連れにし、
//   異常が続くあいだ通数が倍になって本来の警告が埋もれる。
{
  const sends = (SRC.match(/await sendLineMessage\(/g) || []).length;
  // TEST_NOTIFY のテスト送信 1 箇所 + dryRun の本文表示 2 箇所（記録なし / 記録あり）= 3 箇所まで。
  // 判定経路の実送信は deliver → notifyOnce を通る（下の check で固定）。
  check("LINE 送信の呼び出しを増やしていない（設定異常は別送にしない）", sends <= 3, `sends=${sends}`);
  check("設定異常だけの専用メッセージを作っていない", !/朝出勤未確認の設定異常/.test(SRC));
}
check("施設マスタを採用できなかった理由を設定異常へ載せる",
  /fallbackReason/.test(SRC) &&
  /findMonitoringAnomalies\(facilityEntries, CHECK_HOUR, facilities\.length, fallbackReason\)/.test(SRC));
check("施設マスタが件数上限を超えたら採用せず DEFAULT_FACILITIES へ倒す",
  /entries\.length > MAX_FACILITIES[\s\S]{0,400}?entries\.length = 0;/.test(SRC));
check("master/locations が想定外の型なら警告を残す",
  /master\/locations が想定外の型です/.test(SRC));
check("GitHub Actions 上で CHECK_HOUR が空なら実行しない",
  /GITHUB_ACTIONS === "true"[\s\S]{0,300}?process\.exit\(1\)/.test(SRC));
check("打刻があった施設は未打刻に入れない（count === 0 のときだけ）",
  /if \(count === 0\) \{ unconfirmed\.push\(name\); \}/.test(SRC));
check("未打刻0件なら送信しない（従来どおり）",
  /unconfirmed\.length === 0[\s\S]{0,120}?LINE通知スキップ[\s\S]{0,80}?return;/.test(SRC));
check("当日の clockIn・削除済み除外の判定を変えていない",
  /r\.type === "clockIn" && r\.date === today && !r\.deleted/.test(SRC));
check("施設マスタは RTDB の master/locations から取る",
  /fetchRTDB\("master\/locations", idToken\)/.test(SRC));
check("朝通知の除外施設（ハーベスト）を維持している",
  /const NOTIFY_EXCLUDE = \["ハーベスト"\];/.test(SRC));
check("LINE 送信処理（push API）を変えていない",
  /https:\/\/api\.line\.me\/v2\/bot\/message\/push/.test(SRC));
check("dryRun で LINE 送信をスキップする経路が残っている",
  /if \(DRY_RUN\) \{[\s\S]{0,300}?return;/.test(SRC));
check("LINE 本文の施設名をサニタイズしている",
  /names\.map\(\(n\) => `・\$\{safeFacilityLabel\(n\)\}`\)/.test(SRC));
check("LINE 本文に判定時刻を明示している",
  /朝出勤未確認（\$\{p\.hour\}時判定）/.test(SRC) && /hour: CHECK_HOUR,/.test(SRC));
{
  // ⚠ 判定経路から sendLineMessage を直接呼ぶと、cron と外部スケジューラの両方で2通になる。
  const mainBody = SRC.slice(SRC.indexOf("async function main()"));
  const direct = (mainBody.match(/sendLineMessage\(/g) || []).length;
  check("main() で sendLineMessage を直接呼ぶのはテスト通知だけ（判定経路は deliver を通す）",
    direct === 1 && /if \(TEST_NOTIFY\) \{[\s\S]{0,400}?await sendLineMessage\(testMessage\)/.test(mainBody),
    `direct=${direct}`);
  check("未打刻の通知は deliver(unconfirmed) を通す", /await deliver\(unconfirmed\);/.test(mainBody));
  check("deliver は通知記録（notifyOnce）を通して送る",
    /async function sendMorningOnce\([\s\S]{0,1800}?const rootBase = dedupeBaseUrl\(process\.env\.FIREBASE_DATABASE_URL\);[\s\S]{0,1000}?notifyOnce\(\{[\s\S]{0,200}?makeRtdbDedupeStore\(httpRequest, rootBase, path, accessToken\)/.test(SRC) &&
    /sendOnce: makeLineSendOnce\(httpRequest, LINE_TOKEN, LINE_TO\)/.test(SRC) &&
    /newRetryKey: \(\) => crypto\.randomUUID\(\)/.test(SRC));
  check("通知を確定できなかった回は exit 1（赤い実行）になる",
    /result\.failures\.length > 0 \|\| plan\.terminal\.length > 0 \|\| plan\.inflight\.length > 0\)[\s\S]{0,80}?throw new Error/.test(SRC));
  // ⚠⚠ FIREBASE_DATABASE_URL は .../honomi で終わる。それをベースにすると記録が一般スタッフの書ける場所になる。
  check("通知記録・selfTest のベースに FB_DB_URL（/honomi）を使わない",
    !/makeRtdbDedupeStore\(\s*httpRequest,\s*FB_DB_URL/.test(SRC) &&
    (SRC.match(/makeRtdbDedupeStore\(httpRequest, (rootBase|dedupeBaseUrl\(process\.env\.FIREBASE_DATABASE_URL\)),/g) || []).length === 2);
  check("未来日の targetDate では実送信しない",
    /IS_DATE_OVERRIDE && !DRY_RUN && today > getTodayJST\(\)\)[\s\S]{0,40}?throw new Error/.test(SRC) &&
    SRC.indexOf("today > getTodayJST()") < SRC.indexOf("await getFirebaseIdToken()"));
}

// このリポジトリは PUBLIC で、Actions のログは未認証の第三者が閲覧できる。
section("公開 Actions ログへ秘密情報・個人情報を出さないこと");
{
  const logCalls = SRC.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
  // ⚠ ログ呼び出しのテキスト検査は 1 段の間接参照（const who = r.staff）で素通りする。
  //   氏名はソース全体で参照していないことを直接固定する。
  check("従業員氏名（r.staff）をソースのどこでも参照しない",
    !/\br\.staff\b|\.staff\b/.test(SRC),
    (SRC.match(/.*\.staff.*/) || [""])[0].trim());
  const leaky = logCalls.filter((c) => /\bstaff\b/.test(c));
  check("従業員氏名（staff）をログへ出さない", leaky.length === 0,
    leaky.slice(0, 2).join(" / "));
  // 打刻レコード（tc5_records は匿名でも書ける）由来の値を生でログへ出さない。
  const rawRecordLog = logCalls.filter((c) =>
    /\$\{\s*r\.(date|workFacility|facilityName|time)\s*\}/.test(c) ||
    /\$\{\s*key\s*\}/.test(c)
  );
  check("打刻レコード由来の値を生でログへ出さない", rawRecordLog.length === 0,
    rawRecordLog.slice(0, 2).join(" / "));
  const tokenLeak = logCalls.filter((c) => /\.token\b|JSON\.stringify\(\s*(f|entries|rawLocs|rawList)\s*\)/.test(c));
  check("施設マスタのエントリ全体・token をログへ出さない", tokenLeak.length === 0,
    tokenLeak.slice(0, 2).join(" / "));
  const lineToLeak = logCalls.filter((c) => /LINE_TO\.(charAt|slice|substring|length)|toPrefix|toLength/.test(c));
  check("LINE 宛先の一部・長さをログへ出さない", lineToLeak.length === 0,
    lineToLeak.slice(0, 2).join(" / "));
  check("LINE アクセストークン・idToken をログへ出さない",
    !logCalls.some((c) => /\$\{\s*(LINE_TOKEN|idToken|FB_API_KEY|LINE_TO)\s*\}/.test(c)),
    "secret の値そのものをログのテンプレートリテラルへ埋めている箇所がある");
  check("サービスアカウントのアクセストークン・鍵・retry key・本文の記録をログへ出さない",
    !logCalls.some((c) => /accessToken|SERVICE_ACCOUNT\b|private_key|FIREBASE_SERVICE_ACCOUNT_KEY\s*\}|retryKey/.test(c) &&
      !/FIREBASE_SERVICE_ACCOUNT_KEY (が未設定|を解釈できません|が無いため)/.test(c)),
    logCalls.filter((c) => /accessToken|private_key|retryKey/.test(c)).slice(0, 2).join(" / "));
  check("OAuth2 の失敗時に応答本文を出さない",
    /OAuth2 アクセストークン取得失敗 \(HTTP \$\{res\.status\}\)`\)/.test(SRC));
}

// ===== 9. ワークフローの結線 =====
section("morning-check.yml の結線");
// ⚠ CHECK_HOURS の各時刻に対応する cron と case 分岐が在ることを、リテラルではなく導出で確かめる。
//   cron の無い判定時刻を足すと、その施設は誰にも判定されず通知が消える。
{
  const crons = [...WF.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
  const mapped = [...WF.matchAll(/"([^"]+)"\)\s*HOUR=(\d+)\s*;;/g)]
    .map((m) => ({ cron: m[1], hour: Number(m[2]) }));
  CHECK_HOURS.forEach((h) => {
    const utcHour = (h + 24 - 9) % 24; // JST → UTC
    // 分は問わない（将来ずらしても良い）。UTC の「時」だけを導出して照合する。
    const cronRe = new RegExp(`^\\d+\\s+${utcHour}\\s+\\*\\s+\\*\\s+\\*$`);
    const cron = crons.find((c) => cronRe.test(c));
    check(`判定時刻 ${h}時（UTC ${utcHour}時）に対応する cron が存在する`,
      cron !== undefined, `crons=${crons.join(" / ")}`);
    check(`その cron が case で ${h} 時へ写像されている`,
      cron !== undefined && mapped.some((m) => m.cron === cron && m.hour === h),
      `case=${mapped.map((m) => m.cron + "->" + m.hour).join(" / ")}`);
  });
  eq("cron の本数が判定時刻の数と一致する", crons.length, CHECK_HOURS.length);
  check("case が扱う cron 式に未知のものが無い",
    mapped.every((m) => crons.includes(m.cron)),
    `case=${mapped.map((m) => m.cron).join(" / ")}`);
  check("case が写像する判定時刻に CHECK_HOURS 外のものが無い",
    mapped.every((m) => CHECK_HOURS.includes(m.hour)));
}
check("未知の cron ではフェイルクローズする（既定時刻へ倒さない）",
  /未知の cron 式です[\s\S]{0,200}?exit 1/.test(WF));
check("GITHUB_ENV へ書く前に許可値へ丸めている",
  /case "\$\{HOUR\}" in[\s\S]{0,200}?6\|7\)[\s\S]{0,200}?exit 1/.test(WF));
check("allowlist の検査が GITHUB_ENV への書き込みより前にある",
  WF.indexOf('case "${HOUR}" in') !== -1 &&
  WF.indexOf('case "${HOUR}" in') < WF.indexOf('>> "$GITHUB_ENV"'));
check("CHECK_HOUR を後続ステップへ渡す", /CHECK_HOUR=\$\{HOUR\}" >> "\$GITHUB_ENV"/.test(WF));
check("手動・外部スケジューラから判定時刻を指定できる", /checkHour:/.test(WF));
check("inputs 空の workflow_dispatch は6時（既存の外部スケジューラ経路）",
  /inputs 空の workflow_dispatch[\s\S]{0,200}?HOUR=6/.test(WF));
// ⚠ 7時通知の本番経路は cron ではなく外部スケジューラ（cron-job.org）からの
//   workflow_dispatch + inputs.checkHour である。この写像を固定する。
check("inputs.checkHour が指定されていれば最優先で採用する",
  /if \[ -n "\$\{INPUT_CHECK_HOUR\}" \][\s\S]{0,300}?HOUR="\$\{INPUT_CHECK_HOUR\}"/.test(WF));
check("inputs.checkHour を採ったことがログへ残る（決定元の表示）",
  /SRC="inputs\.checkHour"/.test(WF) && /決定元: \$\{SRC\}/.test(WF));
check("inputs.checkHour の判定は schedule の cron 判定より前にある",
  WF.indexOf('if [ -n "${INPUT_CHECK_HOUR}" ]') !== -1 &&
  WF.indexOf('elif [ "${EVENT_NAME}" = "schedule" ]') !== -1 &&
  WF.indexOf('if [ -n "${INPUT_CHECK_HOUR}" ]') < WF.indexOf('elif [ "${EVENT_NAME}" = "schedule" ]'));
// ⚠ 未信頼値は run: へ直接展開せず env: 経由で渡すこと（シェル注入の防止）。
check("inputs.checkHour を run: へ直接展開していない",
  !/run:[\s\S]{0,800}?\$\{\{\s*github\.event\.inputs/.test(WF));
check("inputs / schedule は env: 経由で渡している",
  /INPUT_CHECK_HOUR: \$\{\{ github\.event\.inputs\.checkHour \}\}/.test(WF) &&
  /EVENT_SCHEDULE: \$\{\{ github\.event\.schedule \}\}/.test(WF));
check("FIREBASE_API_KEY の受け渡しを維持している",
  /FIREBASE_API_KEY: \$\{\{ secrets\.FIREBASE_API_KEY \}\}/.test(WF));
check("実行コマンドを変えていない", /run: node scripts\/morning-check\.js/.test(WF));

// ===== 10. 実プロセスでの終了コード（正規表現ではなく実挙動で確かめる） =====
// CHECK_HOUR の検証はモジュール読込時＝通信前に走るため、ここでは外部アクセスが発生しない。
// 念のため RTDB の宛先は到達不能なダミーにし、DRY_RUN=true で LINE 送信経路も塞ぐ。
section("実プロセスでの終了コード");
{
  const { spawnSync } = require("child_process");
  const baseEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LINE_CHANNEL_ACCESS_TOKEN: "dummy",
    LINE_TO_ID: "Udummy0000000000000000000000000000",
    FIREBASE_API_KEY: "dummy",
    FIREBASE_DATABASE_URL: "https://127.0.0.1:1",
    DRY_RUN: "true",
  };
  const run = (extra) =>
    spawnSync(process.execPath, [SRC_PATH], {
      env: Object.assign({}, baseEnv, extra),
      encoding: "utf8",
      timeout: 20000,
    });

  [["23", "範囲外"], ["abc", "数値でない"], ["0", "範囲外"], ["7.5", "整数でない"], ["-7", "負数"]].forEach(
    ([v, why]) => {
      const r = run({ CHECK_HOUR: v });
      check(`CHECK_HOUR="${v}"（${why}）は exit 1 で止まる`, r.status === 1,
        `status=${r.status}`);
      check(`CHECK_HOUR="${v}" は判定を続行しない（RTDB へ行かない）`,
        !/\[RTDB\]/.test(String(r.stdout)), String(r.stdout).slice(0, 120));
    }
  );

  {
    const r = run({ CHECK_HOUR: "", GITHUB_ACTIONS: "true" });
    check("GitHub Actions 上で CHECK_HOUR が空なら exit 1", r.status === 1, `status=${r.status}`);
  }
  {
    // 空白のみも trim 後は空。Actions 上では受け渡しが壊れているとみなして止まる。
    const r = run({ CHECK_HOUR: "   ", GITHUB_ACTIONS: "true" });
    check("GitHub Actions 上で CHECK_HOUR が空白のみでも exit 1", r.status === 1, `status=${r.status}`);
  }
  // ⚠ 通知記録を確認できない実送信は、通信より前に止まる（記録なしで送ると同一枠が2通になる）
  {
    const r = run({ CHECK_HOUR: "6", DRY_RUN: "" });
    check("実送信の回でサービスアカウントが無ければ exit 1", r.status === 1, `status=${r.status}`);
    check("サービスアカウントが無ければ LINE・RTDB へ行かない",
      !/\[LINE\]|\[RTDB\]|\[AUTH\]/.test(String(r.stdout)), String(r.stdout).slice(0, 160));
  }
  {
    const r = run({ CHECK_HOUR: "6", DRY_RUN: "", DEDUPE_SELFTEST: "true" });
    check("selfTest でサービスアカウントが無ければ exit 1", r.status === 1, `status=${r.status}`);
  }
  {
    const secretish = "{not-json-SECRET-VALUE-9f8e";
    const r = run({ CHECK_HOUR: "6", DRY_RUN: "", FIREBASE_SERVICE_ACCOUNT_KEY: secretish });
    check("サービスアカウントの値が壊れていれば exit 1", r.status === 1, `status=${r.status}`);
    check("壊れたサービスアカウントの値をログへ出さない",
      !String(r.stdout + r.stderr).includes("SECRET-VALUE"));
  }
  {
    const r = run({
      CHECK_HOUR: "6", DRY_RUN: "", TARGET_DATE: "2999-01-01",
      FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "a@example.invalid", private_key: "dummy" }),
    });
    check("未来日の targetDate で実送信しようとすると exit 1", r.status === 1, `status=${r.status}`);
    check("未来日の targetDate は通信より前に止まる（Firebase・LINE へ行かない）",
      !/\[AUTH\]|\[RTDB\]|\[LINE\]|\[DEDUPE\]/.test(String(r.stdout)) && /未来の日付/.test(String(r.stderr)),
      String(r.stdout).slice(-200));
  }
}

// ===== 12. 監視が成立しているかの判定（設定異常の検知） =====
section("監視の成立判定（findMonitoringAnomalies）");
{
  const { expectedFacilityCountForHour, findMonitoringAnomalies, NOTIFY_EXCLUDE } = mod;
  const excludeNorms = NOTIFY_EXCLUDE.map(mod.normalizeFacility);
  const live = MASTER.filter(
    (f) => !excludeNorms.includes(mod.normalizeFacility(facilityEntryName(f)))
  );

  eq("6時の期待件数は4", expectedFacilityCountForHour(6), 4);
  eq("7時の期待件数は2", expectedFacilityCountForHour(7), 2);
  eq("判定時刻でない時刻の期待件数は0", expectedFacilityCountForHour(8), 0);

  eq("正常時の6時は異常なし", findMonitoringAnomalies(live, 6, 4, null).length, 0);
  eq("正常時の7時は異常なし", findMonitoringAnomalies(live, 7, 2, null).length, 0);

  // 7時施設の改名は7時の回でだけ異常。6時の回を巻き込まない。
  const renamedLate = live.filter((f) => f.name !== "ハルイロ").concat([{ name: "はるいろ" }]);
  check("7時施設の改名は7時の回で異常になる",
    findMonitoringAnomalies(renamedLate, 7, 1, null).some((a) => /施設マスタにありません/.test(a)),
    JSON.stringify(findMonitoringAnomalies(renamedLate, 7, 1, null)));
  check("7時施設の改名で6時の回に「施設マスタにありません」を出さない",
    !findMonitoringAnomalies(renamedLate, 6, 4, null).some((a) => /施設マスタにありません/.test(a)),
    JSON.stringify(findMonitoringAnomalies(renamedLate, 6, 4, null)));

  // 6時施設を1件消されただけでも監視は落ちている（0件になるまで待たない）
  check("6時施設が1件減っただけでも異常として検知する",
    findMonitoringAnomalies(live, 6, 3, null).length > 0,
    JSON.stringify(findMonitoringAnomalies(live, 6, 3, null)));
  check("対象0件は件数の異常として検知する",
    findMonitoringAnomalies(live, 7, 0, null).some((a) => /1件もありません/.test(a)));
  check("期待件数より多い分には異常を出さない",
    findMonitoringAnomalies(live, 6, 5, null).every((a) => !/しかありません/.test(a)));

  // 施設マスタを採用できなかったこと自体も異常として知らせる
  check("フォールバックした事実を異常として知らせる",
    findMonitoringAnomalies(live, 6, 4, "施設マスタを取得できませんでした")
      .some((a) => /施設マスタを採用できませんでした/.test(a)));
  eq("フォールバックが無ければその項目は出ない",
    findMonitoringAnomalies(live, 6, 4, null).length, 0);

  // 異常本文に第三者が書ける値がそのまま入らないこと
  const evil = live.filter((f) => f.name !== "ハルイロ")
    .concat([{ name: "ハルイロ\nhttps://evil.example/pay" }]);
  const msg = findMonitoringAnomalies(evil, 7, 1, null).join("\n");
  check("異常本文に改行を注入できない", !/\n\s*https/.test(msg), msg);
}

section("LATE_CHECK_FACILITIES の設定不正で起動を止める");
{
  const bad = [
    ['const LATE_CHECK_FACILITIES = {\n  "ハルイロ": 7,\n  "ミュゲの泉": 7,\n};',
     'const LATE_CHECK_FACILITIES = {\n  "ハルイロ": 23,\n};', "範囲外の判定時刻"],
    ['const LATE_CHECK_FACILITIES = {\n  "ハルイロ": 7,\n  "ミュゲの泉": 7,\n};',
     'const LATE_CHECK_FACILITIES = {\n  "ハルイロ": 7,\n  "ハル イロ": 6,\n};', "正規化後に衝突"],
  ];
  bad.forEach(([from, to, why]) => {
    if (BLOCK.indexOf(from) === -1) {
      check(`設定不正（${why}）で起動を止める`, false, "テスト用の差し替え元が見つからない");
      return;
    }
    let exited = null;
    try {
      vm.runInContext(BLOCK.replace(from, to), makeContext({}));
    } catch (e) {
      exited = e.exitCode !== undefined ? e.exitCode : e;
    }
    check(`設定不正（${why}）で起動を止める`, exited === 1, `exited=${String(exited)}`);
  });
}

// ===== 11. 朝通知除外（ハーベスト）を含めた一連の流れ =====
section("除外施設を含めた選抜の流れ");
{
  const excludeNorms = ["ハーベスト"].map(mod.normalizeFacility);
  const afterExclude = MASTER.filter(
    (f) => !excludeNorms.includes(mod.normalizeFacility(facilityEntryName(f)))
  );
  const s6 = namesOf(selectFacilitiesForHour(afterExclude, 6));
  const s7 = namesOf(selectFacilitiesForHour(afterExclude, 7));
  check("除外後の6時対象は4件（ハーベストを含まない）",
    s6.length === 4 && !s6.includes("ハーベスト"), `s6=${s6.join(",")}`);
  check("除外後の7時対象は ハルイロ / ミュゲの泉 の2件",
    s7.length === 2 && s7.includes("ハルイロ") && s7.includes("ミュゲの泉"), `s7=${s7.join(",")}`);
  check("除外後も6時と7時は交差しない", s6.every((n) => !s7.includes(n)));
  check("除外施設はどちらの回にも入らない",
    !s6.includes("ハーベスト") && !s7.includes("ハーベスト"));
}

// =====================================================================
// 同一日 × 同一施設 × 同一判定時刻の通知を最大1回にする（二重通知防止）
// 本物の notifyOnce を、条件付き書き込みを再現したメモリ上の記録と、
// retry key を再現した LINE の模擬で動かす。送信なし・本番データ非アクセス。
// =====================================================================
const D = mod.D;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fakeUuid(n) {
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

function makeEnv(seed) {
  const rnd = mulberry32(seed);
  const clock = { t: Date.UTC(2026, 8, 12, 21, 3, 3) };
  const tick = async () => {
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  const env = { rnd, clock, tick, seq: 0, sleeps: [] };
  env.now = () => clock.t;
  env.sleep = async (ms) => { env.sleeps.push(ms); clock.t += ms; await tick(); };
  // RTDB の ETag 条件付き書き込みの再現（etag が古ければ書かずに ok:false）
  env.store = {
    value: null, ver: 0, reads: 0, writes: 0, failRead: false, failWrite: false,
    async read() {
      this.reads++;
      await tick();
      if (this.failRead) throw new Error("read failed");
      return { value: clone(this.value), etag: "e" + this.ver };
    },
    async cas(v, etag) {
      await tick();
      if (this.failWrite) throw new Error("write failed");
      if (etag !== "e" + this.ver) return { ok: false };
      this.value = clone(v);
      this.ver++;
      this.writes++;
      return { ok: true };
    },
  };
  // LINE の再現。同じ retry key が受付済みなら 409（届かない）。behavior で失敗を差し込む。
  const line = { accepted: Object.create(null), deliveries: [], calls: 0, keys: [], texts: [], behavior: null };
  line.accept = (text, key) => {
    if (line.accepted[key]) return { status: 409 };
    line.accepted[key] = true;
    line.deliveries.push(text);
    return { status: 200 };
  };
  line.sendOnce = async (text, key) => {
    line.calls++;
    line.keys.push(key);
    line.texts.push(text);
    await tick();
    if (line.behavior) {
      const r = line.behavior(line, text, key);
      if (r !== undefined) return r;
    }
    return line.accept(text, key);
  };
  env.line = line;
  return env;
}

const ANOMALY_TEXT = "■ 設定異常（6時判定）\n・テスト異常\n施設マスタ（拠点トークン管理）を確認してください。\n\n";

async function runOnce(env, names, opt) {
  opt = opt || {};
  const facilitiesCount = opt.facilitiesCount === undefined ? 5 : opt.facilitiesCount;
  const anomalySection = opt.anomaly ? ANOMALY_TEXT : "";
  const candidates = names.map((n) => ({ slot: D.dedupeSlotKey(n), kind: "facility", name: n }));
  if (anomalySection) candidates.push({ slot: D.DEDUPE_ANOMALY_SLOT, kind: "anomaly" });
  const buildText = (fresh, ctx) => {
    const freshNames = fresh.filter((c) => c.kind === "facility").map((c) => c.name);
    return D.buildMorningMessage({
      hour: 6, nowStr: "2026/09/13 06:03",
      anomalySection: fresh.some((c) => c.kind === "anomaly") ? anomalySection : "",
      freshNames, suppressedCount: (ctx && ctx.notifiedFacilityCount) || 0, facilitiesCount,
    });
  };
  try {
    return await D.notifyOnce({
      store: opt.store || env.store,
      candidates, buildText,
      sendOnce: env.line.sendOnce,
      sleep: env.sleep, now: env.now,
      runId: opt.runId || "run-" + ++env.seq,
      newBatchId: () => "b_" + (++env.seq).toString(16).padStart(16, "0"),
      newRetryKey: () => fakeUuid(++env.seq),
      dryRun: !!opt.dryRun,
    });
  } catch (e) {
    return { error: e.message };
  }
}

// 届いた通知の中に、その施設の行が何回あったか
function deliveredCount(env, name) {
  return env.line.deliveries.reduce(
    (n, t) => n + t.split("\n").filter((l) => l === "・" + name).length, 0);
}
function anomalyDelivered(env) {
  return env.line.deliveries.filter((t) => t.indexOf("■ 設定異常") !== -1).length;
}
function slotOf(env, name) {
  const v = env.store.value;
  return v && v.slots ? v.slots[name === "anomaly" ? "anomaly" : D.dedupeSlotKey(name)] : undefined;
}

const FAC = ["ナナイロ", "ココラ", "ミュゲ貝塚", "ミュゲ春木"];

(async () => {
  section("二重通知防止: 枠キー");
  {
    const k = D.dedupeSlotKey("ハルイロ");
    check("枠キーは RTDB のキーに使える形（f_ + 32桁の16進）", /^f_[0-9a-f]{32}$/.test(k), k);
    eq("表記ゆれ（空白・全角）は同じ枠", D.dedupeSlotKey("ハル　イロ"), k);
    eq("施設マスタのエントリ形式でも同じ枠", D.dedupeSlotKey({ name: "ハルイロ", token: "t" }), k);
    check("別の施設は別の枠", D.dedupeSlotKey("ミュゲの泉") !== k);
    check("constructor 等の名前でも形式が崩れない", /^f_[0-9a-f]{32}$/.test(D.dedupeSlotKey("constructor")));
    eq("記録の場所は 日付/判定時刻 ごと", D.dedupePath("2026-09-13", 7), "morningNotify/2026-09-13/h7");
    check("日付が違えば別の記録", D.dedupePath("2026-09-14", 6) !== D.dedupePath("2026-09-13", 6));
    check("判定時刻が違えば別の記録", D.dedupePath("2026-09-13", 6) !== D.dedupePath("2026-09-13", 7));
    let threw = 0;
    ["2026-9-13", "../x", "2026-09-13/../../honomi", ""].forEach((d) => { try { D.dedupePath(d, 6); } catch (_) { threw++; } });
    try { D.dedupePath("2026-09-13", 8); } catch (_) { threw++; }
    eq("不正な日付・判定時刻では記録の場所を作らない", threw, 5);
  }

  section("二重通知防止: LINE 応答の分類");
  eq("200 は送信済み", D.classifyLineResult({ status: 200 }), "sent");
  eq("409（同じ retry key が受付済み）は送信済み", D.classifyLineResult({ status: 409 }), "sent");
  eq("500 は未確定（同じ retry key で再送）", D.classifyLineResult({ status: 500 }), "transient");
  eq("429 は未確定（同じ retry key で再送）", D.classifyLineResult({ status: 429 }), "transient");
  eq("タイムアウト・通信断は未確定", D.classifyLineResult({ error: "ETIMEDOUT" }), "transient");
  eq("400 は拒否（受け付けていない）", D.classifyLineResult({ status: 400 }), "rejected");
  eq("401 は拒否（受け付けていない）", D.classifyLineResult({ status: 401 }), "rejected");

  section("二重通知防止: 初回の本文は従来と同じ");
  {
    const now = "2026/09/13 06:03";
    const names = ["ナナイロ", "ココラ"];
    const legacy = `【穂乃味タイムカード】\n朝出勤未確認（6時判定）\n\n確認時刻：${now}\n\n` + ANOMALY_TEXT +
      `未確認施設：${names.length}件\n\n` + names.map((n) => `・${n}`).join("\n") + "\n\n" +
      "シフトミス・遅刻・事故の可能性があります。確認してください。";
    eq("未打刻＋設定異常の本文が従来と一致",
      D.buildMorningMessage({ hour: 6, nowStr: now, anomalySection: ANOMALY_TEXT, freshNames: names, suppressedCount: 0, facilitiesCount: 4 }),
      legacy);
    eq("対象0件で設定異常だけの本文が従来と一致",
      D.buildMorningMessage({ hour: 7, nowStr: now, anomalySection: ANOMALY_TEXT, freshNames: [], suppressedCount: 0, facilitiesCount: 0 }),
      `【穂乃味タイムカード】\n朝出勤未確認（7時判定）\n\n確認時刻：${now}\n\n` + ANOMALY_TEXT.trimEnd());
    eq("未打刻0件で設定異常ありの本文が従来と一致",
      D.buildMorningMessage({ hour: 6, nowStr: now, anomalySection: ANOMALY_TEXT, freshNames: [], suppressedCount: 0, facilitiesCount: 4 }),
      `【穂乃味タイムカード】\n朝出勤未確認（6時判定）\n\n確認時刻：${now}\n\n` + ANOMALY_TEXT +
      "未確認施設：なし（判定できた施設はすべて出勤確認済み）");
    eq("送るものが無ければ空文字（送らない）",
      D.buildMorningMessage({ hour: 6, nowStr: now, anomalySection: "", freshNames: [], suppressedCount: 3, facilitiesCount: 4 }), "");
    const inj = D.buildMorningMessage({ hour: 6, nowStr: now, anomalySection: "", freshNames: ["ナナ\nイロ・偽の行"], suppressedCount: 0, facilitiesCount: 4 });
    check("本文の施設名はサニタイズされる（改行で偽の行を差し込めない）",
      !inj.split("\n").some((l) => l === "イロ・偽の行"), inj);
  }

  section("二重通知防止: 外部スケジューラ → 保険 cron（同一枠を順に実行）");
  {
    const env = makeEnv(1);
    const r1 = await runOnce(env, FAC);
    eq("1回目（外部スケジューラ）は1通送る", env.line.deliveries.length, 1);
    check("1回目は全施設を載せる", FAC.every((n) => deliveredCount(env, n) === 1));
    check("1回目の記録はすべて sent", FAC.every((n) => slotOf(env, n).state === "sent"), JSON.stringify(r1.failures));
    env.clock.t += 2 * 60 * 60 * 1000; // cron は約2時間遅れて走る
    const r2 = await runOnce(env, FAC);
    eq("2回目（保険 cron）は LINE を呼ばない", env.line.calls, 1);
    eq("2回目の後も届いた通知は1通のまま", env.line.deliveries.length, 1);
    check("2回目は全枠を「通知済み」として送らない",
      r2.skipped.length === FAC.length && r2.skipped.every((s) => s.reason === "sent"));
    check("2回目は失敗扱いにしない（赤い実行にならない）", !r2.error && r2.failures.length === 0);
    check("送信後の記録に本文を残さない",
      Object.keys(env.store.value.batches).every((b) => env.store.value.batches[b].text === undefined));
    env.clock.t += 8 * 60 * 60 * 1000; // 8時間遅れの cron でも
    await runOnce(env, FAC);
    eq("さらに遅れた実行でも LINE を呼ばない", env.line.calls, 1);
  }

  section("二重通知防止: 設定異常も同一枠で1回");
  {
    const env = makeEnv(2);
    await runOnce(env, ["ナナイロ"], { anomaly: true });
    await runOnce(env, ["ナナイロ"], { anomaly: true });
    eq("設定異常は1回だけ届く", anomalyDelivered(env), 1);
    eq("施設も1回だけ届く", deliveredCount(env, "ナナイロ"), 1);
    const env2 = makeEnv(3);
    await runOnce(env2, [], { anomaly: true, facilitiesCount: 0 });
    await runOnce(env2, [], { anomaly: true, facilitiesCount: 0 });
    eq("対象0件の設定異常も1回だけ", env2.line.deliveries.length, 1);
  }

  section("二重通知防止: 通知済みの施設は載せず、新しい施設だけ送る");
  {
    const env = makeEnv(4);
    await runOnce(env, ["ナナイロ", "ココラ"]);
    await runOnce(env, ["ナナイロ", "ココラ", "ミュゲ貝塚"]);
    eq("2通目は新しい施設の分だけ", env.line.deliveries.length, 2);
    check("ナナイロ・ココラは合計1回", deliveredCount(env, "ナナイロ") === 1 && deliveredCount(env, "ココラ") === 1);
    eq("ミュゲ貝塚は1回", deliveredCount(env, "ミュゲ貝塚"), 1);
    check("2通目に省略した件数を書く", env.line.deliveries[1].indexOf("ほか 2 件は通知済みのため省略") !== -1,
      env.line.deliveries[1]);
    await runOnce(env, ["ナナイロ"]); // 出勤が入って未打刻が減った
    eq("未打刻が減っただけなら送らない", env.line.calls, 2);
  }

  section("二重通知防止: 日付・判定時刻が違えば抑止しない");
  {
    const env = makeEnv(5);
    const s6 = env.store;
    await runOnce(env, ["ナナイロ"], { store: s6 });
    const other = makeEnv(6).store; // 別の日付（別の記録）
    await runOnce(env, ["ナナイロ"], { store: other });
    eq("別の日付の同じ施設は送る", deliveredCount(env, "ナナイロ"), 2);
  }

  section("二重通知防止: 同時に走った実行（競合）");
  {
    const env = makeEnv(7);
    const rs = await Promise.all([runOnce(env, FAC), runOnce(env, FAC)]);
    check("同時の2実行でも各施設は1回だけ", FAC.every((n) => deliveredCount(env, n) === 1),
      FAC.map((n) => deliveredCount(env, n)).join(","));
    eq("同時の2実行でも LINE の呼び出しは1回", env.line.calls, 1);
    check("同時の2実行はどちらも失敗にならない", rs.every((r) => !r.error && r.failures.length === 0),
      JSON.stringify(rs.map((r) => r.error || r.failures)));
  }
  {
    // retry key に頼らず、記録の確保だけで防げていることを確かめる（LINE 側の重複排除を切る）
    let violations = 0;
    let lost = 0;
    let calls = 0;
    const ITER = 300;
    for (let i = 0; i < ITER; i++) {
      const env = makeEnv(1000 + i);
      env.line.behavior = (line, text) => { line.deliveries.push(text); return { status: 200 }; };
      const n = 2 + Math.floor(env.rnd() * 4);
      const runs = [];
      for (let j = 0; j < n; j++) {
        const subset = FAC.filter(() => env.rnd() < 0.8);
        runs.push(runOnce(env, subset.length ? subset : FAC.slice(0, 1), { anomaly: env.rnd() < 0.3 }));
      }
      await Promise.all(runs);
      calls += env.line.calls;
      FAC.forEach((name) => {
        const c = deliveredCount(env, name);
        if (c > 1) violations++;
      });
      if (anomalyDelivered(env) > 1) violations++;
      // 誰かの候補に入った施設は必ず1回届く（取りこぼさない）
      FAC.forEach((name) => {
        const st = slotOf(env, name);
        if (st && deliveredCount(env, name) !== 1) lost++;
        if (st && st.state !== "sent") lost++;
      });
    }
    eq(`ランダムな競合 ${ITER} 通り（2〜5実行同時）で同一枠の二重通知 0`, violations, 0);
    eq(`ランダムな競合 ${ITER} 通りで取りこぼし 0（候補にした枠はすべて sent で1回届く）`, lost, 0);
    check("競合テストで実際に送信が行われている", calls >= ITER, `calls=${calls}`);
  }

  section("二重通知防止: 他の実行が送信中なら結果を待つ");
  {
    const env = makeEnv(8);
    // 実行A が確保だけした状態を作る
    const cands = ["ナナイロ"].map((n) => ({ slot: D.dedupeSlotKey(n), kind: "facility", name: n }));
    const pA = D.planDedupe(null, cands, {
      now: env.now(), runId: "runA", newBatchId: "b_aaaaaaaaaaaaaaaa", newRetryKey: fakeUuid(99), buildText: () => "・ナナイロ",
    });
    await env.store.cas(pA.next, "e0");
    // 実行B の待機中に、実行A が送信を終えて sent を記録する
    let finished = false;
    const origSleep = env.sleep;
    env.sleep = async (ms) => {
      if (!finished) {
        finished = true;
        env.line.accept("・ナナイロ", fakeUuid(99));
        const cur = await env.store.read();
        const f = D.finalizeDedupe(cur.value, pA.newBatch, "runA", "sent", env.now(), 200);
        await env.store.cas(f.next, cur.etag);
      }
      return origSleep(ms);
    };
    const rB = await runOnce(env, ["ナナイロ"]);
    eq("待っている間に送信済みになれば送らない", env.line.calls, 0);
    check("待機後は通知済みとして扱う", rB.skipped.length === 1 && rB.skipped[0].reason === "sent");
    check("待機は上限内で終わる", env.sleeps.reduce((a, b) => a + b, 0) <= D.DEDUPE_WAIT_MS + 5000);
  }

  section("LINE 送信失敗時の再試行: 1回の実行内");
  {
    const env = makeEnv(9);
    let n = 0;
    env.line.behavior = (line, text, key) => (++n <= 2 ? { status: 500 } : line.accept(text, key));
    const r = await runOnce(env, ["ナナイロ"]);
    eq("500 が2回続いても3回目で届く", env.line.deliveries.length, 1);
    eq("再試行は3回まで", env.line.calls, 3);
    check("再試行は同じ retry key", new Set(env.line.keys).size === 1);
    check("再試行は同じ本文", new Set(env.line.texts).size === 1);
    check("再試行の間隔は 2秒 → 6秒", JSON.stringify(env.sleeps) === JSON.stringify(D.LINE_RETRY_DELAYS_MS),
      JSON.stringify(env.sleeps));
    check("届いたら失敗にしない", !r.error && r.failures.length === 0 && slotOf(env, "ナナイロ").state === "sent");
  }
  {
    // LINE は受け付けたのに 500 を返した → 同じ retry key の再送は 409 → 二重に届かない
    const env = makeEnv(10);
    let first = true;
    env.line.behavior = (line, text, key) => {
      if (first) { first = false; line.accept(text, key); return { status: 500 }; }
      return undefined;
    };
    await runOnce(env, ["ナナイロ"]);
    eq("受付後に 500 が返っても届くのは1回", deliveredCount(env, "ナナイロ"), 1);
    eq("受付後に 500 が返っても再送の 409 で送信済みにする", slotOf(env, "ナナイロ").state, "sent");
  }

  section("LINE 送信失敗時の再試行: 実行をまたぐ（送れたか分からない）");
  {
    const env = makeEnv(11);
    // 受け付けたが、応答がタイムアウトし続けた（本当は届いている）
    env.line.behavior = (line, text, key) => { line.accept(text, key); const e = new Error("t"); e.code = "ETIMEDOUT"; throw e; };
    const r1 = await runOnce(env, ["ナナイロ", "ココラ"]);
    check("応答が取れなければ exit 1 相当（失敗として報告）", r1.failures.some((f) => f.reason === "transient"));
    eq("応答が取れなければ retry 状態で残す", slotOf(env, "ナナイロ").state, "retry");
    const firstKey = env.line.keys[0];
    const firstText = env.line.texts[0];
    env.line.behavior = null;
    env.clock.t += 2 * 60 * 60 * 1000;
    const r2 = await runOnce(env, ["ナナイロ"]); // ココラは出勤して候補から外れても、同じ1通として再送する
    check("次の実行は同じ retry key で再送する", env.line.keys[env.line.keys.length - 1] === firstKey);
    check("次の実行は同じ本文で再送する（作り直さない）", env.line.texts[env.line.texts.length - 1] === firstText);
    eq("実行をまたいでも届くのは1回（LINE が 409 で弾く）", env.line.deliveries.length, 1);
    check("再送の結果、両方の枠が sent", slotOf(env, "ナナイロ").state === "sent" && slotOf(env, "ココラ").state === "sent");
    check("再送が成功した実行は失敗にならない", !r2.error && r2.failures.length === 0);
  }
  {
    // 届いていない通信断が続いた → 次の実行で届く（取りこぼさない）
    const env = makeEnv(12);
    env.line.behavior = () => { const e = new Error("n"); e.code = "ECONNRESET"; throw e; };
    await runOnce(env, ["ナナイロ"]);
    eq("届かなかった回は何も届いていない", env.line.deliveries.length, 0);
    env.line.behavior = null;
    env.clock.t += 60 * 60 * 1000;
    await runOnce(env, ["ナナイロ"]);
    eq("次の実行で1回だけ届く", deliveredCount(env, "ナナイロ"), 1);
  }

  section("LINE 送信失敗時の再試行: 明確な拒否（4xx）");
  {
    const env = makeEnv(13);
    env.line.behavior = () => ({ status: 400 });
    const r1 = await runOnce(env, ["ナナイロ"]);
    eq("4xx は1回の実行内で再試行しない", env.line.calls, 1);
    eq("4xx の枠は failed", slotOf(env, "ナナイロ").state, "failed");
    check("4xx の回は失敗として報告する", r1.failures.some((f) => f.reason === "rejected"));
    env.line.behavior = null;
    await runOnce(env, ["ナナイロ"]);
    eq("受け付けられていないので次の実行で送り直して1回届く", deliveredCount(env, "ナナイロ"), 1);
    check("送り直しは新しい retry key", env.line.keys[0] !== env.line.keys[1]);
  }
  {
    const env = makeEnv(14);
    env.line.behavior = () => ({ status: 403 });
    for (let i = 0; i < 6; i++) await runOnce(env, ["ナナイロ"]);
    eq("拒否が続いても実行をまたいだ試行は上限まで", env.line.calls, D.DEDUPE_MAX_ATTEMPTS);
    eq("上限に達したら gaveup", slotOf(env, "ナナイロ").state, "gaveup");
  }

  section("二重通知防止: 途中で落ちた実行");
  {
    // 確保した直後に落ちた（まだ送っていない）
    const env = makeEnv(15);
    const cands = FAC.slice(0, 2).map((n) => ({ slot: D.dedupeSlotKey(n), kind: "facility", name: n }));
    const text = "【穂乃味タイムカード】\n朝出勤未確認（6時判定）\n\n確認時刻：2026/09/13 06:03\n\n未確認施設：2件\n\n・ナナイロ\n・ココラ";
    const p = D.planDedupe(null, cands, { now: env.now(), runId: "crashed", newBatchId: "b_cccccccccccccccc", newRetryKey: fakeUuid(7), buildText: () => text });
    await env.store.cas(p.next, "e0");
    const started = env.now();
    const rB = await runOnce(env, FAC.slice(0, 2));
    eq("同時に走っていた実行はリースが切れるまで待ち、引き継いで1回だけ送る", env.line.deliveries.length, 1);
    check("引き継ぎはリースが切れてから（リース中には送らない）", env.now() - started >= D.DEDUPE_LEASE_MS);
    check("引き継いだ再送は記録した本文・retry key をそのまま使う", env.line.texts[0] === text && env.line.keys[0] === fakeUuid(7));
    check("引き継いだ実行は送信中の枠を残さず成功する", !rB.error && rB.inflight.length === 0 && rB.failures.length === 0);
    await runOnce(env, FAC.slice(0, 2));
    eq("その後の実行は送らない", env.line.calls, 1);
  }
  {
    // 送信権を持つ実行がリースを更新し続ける（時計のずれ等）→ 待ち切っても送らず、送信中として報告（exit 1）
    const env = makeEnv(24);
    const cands = ["ナナイロ"].map((n) => ({ slot: D.dedupeSlotKey(n), kind: "facility", name: n }));
    const p = D.planDedupe(null, cands, { now: env.now(), runId: "holder", newBatchId: "b_dddddddddddddddd", newRetryKey: fakeUuid(8), buildText: () => "【穂乃味タイムカード】\n朝出勤未確認（6時判定）\n\n・ナナイロ" });
    await env.store.cas(p.next, "e0");
    const baseSleep = env.sleep;
    env.sleep = async (ms) => {
      await baseSleep(ms);
      env.store.value.slots[D.dedupeSlotKey("ナナイロ")].leaseUntil = env.now() + D.DEDUPE_LEASE_MS;
    };
    const r = await runOnce(env, ["ナナイロ"]);
    eq("リースが切れない限り送らない", env.line.calls, 0);
    check("待ち切っても送信中なら報告する（sendMorningOnce が exit 1 にする）", r.inflight.length === 1);
    check("待機は上限で必ず終わる", env.sleeps.reduce((a, b) => a + b, 0) <= D.DEDUPE_WAIT_MS + 20000);
  }
  {
    // LINE へ届いた直後に落ちた（送信結果を記録できなかった）
    const env = makeEnv(16);
    const origCas = env.store.cas.bind(env.store);
    let casCount = 0;
    env.store.cas = async (v, etag) => { casCount++; if (casCount >= 2) throw new Error("crash"); return origCas(v, etag); };
    const r1 = await runOnce(env, ["ナナイロ"]);
    eq("届いた", env.line.deliveries.length, 1);
    check("記録できなかったことは失敗として報告する", r1.failures.some((f) => f.reason === "record_failed"));
    env.store.cas = origCas;
    env.clock.t += 60 * 1000;
    const started = env.now();
    const r2 = await runOnce(env, ["ナナイロ"]);
    check("記録が送信中のままなら、リース切れまで待ってから再送する",
      env.line.calls === 2 && env.now() - started >= D.DEDUPE_LEASE_MS - 60 * 1000, `calls=${env.line.calls}`);
    check("再送は同じ retry key", env.line.keys[1] === env.line.keys[0]);
    eq("リース切れ後の再送は 409 になり、届くのは1回のまま", deliveredCount(env, "ナナイロ"), 1);
    eq("リース切れ後の再送で sent に確定する", slotOf(env, "ナナイロ").state, "sent");
    check("引き継いだ実行は成功する", !r2.error && r2.failures.length === 0 && r2.inflight.length === 0);
  }
  {
    // retry key の有効期限を過ぎた未確定の送信は、二重通知の危険を取らず送らない
    const env = makeEnv(17);
    env.line.behavior = () => ({ status: 503 });
    await runOnce(env, ["ナナイロ"]);
    env.line.behavior = null;
    const calls = env.line.calls;
    env.clock.t += D.DEDUPE_RETRY_KEY_TTL_MS + 1;
    const r = await runOnce(env, ["ナナイロ"]);
    eq("retry key の期限切れ後は送らない", env.line.calls, calls);
    eq("期限切れは expired", slotOf(env, "ナナイロ").state, "expired");
    check("期限切れは赤い実行として知らせる", r.terminal.some((t) => t.reason === "expired"));
    await runOnce(env, ["ナナイロ"]);
    eq("expired の枠はその後も送らない", env.line.calls, calls);
  }
  {
    const env = makeEnv(18);
    env.store.value = { slots: { [D.dedupeSlotKey("ナナイロ")]: { state: "what?" } } };
    const rc = await runOnce(env, ["ナナイロ"]);
    eq("記録が壊れていたら送らない", env.line.calls, 0);
    check("記録が壊れていたら赤い実行として知らせる（緑で黙って終わらない）",
      rc.terminal.some((t) => t.reason === "unknown_state"));
    env.store.value = { slots: { [D.dedupeSlotKey("ナナイロ")]: { state: "retry", batch: "b_missing", attempts: 1 } } };
    await runOnce(env, ["ナナイロ"]);
    eq("再送に要る本文・retry key が無ければ送らない", env.line.calls, 0);
  }

  section("二重通知防止: 記録が書き換えられていても任意の本文を送らない（多層防御）");
  {
    const slotKey = D.dedupeSlotKey("ナナイロ");
    const mk = (text) => {
      const env = makeEnv(30);
      env.store.value = {
        slots: { [slotKey]: { state: "retry", batch: "b_x", attempts: 0 } },
        batches: { b_x: { retryKey: fakeUuid(77), text, createdAt: env.now() } },
      };
      return env;
    };
    {
      const env = mk("お知らせ：こちらから再ログイン https://evil.example/");
      const r = await runOnce(env, ["ナナイロ"]);
      eq("固定の見出しで始まらない本文は再送しない", env.line.calls, 0);
      check("見出しの無い本文は expired として赤く知らせる",
        slotOf(env, "ナナイロ").state === "expired" && r.terminal.length === 1);
    }
    {
      const env = mk("【穂乃味タイムカード】\n朝出勤未確認（" + "あ".repeat(D.MAX_MESSAGE_LEN));
      await runOnce(env, ["ナナイロ"]);
      eq("LINE の上限を超える本文は再送しない", env.line.calls, 0);
    }
  }

  section("二重通知防止: 通知記録の置き場所（/honomi の外）");
  {
    eq("…/honomi で終わる DB URL からはオリジンだけを使う", D.dedupeBaseUrl("https://x.example/honomi"), "https://x.example");
    eq("末尾スラッシュ付きでもオリジン", D.dedupeBaseUrl("https://x.example/honomi/"), "https://x.example");
    eq("パスの無い URL はそのまま", D.dedupeBaseUrl("https://x.example"), "https://x.example");
    let bad = 0;
    ["", "not a url", "http://x.example/honomi", undefined].forEach((u) => { try { D.dedupeBaseUrl(u); } catch (_) { bad++; } });
    eq("解釈できない・https でない URL では記録の場所を作らない", bad, 4);
    const urls = [];
    const req = async (url) => { urls.push(url); return { status: 200, headers: { etag: "e" }, body: null }; };
    await D.makeRtdbDedupeStore(req, D.dedupeBaseUrl("https://x.example/honomi"), D.dedupePath("2026-09-13", 6), "T").read();
    await D.makeRtdbDedupeStore(req, D.dedupeBaseUrl("https://x.example/honomi"), D.DEDUPE_ROOT + "/_selftest", "T").read();
    eq("本番の通知記録はルート直下へ行く", urls[0], "https://x.example/morningNotify/2026-09-13/h6.json");
    eq("selfTest もルート直下へ行く", urls[1], "https://x.example/morningNotify/_selftest.json");
    check("通知記録の URL に /honomi/ を含まない", urls.every((u) => u.indexOf("/honomi") === -1));
  }

  section("二重通知防止: 本文の件数表記・判定対象日");
  {
    const env = makeEnv(31);
    await runOnce(env, ["ナナイロ"]);
    env.store.value.slots[D.dedupeSlotKey("ココラ")] = { state: "gaveup", attempts: 3 };
    await runOnce(env, ["ナナイロ", "ココラ", "ミュゲ貝塚"]);
    const last = env.line.deliveries[env.line.deliveries.length - 1];
    check("「通知済み」の件数は sent の施設だけ（gaveup を通知済みと書かない）",
      last.indexOf("ほか 1 件は通知済みのため省略") !== -1, last);
    const withDate = D.buildMorningMessage({ hour: 6, nowStr: "x", targetDate: "2026-09-10", anomalySection: "", freshNames: ["ナナイロ"], suppressedCount: 0, facilitiesCount: 4 });
    check("targetDate 指定時は本文に判定対象日を書く", withDate.indexOf("判定対象日：2026-09-10（手動指定）") !== -1);
    check("targetDate 指定時も見出しは固定（再送の検査を通る）", withDate.indexOf("【穂乃味タイムカード】\n朝出勤未確認（") === 0);
  }

  section("二重通知防止: 記録を読めない・書けないときは送らない");
  {
    const env = makeEnv(19);
    env.store.failRead = true;
    const r = await runOnce(env, FAC);
    check("記録を読めなければエラー", !!r.error);
    eq("記録を読めなければ LINE を呼ばない", env.line.calls, 0);
  }
  {
    const env = makeEnv(20);
    env.store.failWrite = true;
    const r = await runOnce(env, FAC);
    check("確保を書けなければエラー", !!r.error);
    eq("確保を書けなければ LINE を呼ばない", env.line.calls, 0);
  }
  {
    const env = makeEnv(21);
    env.store.cas = async () => ({ ok: false }); // 競合が続く
    const r = await runOnce(env, FAC);
    check("競合が続けばエラー", !!r.error);
    eq("競合が続けば LINE を呼ばない", env.line.calls, 0);
  }

  section("二重通知防止: 一時的な障害と、応答が失われた書き込み");
  {
    const env = makeEnv(25);
    const origRead = env.store.read.bind(env.store);
    let n = 0;
    env.store.read = async () => { if (++n === 1) throw new Error("blip"); return origRead(); };
    const r = await runOnce(env, ["ナナイロ"]);
    eq("記録の読み取りが1回瞬断しても再試行して1回届く", env.line.deliveries.length, 1);
    check("瞬断を再試行した実行は成功する", !r.error && r.failures.length === 0);
  }
  {
    const env = makeEnv(26);
    const origCas = env.store.cas.bind(env.store);
    let n = 0;
    env.store.cas = async (v, etag) => {
      const w = await origCas(v, etag);
      if (++n === 1) { const e = new Error("timeout"); e.code = "ETIMEDOUT"; throw e; }
      return w;
    };
    const r = await runOnce(env, FAC);
    check("確保は書けたが応答が失われても、各施設1回だけ届く", FAC.every((nm) => deliveredCount(env, nm) === 1),
      FAC.map((nm) => deliveredCount(env, nm)).join(","));
    eq("応答が失われた確保でも LINE は1回", env.line.calls, 1);
    check("自分の確保を読み直して先へ進む（リース切れを待たない・失敗にしない）",
      !r.error && r.failures.length === 0 && env.sleeps.reduce((a, b) => a + b, 0) < D.DEDUPE_LEASE_MS);
  }
  {
    const env = makeEnv(27);
    const origCas = env.store.cas.bind(env.store);
    let n = 0;
    env.store.cas = async (v, etag) => { if (++n === 1) throw new Error("reset"); return origCas(v, etag); };
    const r = await runOnce(env, ["ナナイロ"]);
    eq("確保が本当に書けていなければ作り直して1回届く", deliveredCount(env, "ナナイロ"), 1);
    check("作り直した実行は成功する", !r.error && r.failures.length === 0);
  }
  {
    // 送信中に送信権が他の実行へ移り、その実行が送り終えていた → 偽の失敗にしない
    const env = makeEnv(28);
    env.line.behavior = (line, text, key) => {
      Object.keys(env.store.value.slots).forEach((k) => {
        env.store.value.slots[k] = Object.assign({}, env.store.value.slots[k], { state: "sent", runId: "other" });
      });
      env.store.ver++;
      return line.accept(text, key);
    };
    const r = await runOnce(env, ["ナナイロ"]);
    check("他の実行が送り終えていれば失敗扱いにしない", !r.error && r.failures.length === 0, JSON.stringify(r.failures));
  }
  {
    // 自分の応答は未確定（500）だが、他の実行が同じ送信を sent に確定済み → 赤くしない
    const env = makeEnv(29);
    env.line.behavior = (line, text, key) => {
      Object.keys(env.store.value.slots).forEach((k) => {
        env.store.value.slots[k] = Object.assign({}, env.store.value.slots[k], { state: "sent", runId: "other" });
      });
      env.store.ver++;
      line.accept(text, key);
      return { status: 500 };
    };
    const r = await runOnce(env, ["ナナイロ"]);
    check("他の実行が確定済みなら、自分の応答が未確定でも失敗扱いにしない", !r.error && r.failures.length === 0,
      JSON.stringify(r.failures));
    eq("その場合も届くのは1回", env.line.deliveries.length, 1);
  }
  {
    // 別の送信（別の batch）で sent になっていた → 二重に届いた可能性があるので失敗として残す
    const env = makeEnv(35);
    env.line.behavior = (line, text, key) => {
      Object.keys(env.store.value.slots).forEach((k) => {
        env.store.value.slots[k] = { state: "sent", runId: "other", batch: "b_other", attempts: 1 };
      });
      env.store.ver++;
      line.accept(text, key);
      return { status: 500 };
    };
    const r = await runOnce(env, ["ナナイロ"]);
    check("別の送信で sent になっていたら（二重に届いた可能性）失敗として報告する", r.failures.length > 0,
      JSON.stringify(r.failures));
  }
  {
    // 同じ実行の古い確保（リース切れ）が遅れて書き込まれ、今回の確保の応答が失われた
    // → 古い確保を「今回書けた」と取り違えず、リースを持った状態で送る
    const env = makeEnv(32);
    const slotKey = D.dedupeSlotKey("ナナイロ");
    const text = "【穂乃味タイムカード】\n朝出勤未確認（6時判定）\n\n確認時刻：x\n\n未確認施設：1件\n\n・ナナイロ";
    env.store.value = {
      slots: { [slotKey]: { state: "retry", batch: "b_x", attempts: 1, leaseUntil: 0 } },
      batches: { b_x: { retryKey: fakeUuid(55), text, createdAt: env.now() } },
    };
    let n = 0;
    env.store.cas = async function (v, etag) {
      await env.tick();
      if (++n === 1) {
        // 今回の書き込みは届かず、代わりに同じ実行IDの古い確保（期限切れ）が入った
        this.value = clone(this.value);
        this.value.slots[slotKey] = { state: "sending", batch: "b_x", runId: "me", attempts: 1, leaseUntil: env.now() - 1 };
        this.ver++;
        throw new Error("timeout");
      }
      if (etag !== "e" + this.ver) return { ok: false };
      this.value = clone(v); this.ver++; this.writes++;
      return { ok: true };
    };
    let leaseAtSend = null;
    env.line.behavior = () => { leaseAtSend = env.store.value.slots[slotKey].leaseUntil; return undefined; };
    const r = await runOnce(env, ["ナナイロ"], { runId: "me" });
    check("古い確保を今回の確保と取り違えない（送る時点でリースを持っている）",
      leaseAtSend !== null && leaseAtSend > env.now(), `leaseAtSend=${leaseAtSend} now=${env.now()}`);
    eq("取り違えず、同じ retry key で1回だけ届く", env.line.deliveries.length, 1);
    check("成功する", !r.error && r.failures.length === 0, JSON.stringify(r.error || r.failures));
  }
  {
    const env = makeEnv(33);
    env.store.value = { slots: { [D.dedupeSlotKey("ナナイロ")]: "sent" } };
    const r = await runOnce(env, ["ナナイロ"]);
    eq("枠の値がオブジェクトでなければ（記録の破損）送らない", env.line.calls, 0);
    check("枠の値がオブジェクトでなければ赤い実行として知らせる", r.terminal.some((t) => t.reason === "unknown_state"));
  }
  {
    const bads = [["ノードが文字列", "garbage"], ["ノードが配列", [1, 2]], ["slots が文字列", { slots: "x" }],
      ["batches が配列", { slots: { [D.dedupeSlotKey("ナナイロ")]: { state: "sent" } }, batches: [1] }]];
    for (const [label, bad] of bads) {
      const env = makeEnv(34);
      env.store.value = bad;
      const r = await runOnce(env, ["ナナイロ"], { anomaly: true });
      check(`記録ノードの破損（${label}）では送らない`, env.line.calls === 0 && env.store.writes === 0,
        `calls=${env.line.calls} writes=${env.store.writes}`);
      eq(`記録ノードの破損（${label}）は全候補を赤く知らせる`, r.terminal.length, 2);
    }
  }

  section("二重通知防止: dryRun は記録を書かない");
  {
    const env = makeEnv(22);
    const r = await runOnce(env, FAC, { dryRun: true });
    eq("dryRun は記録へ書かない", env.store.writes, 0);
    eq("dryRun は LINE を呼ばない", env.line.calls, 0);
    check("dryRun でも送る予定の本文は分かる", !!(r.plan && r.plan.newBatch && r.plan.newBatch.text.indexOf("・ナナイロ") !== -1));
  }

  section("二重通知防止: RTDB と LINE の呼び出し形");
  {
    const calls = [];
    let respond = null;
    const req = async (url, options, body) => { calls.push({ url, options, body }); return respond(url, options, body); };
    const store = D.makeRtdbDedupeStore(req, "https://db.example", "morningNotify/2026-09-13/h6", "TOKEN");
    respond = () => ({ status: 200, headers: { etag: "abc" }, body: null });
    const got = await store.read();
    eq("読み取りは morningNotify の該当ノード", calls[0].url, "https://db.example/morningNotify/2026-09-13/h6.json");
    eq("読み取りで ETag を要求する", calls[0].options.headers["X-Firebase-ETag"], "true");
    eq("読み取りは Bearer 認証", calls[0].options.headers.Authorization, "Bearer TOKEN");
    check("トークンを URL に載せない", calls[0].url.indexOf("TOKEN") === -1);
    check("読み取りにタイムアウトを付ける", calls[0].options.timeoutMs > 0);
    eq("ETag を返す", got.etag, "abc");
    respond = () => ({ status: 200, headers: {}, body: null });
    let e1 = null; try { await store.read(); } catch (e) { e1 = e; }
    check("ETag が無ければ送らない（エラー）", !!e1);
    respond = () => ({ status: 401, headers: { etag: "x" }, body: null });
    let e2 = null; try { await store.read(); } catch (e) { e2 = e; }
    check("読み取りが 200 以外ならエラー", !!e2);
    respond = () => ({ status: 200, headers: {}, body: {} });
    const w = await store.cas({ a: 1 }, "abc");
    const last = calls[calls.length - 1];
    check("書き込みは PUT + if-match", last.options.method === "PUT" && last.options.headers["if-match"] === "abc");
    eq("書き込みが 200 なら確保成功", w.ok, true);
    respond = () => ({ status: 412, headers: { etag: "new" }, body: {} });
    eq("412 は競合（書かれていない）", (await store.cas({ a: 1 }, "abc")).ok, false);
    respond = () => ({ status: 500, headers: {}, body: {} });
    let e3 = null; try { await store.cas({ a: 1 }, "abc"); } catch (e) { e3 = e; }
    check("書き込みが 200/412 以外ならエラー", !!e3);

    const lcalls = [];
    const send = D.makeLineSendOnce(async (url, options, body) => { lcalls.push({ url, options, body }); return { status: 200 }; }, "LT", "Uto");
    await send("本文", fakeUuid(5));
    eq("LINE は push API", lcalls[0].url, "https://api.line.me/v2/bot/message/push");
    eq("LINE へ retry key を付ける", lcalls[0].options.headers["X-Line-Retry-Key"], fakeUuid(5));
    check("LINE 送信にタイムアウトを付ける", lcalls[0].options.timeoutMs > 0);
    check("LINE の本文と宛先", JSON.parse(lcalls[0].body).to === "Uto" && JSON.parse(lcalls[0].body).messages[0].text === "本文");
    check("retry key は crypto.randomUUID の形式を受け付ける",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(require("crypto").randomUUID()));
  }

  section("二重通知防止: 自己診断（selfTest）");
  {
    const env = makeEnv(23);
    const ok = await D.dedupeSelfTest(env.store, "run-x", 1);
    check("条件付き書き込みが機能する記録なら PASS", ok.ok, ok.why);
    const broken = { v: null, async read() { return { value: this.v, etag: "same" }; }, async cas(v) { this.v = v; return { ok: true }; } };
    const ng = await D.dedupeSelfTest(broken, "run-x", 1);
    check("古い ETag でも書けてしまう記録なら FAIL", !ng.ok);
  }

  section("二重通知防止: 置き場所とワークフロー");
  {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, "database.rules.json"), "utf8")).rules;
    check("通知記録は database.rules.json に無い（クライアントから読み書きできない）",
      !Object.prototype.hasOwnProperty.call(rules, D.DEDUPE_ROOT));
    check("ルート直下に .read / .write が無い（デフォルト拒否のまま）",
      !Object.prototype.hasOwnProperty.call(rules, ".read") && !Object.prototype.hasOwnProperty.call(rules, ".write"));
    check("通知記録は /honomi の外（一般スタッフ・匿名が書ける場所ではない）", D.DEDUPE_ROOT !== "honomi" &&
      D.dedupePath("2026-09-13", 6).indexOf("honomi") !== 0);
    check("ワークフローはサービスアカウントを渡す",
      /FIREBASE_SERVICE_ACCOUNT_KEY: \$\{\{ secrets\.FIREBASE_SERVICE_ACCOUNT_KEY \}\}/.test(WF));
    check("selfTest は env 経由で渡す", /DEDUPE_SELFTEST: \$\{\{ github\.event\.inputs\.selfTest \|\| 'false' \}\}/.test(WF));
    const crons = [...WF.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
    check("保険の cron 2本は残している", crons.includes("3 21 * * *") && crons.includes("3 22 * * *"));
    check("workflow_dispatch（外部スケジューラ経路）は残している", /workflow_dispatch:/.test(WF));
    check("concurrency で後続の実行を取り消していない（取りこぼし防止）", !/^\s*concurrency:/m.test(WF));
    check("鍵を受け取るワークフローの GITHUB_TOKEN は読み取りだけ", /^permissions:\s*\r?\n\s+contents: read\s*$/m.test(WF));
    {
      // スクリプトの定数から「全通信がタイムアウトし続けた」ときの最悪時間を導き、ジョブ上限とコメントを照合する
      const T = D.HTTP_TIMEOUT_MS;
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const readWorst = D.DEDUPE_IO_TRIES * T + sum(D.DEDUPE_IO_RETRY_MS);          // readWithRetry / OAuth
      const waitWorst = D.DEDUPE_WAIT_MS + D.DEDUPE_POLL_MS + readWorst;
      const casWorst = D.DEDUPE_CAS_TRIES * (readWorst + T + 200 * D.DEDUPE_CAS_TRIES);
      const ioWorst = D.DEDUPE_IO_TRIES * (T + readWorst + Math.max.apply(null, D.DEDUPE_IO_RETRY_MS));
      const sendWorst = D.LINE_SEND_TRIES * T + sum(D.LINE_RETRY_DELAYS_MS);
      const recordWorst = D.DEDUPE_CAS_TRIES * (2 * T + 1000);
      const worst = readWorst + waitWorst + casWorst + ioWorst + 2 * (sendWorst + recordWorst); // 送信は再送＋新規の最大2件
      const m = WF.match(/timeout-minutes:\s*(\d+)/);
      check("ジョブの上限時間はスクリプトの計算上の最悪時間より長い",
        !!m && Number(m[1]) * 60 * 1000 > worst, `timeout=${m ? m[1] : "none"}分 worst=${(worst / 60000).toFixed(1)}分`);
      const c = WF.match(/計算上の最悪でも約(\d+)分/);
      check("ワークフローのコメントの最悪時間が計算値と一致する（切り上げ）",
        !!c && Number(c[1]) === Math.ceil(worst / 60000), `comment=${c ? c[1] : "none"} worst=${(worst / 60000).toFixed(2)}`);
    }
  }

  // ===== 結果 =====
  console.log(`\n========================================`);
  console.log(`合計 ${pass + fail} 件: PASS ${pass} / FAIL ${fail}`);
  console.log(`========================================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("テストが例外で止まりました:", e);
  process.exit(1);
});
