#!/usr/bin/env node
/**
 * verify-punch-events.js — 打刻イベント（event_id / サーバ受信時刻）の適用確認
 *
 * ★ 読み取り専用。RTDB へ一切書き込まない（PUT/PATCH/POST/DELETE を行う関数を持たない）。
 * ★ 本スクリプトは「DB変更の verify」に相当する。
 *   timecard は Firebase Realtime Database でスキーマレスのため migration ファイルは存在しない。
 *   今回の変更で tc5_records に増えるのは、新規打刻のみに付く追加フィールド 2 つだけである。
 *     eventId          … 打刻イベントの一意キー（= レコードのノード名 = id）
 *     serverReceivedAt … サーバが受け取った時刻（{".sv":"timestamp"} でサーバが入れる）
 *   既存行は両方とも持たない（欠落＝許容。nullable 相当）。既存の集計・修正・監査は
 *   これらを参照しないため、後付けの一括更新は不要かつ行ってはならない。
 *
 * 確認すること:
 *   1. ノード名（キー）と id が一致していること
 *      RTDB は「パスが主キー」なので、この一致が event_id の一意制約そのものになる。
 *   2. eventId を持つ行では eventId === ノード名 であること
 *   3. eventId の重複が無いこと（＝二重登録が起きていないこと）
 *   4. 新方式で入った行に serverReceivedAt があり、実打刻時刻より前になっていないこと
 *      （サーバ受信時刻が打刻時刻より前なら、端末時計のずれか実装の取り違えを疑う）
 *   5. 変更前後の件数（適用前後で同じ SQL 相当を実行して比較するための基準値）
 *
 * 実行:
 *   FIREBASE_API_KEY=... FIREBASE_DATABASE_URL=... node scripts/verify-punch-events.js
 *   （PowerShell: $env:FIREBASE_API_KEY="..."; $env:FIREBASE_DATABASE_URL="..."; node scripts/verify-punch-events.js）
 *
 * 終了コード: 0=問題なし / 1=要確認あり / 2=実行不能
 */
"use strict";

const https = require("https");

const REQUIRED = ["FIREBASE_API_KEY", "FIREBASE_DATABASE_URL"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("[ERROR] 環境変数が未設定です: " + missing.join(", "));
  console.error("        値は表示・記録しないこと。GitHub Secrets と同じ値を一時的に環境変数へ入れて実行する。");
  process.exit(2);
}
const FB_API_KEY = process.env.FIREBASE_API_KEY;
const FB_DB_URL = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, "");

function httpRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts || {}, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getIdToken() {
  const res = await httpRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ returnSecureToken: true })
  );
  if (res.status !== 200 || !res.body || !res.body.idToken) {
    throw new Error(`Firebase Anonymous Auth 失敗 (HTTP ${res.status})`);
  }
  return res.body.idToken; // 表示しない
}

async function fetchRTDB(path, idToken) {
  // 接続先ホストは出力しない（AGENTS.md 禁止事項: Firebase 設定値を出力しない）
  console.log(`[RTDB]  GET /${path}.json`);
  const res = await httpRequest(`${FB_DB_URL}/${path}.json?auth=${idToken}`);
  if (res.status !== 200) throw new Error(`RTDB fetch 失敗 (${path}): HTTP ${res.status}`);
  return res.body;
}

(async () => {
  let issues = 0;
  const token = await getIdToken();
  const raw = await fetchRTDB("tc5_records", token);
  if (!raw || typeof raw !== "object") {
    console.error("[ERROR] tc5_records を取得できませんでした（不在または権限なし）");
    process.exit(2);
  }
  const keys = Object.keys(raw);
  const total = keys.length;

  let keyIdMismatch = [];
  let legacyArrayRows = 0;   // 旧「全件を配列で PUT」していた時代の行（キーが配列添字）
  let eventIdMismatch = [];
  let withEventId = 0;
  let withServerTime = 0;
  let serverTimeBeforePunch = [];
  const eventIdSeen = new Map();
  const duplicateEventIds = [];
  let oldest = null, newest = null;

  keys.forEach((k) => {
    const r = raw[k];
    if (!r || typeof r !== "object") return;
    // 旧実装は tc5_records 全体を1つの配列として PUT していたため、
    // その時代の行はキーが配列添字（"0","1",…）で id と一致しない。これは既知で正常。
    // 新方式（個別ノード PUT）の行だけ「キー === id」を必須とする。
    if (/^\d+$/.test(k)) legacyArrayRows++;
    else if (r.id && String(r.id) !== k) keyIdMismatch.push(k);
    if (r.eventId != null) {
      withEventId++;
      if (String(r.eventId) !== k) eventIdMismatch.push(k);
      if (eventIdSeen.has(String(r.eventId))) duplicateEventIds.push(String(r.eventId));
      else eventIdSeen.set(String(r.eventId), k);
    }
    if (r.serverReceivedAt != null) {
      withServerTime++;
      const srv = Number(r.serverReceivedAt);
      const punched = Date.parse(r.timestamp || "");
      // 1分の余裕を見る（端末時計の微差を「異常」にしない）
      if (!isNaN(srv) && !isNaN(punched) && srv < punched - 60000) {
        serverTimeBeforePunch.push({ key: k, punched: r.timestamp, serverReceivedAt: srv });
      }
    }
    if (r.date) {
      if (oldest === null || r.date < oldest) oldest = r.date;
      if (newest === null || r.date > newest) newest = r.date;
    }
  });

  const line = (s) => console.log(s);
  line("");
  line("================ 打刻イベント 適用確認 ================");
  line(`tc5_records 件数              : ${total}`);
  line(`データ期間                    : ${oldest || "-"} 〜 ${newest || "-"}`);
  line(`eventId を持つ行              : ${withEventId}（新方式で入った打刻。既存行は持たない＝正常）`);
  line(`serverReceivedAt を持つ行     : ${withServerTime}`);
  line("");

  line(`旧配列形式の行（キーが添字）  : ${legacyArrayRows}（既知の既存データ。判定対象外）`);
  line("");

  line("1. ノード名と id の一致（RTDB ではパスが主キー＝一意制約の実体）");
  if (keyIdMismatch.length) { issues++; line(`   NG  不一致 ${keyIdMismatch.length} 件: ${keyIdMismatch.slice(0, 5).join(", ")}`); }
  else line(`   OK  個別ノード形式 ${total - legacyArrayRows} 件すべてでノード名と id が一致`);

  line("2. eventId とノード名の一致");
  if (eventIdMismatch.length) { issues++; line(`   NG  不一致 ${eventIdMismatch.length} 件: ${eventIdMismatch.slice(0, 5).join(", ")}`); }
  else line("   OK  eventId を持つ行はすべてノード名と一致");

  line("3. eventId の重複（＝二重登録）");
  if (duplicateEventIds.length) { issues++; line(`   NG  重複 ${duplicateEventIds.length} 件: ${duplicateEventIds.slice(0, 5).join(", ")}`); }
  else line("   OK  重複なし（RTDB はノード名が主キーのため構造上も重複しない）");

  line("4. サーバ受信時刻が実打刻時刻より前になっていないか");
  if (serverTimeBeforePunch.length) {
    issues++;
    line(`   NG  ${serverTimeBeforePunch.length} 件（端末時計のずれ、または実装の取り違えを疑う）`);
    serverTimeBeforePunch.slice(0, 5).forEach((x) => line(`       ${x.key} 打刻=${x.punched} 受信=${new Date(x.serverReceivedAt).toISOString()}`));
  } else line("   OK  すべて 実打刻時刻 <= サーバ受信時刻");

  line("");
  line(issues ? `結果: 要確認 ${issues} 件` : "結果: 問題なし");
  line("=======================================================");
  process.exit(issues ? 1 : 0);
})().catch((e) => {
  console.error("[ERROR] " + (e && e.message ? e.message : String(e)));
  process.exit(2);
});
