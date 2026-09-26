#!/usr/bin/env node
/**
 * scripts/bootstrap-tenant.js — 新しい利用会社の初期データ投入（本番データを作る唯一の手順）
 *
 * 作るもの（すべて新規パス。既存の穂乃味のデータ・/authz 本体には触れない）:
 *   /tenantReg/<会社ID>                 { active, createdAt, updatedAt, updatedBy }   ← 利用中／停止
 *   /srv/<会社ID>/authz/_meta           { createdAt, version }                       ← 認証の準備完了フラグ
 *   /srv/<会社ID>/authz/adminPin        scrypt+pepper＋暗号化平文                     ← 会社管理者PIN
 *   （任意）/authz/systemAdminPin       システム管理者PIN（株式会社 穂乃味）。★ 既に在れば書かない
 *
 * 作らないもの:
 *   /tenants/<会社ID>（業務データ）… 施設・スタッフは会社管理者が管理画面から登録する。
 *
 * 【安全設計】
 *  - 既定は dry-run（何も書かない）。書き込みは --apply を付けたときだけ。
 *  - /tenantReg/<会社ID> か /srv/<会社ID>/authz が既に在れば停止する（上書きしない）。
 *  - 書き込みはルートへの1回のマルチパス更新（原子的）。途中まで書かれた状態を作らない。
 *  - 既定では active=false（停止）で作る。--activate を付けたときだけ利用中で作る。
 *  - PIN・pepper・暗号鍵・サービスアカウント鍵をログへ出さない。
 *  - 書き込み後に読み戻して、作ったパスが期待どおりか確認する。
 *
 * 【実行】（値は環境変数で渡す。コマンドラインに PIN を書かない）
 *   FIREBASE_SERVICE_ACCOUNT_KEY=<JSON> FIREBASE_DATABASE_URL=<.../honomi>
 *   TC_PIN_PEPPER=<Vercel と同一> TC_ENC_KEY=<Vercel と同一>
 *   TENANT_ADMIN_PIN=<8桁> [SYSTEM_ADMIN_PIN=<8桁>]
 *   node scripts/bootstrap-tenant.js --tenant mantel                 # dry-run
 *   node scripts/bootstrap-tenant.js --tenant mantel --apply         # 投入（停止状態で作る）
 *   node scripts/bootstrap-tenant.js --tenant mantel --apply --activate
 *
 * 【rollback】
 *   作ったのは上の新規パスだけなので、戻すときはそれを消す（/tenantReg/<会社ID> を消せば
 *   Rules と API の両方で即座に停止扱いになる）。穂乃味のデータは一切変わっていない。
 */
"use strict";

const path = require("path");
const G = require(path.join(__dirname, "..", "api", "_lib", "google.js"));
const S = require(path.join(__dirname, "..", "api", "_lib", "secrets.js"));
const T = require(path.join(__dirname, "..", "api", "_lib", "tenant.js"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const ACTIVATE = process.argv.includes("--activate");
const CID = arg("--tenant");

function fail(msg) { console.error("[ERROR] " + msg); process.exit(1); }

async function rootGet(p) {
  const token = await G.getDbAccessToken();
  const origin = new URL(process.env.FIREBASE_DATABASE_URL).origin;
  const res = await G.httpRequest(origin + "/" + p + ".json", { method: "GET", headers: { Authorization: "Bearer " + token } });
  if (res.status !== 200) throw new Error("read failed: HTTP " + res.status);
  return res.body;
}
async function rootPatch(map) {
  const token = await G.getDbAccessToken();
  const origin = new URL(process.env.FIREBASE_DATABASE_URL).origin;
  const body = JSON.stringify(map);
  const res = await G.httpRequest(origin + "/.json", {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, body);
  if (res.status < 200 || res.status >= 300) throw new Error("write failed: HTTP " + res.status);
}

async function main() {
  const t = T.get(CID);
  if (!t) fail("--tenant に登録済みの会社IDを指定してください（api/_lib/tenant.js の TENANTS）");
  if (t.legacy || t.system) fail("穂乃味（既定テナント）には使えません。穂乃味は scripts/bootstrap-authz.js です");
  for (const k of ["FIREBASE_SERVICE_ACCOUNT_KEY", "FIREBASE_DATABASE_URL", "TC_PIN_PEPPER", "TC_ENC_KEY"]) {
    if (!process.env[k]) fail(k + " が未設定です");
  }
  const adminPin = String(process.env.TENANT_ADMIN_PIN || "");
  if (!/^\d{8}$/.test(adminPin)) fail("TENANT_ADMIN_PIN は数字8桁で指定してください（値は表示しません）");
  const sysPin = String(process.env.SYSTEM_ADMIN_PIN || "");
  if (sysPin && !/^\d{8}$/.test(sysPin)) fail("SYSTEM_ADMIN_PIN は数字8桁で指定してください（値は表示しません）");

  console.log("[INFO] 会社: " + t.id + "（" + t.displayName + "）");
  console.log("[INFO] モード: " + (APPLY ? "投入（--apply）" : "dry-run（書き込みなし）"));

  // ---- 既存確認（上書きしない）----
  const [reg, authz, sysRec] = await Promise.all([
    rootGet("tenantReg/" + t.id),
    rootGet("srv/" + t.id + "/authz"),
    sysPin ? rootGet("authz/systemAdminPin") : Promise.resolve(null),
  ]);
  if (reg !== null) fail("/tenantReg/" + t.id + " が既に在ります（上書きしません）");
  if (authz !== null) fail("/srv/" + t.id + "/authz が既に在ります（上書きしません）");
  const writeSys = !!sysPin && sysRec === null;
  if (sysPin && !writeSys) console.log("[INFO] システム管理者PINは既に在るため書きません");

  const now = Date.now();
  const map = {};
  map["tenantReg/" + t.id] = { active: ACTIVATE === true, createdAt: now, updatedAt: now, updatedBy: "bootstrap-tenant" };
  map["srv/" + t.id + "/authz/_meta"] = { createdAt: new Date(now).toISOString(), version: 1, tenant: t.id };
  map["srv/" + t.id + "/authz/adminPin"] = S.makePinRecord(adminPin);
  if (writeSys) map["authz/systemAdminPin"] = S.makePinRecord(sysPin);

  console.log("[PLAN] 書き込むパス（値は表示しません）:");
  Object.keys(map).forEach(function (k) { console.log("  - /" + k); });
  console.log("[PLAN] 利用状態: " + (ACTIVATE ? "利用中（active=true）" : "停止（active=false）。有効化は --activate かシステム管理者画面から"));

  if (!APPLY) { console.log("[DONE] dry-run のため書き込んでいません"); return; }

  await rootPatch(map);

  // ---- 読み戻し確認 ----
  const [reg2, meta2, pin2, sys2] = await Promise.all([
    rootGet("tenantReg/" + t.id),
    rootGet("srv/" + t.id + "/authz/_meta"),
    rootGet("srv/" + t.id + "/authz/adminPin"),
    writeSys ? rootGet("authz/systemAdminPin") : Promise.resolve(null),
  ]);
  const ok = reg2 && reg2.active === (ACTIVATE === true)
    && meta2 && meta2.tenant === t.id
    && pin2 && typeof pin2.dk === "string" && typeof pin2.salt === "string"
    && (!writeSys || (sys2 && typeof sys2.dk === "string"));
  if (!ok) fail("読み戻しの確認に失敗しました。書き込まれたパスを確認してください");
  console.log("[DONE] 投入と読み戻し確認が完了しました");
}

main().catch(function (e) { console.error("[ERROR]", e && e.message); process.exit(1); });
