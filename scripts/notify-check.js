/**
 * notify-check.js — 未承認・打刻漏れ・時刻修正 LINE通知
 * GitHub Actions (workflow_dispatch) から実行。Node.js 標準モジュールのみ。
 */

"use strict";

const https = require("https");

// ===== Secrets バリデーション =====
const REQUIRED_SECRETS = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
];
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("[ERROR] 以下の GitHub Secret が未設定です: " + missing.join(", "));
  process.exit(1);
}

const LINE_TO_ENV = (process.env.LINE_TO_ID || "").trim();
if (!LINE_TO_ENV || LINE_TO_ENV === "temp") {
  console.error("[ERROR] LINE_TO_ID が未設定です");
  console.error("GitHub Secrets → LINE_TO_ID を設定してください");
  process.exit(1);
}

const FB_API_KEY = process.env.FIREBASE_API_KEY;
const FB_DB_URL  = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, "");
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // ログ出力禁止
const LINE_TO    = LINE_TO_ENV;

const TEST_NOTIFY = (process.env.TEST_NOTIFY || "").trim() === "true";
const DRY_RUN     = (process.env.DRY_RUN     || "").trim() === "true";

// ===== HTTPS リクエストヘルパー =====
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: (options && options.method) || "GET",
      headers: (options && options.headers) || {},
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ===== JST 日付 yyyy-mm-dd =====
function getTodayJST() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// ===== JST 30日前の日付 yyyy-mm-dd =====
function getCutoffJST() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y  = parts.find((p) => p.type === "year").value;
  const m  = parts.find((p) => p.type === "month").value;
  const da = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${da}`;
}

// ===== UTC ISO8601 を JST 日付 yyyy-mm-dd に変換 =====
function isoToDateJST(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y  = parts.find((p) => p.type === "year").value;
  const mo = parts.find((p) => p.type === "month").value;
  const da = parts.find((p) => p.type === "day").value;
  return `${y}-${mo}-${da}`;
}

// ===== JST 現在時刻文字列 YYYY/MM/DD HH:mm:ss =====
function getNowJSTWithSeconds() {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

// ===== Firebase Anonymous Auth =====
async function getFirebaseIdToken() {
  const res = await httpRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ returnSecureToken: true })
  );
  if (res.status !== 200 || !res.body || !res.body.idToken) {
    throw new Error(
      `Firebase Anonymous Auth 失敗 (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`
    );
  }
  return res.body.idToken; // ログ出力禁止
}

// ===== Firebase RTDB GET =====
async function fetchRTDB(path, idToken) {
  const logUrl = `${FB_DB_URL}/${path}.json`;
  console.log(`[RTDB]  GET ${logUrl}`);
  const fullUrl = `${logUrl}?auth=${idToken}`;
  const res = await httpRequest(fullUrl);
  console.log(`[RTDB]  HTTP ${res.status}`);
  if (res.status !== 200) {
    throw new Error(
      `RTDB fetch 失敗 (${path}): HTTP ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`
    );
  }
  return res.body;
}

// ===== LINE Push 送信 =====
async function sendLineMessage(text) {
  const toPrefix = LINE_TO.charAt(0);
  const toLength = LINE_TO.length;
  console.log("[LINE]  Push送信開始");
  console.log(`[LINE]  LINE_TO_ID 存在: true (先頭文字=${toPrefix} 長さ=${toLength})`);
  console.log(`[LINE]  LINE_CHANNEL_ACCESS_TOKEN 存在: ${!!LINE_TOKEN}`);

  const payload = JSON.stringify({
    to: LINE_TO,
    messages: [{ type: "text", text }],
  });
  const res = await httpRequest(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LINE_TOKEN,
      },
    },
    payload
  );

  console.log(`[LINE]  response status=${res.status}`);
  console.log(`[LINE]  response body=${JSON.stringify(res.body)}`);

  if (res.status !== 200) {
    console.error("[LINE]  Push送信失敗");
    throw new Error("LINE Push 失敗: HTTP " + res.status);
  }
  console.log("[LINE]  Push送信成功");
}

// ===== サンプル3件整形 =====
function formatSamples(items) {
  if (items.length === 0) return "  (なし)";
  return items.slice(0, 3).map((x) => `  ${x.date} ${x.staff}`).join("\n");
}

// ===== メイン =====
async function main() {
  console.log("========================================");
  console.log("[START] notify-check.js");
  console.log(`[TIME]  現在JST時刻: ${getNowJSTWithSeconds()}`);
  console.log(`[CONFIG] TEST_NOTIFY=${TEST_NOTIFY} DRY_RUN=${DRY_RUN}`);
  console.log(`[FIREBASE] base URL: ${FB_DB_URL}`);
  console.log("========================================");

  // ── テスト通知モード ──
  if (TEST_NOTIFY) {
    console.log("[TEST]  testNotify=true → Firebase スキップ・テスト通知送信");
    const testMessage =
      "【穂乃味タイムカード】\nテスト通知\n\n" +
      "LINE通知設定は正常です。\n\n" +
      `送信時刻：${getNowJSTWithSeconds()}`;
    if (DRY_RUN) {
      console.log("[DRY]   dryRun=true → LINE送信スキップ (testNotify)");
      console.log("[DRY]   送信予定メッセージ ↓");
      console.log("---");
      console.log(testMessage);
      console.log("---");
    } else {
      await sendLineMessage(testMessage);
    }
    console.log("[DONE]  テスト通知完了");
    return;
  }

  const today  = getTodayJST();
  const cutoff = getCutoffJST();
  console.log(`[DATE]  基準日(JST今日): ${today}`);
  console.log(`[DATE]  直近30日範囲: ${cutoff} ～ ${today} (前日まで)`);

  // ── Firebase 認証 ──
  console.log("[AUTH]  Firebase Anonymous Auth 開始");
  const idToken = await getFirebaseIdToken();
  console.log("[AUTH]  idToken 取得完了");

  // ── tc5_records 取得 ──
  const rawRecords = await fetchRTDB("tc5_records", idToken);
  const allRecords = rawRecords == null
    ? []
    : Array.isArray(rawRecords)
      ? rawRecords
      : Object.values(rawRecords);
  const records = allRecords.filter(Boolean);
  console.log(`[RTDB]  tc5_records 総件数: ${records.length}`);

  // ── 特定レコード raw JSON 確認（文字化け調査: id=1778822455178） ──
  const TARGET_ID = "1778822455178";
  const targetByKey = rawRecords && typeof rawRecords === "object" ? rawRecords[TARGET_ID] : null;
  const targetById  = records.find((r) => String(r.id) === TARGET_ID);
  const targetRec   = targetByKey || targetById || null;
  console.log(`[RAW]   対象レコード id=${TARGET_ID}`);
  if (targetRec) {
    console.log(`[RAW]   JSON.stringify: ${JSON.stringify(targetRec)}`);
    const staffVal  = targetRec.staff;
    const staffCode = staffVal
      ? [...staffVal].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ")
      : "(なし)";
    console.log(`[RAW]   staff        : ${staffVal}`);
    console.log(`[RAW]   staff charCode: ${staffCode}`);
    if (targetRec.name)         console.log(`[RAW]   name         : ${targetRec.name}`);
    if (targetRec.staffName)    console.log(`[RAW]   staffName    : ${targetRec.staffName}`);
    if (targetRec.employeeName) console.log(`[RAW]   employeeName : ${targetRec.employeeName}`);
    if (targetRec.staffId)      console.log(`[RAW]   staffId      : ${targetRec.staffId}`);
  } else {
    console.log(`[RAW]   該当レコードなし（id=${TARGET_ID} は存在しないか既に削除済み）`);
  }

  // ── tc5_approvals 取得 ──
  const rawApprovals = await fetchRTDB("tc5_approvals", idToken);
  const approvals = (rawApprovals && typeof rawApprovals === "object") ? rawApprovals : {};
  console.log(`[RTDB]  tc5_approvals 件数: ${Object.keys(approvals).length}`);

  // ========================================
  // ■ 未承認チェック
  // 対象: date < today、deleted=false
  // 条件: tc5_approvals にキーなし
  // ========================================
  console.log("[CHECK] 未承認チェック開始");
  const seenUnapproved = {};
  const unapprovedList = [];
  const unapprovedDebug = {}; // key → 代表レコード（文字化け調査用）

  records
    .filter((r) => r.date >= cutoff && r.date < today && !r.deleted)
    .forEach((r) => {
      const key = `${r.date}__${r.staff}`;
      if (seenUnapproved[key]) return;
      seenUnapproved[key] = true;
      if (!approvals[key]) {
        unapprovedList.push({ date: r.date, staff: r.staff });
        unapprovedDebug[key] = r;
      }
    });

  console.log(`[CHECK] 未承認: ${unapprovedList.length} 件`);
  unapprovedList.slice(0, 3).forEach((x) => console.log(`  ${x.date} ${x.staff}`));

  // 文字化け調査ログ（未承認先頭3件の全フィールド）
  console.log("[DEBUG] 未承認 詳細 (先頭3件):");
  unapprovedList.slice(0, 3).forEach((x) => {
    const r = unapprovedDebug[`${x.date}__${x.staff}`];
    if (!r) return;
    const staffCodes = [...(r.staff || "")].map((c) =>
      "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")
    ).join(" ");
    console.log("  ---");
    console.log(`  id/key       : ${r.id || "(なし)"}`);
    console.log(`  date         : ${r.date}`);
    console.log(`  staff        : ${r.staff}`);
    console.log(`  charCode     : ${staffCodes}`);
    console.log(`  type         : ${r.type}`);
    console.log(`  time         : ${r.time}`);
    console.log(`  facilityName : ${r.facilityName || ""}`);
    console.log(`  homeFacility : ${r.homeFacility || ""}`);
    console.log(`  workFacility : ${r.workFacility || ""}`);
  });

  // ========================================
  // ■ 打刻漏れチェック
  // 対象: date < today、deleted=false
  // 条件: clockInあり・clockOutなし または clockInなし・clockOutあり
  //        承認済みは除外
  // ========================================
  console.log("[CHECK] 打刻漏れチェック開始");
  const punchMap = {};

  records
    .filter((r) => r.date >= cutoff && r.date < today && !r.deleted)
    .forEach((r) => {
      const key = `${r.date}__${r.staff}`;
      if (!punchMap[key]) {
        punchMap[key] = { date: r.date, staff: r.staff, hasIn: false, hasOut: false };
      }
      if (r.type === "clockIn")  punchMap[key].hasIn  = true;
      if (r.type === "clockOut") punchMap[key].hasOut = true;
    });

  const missingList = Object.values(punchMap).filter((x) => {
    if (approvals[`${x.date}__${x.staff}`]) return false;
    return x.hasIn !== x.hasOut;
  });

  console.log(`[CHECK] 打刻漏れ: ${missingList.length} 件`);
  missingList.slice(0, 3).forEach((x) => {
    const status = x.hasIn ? "clockInのみ" : "clockOutのみ";
    console.log(`  ${x.date} ${x.staff} (${status})`);
  });

  // ========================================
  // ■ 時刻修正チェック（本日JST分のみ）
  // 対象: editedByAdmin=true、editedAt が JST今日、deleted=false
  // ========================================
  console.log("[CHECK] 時刻修正チェック開始");
  const seenEdited = {};
  const editedList = [];

  records
    .filter((r) => r.editedByAdmin && r.editedAt && !r.deleted)
    .forEach((r) => {
      if (isoToDateJST(r.editedAt) !== today) return;
      const key = r.id || `${r.date}__${r.staff}__${r.type}`;
      if (seenEdited[key]) return;
      seenEdited[key] = true;
      editedList.push({ date: r.date, staff: r.staff, type: r.type, editedAt: r.editedAt, editedFrom: r.editedFrom, editedFields: r.editedFields });
    });

  console.log(`[CHECK] 時刻修正(本日): ${editedList.length} 件`);
  editedList.slice(0, 3).forEach((x) => {
    console.log(`  date=${x.date} staff=${x.staff} type=${x.type}`);
    console.log(`  editedAt=${x.editedAt}`);
    console.log(`  editedFrom=${x.editedFrom} editedFields=${JSON.stringify(x.editedFields)}`);
  });

  // ========================================
  // ■ 集計サマリー
  // ========================================
  const unapprovedCount = unapprovedList.length;
  const missingCount    = missingList.length;
  const editedCount     = editedList.length;
  const total = unapprovedCount + missingCount + editedCount;

  console.log("========================================");
  console.log("[RESULT] 集計結果");
  console.log(`  未承認  : ${unapprovedCount} 件`);
  console.log(`  打刻漏れ: ${missingCount} 件`);
  console.log(`  時刻修正: ${editedCount} 件`);
  console.log(`  合計    : ${total} 件`);
  console.log("========================================");
  console.log("[SAMPLE] 未承認 サンプル3件:");
  console.log(formatSamples(unapprovedList));
  console.log("[SAMPLE] 打刻漏れ サンプル3件:");
  console.log(formatSamples(missingList));
  console.log("[SAMPLE] 時刻修正 サンプル3件:");
  console.log(formatSamples(editedList));

  // 文字コード確認（文字化けデバッグ用・先頭1件のみ）
  const debugStaff = (unapprovedList[0] || missingList[0] || editedList[0] || {}).staff || "";
  if (debugStaff) {
    const codes = [...debugStaff].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
    console.log(`[CHARCODE] "${debugStaff}" → ${codes}`);
  }

  // ── 対象なしなら通知スキップ ──
  if (total === 0) {
    console.log("[OK]    通知対象なし — LINE送信スキップ");
    return;
  }

  // ── LINE 通知本文 ──
  const message =
    "【穂乃味タイムカード】\n\n" +
    `未承認：${unapprovedCount}件\n` +
    `打刻漏れ：${missingCount}件\n` +
    `時刻修正：${editedCount}件\n\n` +
    "▼管理者画面\n" +
    "https://rsb79692-create.github.io/timecard/?token=all";

  if (DRY_RUN) {
    console.log("[DRY]   dryRun=true → LINE送信スキップ");
    console.log("[DRY]   送信予定メッセージ ↓");
    console.log("---");
    console.log(message);
    console.log("---");
  } else {
    await sendLineMessage(message);
  }
  console.log("[DONE]  処理完了");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
