#!/usr/bin/env node
/**
 * 月次精査完了の状態 API（GET /api/review-status）の回帰テスト。
 * 依存パッケージなし・送信なし・本番データ非アクセス（api/_lib/google.js を差し替える）。
 *
 *   node scripts/test-review-status.js
 *
 * 確認すること
 *  1. ym の検査（YYYY-MM 以外は 400・DB に触れない）／GET 以外は 405
 *  2. 返す項目が ok・ym・reviewed・reviewedAt の4つだけ（reviewedBy 等を返さない）
 *  3. 記録なし・解除済み（reviewed:false）は reviewed:false, reviewedAt:null
 *  4. 読む場所は穂乃味の tc5_monthly_review_status/{ym} だけ・書き込みはレート制限だけ
 *  5. IP ごとの回数制限（上限超えは 429・DB の本体を読まない）・no-store・CORS なし
 */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");

const GDB = Object.create(null);
const GCALLS = { get: [], put: [], patch: [] };
let counter = 0;
require.cache[require.resolve(path.join(ROOT, "api", "_lib", "google.js"))] = {
  id: "google-stub", filename: "google-stub", loaded: true,
  exports: {
    async dbGet(p) {
      GCALLS.get.push(p);
      if (/^ratelimit\//.test(p)) return counter;
      return Object.prototype.hasOwnProperty.call(GDB, p) ? GDB[p] : null;
    },
    async dbPut(p, v) { GCALLS.put.push(p); return v; },
    async dbPatch(p, v) { GCALLS.patch.push(p); counter++; return v; },
    async dbPatchRoot() { throw new Error("stub: not used"); },
    async httpRequest() { throw new Error("stub: network not allowed"); },
    async verifyIdToken() { throw new Error("stub: not used"); },
    async getDbAccessToken() { throw new Error("stub: not used"); },
  },
};

const API = require(path.join(ROOT, "api", "review-status.js"));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function reset() { GCALLS.get.length = 0; GCALLS.put.length = 0; GCALLS.patch.length = 0; counter = 0; }
async function call(method, query, headers) {
  const res = {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  await API({ method: method, query: query || {}, headers: Object.assign({ "x-real-ip": "203.0.113.5" }, headers || {}) }, res);
  return res;
}
const KEYS = ["ok", "reviewed", "reviewedAt", "ym"];
function keysOk(b) { return JSON.stringify(Object.keys(b || {}).sort()) === JSON.stringify(KEYS); }

(async function main() {
  console.log("── 1. ym の検査・メソッド ──");
  for (const bad of ["abc", "2026-1", "202611", "2026-11-01", " 2026-11", "2026-11\n", "", "２０２６-１１"]) {
    reset();
    const r = await call("GET", { ym: bad });
    check("ym=" + JSON.stringify(bad) + " は 400", r.statusCode === 400 && r.body && r.body.error === "bad_ym");
    check("ym=" + JSON.stringify(bad) + " は DB に触れない", GCALLS.get.length === 0 && GCALLS.patch.length === 0);
  }
  reset();
  let r = await call("GET", {});
  check("ym なしは 400", r.statusCode === 400);
  r = await call("GET", { ym: ["2026-10", "2026-11"] });
  check("ym の複数指定（配列）は 400", r.statusCode === 400);
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    reset();
    r = await call(m, { ym: "2026-10" });
    check(m + " は 405", r.statusCode === 405 && GCALLS.get.length === 0);
  }

  console.log("── 2/3. 返す項目 ──");
  GDB["tc5_monthly_review_status/2026-10"] = { reviewed: true, reviewedAt: "2026-11-05T01:02:03.456Z", reviewedBy: "admin", extra: "x" };
  GDB["tc5_monthly_review_status/2026-09"] = { reviewed: false, reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: "admin" };
  GDB["tc5_monthly_review_status/2026-08"] = { reviewed: "true", reviewedAt: "2026-09-01T00:00:00.000Z" };
  GDB["tc5_monthly_review_status/2026-07"] = { reviewed: true, reviewedAt: "壊れた値" };
  reset();
  r = await call("GET", { ym: "2026-10" });
  check("精査完了の月は 200", r.statusCode === 200);
  check("返す項目は ok・ym・reviewed・reviewedAt の4つだけ", keysOk(r.body), JSON.stringify(r.body));
  check("reviewed:true・reviewedAt は ISO", r.body.ok === true && r.body.ym === "2026-10" && r.body.reviewed === true && r.body.reviewedAt === "2026-11-05T01:02:03.456Z");
  check("reviewedBy・他の項目を返さない", !("reviewedBy" in r.body) && !("extra" in r.body) && JSON.stringify(r.body).indexOf("admin") < 0);
  check("読む場所は tc5_monthly_review_status/{ym} だけ", GCALLS.get.filter((p) => !/^ratelimit\//.test(p)).join(",") === "tc5_monthly_review_status/2026-10");
  check("書き込みはレート制限（ratelimit/）だけ", GCALLS.patch.concat(GCALLS.put).every((p) => /^ratelimit(\/|$)/.test(p)));
  check("Cache-Control: no-store", r.headers["cache-control"] === "no-store");
  check("CORS 応答ヘッダを付けない", !("access-control-allow-origin" in r.headers));

  reset();
  r = await call("GET", { ym: "2026-11" });
  check("記録なしは 200・reviewed:false・reviewedAt:null", r.statusCode === 200 && keysOk(r.body) && r.body.reviewed === false && r.body.reviewedAt === null && r.body.ym === "2026-11");
  r = await call("GET", { ym: "2026-09" });
  check("解除済み（reviewed:false）は reviewedAt:null", keysOk(r.body) && r.body.reviewed === false && r.body.reviewedAt === null);
  r = await call("GET", { ym: "2026-08" });
  check("reviewed が true（真偽値）以外は未完了扱い", r.body.reviewed === false && r.body.reviewedAt === null);
  r = await call("GET", { ym: "2026-07" });
  check("reviewedAt が日時でなければ null", r.body.reviewed === true && r.body.reviewedAt === null);
  check("pickStatus: null / 文字列 / 配列は未完了", ["x", null, [1], 0].every((v) => { const s = API.pickStatus(v); return s.reviewed === false && s.reviewedAt === null; }));

  console.log("── 5. 回数制限・失敗時 ──");
  reset();
  counter = 300;
  r = await call("GET", { ym: "2026-10" });
  check("上限超え（301回目）は 429", r.statusCode === 429 && r.body.error === "rate_limited" && r.headers["retry-after"] === "600");
  check("上限超えは本体を読まない", GCALLS.get.every((p) => /^ratelimit\//.test(p)));
  reset();
  counter = 299;
  r = await call("GET", { ym: "2026-10" });
  check("300回目までは 200", r.statusCode === 200);
  reset();
  const orig = require.cache[require.resolve(path.join(ROOT, "api", "_lib", "google.js"))].exports.dbGet;
  require.cache[require.resolve(path.join(ROOT, "api", "_lib", "google.js"))].exports.dbGet = async () => { throw new Error("rtdb GET failed: HTTP 500 secret-ish"); };
  r = await call("GET", { ym: "2026-10" });
  require.cache[require.resolve(path.join(ROOT, "api", "_lib", "google.js"))].exports.dbGet = orig;
  check("DB 失敗は 500 server_error（中身を返さない・reviewed を推測しない）", r.statusCode === 500 && r.body.error === "server_error" && !("reviewed" in r.body) && JSON.stringify(r.body).indexOf("secret") < 0);

  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
