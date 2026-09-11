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

const mod = {};
// 判定ブロックは設定不正のときに console.error + process.exit(1) する。
// vm 側にも同名を用意して、その分岐を検証できるようにする。
function makeContext(target) {
  const c = {
    out: target,
    console: { log() {}, warn() {}, error() {} },
    process: { exit(code) { const e = new Error("__vm_exit__"); e.exitCode = code; throw e; } },
  };
  vm.createContext(c);
  return c;
}
const ctx = makeContext(mod);
vm.runInContext(
  BLOCK +
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
  /anomalySection \+ unconfirmedSection/.test(SRC));
check("対象0件でも設定異常があれば LINE を送る",
  /facilities\.length === 0[\s\S]{0,300}?if \(anomalySection\)[\s\S]{0,300}?await sendLineMessage\(/.test(SRC));
check("未打刻0件でも設定異常があれば通知を止めない",
  /unconfirmed\.length === 0 && !anomalySection/.test(SRC));
// ⚠ LINE は1回の実行で最大1通。別送にすると送信失敗が未打刻通知を道連れにし、
//   異常が続くあいだ通数が倍になって本来の警告が埋もれる。
{
  const sends = (SRC.match(/await sendLineMessage\(/g) || []).length;
  // TEST_NOTIFY のテスト送信 1 箇所 + 判定経路 2 箇所（対象0件 / 通常）= 3 箇所まで。
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
  /unconfirmed\.map\(\(n\) => `・\$\{safeFacilityLabel\(n\)\}`\)/.test(SRC));
check("LINE 本文に判定時刻を明示している",
  /朝出勤未確認（\$\{CHECK_HOUR\}時判定）/.test(SRC));

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

// ===== 結果 =====
console.log(`\n========================================`);
console.log(`合計 ${pass + fail} 件: PASS ${pass} / FAIL ${fail}`);
console.log(`========================================`);
process.exit(fail === 0 ? 0 : 1);
