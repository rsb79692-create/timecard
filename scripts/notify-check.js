/**
 * notify-check.js — 未承認・打刻漏れ LINE通知
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

// ===== JST 昨日の日付 yyyy-mm-dd =====
function getYesterdayJST() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
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

// =========================================================
// ■ スタッフ名正規化ユーティリティ
//
// キー仕様（未承認・打刻漏れ共通）:
//   date + "__" + normalizeStaff(r.staff)
//
// 文字化けレコード（U+FFFD含む）は 2パスで処理する:
//   Pass-1: 非garbledレコードをマップに登録
//   Pass-2: garbledレコードは既存エントリとの前方一致でマージを試みる
//            一意に特定できた場合のみマージ（曖昧な場合は独立エントリとして追加）
// =========================================================

// NFKC正規化 → U+FFFD除去 → 空白除去 → trim
// 正規化後が空文字になる場合はログを出して raw を返す（除外しない）
function normalizeStaff(raw) {
  if (!raw || typeof raw !== "string") return raw || "";
  const n = raw.normalize("NFKC").replace(/�/g, "").replace(/\s/g, "").trim();
  if (n === "") {
    console.log(`[WARN]  normalizeStaff: 正規化後に空文字 rawStaff="${raw}" → raw のまま使用`);
    return raw;
  }
  return n;
}

// U+FFFD が含まれるか（文字化け判定）
function isGarbled(s) {
  return typeof s === "string" && s.includes("�");
}

// mapObj の中から date+staff が前方一致する唯一のキーを返す。
// 一致が 0 件または 2 件以上の場合は null を返す（曖昧マージを避ける）。
function findGarbledMatch(mapObj, date, garbledNormStaff) {
  const prefix = `${date}__`;
  const candidates = Object.keys(mapObj).filter((k) => {
    if (!k.startsWith(prefix)) return false;
    const existing = k.slice(prefix.length);
    return existing.startsWith(garbledNormStaff) || garbledNormStaff.startsWith(existing);
  });
  if (candidates.length === 1) return candidates[0];
  return null;
}

// approvals に date+staff のキーが存在するか
// raw キー → 正規化キー → garbled 前方一致 の順に照合
function approvalsHas(approvals, date, rawStaff) {
  const rawKey  = `${date}__${rawStaff}`;
  const normKey = `${date}__${normalizeStaff(rawStaff)}`;
  if (approvals[rawKey]) return true;
  if (normKey !== rawKey && approvals[normKey]) return true;
  if (isGarbled(rawStaff)) {
    const match = findGarbledMatch(approvals, date, normalizeStaff(rawStaff));
    if (match !== null) return true;
  }
  return false;
}

// LINE 本文用の表示名
// 文字化けがある場合は壊れた文字を出さず代替テキストを返す
function displayName(rawStaff, date, facility) {
  if (isGarbled(rawStaff)) {
    return `氏名文字化けあり(${facility})`;
  }
  return rawStaff;
}

// ===== 文字化け診断 charCode ログ（一時的） =====
// Firebase保存データ自体の文字化けか、JS処理中の変換失敗かを判別するため。
// rawStaff に U+FFFD が含まれていれば Firebase 保存データ自体が文字化けしている可能性が高い。
function logCharCodes(label, str) {
  if (!str || typeof str !== "string") return;
  const codes = [...str]
    .map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");
  console.log(`[CHARCODE] ${label}: "${str}" → ${codes}`);
}

// ===== 通知本文用明細行フォーマット =====
// 最大 MAX_DETAIL_LINES 件を詳細表示し、超える分は「他 N 件」と追記
const MAX_DETAIL_LINES = 5;

function formatUnapprovedLines(items) {
  if (items.length === 0) return "（なし）";
  const shown = items.slice(0, MAX_DETAIL_LINES);
  const rest  = items.length - shown.length;
  const lines = shown.map(
    (x) => `・${x.date} ${displayName(x.rawStaff, x.date, x.facility)}`
  );
  if (rest > 0) lines.push(`  他 ${rest} 件`);
  return lines.join("\n");
}

function formatMissingLines(items) {
  if (items.length === 0) return "（なし）";
  const shown = items.slice(0, MAX_DETAIL_LINES);
  const rest  = items.length - shown.length;
  const lines = shown.map((x) => {
    let reason;
    if (x.hasIn !== x.hasOut) {
      reason = x.hasIn ? "（退勤漏れ）" : "（出勤漏れ）";
    } else if (x.hasBreakStart && !x.hasBreakEnd) {
      reason = "（休憩終了漏れ）";
    } else {
      reason = "（打刻不整合）";
    }
    return `・${x.date} ${displayName(x.rawStaff, x.date, x.facility)}${reason}`;
  });
  if (rest > 0) lines.push(`  他 ${rest} 件`);
  return lines.join("\n");
}

// =========================================================
// ■ 通知範囲の提案（方針4 / 選択肢）
//
// 現在: 前日分のみ（yesterday）
// → 古い未処理は再通知されない。当日分は翌日の通知で拾う。
//
// 直近30日全体に戻す場合:
//   targetRecords のフィルタを以下に変更する:
//     const cutoff = getCutoffJST();  // 30日前の日付
//     r.date >= cutoff && r.date < today
//   LINE本文の期間表記も「直近30日分: ${cutoff}〜${yesterday}」に変更する。
// =========================================================

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

  const today     = getTodayJST();
  const yesterday = getYesterdayJST();
  console.log(`[DATE]  基準日(JST今日): ${today}`);
  console.log(`[DATE]  通知対象日(前日): ${yesterday}`);

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

  // ── tc5_approvals 取得 ──
  const rawApprovals = await fetchRTDB("tc5_approvals", idToken);
  const approvals = (rawApprovals && typeof rawApprovals === "object") ? rawApprovals : {};
  console.log(`[RTDB]  tc5_approvals 件数: ${Object.keys(approvals).length}`);

  // 対象レコードを先に絞る（未承認・打刻漏れ両方で共用）
  // 【通知範囲: 前日分のみ（今日当日は含まない）】
  // 直近30日全体に戻す場合は上記「通知範囲の提案（方針4）」コメントを参照
  const targetRecords = records.filter(
    (r) => r.date === yesterday && !r.deleted
  );
  // 非garbledを先に処理し、garbledがマージ対象を見つけられるようにする
  const sortedTarget = [
    ...targetRecords.filter((r) => !isGarbled(r.staff)),
    ...targetRecords.filter((r) =>  isGarbled(r.staff)),
  ];

  // ========================================
  // ■ 未承認チェック
  // 対象: date === yesterday、deleted=false
  // 条件: tc5_approvals にキーなし（raw/正規化/前方一致で照合）
  // ========================================
  console.log("[CHECK] 未承認チェック開始");
  const seenUnapproved = {};
  const unapprovedList = [];

  sortedTarget.forEach((r) => {
    const normStaff = normalizeStaff(r.staff);
    let key = `${r.date}__${normStaff}`;

    if (isGarbled(r.staff)) {
      const matched = findGarbledMatch(seenUnapproved, r.date, normStaff);
      if (matched !== null) key = matched;
    }

    if (seenUnapproved[key]) return;
    seenUnapproved[key] = true;

    if (!approvalsHas(approvals, r.date, r.staff)) {
      unapprovedList.push({
        rawStaff:        r.staff,
        normalizedStaff: normStaff,
        date:            r.date,
        facility:        r.workFacility || r.facilityName || "施設不明",
      });
    }
  });

  console.log(`[CHECK] 未承認: ${unapprovedList.length} 件`);
  unapprovedList.forEach((x) => {
    const rawKey  = `${x.date}__${x.rawStaff}`;
    const normKey = `${x.date}__${x.normalizedStaff}`;
    console.log(
      `[UNAPPROVED_DETAIL]` +
      ` date=${x.date}` +
      ` rawStaff=${x.rawStaff}` +
      ` normalizedStaff=${x.normalizedStaff}` +
      ` garbled=${isGarbled(x.rawStaff)}` +
      ` facility=${x.facility}` +
      ` approvalKey(raw)=${rawKey}` +
      ` approvalValue(raw)=${JSON.stringify(approvals[rawKey])}` +
      ` approvalKey(norm)=${normKey}` +
      ` approvalValue(norm)=${JSON.stringify(approvals[normKey])}`
    );
    // 文字化けが検出された場合: Firebase保存データ自体の文字化けかを判別するための charCode ログ
    if (isGarbled(x.rawStaff)) {
      logCharCodes("UNAPPROVED rawStaff", x.rawStaff);
    }
  });

  // ========================================
  // ■ 打刻漏れチェック
  // 対象: date === yesterday、deleted=false
  // キー: date + "__" + normalizeStaff(r.staff)
  // garbledレコードは非garbledエントリへ前方一致マージ
  // 条件: clockInあり・clockOutなし または clockInなし・clockOutあり
  //        承認済みは除外（raw/正規化/前方一致で照合）
  // ========================================
  console.log("[CHECK] 打刻漏れチェック開始");
  const punchMap = {};

  sortedTarget.forEach((r) => {
    const normStaff = normalizeStaff(r.staff);
    let key = `${r.date}__${normStaff}`;

    if (isGarbled(r.staff)) {
      const matched = findGarbledMatch(punchMap, r.date, normStaff);
      if (matched !== null) {
        console.log(
          `[GARBLED_MERGE]` +
          ` date=${r.date}` +
          ` rawStaff="${r.staff}"` +
          ` norm="${normStaff}"` +
          ` type=${r.type}` +
          ` → merged into key="${matched}"`
        );
        key = matched;
      } else {
        console.log(
          `[GARBLED_NEW]` +
          ` date=${r.date}` +
          ` rawStaff="${r.staff}"` +
          ` norm="${normStaff}"` +
          ` type=${r.type}` +
          ` → 既存マッチなし、新規キー="${key}"`
        );
      }
    }

    if (!punchMap[key]) {
      punchMap[key] = {
        rawStaff:        r.staff,
        normalizedStaff: normStaff,
        date:            r.date,
        facility:        r.workFacility || r.facilityName || "施設不明",
        hasIn:           false,
        hasOut:          false,
        inTime:          null,
        outTime:         null,
        hasBreakStart:   false,
        hasBreakEnd:     false,
      };
    }
    if (r.type === "clockIn")    { punchMap[key].hasIn        = true; punchMap[key].inTime  = r.time || null; }
    if (r.type === "clockOut")   { punchMap[key].hasOut       = true; punchMap[key].outTime = r.time || null; }
    if (r.type === "breakStart") { punchMap[key].hasBreakStart = true; }
    if (r.type === "breakEnd")   { punchMap[key].hasBreakEnd   = true; }
    if (punchMap[key].facility === "施設不明") {
      punchMap[key].facility = r.workFacility || r.facilityName || "施設不明";
    }
    // 文字化けのない rawStaff が後から現れたら上書きして保持
    if (isGarbled(punchMap[key].rawStaff) && !isGarbled(r.staff)) {
      punchMap[key].rawStaff = r.staff;
    }
  });

  const missingList = Object.values(punchMap).filter((x) => {
    if (approvalsHas(approvals, x.date, x.rawStaff)) return false;
    // clockIn/clockOut の不整合
    if (x.hasIn !== x.hasOut) return true;
    // breakStart あり・breakEnd なし（出退勤が揃っている場合のみ追加検出）
    if (x.hasBreakStart && !x.hasBreakEnd) return true;
    return false;
  });

  console.log(`[CHECK] 打刻漏れ: ${missingList.length} 件`);
  missingList.forEach((x) => {
    let reason;
    if (x.hasIn !== x.hasOut) {
      reason = x.hasIn ? "退勤漏れ(clockInのみ)" : "出勤漏れ(clockOutのみ)";
    } else if (x.hasBreakStart && !x.hasBreakEnd) {
      reason = "休憩終了漏れ(breakStartのみ)";
    } else {
      reason = "打刻不整合";
    }
    console.log(
      `[MISSING_DETAIL]` +
      ` date=${x.date}` +
      ` rawStaff=${x.rawStaff}` +
      ` normalizedStaff=${x.normalizedStaff}` +
      ` garbled=${isGarbled(x.rawStaff)}` +
      ` facility=${x.facility}` +
      ` clockIn=${x.inTime  ?? "なし"}` +
      ` clockOut=${x.outTime ?? "なし"}` +
      ` breakStart=${x.hasBreakStart}` +
      ` breakEnd=${x.hasBreakEnd}` +
      ` reason=${reason}`
    );
    // 文字化けが検出された場合: Firebase保存データ自体の文字化けかを判別するための charCode ログ
    if (isGarbled(x.rawStaff)) {
      logCharCodes("MISSING rawStaff", x.rawStaff);
    }
  });

  // ========================================
  // ■ 集計サマリー
  // ========================================
  const unapprovedCount = unapprovedList.length;
  const missingCount    = missingList.length;
  const total = unapprovedCount + missingCount;

  console.log("========================================");
  console.log("[RESULT] 集計結果");
  console.log(`  未承認  : ${unapprovedCount} 件`);
  console.log(`  打刻漏れ: ${missingCount} 件`);
  console.log(`  合計    : ${total} 件`);
  console.log("========================================");
  console.log("[DETAIL] 未承認 一覧:");
  console.log(formatUnapprovedLines(unapprovedList));
  console.log("[DETAIL] 打刻漏れ 一覧:");
  console.log(formatMissingLines(missingList));

  // ── 対象なしなら通知スキップ ──
  if (total === 0) {
    console.log("[OK]    通知対象なし — LINE送信スキップ");
    return;
  }

  // ── LINE 通知本文 ──
  // タイトル: morning-check.js の「朝出勤未確認」と混同しないよう「未承認・打刻漏れ通知」と明記
  const unapprovedSection =
    `▼未承認（${unapprovedCount}件）\n` +
    formatUnapprovedLines(unapprovedList);

  const missingSection =
    `▼打刻漏れ（${missingCount}件）\n` +
    formatMissingLines(missingList);

  const message =
    "【穂乃味タイムカード】\n" +
    "未承認・打刻漏れ通知\n" +
    `（前日分: ${yesterday}）\n\n` +
    unapprovedSection + "\n\n" +
    missingSection + "\n\n" +
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
