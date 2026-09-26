/**
 * tests/visual/harness.js — ブラウザテストの共通部品（模擬ネットワーク・模擬データ・固定時刻）
 *
 * ★ ネットワークはすべて模擬する（本番の Firebase・Vercel・LINE へは一切接続しない）。
 * ★ Service Worker は無効化する（キャッシュの影響を受けないように）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function requirePlaywright() {
  const cands = ["playwright", "/opt/node22/lib/node_modules/playwright"];
  for (const c of cands) { try { return require(c); } catch (e) { /* 次へ */ } }
  console.error("playwright が見つかりません");
  process.exit(2);
}
const { chromium } = requirePlaywright();

const ROOT = path.join(__dirname, "..", "..");
const APP = "https://rsb79692-create.github.io/timecard/";
const FIXED_NOW = new Date("2026-09-24T09:30:00+09:00");


// ===== 模擬データ（両方の版で同一）=====
const sha = (v) => crypto.createHash("sha256").update("honomi_pin_v1:" + v).digest("hex");
const TODAY = "2026-09-24";
const STAFF = [
  { name: "山田 太郎", lastName: "山田", firstName: "太郎", yomi: "やまだたろう", yomiLast: "やまだ", yomiFirst: "たろう", location: "本店", status: "在籍", employeeId: "E001", employmentType: "正社員" },
  { name: "佐藤 花子", lastName: "佐藤", firstName: "花子", yomi: "さとうはなこ", yomiLast: "さとう", yomiFirst: "はなこ", location: "本店", status: "在籍", employeeId: "E002", employmentType: "パート" },
  { name: "鈴木 一郎", lastName: "鈴木", firstName: "一郎", yomi: "すずきいちろう", yomiLast: "すずき", yomiFirst: "いちろう", location: "二号店", status: "在籍", employeeId: "E003", employmentType: "正社員" },
];
function dataFor(tenant) {
  const pins = tenant === "honomi"
    ? { "山田 太郎": { hash: sha("1234"), plain: "1234" } }
    : { "山田 太郎": { set: true } };
  return {
    tc5_staff: STAFF,
    tc5_pins: pins,
    tc_master_depts: ["厨房", "ホール"],
    master: { locations: [{ name: "本店", token: "tokHonten" }, { name: "二号店", token: "tokNigo" }] },
    tc5_records: {
      rec_1: { id: "rec_1", staff: "山田 太郎", type: "clockIn", date: TODAY, time: "08:58", timestamp: Date.parse(TODAY + "T08:58:00+09:00"), facilityName: "本店", workFacility: "本店" },
      rec_2: { id: "rec_2", staff: "佐藤 花子", type: "clockIn", date: "2026-09-22", time: "09:01", timestamp: Date.parse("2026-09-22T09:01:00+09:00"), facilityName: "本店", workFacility: "本店" },
      rec_3: { id: "rec_3", staff: "佐藤 花子", type: "clockOut", date: "2026-09-22", time: "17:05", timestamp: Date.parse("2026-09-22T17:05:00+09:00"), facilityName: "本店", workFacility: "本店" },
    },
    tc5_approvals: {},
    tc5_correction_requests: {},
    tc5_paid_leave_requests: {},
    tc5_paid_leave_balances: {},
    tc5_monthly_days_import: {},
    tc5_monthly_review_status: {},
    tc5_meals: {},
    tc5_meal_confirmations: {},
    tc5_staff_notifications: {},
    documents: {},
    config: { adminTokenSet: true },
    viewerTokens: { vtok1: { enabled: true, expiresAt: "2026-12-31" } },
    demoTokens: {},
    staffDemoTokens: {},
  };
}
function getPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = cur[decodeURIComponent(p)];
  }
  return cur === undefined ? null : cur;
}
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function fakeIdToken(claims) {
  const now = Math.floor(FIXED_NOW.getTime() / 1000);
  return b64u({ alg: "RS256", kid: "x" }) + "." + b64u(Object.assign({ iat: now, exp: now + 3600, sub: "u" }, claims)) + ".sig";
}

async function installRoutes(page, srcDir, opts) {
  opts = opts || {};
  const lastClaims = { value: {} };
  const log = page.__netLog = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push({ method: req.method(), host: url.host, path: url.pathname, query: url.search });
    if (opts.dbDown && /firebasedatabase\.app$/.test(url.host)) return route.fulfill({ status: 503, body: "" });
    // ---- アプリ本体（静的ファイル）----
    if (url.origin === "https://rsb79692-create.github.io" && url.pathname.startsWith("/timecard/")) {
      let rel = url.pathname.slice("/timecard/".length) || "index.html";
      const f = path.join(srcDir, rel);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
      const ct = rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".json") ? "application/json"
        : rel.endsWith(".png") ? "image/png" : rel.endsWith(".js") ? "application/javascript" : "application/octet-stream";
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "content-type": ct } });
    }
    // ---- 外部スクリプト（Firebase SDK / JSZip）は空で返す ----
    if (/gstatic\.com|cdnjs\.cloudflare\.com/.test(url.host)) {
      return route.fulfill({ status: 200, body: "", headers: { "content-type": "application/javascript" } });
    }
    // ---- 認証（Identity Toolkit / securetoken）----
    if (url.host === "identitytoolkit.googleapis.com") {
      if (url.pathname.endsWith("accounts:signUp")) {
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ idToken: fakeIdToken({}), refreshToken: "r", expiresIn: "3600" }) });
      }
      // signInWithCustomToken: 直前にサーバが返した役割をそのまま IDトークンへ
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ idToken: fakeIdToken(lastClaims.value), refreshToken: "r", expiresIn: "3600" }) });
    }
    if (url.host === "securetoken.googleapis.com") {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ id_token: fakeIdToken(lastClaims.value), refresh_token: "r", expires_in: "3600" }) });
    }
    // ---- サーバ API（Vercel）----
    if (url.host === "timecard-rho.vercel.app") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, body: "" });
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (e) { body = {}; }
      const tenant = body.tenant || "honomi";
      const sx = Math.floor(FIXED_NOW.getTime() / 1000) + 43200;
      const cl = tenant === "honomi" ? {} : { c: tenant, sx: sx };
      const p = url.pathname;
      if (p === "/api/auth/admin") {
        lastClaims.value = Object.assign({ r: "a" }, cl);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: "a" }) });
      }
      if (p === "/api/auth/staff") {
        lastClaims.value = Object.assign({ r: "s" }, cl);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: "s" }) });
      }
      if (p === "/api/auth/share" && typeof opts.share === "function") {
        opts.shareCalls = (opts.shareCalls || 0) + 1;
        const r = opts.share(body, opts.shareCalls);
        if (r) {
          if (r.status === 200) {
            const role = body.kind === "kiosk" ? "k" : "v";
            lastClaims.value = Object.assign({ r: role }, cl, { sx: sx });
          }
          return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body || {}) });
        }
      }
      if (p === "/api/auth/share") {
        const role = body.kind === "kiosk" ? "k" : body.kind === "viewer" ? "v" : body.kind === "demo" ? "d" : "x";
        lastClaims.value = Object.assign({ r: role }, cl, role === "k" ? { sx: sx } : {});
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: role, sessionExpiresAt: sx }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    // ---- Realtime Database（REST）----
    if (/firebasedatabase\.app$/.test(url.host)) {
      const parts = url.pathname.replace(/\.json$/, "").split("/").filter(Boolean);
      let tenant = "honomi", rest = parts;
      if (parts[0] === "honomi") rest = parts.slice(1);
      else if (parts[0] === "tenants") { tenant = parts[1]; rest = parts.slice(2); }
      if (req.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      const d = dataFor(tenant);
      let v = getPath(d, rest);
      if (rest[0] === "tc5_records" && rest.length === 1 && url.searchParams.get("orderBy")) {
        // 期間取得（orderBy="date"&startAt/endAt/limitToFirst）
        const all = d.tc5_records;
        const st = (url.searchParams.get("startAt") || '""').replace(/"/g, "");
        const en = (url.searchParams.get("endAt") || '""').replace(/"/g, "");
        const lim = parseInt(url.searchParams.get("limitToFirst") || "0", 10);
        let keys = Object.keys(all).filter((k) => all[k].date >= st && all[k].date <= en).sort((a, b) => all[a].date < all[b].date ? -1 : 1);
        if (lim) keys = keys.slice(0, lim);
        v = {}; keys.forEach((k) => { v[k] = all[k]; });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v === undefined ? null : v) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
}

async function openApp(browser, srcDir, query, opts) {
  opts = opts || {};
  const ctx = opts.context || await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block",
    locale: "ja-JP", timezoneId: "Asia/Tokyo",
  });
  const page = await ctx.newPage();
  await page.clock.install({ time: FIXED_NOW });
  await page.clock.pauseAt(FIXED_NOW);
  // 通知APIは無いものとして扱う（許可ダイアログの状態で画面が変わらないように）
  await page.addInitScript(() => { try { delete window.Notification; } catch (e) {} });
  await installRoutes(page, srcDir, opts);
  await page.goto(APP + (query || ""), { waitUntil: "domcontentloaded" });
  await settle(page);
  return { ctx, page };
}
async function settle(page) {
  // ★ ページ側のタイマーが投げた例外（SW を無効化した環境でだけ起きるもの等）は、
  //   両方の版で同じように起きるので無視して進める。比べるのは描画結果だけ。
  for (let i = 0; i < 6; i++) {
    try { await page.clock.runFor(700); } catch (e) { /* 無視 */ }
    await page.waitForTimeout(60);
  }
}
async function shot(page, file) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  const buf = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  fs.writeFileSync(file, buf);
  return buf;
}
async function tapPin(page, digits) {
  for (const d of digits) {
    await page.evaluate((x) => { window.pinTap ? window.pinTap(x) : null; }, Number(d));
    try { await page.clock.runFor(200); } catch (e) { /* 無視 */ }
  }
  await settle(page);
}
async function tapStaffPin(page, digits) {
  for (const d of digits) {
    await page.evaluate((x) => window.sTap(String(x)), d);
    try { await page.clock.runFor(200); } catch (e) { /* 無視 */ }
  }
  await settle(page);
}


module.exports = { requirePlaywright, ROOT, APP, FIXED_NOW, dataFor, installRoutes, openApp, settle, shot, tapPin, tapStaffPin };
