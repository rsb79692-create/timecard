#!/usr/bin/env node
/**
 * 月別出勤日数（tc5_monthly_days_import）の年マッピング訂正ツール
 *
 * 背景:
 *   「勤務日数管理.xlsx」を取り込んだ際、列→年月のマッピングを誤って
 *   B列=2023-03 として登録してしまった。正しくは B列=2024-03。
 *   その結果、全月キーがちょうど 1年（12か月）早くずれて保存されている。
 *
 * 正しい列→年月対応（ヘッダ行2基準。B=2024-03）:
 *   B(3月)=2024-03 … K(12月)=2024-12
 *   L(1月)=2025-01 … W(12月)=2025-12
 *   X(1月)=2026-01   Y(2月)=2026-02   Z(3月)=2026-03 …
 *   ※値そのものはExcelセルと一致しており不変。誤っているのは「年ラベル」だけ。
 *
 * 本ツールの動作:
 *   tc5_monthly_days_import の各エントリの months キー "YYYY-MM" を
 *   すべて +1年（"YYYY-MM" → "(YYYY+1)-MM"）に付け替える。
 *   これは「B=2024-03 で取り込み直す」のと同一の結果になる（値不変・完全可逆）。
 *
 * 安全策:
 *   - 既定は dry-run（差分表示のみ、書込なし）
 *   - --apply 指定時のみ書込。書込前に tc5_monthly_days_import_backup_pre2024fix へ
 *     現状を丸ごとバックアップしてから上書きする。
 *
 * 実行:
 *   FIREBASE_API_KEY=... FIREBASE_DATABASE_URL=".../honomi" node scripts/fix-monthly-days-year.js          # dry-run
 *   FIREBASE_API_KEY=... FIREBASE_DATABASE_URL=".../honomi" node scripts/fix-monthly-days-year.js --apply  # 実適用
 */
"use strict";
const https = require("https");

const FB_API_KEY = process.env.FIREBASE_API_KEY;
const FB_DB_URL = (process.env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
const APPLY = process.argv.includes("--apply");
const NODE = "tc5_monthly_days_import";
const BACKUP_NODE = "tc5_monthly_days_import_backup_pre2024fix";

if (!FB_API_KEY || !FB_DB_URL) {
  console.error("環境変数 FIREBASE_API_KEY と FIREBASE_DATABASE_URL が必要です。");
  process.exit(1);
}

function httpRequest(url, opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts || {}, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
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
  const j = JSON.parse(res.body);
  if (!j.idToken) throw new Error("匿名認証に失敗: " + res.body);
  return j.idToken;
}

// "YYYY-MM" -> "(YYYY+1)-MM"
function shiftYear(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  return parseInt(m[1], 10) + 1 + "-" + m[2];
}

(async function main() {
  const tok = await getIdToken();
  const cur = JSON.parse(
    (await httpRequest(`${FB_DB_URL}/${NODE}.json?auth=${tok}`)).body
  ) || {};
  const eids = Object.keys(cur);

  const fixed = {};
  const report = [];
  let totalCells = 0;
  const yearBefore = {}, yearAfter = {};
  eids.forEach((e) => {
    const src = cur[e] || {};
    const ms = src.months || {};
    const nm = {};
    Object.keys(ms).forEach((k) => {
      const nk = shiftYear(k);
      if (!nk) return;
      nm[nk] = ms[k];
      totalCells++;
      (yearBefore[k.slice(0, 4)] = (yearBefore[k.slice(0, 4)] || 0) + 1);
      (yearAfter[nk.slice(0, 4)] = (yearAfter[nk.slice(0, 4)] || 0) + 1);
    });
    fixed[e] = Object.assign({}, src, { months: nm, source: (src.source || "xlsx_import") + "+year_fix_2024base" });
    const bk = Object.keys(ms).sort();
    const ak = Object.keys(nm).sort();
    report.push({ e, name: src.staffName || "", n: bk.length, before: bk[0] + ".." + bk[bk.length - 1], after: ak[0] + ".." + ak[ak.length - 1] });
  });

  console.log("=== 月別出勤日数 年マッピング訂正 (" + (APPLY ? "APPLY" : "DRY-RUN") + ") ===");
  console.log("対象エントリ: " + eids.length + " / 値セル合計: " + totalCells);
  console.log("年別セル数 before:", JSON.stringify(yearBefore));
  console.log("年別セル数 after :", JSON.stringify(yearAfter));
  console.log("\n社員番号 | 氏名 | 月数 | before → after");
  report.forEach((r) => console.log("  " + r.e + " | " + r.name + " | " + r.n + " | " + r.before + " → " + r.after));

  if (!APPLY) {
    console.log("\n[DRY-RUN] Firebaseへの書込は行っていません。適用するには --apply を付けて実行してください。");
    return;
  }

  // バックアップ → 上書き
  console.log("\nバックアップ書込: " + BACKUP_NODE);
  const bkRes = await httpRequest(`${FB_DB_URL}/${BACKUP_NODE}.json?auth=${tok}`,
    { method: "PUT", headers: { "Content-Type": "application/json" } }, JSON.stringify(cur));
  if (bkRes.status !== 200) throw new Error("バックアップ失敗: " + bkRes.status + " " + bkRes.body);

  console.log("本書込: " + NODE);
  const wr = await httpRequest(`${FB_DB_URL}/${NODE}.json?auth=${tok}`,
    { method: "PUT", headers: { "Content-Type": "application/json" } }, JSON.stringify(fixed));
  if (wr.status !== 200) throw new Error("本書込失敗: " + wr.status + " " + wr.body);
  console.log("✅ 適用完了。バックアップ: /" + BACKUP_NODE + " （-1年で元に戻せます）");
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
