/**
 * morning-check.js — Phase 2-D rev.6
 * 朝出勤未確認施設を Firebase RTDB から取得し LINE へ Push 通知する
 * GitHub Actions から実行。Node.js 標準モジュールのみ（npm install 不要）。
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

// LINE_TO_ID: 必須。未設定または "temp" の場合は明確なエラーで停止。
const LINE_TO_ENV = (process.env.LINE_TO_ID || "").trim();
if (!LINE_TO_ENV || LINE_TO_ENV === "temp") {
  console.error("[ERROR] LINE_TO_ID が未設定です");
  console.error("GitHub Secrets → LINE_TO_ID を設定してください");
  process.exit(1);
}

const FB_API_KEY  = process.env.FIREBASE_API_KEY;
const FB_DB_URL   = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, ""); // 末尾スラッシュ除去
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN; // ログ出力禁止
const LINE_TO     = LINE_TO_ENV;

// testNotify=true のとき Firebase をスキップしてテスト通知のみ送信
const TEST_NOTIFY = (process.env.TEST_NOTIFY || "").trim() === "true";

// dryRun=true のとき LINE 送信しない（判定ログのみ）
const DRY_RUN = (process.env.DRY_RUN || "").trim() === "true";

// targetDate: 任意の日付 yyyy-mm-dd。空欄なら JST 今日。
const TARGET_DATE_ENV = (process.env.TARGET_DATE || "").trim();
const IS_DATE_OVERRIDE = /^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE_ENV);

// ===== DEFAULT_FACILITIES（index.html と同じ内容） =====
const DEFAULT_FACILITIES = [
  "ナナイロ", "ココラ", "ハーベスト",
  "ミュゲ貝塚", "ミュゲ春木", "ミュゲの泉", "ハルイロ",
];

// ===== 朝打刻通知から除外する施設 =====
// ハーベストは朝5:55通知の対象外（打刻機能・管理画面は通常通り）
const NOTIFY_EXCLUDE = ["ハーベスト"];

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

// ===== JST 現在時刻文字列 YYYY/MM/DD HH:mm =====
function getNowJST() {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
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
  // auth トークンは URL から除いてログ出力
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

  if (DRY_RUN) {
    console.log("[DRY]   dryRun=true → LINE送信スキップ");
    console.log("[DRY]   送信予定メッセージ ↓");
    console.log("---");
    console.log(text);
    console.log("---");
    return;
  }

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

// ===== メイン =====
async function main() {
  const nowUtc = new Date();

  // ── 起動ログ ──
  console.log("========================================");
  console.log("[START] morning-check.js");
  console.log(`[TIME]  現在UTC時刻: ${nowUtc.toISOString()}`);
  console.log(`[TIME]  現在JST時刻: ${getNowJSTWithSeconds()}`);
  console.log(`[CONFIG] TEST_NOTIFY=${TEST_NOTIFY} DRY_RUN=${DRY_RUN} TARGET_DATE="${TARGET_DATE_ENV || "(なし)"}"`);
  console.log(`[FIREBASE] base URL: ${FB_DB_URL}`);
  console.log("========================================");

  // ── テスト通知モード（Firebase 操作をスキップして即時送信） ──
  if (TEST_NOTIFY) {
    console.log("[TEST]  testNotify=true → Firebase スキップ・テスト通知送信");
    const testMessage =
      "【穂乃味タイムカード】\nテスト通知\n\n" +
      "LINE通知設定は正常です。\n\n" +
      `送信時刻：${getNowJSTWithSeconds()}`;
    await sendLineMessage(testMessage);
    console.log("[DONE]  テスト通知完了");
    return;
  }

  // ── 判定対象日 ──
  const today = IS_DATE_OVERRIDE ? TARGET_DATE_ENV : getTodayJST();
  console.log(`[DATE]  判定対象日: ${today}${IS_DATE_OVERRIDE ? " (手動指定)" : " (JST今日)"}`);

  // ── Firebase 認証 ──
  console.log("[AUTH]  Firebase Anonymous Auth 開始");
  const idToken = await getFirebaseIdToken();
  console.log("[AUTH]  idToken 取得完了");

  // ── records 取得 ──
  console.log("[RTDB]  tc5_records 参照先↓");
  const rawRecords = await fetchRTDB("tc5_records", idToken);
  const records = rawRecords == null
    ? []
    : Array.isArray(rawRecords)
      ? rawRecords
      : Object.values(rawRecords);
  const validRecords = records.filter(Boolean);
  console.log(`[RTDB]  records 総件数: ${validRecords.length}`);
  if (rawRecords == null) {
    console.warn("[WARN]  rawRecords が null です。パスが空または権限エラーの可能性があります。");
    console.warn(`[WARN]  参照 URL: ${FB_DB_URL}/tc5_records.json`);
    console.warn("[WARN]  index.html の FB_URL と FIREBASE_DATABASE_URL Secret が一致しているか確認してください。");
  }

  // ── 施設マスタ取得（Firebase 優先、なければ DEFAULT_FACILITIES） ──
  let facilities = DEFAULT_FACILITIES.slice();
  try {
    console.log("[RTDB]  master/locations 参照先↓");
    const rawLocs = await fetchRTDB("master/locations", idToken);
    if (rawLocs == null) {
      console.log("[RTDB]  master/locations が null → DEFAULT_FACILITIES を使用");
    } else if (Array.isArray(rawLocs) && rawLocs.length > 0) {
      const names = rawLocs
        .map((f) => (typeof f === "string" ? f : f && f.name))
        .filter(Boolean);
      if (names.length > 0) {
        facilities = names;
        console.log(`[RTDB]  master/locations(配列) から ${names.length} 件取得`);
      }
    } else if (typeof rawLocs === "object" && rawLocs !== null) {
      const names = Object.values(rawLocs)
        .map((f) => (typeof f === "string" ? f : f && f.name))
        .filter(Boolean);
      if (names.length > 0) {
        facilities = names;
        console.log(`[RTDB]  master/locations(オブジェクト) から ${names.length} 件取得`);
      }
    }
  } catch (e) {
    console.warn(`[WARN]  master/locations 取得失敗 → DEFAULT_FACILITIES を使用: ${e.message}`);
  }

  // ── 朝通知除外施設を取り除く ──
  facilities = facilities.filter((name) => !NOTIFY_EXCLUDE.includes(name));

  console.log(`[FAC]   通知対象施設 ${facilities.length} 件:`);
  facilities.forEach((name, i) => {
    console.log(`  [${i + 1}] ${name}`);
  });

  // ── 当日 clockIn レコード取得 ──
  const todayClockIns = validRecords.filter(
    (r) => r && r.type === "clockIn" && r.date === today && !r.deleted
  );
  console.log(`[DATE]  対象日 ${today} の clockIn 件数: ${todayClockIns.length}`);

  // ── 施設別に出勤件数を集計 ──
  const facilityClockInCount = {};
  facilities.forEach((name) => { facilityClockInCount[name] = 0; });

  todayClockIns.forEach((r) => {
    const fac = r.workFacility || r.facilityName || "";
    if (fac && Object.prototype.hasOwnProperty.call(facilityClockInCount, fac)) {
      facilityClockInCount[fac]++;
    } else if (fac) {
      // 通知対象外施設（応援等）
      if (!facilityClockInCount["__other__"]) facilityClockInCount["__other__"] = {};
      facilityClockInCount["__other__"][fac] = (facilityClockInCount["__other__"][fac] || 0) + 1;
    }
  });

  // ── 施設別判定ログ ──
  console.log("[CHECK] 施設別出勤状況:");
  const unconfirmed = [];
  facilities.forEach((name) => {
    const count = facilityClockInCount[name] || 0;
    const status = count >= 1 ? "OK  " : "未打";
    console.log(`  [${status}] ${name}  出勤 ${count} 件`);
    if (count === 0) { unconfirmed.push(name); }
  });

  // 通知対象外施設の出勤
  if (facilityClockInCount["__other__"]) {
    const others = Object.entries(facilityClockInCount["__other__"])
      .map(([k, v]) => `${k}(${v}件)`)
      .join(", ");
    console.log(`[CHECK] 通知対象外施設に出勤あり: ${others}`);
  }

  console.log(`[CHECK] 未打刻施設 ${unconfirmed.length} 件: ${unconfirmed.length > 0 ? unconfirmed.join(", ") : "なし"}`);

  // ── 未確認が 0 件なら通知せず終了 ──
  if (unconfirmed.length === 0) {
    console.log("[OK]    全施設出勤確認済み — LINE通知スキップ");
    return;
  }

  // ── LINE 通知本文 ──
  const nowStr = getNowJST();
  const facilityLines = unconfirmed.map((n) => `・${n}`).join("\n");
  const message =
    "【穂乃味タイムカード】\n朝出勤未確認\n\n" +
    `確認時刻：${nowStr}\n` +
    `未確認施設：${unconfirmed.length}件\n\n` +
    facilityLines + "\n\n" +
    "シフトミス・遅刻・事故の可能性があります。確認してください。";

  // ── 送信 ──
  await sendLineMessage(message);
  console.log("[DONE]  処理完了");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
