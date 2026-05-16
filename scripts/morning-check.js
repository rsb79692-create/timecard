/**
 * morning-check.js — Phase 2-D
 * 朝出勤未確認施設を Firebase RTDB から取得し LINE へ Push 通知する
 * GitHub Actions から実行。Node.js 標準モジュールのみ使用（npm install 不要）。
 */

"use strict";

const https = require("https");

// ===== Secrets バリデーション =====
const REQUIRED_SECRETS = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_TO_ID",
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
];
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[ERROR] 以下の GitHub Secret が未設定です: ${missing.join(", ")}`);
  process.exit(1);
}

const FB_API_KEY = process.env.FIREBASE_API_KEY;
// FIREBASE_DATABASE_URL は "https://xxx.asia-southeast1.firebasedatabase.app/honomi" を想定
const FB_DB_URL  = process.env.FIREBASE_DATABASE_URL;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // ログ出力禁止
const LINE_TO    = process.env.LINE_TO_ID;

// ===== DEFAULT_FACILITIES（index.html と同じ内容） =====
const DEFAULT_FACILITIES = [
  "ナナイロ", "ココラ", "ハーベスト",
  "ミュゲ貝塚", "ミュゲ春木", "ミュゲの泉", "ハルイロ",
];

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

// ===== JST 今日の日付 yyyy-mm-dd =====
function getTodayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ===== JST 現在時刻文字列 YYYY/MM/DD HH:mm =====
function getNowJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${h}:${min}`;
}

// ===== Firebase Anonymous Auth =====
async function getFirebaseIdToken() {
  const res = await httpRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    JSON.stringify({ returnSecureToken: true })
  );
  if (!res.body || !res.body.idToken) {
    throw new Error("Firebase Anonymous Auth 失敗: " + JSON.stringify(res.body));
  }
  return res.body.idToken; // idToken はログ出力禁止
}

// ===== Firebase RTDB GET =====
async function fetchRTDB(path, idToken) {
  // idToken をクエリパラメータで渡す（index.html と同じ方式）
  const url = `${FB_DB_URL}/${path}.json?auth=${idToken}`;
  const res = await httpRequest(url);
  if (res.status !== 200) {
    throw new Error(`RTDB fetch 失敗 (${path}): HTTP ${res.status}`);
  }
  return res.body;
}

// ===== LINE Push 通知 =====
async function sendLineMessage(text) {
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
        "Authorization": "Bearer " + LINE_TOKEN, // トークンはログに出さない
      },
    },
    payload
  );
  if (res.status !== 200) {
    throw new Error("LINE Push 失敗: HTTP " + res.status + " " + JSON.stringify(res.body));
  }
  console.log("[LINE] Push 送信成功");
}

// ===== メイン =====
async function main() {
  console.log("[START] morning-check.js");

  // 1. Firebase 認証（idToken はログに出さない）
  const idToken = await getFirebaseIdToken();
  console.log("[AUTH] Firebase idToken 取得完了");

  // 2. records 取得
  const rawRecords = await fetchRTDB("tc5_records", idToken);
  const records = rawRecords == null
    ? []
    : Array.isArray(rawRecords)
      ? rawRecords
      : Object.values(rawRecords);
  console.log(`[RTDB] records 件数: ${records.length}`);

  // 3. 施設マスタ取得（Firebase 優先、なければ DEFAULT_FACILITIES）
  let facilities = DEFAULT_FACILITIES.slice();
  try {
    const rawLocs = await fetchRTDB("master/locations", idToken);
    if (rawLocs == null) {
      console.log("[RTDB] 施設マスタが null → DEFAULT_FACILITIES を使用");
    } else if (Array.isArray(rawLocs) && rawLocs.length > 0) {
      const names = rawLocs.map((f) => (typeof f === "string" ? f : f && f.name)).filter(Boolean);
      if (names.length > 0) { facilities = names; }
      console.log(`[RTDB] 施設マスタ取得: ${facilities.join(", ")}`);
    } else if (typeof rawLocs === "object") {
      const names = Object.values(rawLocs)
        .map((f) => (typeof f === "string" ? f : f && f.name))
        .filter(Boolean);
      if (names.length > 0) { facilities = names; }
      console.log(`[RTDB] 施設マスタ取得(object): ${facilities.join(", ")}`);
    }
  } catch (e) {
    console.warn(`[WARN] 施設マスタ取得失敗 → DEFAULT_FACILITIES を使用: ${e.message}`);
  }

  // 4. JST 本日日付
  const today = getTodayJST();
  console.log(`[DATE] 対象日: ${today}`);

  // 5. 本日の clockIn（未削除）から出勤済み施設を収集
  const checked = {};
  records
    .filter((r) => r && r.type === "clockIn" && r.date === today && !r.deleted)
    .forEach((r) => {
      const fac = r.workFacility || r.facilityName || "";
      if (fac) { checked[fac] = true; }
    });
  const checkedList = Object.keys(checked);
  console.log(`[CHECK] 出勤確認済み施設: ${checkedList.length > 0 ? checkedList.join(", ") : "なし"}`);

  // 6. 未確認施設を抽出
  const unconfirmed = facilities.filter((name) => !checked[name]);
  console.log(`[CHECK] 未確認施設 ${unconfirmed.length} 件: ${unconfirmed.length > 0 ? unconfirmed.join(", ") : "なし"}`);

  // 7. 未確認が 0 件なら通知せず終了
  if (unconfirmed.length === 0) {
    console.log("[OK] 未確認施設なし — LINE通知スキップ");
    return;
  }

  // 8. LINE 通知本文
  const nowStr = getNowJST();
  const facilityLines = unconfirmed.map((n) => `・${n}`).join("\n");
  const message =
    "【穂乃味タイムカード】\n朝出勤未確認\n\n" +
    `確認時刻：${nowStr}\n` +
    `未確認施設：${unconfirmed.length}件\n\n` +
    facilityLines + "\n\n" +
    "シフトミス・遅刻・事故の可能性があります。確認してください。";

  // 9. LINE Push 送信
  await sendLineMessage(message);
  console.log("[DONE] 処理完了");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
