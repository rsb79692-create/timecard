#!/usr/bin/env node
/**
 * scripts/report-employee-verify-readiness.js — /api/auth/employee-verify の準備状況を数えるだけの診断（読み取り専用）
 *
 * ★ 書き込みを一切しない（RTDB へは GET だけ）。出力は件数だけで、氏名・社員番号・PIN・ハッシュを出さない。
 * ★ 照合規則は api/auth/employee-verify.js の resolveRow をそのまま使う（規則を二重に持たない）。
 *
 * 【実行】（サービスアカウントは api/_lib/google.js と同じ環境変数を使う）
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"   # または FIREBASE_SERVICE_ACCOUNT_KEY に JSON 本文
 *   $env:FIREBASE_DATABASE_URL="https://<project>.firebaseio.com/honomi"
 *   node scripts/report-employee-verify-readiness.js [honomi-shift-active-staff.json]
 *
 *   JSON の形式: [{"code": "<職員コード>", "nameHash": "<sha256hex('honomi-staff-name/v1:' + 正規化氏名)>"}, ...]
 */
"use strict";

const fs = require("fs");
const path = require("path");

function loadServiceAccountEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) return;
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (!p) {
    console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS か FIREBASE_SERVICE_ACCOUNT_KEY が必要です");
    process.exit(2);
  }
  try {
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = fs.readFileSync(p, "utf8");
  } catch (e) {
    console.error("ERROR: サービスアカウントの鍵ファイルを読めません");
    process.exit(2);
  }
}

function loadInput(file) {
  if (!file) return null;
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("ERROR: 入力 JSON を読めません（形式不正またはファイルなし）");
    process.exit(2);
  }
  if (!Array.isArray(arr)) {
    console.error("ERROR: 入力 JSON は配列である必要があります");
    process.exit(2);
  }
  return arr;
}

async function main() {
  const input = loadInput(process.argv[2]);
  loadServiceAccountEnv();
  if (!process.env.FIREBASE_DATABASE_URL) {
    console.error("ERROR: FIREBASE_DATABASE_URL が必要です");
    process.exit(2);
  }

  const T = require(path.join(__dirname, "..", "api", "_lib", "tenant.js"));
  T.enterForScript("honomi");
  const G = require(path.join(__dirname, "..", "api", "_lib", "google.js"));
  const S = require(path.join(__dirname, "..", "api", "_lib", "secrets.js"));
  const EV = require(path.join(__dirname, "..", "api", "auth", "employee-verify.js"))._internal;

  // 読み取りだけ（2 往復）
  const [staffRaw, pinsRaw] = await Promise.all([G.dbGet("tc5_staff"), G.dbGet(S.AUTHZ + "/pins")]);
  const list = Array.isArray(staffRaw) ? staffRaw : Object.values(staffRaw || {});
  const rows = list.filter((r) => r && typeof r === "object");
  const pins = pinsRaw && typeof pinsRaw === "object" ? pinsRaw : {};

  const codeOf = (r) => (typeof r.employeeId === "string" || typeof r.employeeId === "number") ? EV.normalizeCode(r.employeeId) : "";
  const isRetired = (r) => String(r.status ?? "").trim() === "退職";
  const pinRecOf = (r) => (typeof r.name === "string" && r.name) ? pins[S.subjectKey(r.name)] : undefined;

  const codeCount = new Map();
  const nameCount = new Map();
  for (const r of rows) {
    const c = codeOf(r);
    if (c) codeCount.set(c, (codeCount.get(c) || 0) + 1);
    const names = new Set([EV.rowNameOf(r), EV.normName(r.name ?? "")].filter(Boolean));
    for (const n of names) nameCount.set(n, (nameCount.get(n) || 0) + 1);
  }

  const out = {
    tc5_staff_rows_total: rows.length,
    active_rows: 0,
    active_blank_employeeId: 0,
    active_duplicated_employeeId: 0,
    active_same_name_duplicates: 0,
    active_without_pin_record: 0,
    active_pin_record_scrypt: 0,
    active_pin_record_legacy_sha256: 0,
    active_pin_record_other: 0,
  };
  for (const r of rows) {
    if (isRetired(r)) continue;
    out.active_rows++;
    const c = codeOf(r);
    if (!c) out.active_blank_employeeId++;
    else if ((codeCount.get(c) || 0) >= 2) out.active_duplicated_employeeId++;
    const names = new Set([EV.rowNameOf(r), EV.normName(r.name ?? "")].filter(Boolean));
    if ([...names].some((n) => (nameCount.get(n) || 0) >= 2)) out.active_same_name_duplicates++;
    const rec = pinRecOf(r);
    if (!rec || typeof rec !== "object") out.active_without_pin_record++;
    else if (rec.dk) out.active_pin_record_scrypt++;
    else if (typeof rec.legacy === "string" && rec.legacy) out.active_pin_record_legacy_sha256++;
    else out.active_pin_record_other++;
  }

  if (input) {
    const m = {
      input_total: input.length,
      ready_exactly_one_match_with_pin_record: 0,
      match_but_no_pin_record: 0,
      code_not_found: 0,
      code_duplicate: 0,
      name_hash_mismatch: 0,
      retired: 0,
      same_name_ambiguous: 0,
      timecard_row_without_name: 0,
      invalid_input_row: 0,
    };
    const map = {
      code_not_found: "code_not_found",
      code_duplicate: "code_duplicate",
      name_mismatch: "name_hash_mismatch",
      retired: "retired",
      same_name: "same_name_ambiguous",
      no_name: "timecard_row_without_name",
    };
    for (const it of input) {
      const code = it && typeof it.code === "string" ? EV.normalizeCode(it.code) : "";
      const nh = it && typeof it.nameHash === "string" ? it.nameHash : "";
      if (!/^[0-9A-Za-z_-]{1,32}$/.test(code) || !/^[0-9a-f]{64}$/.test(nh)) { m.invalid_input_row++; continue; }
      const r = EV.resolveRow(rows, code, nh);
      if (r.row) {
        const rec = pinRecOf(r.row);
        if (rec && typeof rec === "object") m.ready_exactly_one_match_with_pin_record++;
        else m.match_but_no_pin_record++;
      } else {
        const k = map[r.fail] || "invalid_input_row";
        m[k]++;
      }
    }
    out.honomi_shift = m;
  }

  // 件数だけを出力する
  console.log(JSON.stringify(out, null, 2));
}

main().catch(function (e) {
  // 例外メッセージは google.js 側で値を含まない形にしてある。念のため種類だけ出す。
  console.error("ERROR:", e && e.message ? String(e.message).slice(0, 120) : "unknown");
  process.exit(1);
});
