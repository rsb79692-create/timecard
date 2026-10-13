/**
 * tests/visual/window-tenant.js — ホーム画面アプリのウィンドウを会社ごとに固定する（WINDOW-TENANT）
 *
 * 実行: node tests/visual/window-tenant.js
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬する（本番へ接続しない）。
 *   ※ ホーム画面アプリ（standalone）は navigator.standalone=true で模擬する（iPhone と同じ判定経路）。
 *
 * 固定すること（docs/features/multitenant.md「ホーム画面アプリの会社の固定」）
 *   ・standalone のウィンドウで最初に開いた会社と別の会社のURLが読み込まれたら、起動せず案内だけを出す
 *     （認証API・RTDB へ通信しない）。「戻る」で本来の会社のトップ（トークン無し）へ戻る
 *   ・同じ会社のURLへの移動・ブラウザのタブ（standalone でない）では何も変わらない
 *   ・穂乃味のシステム管理画面の「この会社の管理画面へ」は別ウィンドウで開く
 */
"use strict";

const fs = require("fs");
const path = require("path");
const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, APP, openApp, settle } = HN;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}

async function newCtx(browser, standalone) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  if (standalone) {
    await ctx.addInitScript(() => {
      try { Object.defineProperty(Navigator.prototype, "standalone", { get: function () { return true; }, configurable: true }); } catch (e) {}
    });
  }
  return ctx;
}
async function go(page, query) {
  await page.goto(APP + query, { waitUntil: "domcontentloaded" });
  await settle(page);
}
const view = (p) => p.evaluate(() => ({
  other: TC_WINDOW_TENANT_OTHER, tenant: TENANT_ID,
  text: (document.getElementById("app") || {}).innerText || "",
  saved: (function () { try { return sessionStorage.getItem("tc_window_tenant"); } catch (e) { return "?"; } })(),
}));
const authCalls = (p, from) => p.__netLog.slice(from).filter((r) =>
  r.host === "timecard-rho.vercel.app" || /firebasedatabase\.app$/.test(r.host) || r.host === "identitytoolkit.googleapis.com").length;

async function main() {
  const browser = await chromium.launch();

  // 1. standalone: 穂乃味で起動 → 同じウィンドウでマンテールの管理者URL → 止まる → 戻る
  {
    const ctx = await newCtx(browser, true);
    const { page } = await openApp(browser, ROOT, "?token=all", { context: ctx });
    let v = await view(page);
    check("穂乃味で起動: ウィンドウの会社を記録", v.saved === "honomi" && v.other === "", JSON.stringify(v).slice(0, 200));
    check("穂乃味で起動: 通常どおり打刻画面", !/このアプリは/.test(v.text));
    const n0 = page.__netLog.length;
    await go(page, "?c=mantel&admin=abc");
    v = await view(page);
    check("マンテールのURLへ移る: 案内を出して止まる", v.other === "honomi" && /このアプリは株式会社 穂乃味用です/.test(v.text), v.text.slice(0, 120));
    check("マンテールのURLへ移る: 認証API・RTDB へ通信しない", authCalls(page, n0) === 0, "calls=" + authCalls(page, n0));
    check("マンテールのURLへ移る: 記録は穂乃味のまま", v.saved === "honomi");
    await page.evaluate(() => { const b = document.querySelector("#app .btn-admin"); if (b) b.click(); });
    await page.waitForLoadState("domcontentloaded");
    await settle(page);
    const u = new URL(page.url());
    v = await view(page);
    check("戻る: 穂乃味のトップ（トークン無し）", u.pathname === "/timecard/" && u.search === "" && v.tenant === "honomi" && v.other === "", page.url());
    await go(page, "?admin=abc");
    v = await view(page);
    check("同じ会社（穂乃味の管理者URL）への移動は止めない", v.other === "" && v.tenant === "honomi");
    await ctx.close();
  }

  // 2. standalone: マンテールで起動 → 穂乃味のURL → 止まる（逆向き）
  {
    const ctx = await newCtx(browser, true);
    const { page } = await openApp(browser, ROOT, "?c=mantel&admin=abc", { context: ctx });
    let v = await view(page);
    check("マンテールで起動: 記録はマンテール・通常起動", v.saved === "mantel" && v.other === "");
    await go(page, "?token=all");
    v = await view(page);
    check("穂乃味のURLへ移る: マンテール用の案内で止まる", v.other === "mantel" && /このアプリはマンテール株式会社用です/.test(v.text), v.text.slice(0, 120));
    await page.evaluate(() => { const b = document.querySelector("#app .btn-admin"); if (b) b.click(); });
    await page.waitForLoadState("domcontentloaded");
    await settle(page);
    const u = new URL(page.url());
    check("戻る: マンテールのトップ（?c=mantel のみ）", u.search === "?c=mantel", page.url());
    await ctx.close();
  }

  // 3. ブラウザのタブ（standalone でない）では何もしない
  {
    const ctx = await newCtx(browser, false);
    const { page } = await openApp(browser, ROOT, "?token=all", { context: ctx });
    await go(page, "?c=mantel&admin=abc");
    const v = await view(page);
    check("ブラウザのタブ: 会社が変わっても止めない・記録しない", v.other === "" && v.tenant === "mantel" && v.saved === null, JSON.stringify(v).slice(0, 160));
    await ctx.close();
  }

  await browser.close();

  // 4. 静的: システム管理画面の会社リンクは別ウィンドウで開く
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  check("「この会社の管理画面へ」は target=_blank rel=noopener", /<a href="'\+esc\(link\)\+'" target="_blank" rel="noopener"[^>]*>この会社の管理画面へ<\/a>/.test(src));

  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
