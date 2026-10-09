/**
 * マニュアル用の実画面スクリーンショット（作業ツリーの timecard-git/index.html を Chromium で開く）。
 * ★ ネットワークはすべて模擬（本番の Firebase・Vercel へは接続しない）。氏名・データは架空。
 *   node manual-shots.js <timecard-git のパス> <出力先>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
fs.mkdirSync(OUT, { recursive: true });
const APP = "https://rsb79692-create.github.io/timecard/";
const FAC = "ミュゲの泉";
const D = "2026-10-12";
const sha = (v) => crypto.createHash("sha256").update("honomi_pin_v1:" + v).digest("hex");
const ST = (name, last, first, id) => ({ name, lastName: last, firstName: first, yomi: "", yomiLast: "", yomiFirst: "", location: FAC, status: "在籍", employeeId: id, employmentType: "パート" });
const STAFF = [ST("見本 花子", "見本", "花子", "E101"), ST("見本 一郎", "見本", "一郎", "E102"), ST("見本 次郎", "見本", "次郎", "E103")];
const DEVS = [
  { id: "11111111-1111-4111-8111-111111111111", k: "r", n: "冷蔵庫1 冷蔵", o: 1 },
  { id: "33333333-3333-4333-8333-333333333333", k: "r", n: "冷蔵庫2 冷蔵", o: 2 },
  { id: "22222222-2222-4222-8222-222222222222", k: "f", n: "冷蔵庫1 冷凍", o: 1 },
  { id: "44444444-4444-4444-8444-444444444444", k: "f", n: "冷蔵庫3 冷凍", o: 3 },
];
const ts = (hh, mm) => new Date(D + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00+09:00");
const R = (id, staff, type, hh, mm, mdoc) => ({ id, eventId: id, staff, type, date: D, time: String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0"),
  timestamp: ts(hh, mm).toISOString(), facilityName: FAC, workFacility: FAC, homeFacility: FAC, ...(mdoc ? { mdoc } : {}) });
const TEMP0 = { s: 0, d: DEVS.map((x, i) => ({ id: x.id, k: x.k, n: x.n, o: x.o, v: x.k === "r" ? 3 + i * 0.5 : -19 })), at: ts(7, 2).toISOString() };

function data(records) {
  const pins = {}; STAFF.forEach((s) => (pins[s.name] = { hash: sha("1234"), plain: "1234" }));
  const recs = {}; records.forEach((r) => (recs[r.id] = r));
  return { tc5_staff: STAFF, tc5_pins: pins, tc_master_depts: ["厨房"], master: { locations: [{ name: FAC, token: "tokMuguet" }, { name: "ナナイロ", token: "tokNana" }] },
    tc5_records: recs, tc5_approvals: {}, tc5_correction_requests: {}, tc5_paid_leave_requests: {}, tc5_paid_leave_balances: {}, tc5_monthly_days_import: {},
    tc5_monthly_review_status: {}, tc5_meals: {}, tc5_meal_confirmations: {}, tc5_staff_notifications: {}, documents: {}, config: { adminTokenSet: true },
    viewerTokens: {}, demoTokens: {}, staffDemoTokens: {} };
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idTok = (now, c) => b64u({ alg: "RS256", kid: "x" }) + "." + b64u(Object.assign({ iat: now, exp: now + 3600, sub: "u" }, c)) + ".sig";
function getPath(o, parts) { let c = o; for (const p of parts) { if (c == null || typeof c !== "object") return null; c = c[decodeURIComponent(p)]; } return c === undefined ? null : c; }

async function open(browser, now, records) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.addInitScript(() => { try { delete window.Notification; } catch (e) {} });
  const db = data(records);
  const nowS = Math.floor(now.getTime() / 1000);
  let claims = {};
  page.__puts = [];
  await page.route("**/*", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin === "https://rsb79692-create.github.io" && url.pathname.startsWith("/timecard/")) {
      const rel = url.pathname.slice("/timecard/".length) || "index.html"; const f = path.join(ROOT, rel);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
      const ct = rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".json") ? "application/json" : rel.endsWith(".png") ? "image/png" : rel.endsWith(".js") ? "application/javascript" : "application/octet-stream";
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { "content-type": ct } });
    }
    if (/gstatic\.com|cdnjs\.cloudflare\.com/.test(url.host)) return route.fulfill({ status: 200, body: "", headers: { "content-type": "application/javascript" } });
    if (url.host === "identitytoolkit.googleapis.com") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ idToken: idTok(nowS, claims), refreshToken: "r", expiresIn: "3600" }) });
    if (url.host === "securetoken.googleapis.com") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id_token: idTok(nowS, claims), refresh_token: "r", expires_in: "3600" }) });
    if (url.host === "timecard-rho.vercel.app") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, body: "" });
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
      const p = url.pathname;
      if (p === "/api/auth/staff") { claims = { r: "s" }; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role: "s" }) }); }
      if (p === "/api/auth/share") { const role = body.kind === "kiosk" ? "k" : "x"; claims = { r: role, sx: nowS + 43200 }; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customToken: "ct", role, sessionExpiresAt: nowS + 43200 }) }); }
      if (p === "/api/monthly-docs" && body.action === "devices") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, devices: DEVS, last: { at: TEMP0.at, devs: TEMP0.d } }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (/firebasedatabase\.app$/.test(url.host)) {
      const parts = url.pathname.replace(/\.json$/, "").split("/").filter(Boolean);
      const rest = parts[0] === "honomi" ? parts.slice(1) : parts;
      if (req.method() === "PUT" && rest[0] === "tc5_records" && rest.length === 2) {
        const v = JSON.parse(req.postData() || "null"); if (v) { delete v.serverReceivedAt; db.tc5_records[decodeURIComponent(rest[1])] = v; page.__puts.push(v); }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v) });
      }
      if (req.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      let v = getPath(db, rest);
      if (rest[0] === "tc5_records" && rest.length === 1 && url.searchParams.get("orderBy")) {
        const st = (url.searchParams.get("startAt") || '""').replace(/"/g, ""), en = (url.searchParams.get("endAt") || '""').replace(/"/g, "");
        v = {}; Object.keys(db.tc5_records).filter((k) => db.tc5_records[k].date >= st && db.tc5_records[k].date <= en).forEach((k) => (v[k] = db.tc5_records[k]));
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v === undefined ? null : v) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(APP + "?token=tokMuguet", { waitUntil: "domcontentloaded" });
  await settle(page);
  return { ctx, page };
}
async function settle(page, n) { for (let i = 0; i < (n || 6); i++) { try { await page.clock.runFor(700); } catch (e) {} await page.waitForTimeout(80); } }
// 押す場所の位置（CSS ピクセル）を一緒に保存する
async function shot(page, name, targets) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  const boxes = [];
  for (const t of targets || []) {
    const loc = typeof t.sel === "string" ? page.locator(t.sel).first() : t.sel;
    const b = await loc.boundingBox();
    boxes.push(Object.assign({ n: t.n, box: b }, t.extra || {}));
  }
  const mask = await page.evaluate(() => {
    // 氏名（架空でも隠す）: 画面上の職員名の文字の位置
    const out = []; const names = ["見本 花子", "見本 一郎", "見本 次郎", "見本　花子", "見本　一郎", "見本　次郎", "見本花子", "見本一郎", "見本次郎"];
    const card = document.querySelector(".mdoc-card"); const cr = card ? card.getBoundingClientRect() : null;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let nd; while ((nd = w.nextNode())) {
      const inOv = !!(nd.parentElement && nd.parentElement.closest(".mdoc-ov"));
      const t = nd.nodeValue || ""; for (const nm of names) { let i = t.indexOf(nm); while (i >= 0) { const r = document.createRange(); r.setStart(nd, i); r.setEnd(nd, i + nm.length);
        for (const rc of r.getClientRects()) {
          if (!(rc.width > 0)) continue;
          let m = { x: rc.x, y: rc.y, w: rc.width, h: rc.height };
          // 確認画面の裏の文字は、カードに隠れていない部分だけを隠す（カードの上に重ねない）
          if (cr && !inOv && m.y + m.h > cr.top && m.y < cr.bottom) { m.h = cr.top - m.y + 2; if (m.h < 4) continue; }
          out.push(m);
        }
        i = t.indexOf(nm, i + 1); } }
    }
    return out;
  });
  const vp = page.viewportSize();
  await page.screenshot({ path: path.join(OUT, name + ".png"), animations: "disabled", caret: "hide" });
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({ vp, boxes, mask }, null, 1));
  console.log("shot", name, boxes.length, "targets", mask.length, "masks");
}
async function login(page, name) {
  await page.evaluate((n) => window.selStaff(n), name); await settle(page, 3);
  return async (shotName) => {
    if (shotName) await shot(page, shotName, [{ n: 1, sel: page.locator("button,div").filter({ hasText: /^1$/ }).first() }]);
    for (const d of "1234") { await page.evaluate((x) => window.sTap(String(x)), d); try { await page.clock.runFor(200); } catch (e) {} }
    await settle(page, 4);
  };
}
const ovBtn = (page, text) => page.locator(".mdoc-ov button", { hasText: new RegExp("^" + text + "$") });

(async () => {
  const browser = await chromium.launch();
  // ── A: 朝 7:00 出勤（衛生 → 問題なし → 出勤確定 → 朝の温度）
  {
    const { ctx, page } = await open(browser, ts(7, 0), []);
    await shot(page, "01-home", [{ n: 1, sel: page.getByText(/見本\s*花子/).first() }]);
    const pin = await login(page, "見本 花子");
    await shot(page, "02-pin", []);
    await pin();
    await shot(page, "03-punch", [{ n: 2, sel: "button.btn-in" }]);
    await page.click("button.btn-in"); await settle(page, 2);
    await shot(page, "04-hyg", [{ n: 3, sel: ovBtn(page, "問題なし") }]);
    await ovBtn(page, "問題なし").click(); await page.waitForTimeout(150); try { await page.clock.runFor(300); } catch (e) {}
    await page.waitForTimeout(150);
    await shot(page, "05-temp-empty", [{ n: 4, sel: ".mdoc-done" }]);
    const ins = page.locator(".mdoc-ov input.mdoc-tin");
    const vals = ["3.5", "19", "4", "20"]; // 表示順に入力（冷凍はマイナス不要）
    for (let i = 0; i < (await ins.count()); i++) await ins.nth(i).fill(vals[i] || "3");
    await shot(page, "06-temp-filled", [{ n: 1, sel: ins.nth(0) }, { n: 2, sel: ovBtn(page, "温度を記録") }]);
    console.log("puts before record:", page.__puts.length);
    await ovBtn(page, "温度を記録").click(); await page.waitForTimeout(150);
    await shot(page, "07-saved", [{ n: 3, sel: ".mdoc-card" }]);
    console.log("puts while saved screen:", page.__puts.length);
    await settle(page, 3);
    console.log("puts after record:", page.__puts.length, JSON.stringify(page.__puts.map((p) => ({ type: p.type, time: p.time, hyg: p.mdoc && p.mdoc.hyg, temp: !!(p.mdoc && p.mdoc.temp) }))));
    await shot(page, "07-after", []);
    await ctx.close();
  }
  // ── A2: 朝の温度が記録済みの日の出勤（「問題なし」でそのまま完了）
  {
    const { ctx, page } = await open(browser, ts(7, 15), [R("r1", "見本 花子", "clockIn", 7, 0, { f: FAC, sid: "E101", hyg: { a: "ok" }, temp: TEMP0 })]);
    const pin = await login(page, "見本 一郎"); await pin();
    await page.click("button.btn-in"); await settle(page, 2);
    await ovBtn(page, "問題なし").click(); await page.waitForTimeout(120); try { await page.clock.runFor(200); } catch (e) {} await page.waitForTimeout(120);
    await shot(page, "08-clockin-done", [{ n: 1, sel: page.getByText(/出勤\s*07:15/).first() }]);
    await ctx.close();
  }
  // ── A3: 問題あり
  {
    const { ctx, page } = await open(browser, ts(7, 20), []);
    const pin = await login(page, "見本 次郎"); await pin();
    await page.click("button.btn-in"); await settle(page, 2);
    await ovBtn(page, "問題あり").click(); await page.waitForTimeout(150);
    await shot(page, "09-hyg-ng", [{ n: 1, sel: ovBtn(page, "閉じる") }]);
    await ctx.close();
  }
  // ── B: 13:30 日中勤務の人の退勤（他に勤務中の人がいる）→ 日中の温度
  {
    const recs = [R("r1", "見本 花子", "clockIn", 7, 0, { f: FAC, sid: "E101", hyg: { a: "ok" }, temp: TEMP0 }), R("r2", "見本 一郎", "clockIn", 7, 15, { f: FAC, sid: "E102", hyg: { a: "ok" } })];
    const { ctx, page } = await open(browser, ts(13, 30), recs);
    const pin = await login(page, "見本 花子"); await pin();
    await shot(page, "10-punch-out", [{ n: 1, sel: "button.btn-out" }]);
    await page.click("button.btn-out"); await settle(page, 2);
    const ins = page.locator(".mdoc-ov input.mdoc-tin");
    for (let i = 0; i < (await ins.count()); i++) await ins.nth(i).fill(["4", "19", "4.5", "20"][i] || "3");
    await shot(page, "11-temp-day", [{ n: 2, sel: ins.nth(0) }, { n: 3, sel: ovBtn(page, "記録して退勤") }]);
    await ovBtn(page, "記録して退勤").click(); await page.waitForTimeout(120); try { await page.clock.runFor(300); } catch (e) {} await page.waitForTimeout(120);
    await shot(page, "12-out-done", [{ n: 4, sel: page.getByText(/退勤\s*13:30/).first() }]);
    await ctx.close();
  }
  // ── C: 17:30 最後の退勤者 → 夕方の温度 → 保存食
  {
    const recs = [R("r1", "見本 花子", "clockIn", 7, 0, { f: FAC, sid: "E101", hyg: { a: "ok" }, temp: TEMP0 }), R("r2", "見本 一郎", "clockIn", 7, 15, { f: FAC, sid: "E102", hyg: { a: "ok" } }),
      R("r3", "見本 花子", "clockOut", 13, 30, { f: FAC, sid: "E101", temp: Object.assign({}, TEMP0, { s: 1, at: ts(13, 30).toISOString() }) })];
    const { ctx, page } = await open(browser, ts(17, 30), recs);
    const pin = await login(page, "見本 一郎"); await pin();
    await page.click("button.btn-out"); await settle(page, 2);
    const ins = page.locator(".mdoc-ov input.mdoc-tin");
    for (let i = 0; i < (await ins.count()); i++) await ins.nth(i).fill(["4", "19", "4.5", "20"][i] || "3");
    await shot(page, "13-temp-eve", [{ n: 1, sel: ins.nth(0) }, { n: 2, sel: ovBtn(page, "次へ") }]);
    await ovBtn(page, "次へ").click(); await page.waitForTimeout(150);
    await shot(page, "14-hozon", [{ n: 3, sel: ovBtn(page, "はい") }, { n: 0, sel: ovBtn(page, "いいえ"), extra: { info: true } }]);
    await ovBtn(page, "いいえ").click(); await page.waitForTimeout(150);
    await shot(page, "15-hozon-no", [{ n: 1, sel: ovBtn(page, "退勤する") }]);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
