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
// ⚠ FIREBASE_API_KEY はもう使わない（RTDB を匿名で叩くのをやめたため）。
const REQUIRED_SECRETS = [
  "FIREBASE_DATABASE_URL",
  "FIREBASE_SERVICE_ACCOUNT_KEY",
];
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("[ERROR] 未設定の GitHub Secret: " + missing.join(", "));
  process.exit(1);
}

const FB_DB_URL = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, "");
const DRY_RUN = (process.env.DRY_RUN || "").trim() === "true";

let SERVICE_ACCOUNT;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("[ERROR] FIREBASE_SERVICE_ACCOUNT_KEY が有効な JSON ではありません");
  process.exit(1);
}
// ⚠ 値は絶対に出さない。欠けているキー名だけを出す。
{
  const lack = ["client_email", "private_key", "project_id"].filter((k) => !SERVICE_ACCOUNT[k]);
  if (lack.length) {
    console.error("[ERROR] FIREBASE_SERVICE_ACCOUNT_KEY に次のキーがありません: " + lack.join(", "));
    process.exit(1);
  }
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
      // ⚠ setEncoding を入れないと、chunk の境界でマルチバイト文字が壊れる（氏名が U+FFFD になる）。
      //   RTDB の応答は本番 1MB 超で必ず複数 chunk に割れる。
      res.setEncoding("utf8");
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

// ===== Firebase RTDB（サービスアカウントで読み書きする）=====
// ⚠⚠ 以前はここで accounts:signUp の匿名アカウントを作って ?auth= で叩いていた。
//    その経路は 2026-09-06 に廃止した。匿名アカウントは公開 apiKey で誰でも作れるため、
//    「匿名なら読める」というルールを残すと、このジョブと攻撃者を区別できない。
//    このジョブが読む tc5_correction_requests / tc5_fcm_state / tc5_fcm_tokens は
//    役割トークンを持つ人だけが触れる領域になった。ジョブは人ではないので、
//    FCM 送信と同じサービスアカウントの資格で入る。
// ⚠ 打刻に要る tc5_records / tc5_pins / tc5_staff / master / tc_master_depts は、
//    いまも匿名で読める（打刻端末は起動時に役割を持てないため）。**穴が全部塞がったわけではない。**
// ⚠ アクセストークンは絶対にログへ出さない。

// ===== Firebase RTDB GET =====
async function fetchRTDB(path, accessToken) {
  const logUrl = `${FB_DB_URL}/${path}.json`;
  console.log(`[RTDB]  GET ${logUrl}`);
  const res = await httpRequest(logUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  console.log(`[RTDB]  HTTP ${res.status}`);
  if (res.status !== 200) {
    throw new Error(`RTDB GET 失敗 (${path}): HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body;
}

// ===== Firebase RTDB PATCH =====
// ⚠ httpRequest は通信エラーでしか reject しない。401/403 でも resolve するので、
//   ここでステータスを見ないと呼び出し側の .catch が一生発火しない。
//   その場合 tc5_fcm_state が更新されず、30分ごとに同じ通知を送り続ける。
async function patchRTDB(path, accessToken, data) {
  const url = `${FB_DB_URL}/${path}.json`;
  return httpRequest(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  }, JSON.stringify(data)).then((res) => {
    if (res.status !== 200) {
      throw new Error(`RTDB PATCH 失敗 (${path}): HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    return res;
  });
}

// ===== FCM v1 API: サービスアカウント JWT → OAuth2 アクセストークン =====
function createGoogleJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    // ⚠ RTDB も同じアクセストークンで叩く。firebase.database と userinfo.email を
    //    外すと RTDB REST が 401 を返す（FCM だけなら messaging で足りる）。
    scope: [
      "https://www.googleapis.com/auth/firebase.messaging",
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
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

  // RTDB 認証（サービスアカウント。匿名サインインは廃止した）
  const accessToken = await getAccessToken(SERVICE_ACCOUNT);
  console.log("[AUTH]  アクセストークン取得完了");

  // 修正申請取得
  const raw = await fetchRTDB("tc5_correction_requests", accessToken);
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
  const stateRaw = await fetchRTDB("tc5_fcm_state", accessToken).catch(() => null);
  const lastSentCount = (stateRaw && stateRaw.lastSentCount != null) ? stateRaw.lastSentCount : -1;
  if (lastSentCount === pendingCount) {
    console.log(`[SKIP]  前回送信 (${lastSentCount}件) と変化なし → 再送スキップ`);
    return;
  }

  // FCM トークン取得
  const tokensRaw = await fetchRTDB("tc5_fcm_tokens", accessToken).catch(() => null);
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
  await patchRTDB("tc5_fcm_state", accessToken, {
    lastSentCount: pendingCount,
    lastSentAt: new Date().toISOString(),
  }).catch((e) => {
    // ⚠ ここが失敗し続けると lastSentCount が更新されず、30分おきに同じ通知を送り続ける。
    //   warn だけだとワークフローは緑のままで気づけない。exit code を落として見えるようにする。
    console.error("[ERROR] state 保存失敗:", e.message);
    process.exitCode = 1;
  });

  console.log(`[DONE]  ${successCount}/${tokenList.length} 端末への通知完了`);
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
