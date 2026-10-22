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
 *   ・打刻時の顔撮影の既定（facePhotoDefault）: マンテールはスタッフ全員 ON（個別に OFF は撮らない）／穂乃味は OFF
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
  out.face = await page.evaluate(() => ({
    unset: faceCamStaffEnabled({ name: "x" }), off: faceCamStaffEnabled({ name: "x", facePhoto: false }),
    existing: faceCamStaffEnabled(staffList.find((x) => x.name === "佐藤 花子")),
  }));
  // 勤務区分（穂乃味だけ）: 欄の有無と、登録済みの区分にチェックが入るか
  out.shiftField = await page.evaluate(() => document.querySelectorAll(".modal-shift-type").length);
  out.shiftChecked = await page.evaluate(() => {
    const s = staffList.find((x) => x.name === "佐藤 花子"); s.shiftTypes = ["open", "split"];
    openHrmEdit(s.name);
    const v = Array.from(document.querySelectorAll(".modal-shift-type")).filter((e) => e.checked).map((e) => e.value).join(",");
    try { closeHrmModal(); } catch (e) {} delete s.shiftTypes; return v;
  });
  out.faceNewChecked = await page.evaluate(() => { openHrmEdit(null); const el = document.getElementById("modal-face-photo"); const v = !!(el && el.checked); try { closeHrmModal(); } catch (e) {} return v; });
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
  check("穂乃味: 打刻時の顔撮影は既定 OFF（従来どおり）", h.face.unset === false && h.face.existing === false && h.faceNewChecked === false, JSON.stringify(h.face) + " new=" + h.faceNewChecked);
  check("マンテール: 打刻時の顔撮影はスタッフ全員を既定で ON（既存・新規とも）", m.face.unset === true && m.face.existing === true && m.faceNewChecked === true, JSON.stringify(m.face) + " new=" + m.faceNewChecked);
  check("マンテール: 個別に OFF にしたスタッフは撮らない", m.face.off === false);
  check("マンテール: 退勤時に賄いを聞かない", m.clockOutAsk === false, JSON.stringify(m));
  check("マンテール: 衛生・感染症の確認（月次書類）を動かさない", m.mdoc === false);
  check("マンテール: CSV出力に賄い一覧・賄いの列を出さない", !m.mealToggle && !m.mealList && !m.preview_monthly && !m.preview_daily, JSON.stringify(m));
  check("マンテール: スタッフ編集に「賄い 要」を出さない", m.staffMealField === false);
  check("マンテール: 閲覧用に「この月の賄い回数」を出さない", m.viewerMeals === false);
  check("穂乃味: スタッフ編集に勤務区分（開け・日中・閉め・通し・間抜け）の5つのチェック欄", h.shiftField === 5, "n=" + h.shiftField);
  check("穂乃味: 登録済みの勤務区分にチェックが入る", h.shiftChecked === "open,split", h.shiftChecked);
  check("マンテール: スタッフ編集に勤務区分を出さない", m.shiftField === 0, "n=" + m.shiftField);
  await browser.close();
  console.log("\n" + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
