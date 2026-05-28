/**
 * api/line-notify.js — Vercel サーバーレス関数
 * スタッフが書類をアップロードした際に管理者へ LINE Push 通知を送る。
 * LINE_CHANNEL_ACCESS_TOKEN / LINE_TO_ID は Vercel 環境変数に設定すること。
 */

"use strict";

const https = require("https");

const ALLOWED_ORIGIN = "https://rsb79692-create.github.io";
const ADMIN_URL = "https://rsb79692-create.github.io/timecard/?token=all";

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

module.exports = async function handler(req, res) {
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

  var LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  var LINE_TO    = process.env.LINE_TO_ID || "";

  if (!LINE_TOKEN || !LINE_TO) {
    console.error("[line-notify] LINE credentials not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }

  var body       = req.body || {};
  var staffName  = (body.staffName  || "").trim();
  var facilityName = (body.facilityName || "").trim();
  var uploadedAt = body.uploadedAt  || new Date().toISOString();

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

  var message = [
    "【穂乃味タイムカード】",
    "写真アップロード通知",
    "",
    "施設：" + (facilityName || "（不明）"),
    "スタッフ：" + staffName,
    "日時：" + dateStr,
    "",
    "▼管理者画面（書類確認）",
    ADMIN_URL,
  ].join("\n");

  var payload = JSON.stringify({
    to: LINE_TO,
    messages: [{ type: "text", text: message }],
  });

  try {
    var result = await httpsPost(
      "https://api.line.me/v2/bot/message/push",
      {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LINE_TOKEN,
      },
      payload
    );

    if (result.status !== 200) {
      console.error(
        "[line-notify] LINE API error: HTTP " + result.status + " " +
        result.body.slice(0, 200)
      );
      return res.status(500).json({ error: "LINE API error: HTTP " + result.status });
    }

    console.log("[line-notify] sent staff=" + staffName + " facility=" + facilityName);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[line-notify] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
