/**
 * fcm-check.js
 * 打刻修正申請の承認待ち件数を確認し FCM Push で管理者端末へ通知する。
 * GitHub Actions から実行。Node.js 標準モジュールのみ（npm install 不要）。
 * FCM HTTP v1 API + サービスアカウント JWT 認証。
 */

"use strict";

const https = require("https");
const crypto = require("crypto");

// ===== Secrets バリデーション =====
const REQUIRED_SECRETS = [
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_SERVICE_ACCOUNT_KEY",
];
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("[ERROR] 未設定の GitHub Secret: " + missing.join(", "));
  process.exit(1);
}

const FB_API_KEY = process.env.FIREBASE_API_KEY;
const FB_DB_URL = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, "");
const DRY_RUN = (process.env.DRY_RUN || "").trim() === "true";

let SERVICE_ACCOUNT;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("[ERROR] FIREBASE_SERVICE_ACCOUNT_KEY が有効な JSON ではありません");
  process.exit(1);
}

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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ===== Firebase Anonymous Auth（RTDB アクセス用）=====
async function getFirebaseIdToken() {
  const res = await httpRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ returnSecureToken: true })
  );
  if (res.status !== 200 || !res.body || !res.body.idToken) {
    throw new Error(`Firebase Auth 失敗 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body.idToken;
}

// ===== Firebase RTDB GET =====
async function fetchRTDB(path, idToken) {
  const logUrl = `${FB_DB_URL}/${path}.json`;
  console.log(`[RTDB]  GET ${logUrl}`);
  const res = await httpRequest(`${logUrl}?auth=${idToken}`);
  console.log(`[RTDB]  HTTP ${res.status}`);
  if (res.status !== 200) {
    throw new Error(`RTDB GET 失敗 (${path}): HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body;
}

// ===== Firebase RTDB PATCH =====
async function patchRTDB(path, idToken, data) {
  const url = `${FB_DB_URL}/${path}.json?auth=${idToken}`;
  return httpRequest(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
  }, JSON.stringify(data));
}

// ===== FCM v1 API: サービスアカウント JWT → OAuth2 アクセストークン =====
function createGoogleJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const sigInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(sigInput, "ascii");
  const sig = signer.sign({ key: sa.private_key, padding: crypto.constants.RSA_PKCS1_PADDING }, "base64url");
  return `${sigInput}.${sig}`;
}

async function getAccessToken(sa) {
  const jwt = createGoogleJWT(sa);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res = await httpRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, body);
  if (!res.body || !res.body.access_token) {
    throw new Error(`OAuth2 アクセストークン取得失敗: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body.access_token;
}

// ===== FCM v1 API: data-only メッセージ送信 =====
async function sendFcmV1(token, count, projectId, accessToken) {
  const payload = JSON.stringify({
    message: {
      token,
      data: { pendingCount: String(count), type: "correction" },
      android: { priority: "high" },
    },
  });
  return httpRequest(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    payload
  );
}

// ===== メイン =====
async function main() {
  console.log("========================================");
  console.log("[START] fcm-check.js");
  console.log(`[TIME]  ${new Date().toISOString()}`);
  console.log(`[CONFIG] DRY_RUN=${DRY_RUN}`);
  console.log("========================================");

  // RTDB 認証
  const idToken = await getFirebaseIdToken();
  console.log("[AUTH]  idToken 取得完了");

  // 修正申請取得
  const raw = await fetchRTDB("tc5_correction_requests", idToken);
  const requests = raw == null
    ? []
    : Array.isArray(raw) ? raw.filter(Boolean) : Object.values(raw).filter(Boolean);
  const pendingCount = requests.filter((r) => r && r.status === "pending").length;
  console.log(`[COUNT] 承認待ち: ${pendingCount} 件`);

  if (pendingCount === 0) {
    console.log("[SKIP]  承認待ちなし → 通知スキップ");
    return;
  }

  // 前回送信と同件数なら重複送信しない
  const stateRaw = await fetchRTDB("tc5_fcm_state", idToken).catch(() => null);
  const lastSentCount = (stateRaw && stateRaw.lastSentCount != null) ? stateRaw.lastSentCount : -1;
  if (lastSentCount === pendingCount) {
    console.log(`[SKIP]  前回送信 (${lastSentCount}件) と変化なし → 再送スキップ`);
    return;
  }

  // FCM トークン取得
  const tokensRaw = await fetchRTDB("tc5_fcm_tokens", idToken).catch(() => null);
  const tokenList = tokensRaw
    ? Object.values(tokensRaw).map((t) => t && t.token).filter(Boolean)
    : [];
  console.log(`[TOKENS] 登録済み ${tokenList.length} 件`);

  if (tokenList.length === 0) {
    console.log("[SKIP]  FCM トークン未登録 → 通知スキップ");
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY]   ${tokenList.length} 端末へ pendingCount=${pendingCount} を送信予定（dryRun=true のためスキップ）`);
    return;
  }

  // OAuth2 アクセストークン取得（FCM v1 API 用）
  const accessToken = await getAccessToken(SERVICE_ACCOUNT);
  console.log("[AUTH]  FCM アクセストークン取得完了");

  // 各端末へ送信
  let successCount = 0;
  for (const token of tokenList) {
    try {
      const res = await sendFcmV1(token, pendingCount, SERVICE_ACCOUNT.project_id, accessToken);
      console.log(`[FCM]   HTTP ${res.status} ${JSON.stringify(res.body)}`);
      if (res.status === 200) successCount++;
    } catch (e) {
      console.warn(`[FCM]   送信エラー: ${e.message}`);
    }
  }

  // 送信済み件数を RTDB に記録
  await patchRTDB("tc5_fcm_state", idToken, {
    lastSentCount: pendingCount,
    lastSentAt: new Date().toISOString(),
  }).catch((e) => console.warn("[RTDB]  state 保存失敗:", e.message));

  console.log(`[DONE]  ${successCount}/${tokenList.length} 端末への通知完了`);
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
