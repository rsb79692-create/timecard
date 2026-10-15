/**
 * マンテール向けマニュアル（従業員用・管理者用）のスクリーンショット。
 * MANUAL_TENANT=honomi で穂乃味の従業員用（施設URL・賄いの質問）を撮る（管理画面は撮らない）。
 * ★ ネットワークはすべて模擬（本番の Firebase・Vercel へは接続しない・書き込まない）。氏名・データは架空。
 *   node tests/visual/manual/mantel-shots.js <出力先>
 * 撮影の出力をこのリポジトリに置かない（公開リポジトリ）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const HN = require("../harness");
const { chromium } = HN.requirePlaywright();
const ROOT = HN.ROOT, APP = HN.APP;
const OUT = path.resolve(process.argv[2] || "shots");
const HONOMI = process.env.MANUAL_TENANT === "honomi";
const FAC_Q = HONOMI ? "?token=tokHonten" : "?c=mantel&token=tokHonten";
fs.mkdirSync(OUT, { recursive: true });

const NOW = new Date("2026-10-13T09:30:00+09:00");
const D = "2026-10-13";
const ST = (name, last, first, yl, yf, loc, id, type) => ({ name, lastName: last, firstName: first, yomi: yl + yf, yomiLast: yl, yomiFirst: yf, location: loc, status: "在籍", employeeId: id, employmentType: type, dept: "ホール" });
const STAFF = [
  ST("見本 太郎", "見本", "太郎", "みほん", "たろう", "本店", "M001", "正社員"),
  Object.assign(ST("見本 花子", "見本", "花子", "みほん", "はなこ", "本店", "M002", "パート"), { canSupportWork: true, mealRequired: true }),
  ST("試験 一郎", "試験", "一郎", "しけん", "いちろう", "本店", "M003", "パート"),
  ST("試験 次郎", "試験", "次郎", "しけん", "じろう", "駅前店", "M004", "正社員"),
];
const ts = (d, hm) => new Date(d + "T" + hm + ":00+09:00").toISOString();
const recs = {};
let n = 0;
function R(staff, type, d, hm, fac) { const id = "rec" + (++n); recs[id] = { id, eventId: id, staff, type, date: d, time: hm, timestamp: ts(d, hm), facilityName: fac || "本店", workFacility: fac || "本店", homeFacility: fac || "本店" }; }
// 10月の見本の勤務（平日）
for (let day = 1; day <= 12; day++) {
  const d = "2026-10-" + String(day).padStart(2, "0");
  const wd = new Date(d + "T12:00:00+09:00").getUTCDay();
  if (wd === 0 || wd === 6) continue;
  R("見本 太郎", "clockIn", d, "08:5" + (day % 10 > 5 ? 5 : day % 10));
  R("見本 太郎", "breakStart", d, "12:00");
  R("見本 太郎", "breakEnd", d, "13:00");
  R("見本 太郎", "clockOut", d, "18:0" + (day % 7));
  R("見本 花子", "clockIn", d, "09:00");
  R("見本 花子", "clockOut", d, "15:00");
  R("試験 次郎", "clockIn", d, "10:00", "駅前店");
  if (day !== 7) R("試験 次郎", "clockOut", d, "19:00", "駅前店");
}
R("見本 花子", "clockIn", D, "08:58");
// 過去の日は承認済み（試験 次郎の退勤漏れの日だけ未承認）
const APV = {};
Object.values(recs).forEach((r) => { if (r.date < D && !(r.staff === "試験 次郎" && r.date === "2026-10-07")) APV[r.date + "__" + r.staff] = true; });
R("試験 次郎", "clockIn", D, "09:02", "駅前店");

function data() {
  const sha = (v) => require("crypto").createHash("sha256").update("honomi_pin_v1:" + v).digest("hex");
  const pins = {}; STAFF.forEach((s) => { if (s.name !== "試験 一郎") pins[s.name] = HONOMI ? { hash: sha("1234"), plain: "1234" } : { set: true }; }); // 試験 一郎は PIN 未登録（初回登録の画面用）
  return {
    tc5_staff: STAFF, tc5_pins: pins, tc_master_depts: ["ホール", "キッチン"],
    master: { locations: [{ name: "本店", token: "tokHonten" }, { name: "駅前店", token: "tokEki" }] },
    tc5_records: recs, tc5_approvals: APV,
    tc5_correction_requests: {
      cr1: { id: "cr1", staff: "試験 次郎", date: "2026-10-07", type: "clockOut", requestedTime: "19:00", originalTime: "", adjustReasonLabel: "打刻忘れ", adjustComment: "退勤を押し忘れました", status: "pending", createdAt: ts("2026-10-08", "10:00"), facilityName: "駅前店" },
    },
    tc5_paid_leave_requests: {
      pl1: { id: "pl1", staff: "見本 花子", staffName: "見本 花子", employeeId: "M002", dates: ["2026-10-20"], date: "2026-10-20", days: 1, status: "pending", reason: "私用のため", createdAt: ts("2026-10-10", "12:00"), facility: "本店" },
    },
    tc5_paid_leave_balances: {
      b1: { id: "b1", staffId: "M001", staffName: "見本 太郎", grantDate: "2026-04-01", expiresAt: "2028-03-31", grantedDays: 10, usedDays: 2, remainDays: 8 },
      b2: { id: "b2", staffId: "M002", staffName: "見本 花子", grantDate: "2026-04-01", expiresAt: "2028-03-31", grantedDays: 7, usedDays: 1, remainDays: 6 },
    },
    tc5_monthly_days_import: {}, tc5_monthly_review_status: {}, tc5_meals: {}, tc5_meal_confirmations: {}, tc5_staff_notifications: {},
    documents: {}, config: { adminTokenSet: true }, viewerTokens: {}, demoTokens: {}, staffDemoTokens: {},
  };
}
const DB = data();
function getPath(o, parts) { let c = o; for (const p of parts) { if (c == null || typeof c !== "object") return null; c = c[decodeURIComponent(p)]; } return c === undefined ? null : c; }
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowS = Math.floor(NOW.getTime() / 1000);
const idTok = (c) => b64u({ alg: "RS256", kid: "x" }) + "." + b64u(Object.assign({ iat: nowS, exp: nowS + 3600, sub: "u" }, c)) + ".sig";

async function open(browser, query, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.w || 390, height: opts.h || 844 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo", permissions: ["camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await page.addInitScript(() => {
    try { delete window.Notification; } catch (e) {}
    // 顔撮影のカメラは人物のシルエットを描いた模擬映像にする（実カメラを使わない）
    const fake = () => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 480; const g = c.getContext("2d");
      g.fillStyle = "#cbd5e1"; g.fillRect(0, 0, 640, 480); g.fillStyle = "#94a3b8";
      g.beginPath(); g.arc(320, 200, 85, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(320, 480, 190, 150, 0, Math.PI, 0); g.fill();
      return Promise.resolve(c.captureStream(5));
    };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = fake;
  });
  let claims = {};
  const sx = nowS + 43200;
  await page.route("**/*", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin === "https://rsb79692-create.github.io" && url.pathname.startsWith("/timecard/")) {
      const rel = url.pathname.slice("/timecard/".length) || "index.html"; const f = path.join(ROOT, rel);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
      const ct = rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".json") ? "application/json" : rel.endsWith(".png") ? "image/png" : rel.endsWith(".js") ? "application/javascript" : "application/octet-stream";
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "content-type": ct } });
    }
    if (/gstatic\.com|cdnjs\.cloudflare\.com/.test(url.host)) return route.fulfill({ status: 200, body: "", headers: { "content-type": "application/javascript" } });
    if (url.host === "identitytoolkit.googleapis.com") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ idToken: idTok(claims), refreshToken: "r", expiresIn: "3600" }) });
    if (url.host === "securetoken.googleapis.com") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id_token: idTok(claims), refresh_token: "r", expires_in: "3600" }) });
    if (url.host === "timecard-rho.vercel.app") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, body: "" });
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
      const p = url.pathname; const cl = HONOMI ? {} : { c: "mantel", sx };
      if (p === "/api/auth/admin") { claims = Object.assign({ r: "a" }, cl); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: "a", sessionExpiresAt: sx }) }); }
      if (p === "/api/auth/staff") { claims = Object.assign({ r: "s" }, cl); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: "s", sessionExpiresAt: sx }) }); }
      if (p === "/api/auth/share") { const role = (body.kind === "kiosk" || body.kind === "adminKiosk") ? "k" : body.kind === "viewer" ? "v" : "x"; claims = Object.assign({ r: role }, cl); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role, sessionExpiresAt: sx }) }); }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (/firebasedatabase\.app$/.test(url.host)) {
      const parts = url.pathname.replace(/\.json$/, "").split("/").filter(Boolean);
      const rest = parts[0] === "tenants" ? parts.slice(2) : parts[0] === "honomi" ? parts.slice(1) : parts;
      if (req.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: req.postData() || "null" });
      let v = getPath(DB, rest);
      if (rest[0] === "tc5_records" && rest.length === 1 && url.searchParams.get("orderBy")) {
        const st = (url.searchParams.get("startAt") || '""').replace(/"/g, ""), en = (url.searchParams.get("endAt") || '""').replace(/"/g, "");
        v = {}; Object.keys(DB.tc5_records).filter((k) => DB.tc5_records[k].date >= st && DB.tc5_records[k].date <= en).forEach((k) => (v[k] = DB.tc5_records[k]));
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v === undefined ? null : v) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(APP + query, { waitUntil: "domcontentloaded" });
  await settle(page);
  return { ctx, page };
}
async function settle(page, k) { for (let i = 0; i < (k || 6); i++) { try { await page.clock.runFor(700); } catch (e) {} await page.waitForTimeout(80); } }
// targets: [{ n: 番号, sel: CSSセレクタ or Locator }] の位置を <name>.json に保存する（番号・赤枠は後で重ねる）
async function shot(page, name, full, targets) {
  const boxes = [];
  for (const t of targets || []) {
    const loc = typeof t.sel === "string" ? page.locator(t.sel).first() : t.sel.first();
    const b = await loc.boundingBox().catch(() => null);
    if (!b) console.log("  target not found", name, t.n);
    boxes.push({ n: t.n, box: b });
  }
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({ boxes, dpr: 2 }));
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    // 「通知: このブラウザは非対応」の一時表示（模擬環境だけで出る）を消す
    document.querySelectorAll("body > div").forEach((d) => { if (/^通知/.test(d.textContent || "")) d.remove(); });
  });
  await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full, animations: "disabled", caret: "hide" });
  console.log("shot", name);
}
async function staffLogin(page, name) {
  await page.evaluate((n) => window.selStaff(n), name); await settle(page, 3);
  for (const d of "1234") { await page.evaluate((x) => window.sTap(String(x)), d); try { await page.clock.runFor(200); } catch (e) {} }
  await settle(page, 5);
}
async function staffShots(browser) {
  const FAC = FAC_Q;
  { // 打刻トップ・PIN
    const { ctx, page } = await open(browser, FAC);
    await shot(page, "s01-home", false, [{ n: 1, sel: page.locator("#app .btn-staff").filter({ hasText: /見本\s*太郎/ }) }]);
    await page.evaluate(() => window.selStaff("試験 一郎")); await settle(page, 3);
    await shot(page, "s02-pinnew");
    await page.evaluate(() => window.goHome()); await settle(page, 2);
    await page.evaluate(() => window.selStaff("見本 太郎")); await settle(page, 3);
    for (const d of "12") { await page.evaluate((x) => window.sTap(String(x)), d); try { await page.clock.runFor(200); } catch (e) {} }
    await shot(page, "s03-pin", false, [{ n: 1, sel: ".btn-pin-enter" }]);
    for (const d of "34") { await page.evaluate((x) => window.sTap(String(x)), d); try { await page.clock.runFor(200); } catch (e) {} }
    await settle(page, 5);
    await shot(page, "s04-punch", true, [{ n: 1, sel: "button.btn-in" }]);
    await page.click("button.btn-in"); await page.waitForTimeout(150); try { await page.clock.runFor(300); } catch (e) {} await page.waitForTimeout(150);
    await shot(page, "s05-done", true);
    await ctx.close();
  }
  { // 勤務中のスタッフ
    const { ctx, page } = await open(browser, FAC);
    await staffLogin(page, "見本 花子");
    await shot(page, "s06-working", true, [{ n: 1, sel: "button.btn-out" }, { n: 2, sel: "button.btn-bs" }, { n: 3, sel: "button.btn-be" }]);
    await page.evaluate(() => window.openFacilityChangeModal()); await settle(page, 2);
    await shot(page, "s07-facility", false, [{ n: 1, sel: "select" }, { n: 2, sel: page.getByText("施設を変更する", { exact: true }) }]);
    await page.keyboard.press("Escape"); await page.evaluate(() => { document.querySelectorAll("body > div").forEach((d) => { if (getComputedStyle(d).position === "fixed" && d.id !== "app") d.remove(); }); });
    await page.evaluate(() => window.showCorrectionRequestModal("見本 花子")); await settle(page, 2);
    await shot(page, "s08-correction", false, [{ n: 1, sel: "body > div input[type=date]" }, { n: 2, sel: "body > div input[type=time]" }, { n: 3, sel: page.getByText("申請する", { exact: true }) }]);
    await page.evaluate(() => { document.querySelectorAll("body > div").forEach((d) => { if (getComputedStyle(d).position === "fixed" && d.id !== "app") d.remove(); }); });
    await page.evaluate(() => { window.showPaidLeaveForm = true; window.plFormMonth = ""; window.render(); }); await settle(page, 2);
    await shot(page, "s09-paidleave", true, [{ n: 1, sel: page.locator("#app").getByText("22", { exact: true }) }, { n: 2, sel: page.locator("#app button").filter({ hasText: /^申請する$/ }) }]);
    await page.evaluate(() => { window.showPaidLeaveForm = false; window.render(); window.toggleMonthPunch(); }); await settle(page, 3);
    await shot(page, "s10-month", true);
    if (HONOMI) { // 退勤 → 賄いの質問（穂乃味の「賄い 要」のスタッフ）
      await page.evaluate(() => { window.render(); }); await settle(page, 1);
      await page.click("button.btn-out"); await settle(page, 2);
      await shot(page, "s11-meal", false, [{ n: 1, sel: page.getByText("はい", { exact: true }) }, { n: 2, sel: page.getByText("いいえ", { exact: true }) }]);
    }
    await ctx.close();
  }
}
async function adminShots(browser) {
  { // 打刻トップの「管理者メニュー」→ 管理者PIN
    const { ctx, page } = await open(browser, "?c=mantel&token=tokHonten");
    await page.click("#app .btn-admin"); await settle(page, 3);
    await shot(page, "a01-pin");
    await ctx.close();
  }
  const { ctx, page } = await open(browser, "?c=mantel&admin=abc", { w: 1280, h: 900 });
  await shot(page, "a02-records", false, [{ n: 1, sel: page.locator("#app select").first() }, { n: 2, sel: page.locator("#app button").filter({ hasText: /^承認$/ }) }, { n: 3, sel: page.locator("#app button").filter({ hasText: /^一括承認$/ }) }]);
  const tabs = ["export", "staff", "master", "support", "morning", "notify", "paidleave", "adjustlog", "monthlyDays", "leavePlan", "csvImport"];
  for (const t of tabs) {
    await page.evaluate((x) => window.setTab(x), t); await settle(page, 4);
    await shot(page, "a-" + t, true);
  }
  await page.evaluate(() => window.setTab("staff")); await settle(page, 3);
  await page.getByText("＋ スタッフ追加").first().click().catch(() => page.getByText(/スタッフ追加/).first().click()); await settle(page, 3);
  await shot(page, "a-staffadd", false, [{ n: 1, sel: page.getByText(/応援勤務あり/) }, { n: 2, sel: page.getByText(/打刻時の顔撮影/) }]);
  await page.evaluate(() => { document.querySelectorAll("body > div").forEach((d) => { if (getComputedStyle(d).position === "fixed") d.remove(); }); });
  await page.evaluate(() => { window.setTab("records"); window.showUnapprovedOnly = true; window.render(); }); await settle(page, 3);
  await shot(page, "a03-unapproved", true, [{ n: 1, sel: ".btn-crq-approve" }, { n: 2, sel: page.locator("#app td").filter({ hasText: /^-\s*-\s*:\s*-\s*-$/ }) }]);
  const cell = page.locator("#app td").filter({ hasText: /^-\s*-\s*:\s*-\s*-$/ }).first();
  if (await cell.count()) { await cell.click().catch(() => {}); await settle(page, 2); await shot(page, "a04-edit", false, [{ n: 1, sel: "#app input[type=time]" }, { n: 2, sel: page.locator("#app button").filter({ hasText: /^設定$/ }) }]); }
  await ctx.close();
}
module.exports = { open, settle, shot, OUT, NOW };
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch();
    await staffShots(browser);
    if (!HONOMI) await adminShots(browser);
    await browser.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
