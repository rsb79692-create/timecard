/**
 * tests/visual/tenant-features.js — 会社ごとの機能フラグ（賄い・月次書類の感染症確認）の表示
 *
 * 実行: node tests/visual/tenant-features.js
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬する（本番へ接続しない）。
 *
 * 固定すること（docs/features/multitenant.md「機能フラグ」）
 *   ・マンテール（meals:false）: 退勤時の賄いの質問・CSV出力の賄いの列と賄い一覧・スタッフ編集の「賄い 要」・閲覧用の賄い回数を出さない
 *   ・マンテール（monthlyDocs:false）: 打刻時の衛生・感染症の確認（月次書類）を動かさない
 *   ・穂乃味（meals:true）は従来どおり出す
 */
"use strict";

const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle, tapPin } = HN;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}

async function probe(browser, tenant) {
  const mantel = tenant === "mantel";
  const { ctx, page } = await openApp(browser, ROOT, mantel ? "?c=mantel" : "?token=all");
  if (!mantel) { await page.evaluate(() => window.goPin()); await settle(page); }
  await tapPin(page, "12345678");
  const out = {};
  out.clockOutAsk = await page.evaluate(() => {
    const s = staffList.find((x) => x.name === "山田 太郎");
    s.mealRequired = true; mealsLoaded = true;
    const r = mealClockOutNeed("山田 太郎", getTodayJSTStr());
    return !!r;
  });
  out.mdoc = await page.evaluate(() => (typeof mdocActive === "function" ? mdocActive() : false));
  await page.evaluate(() => window.setTab("export")); await settle(page);
  out.mealToggle = await page.evaluate(() => !!document.getElementById("btn-meal-toggle"));
  out.mealList = await page.evaluate(() => { mealListOpen = true; render(); return /賄い一覧（/.test(document.getElementById("app").innerText); });
  for (const t of ["monthly", "daily"]) {
    out["preview_" + t] = await page.evaluate((tt) => { csvPreviewType = tt; screen = "csvPreview"; render(); const th = Array.from(document.querySelectorAll("#app th")).map((e) => e.textContent); screen = "admin"; render(); return th.some((x) => /賄い/.test(x)); }, t);
  }
  await page.evaluate(() => window.setTab("staff")); await settle(page);
  out.staffMealField = await page.evaluate(() => !!document.getElementById("modal-meal-required"));
  await ctx.close();
  // 閲覧用URL（労務士）
  const v = await openApp(browser, ROOT, mantel ? "?c=mantel&viewer=vtok1" : "?viewer=vtok1");
  out.viewerMeals = await v.page.evaluate(() => /この月の賄い回数/.test(document.getElementById("app").innerText));
  await v.ctx.close();
  return out;
}

async function main() {
  const browser = await chromium.launch();
  const h = await probe(browser, "honomi");
  const m = await probe(browser, "mantel");
  check("穂乃味: 退勤時に賄いを聞く（従来どおり）", h.clockOutAsk === true, JSON.stringify(h));
  check("穂乃味: CSV出力に賄い一覧ボタン・賄いの列（月次・日次）", h.mealToggle && h.mealList && h.preview_monthly && h.preview_daily, JSON.stringify(h));
  check("穂乃味: スタッフ編集に「賄い 要」", h.staffMealField === true);
  check("穂乃味: 閲覧用に「この月の賄い回数」", h.viewerMeals === true);
  check("マンテール: 退勤時に賄いを聞かない", m.clockOutAsk === false, JSON.stringify(m));
  check("マンテール: 衛生・感染症の確認（月次書類）を動かさない", m.mdoc === false);
  check("マンテール: CSV出力に賄い一覧・賄いの列を出さない", !m.mealToggle && !m.mealList && !m.preview_monthly && !m.preview_daily, JSON.stringify(m));
  check("マンテール: スタッフ編集に「賄い 要」を出さない", m.staffMealField === false);
  check("マンテール: 閲覧用に「この月の賄い回数」を出さない", m.viewerMeals === false);
  await browser.close();
  console.log("\n" + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
