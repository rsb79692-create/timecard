/**
 * line-webhook-id.js — LINE_TO_ID 取得用 一時Webhookサーバー
 *
 * 使い方:
 *   1. node scripts/line-webhook-id.js
 *   2. 別ターミナルで: npx localtunnel --port 3000
 *   3. 表示された https://xxxx.loca.lt を LINE Developers の Webhook URL に設定
 *      → https://xxxx.loca.lt/api/line-userid
 *   4. LINE で Bot にメッセージを送る
 *   5. このターミナルに userId / groupId が表示される
 *   6. 表示された ID を GitHub Secrets → LINE_TO_ID に登録
 *   7. Ctrl+C で停止
 *
 * 依存: Node.js 標準モジュールのみ（npm install 不要）
 */

"use strict";

const http = require("http");

const PORT = 3000;

const server = http.createServer((req, res) => {
  // LINE の Webhook 検証リクエスト（GET）
  if (req.method === "GET" && req.url === "/api/line-userid") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // LINE Webhook 受信（POST）
  if (req.method === "POST" && req.url === "/api/line-userid") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        console.log("[RAW]", body);
        return;
      }

      // イベントから userId / groupId を抽出して表示
      const events = parsed.events || [];
      if (events.length === 0) {
        console.log("[WEBHOOK] イベントなし（検証リクエストの可能性）");
        console.log(JSON.stringify(parsed, null, 2));
        return;
      }

      events.forEach((e, i) => {
        const src = e.source || {};
        console.log("─────────────────────────────────");
        console.log(`[EVENT ${i + 1}] type: ${e.type}`);
        if (src.userId)  console.log("  userId  :", src.userId);
        if (src.groupId) console.log("  groupId :", src.groupId);
        if (src.roomId)  console.log("  roomId  :", src.roomId);
        console.log("─────────────────────────────────");
        console.log("[FULL JSON]");
        console.log(JSON.stringify(parsed, null, 2));
      });
    });
    return;
  }

  // その他のパス
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log("");
  console.log("==============================================");
  console.log(`  LINE Webhook 受信サーバー起動 (port ${PORT})`);
  console.log("==============================================");
  console.log("");
  console.log("【手順】");
  console.log("1. 別ターミナルで以下を実行:");
  console.log("   npx localtunnel --port " + PORT);
  console.log("");
  console.log("2. 表示された URL を LINE Developers に設定:");
  console.log("   https://xxxx.loca.lt/api/line-userid");
  console.log("   ※ Webhook URL 欄 → 検証ボタンを押す");
  console.log("");
  console.log("3. LINE で Bot にメッセージを送る");
  console.log("");
  console.log("4. ここに userId / groupId が表示される");
  console.log("");
  console.log("5. Ctrl+C で停止");
  console.log("");
});
