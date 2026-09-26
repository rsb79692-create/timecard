/**
 * api/discord-notify.js — Vercel サーバーレス関数
 * スタッフが書類をアップロードした際に管理者へ Discord Webhook 通知を送る。
 * DISCORD_WEBHOOK_URL は Vercel 環境変数に設定すること。
 */

"use strict";

const https = require("https");
const T = require("./_lib/tenant");

const ALLOWED_ORIGIN = "https://rsb79692-create.github.io";
// ★ 管理画面URL・社名は会社設定（api/_lib/tenant.js）から引く。共通処理へ直書きしない。

function httpsPost(url, headers, bodyStr) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: Object.assign(
          { "Content-Length": Buffer.byteLength(bodyStr) },
          headers
        ),
      },
      function (res) {
        var data = "";
        res.on("data", function (chunk) { data += chunk; });
        res.on("end", function () {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = T.handler(async function handler(req, res) {
  var origin = req.headers["origin"] || "";

  // CORS: GitHub Pages からのリクエストのみ許可
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 想定外オリジンからの非プリフライトリクエストを拒否
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // ===== 会社 =====
  // ★ 宛先・社名・URL は会社ごと。穂乃味は従来の環境変数名・文言・URLのまま（挙動不変）。
  // ★ 穂乃味以外の会社は、その会社のログイン中トークンを必須にする
  //   （誰でも他社の通知を鳴らせないようにする。穂乃味の既存経路は変えない）。
  var tenant = T.current();
  var ADMIN_URL = tenant.adminUrl;
  if (!tenant.legacy) {
    var reqBody = req.body || {};
    try {
      await require("./_lib/google").verifyIdToken(typeof reqBody.idToken === "string" ? reqBody.idToken : "");
    } catch (e) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
  }

  // ★ 見つからなければ送らない。穂乃味の宛先へ倒さない。
  var WEBHOOK_URL = T.notifyEnv("DISCORD_WEBHOOK_URL", tenant);

  if (!WEBHOOK_URL) {
    console.error("[discord-notify] DISCORD_WEBHOOK_URL not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }

  var body         = req.body || {};
  var staffName    = (body.staffName    || "").trim();
  var facilityName = (body.facilityName || "").trim();
  var uploadedAt   = body.uploadedAt    || new Date().toISOString();

  if (!staffName) {
    return res.status(400).json({ error: "staffName is required" });
  }

  var uploadDate = new Date(uploadedAt);
  if (isNaN(uploadDate.getTime())) uploadDate = new Date();

  var dateStr = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(uploadDate);

  var message = (tenant.legacy ? [] : ["【" + tenant.appName + "】"]).concat([
    "📷 写真アップロード通知",
    "",
    "施設：" + (facilityName || "（不明）"),
    "スタッフ：" + staffName,
    "日時：" + dateStr,
    "",
    "確認URL",
    ADMIN_URL,
  ]).join("\n");

  var payload = JSON.stringify({ content: message });

  try {
    var result = await httpsPost(
      WEBHOOK_URL,
      { "Content-Type": "application/json" },
      payload
    );

    // Discord Webhook は成功時に 204 No Content を返す
    if (result.status !== 200 && result.status !== 204) {
      console.error(
        "[discord-notify] Discord error: HTTP " + result.status + " " +
        result.body.slice(0, 200)
      );
      return res.status(500).json({ error: "Discord error: HTTP " + result.status });
    }

    console.log("[discord-notify] sent staff=" + staffName + " facility=" + facilityName);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[discord-notify] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});
