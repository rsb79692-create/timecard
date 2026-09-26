/**
 * tests/visual/client-isolation.js — 画面（index.html）側の会社間分離テスト（実ブラウザ）
 *
 * 実行: node tests/visual/client-isolation.js
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬（本番へは接続しない）。
 *
 * 固定すること
 *   ・マンテールの画面は /honomi へ一切アクセスしない・匿名サインインをしない
 *   ・穂乃味の画面は /tenants へ一切アクセスしない・従来どおり匿名サインインで起動する
 *   ・同じ端末で両社を開いても、端末保存（localStorage）が混ざらない
 *     （マンテールがサーバへ届かないとき、穂乃味のスタッフ一覧を表示しない）
 *   ・マンテールの IndexedDB（未送信打刻）は穂乃味と別の DB
 *   ・未知の会社ID（?c=zzz）では何も読まない
 *   ・Storage へのアップロード先・共有URL・施設URLに会社IDが入る
 */
"use strict";

const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle, tapPin } = HN;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}

function dbPaths(page) {
  return page.__netLog.filter((r) => /firebasedatabase\.app$/.test(r.host)).map((r) => r.path);
}
function signUps(page) {
  return page.__netLog.filter((r) => r.host === "identitytoolkit.googleapis.com" && /accounts:signUp$/.test(r.path)).length;
}

async function main() {
  const browser = await chromium.launch();

  // ---- 1. マンテールの施設端末 ----
  {
    const { ctx, page } = await openApp(browser, ROOT, "?c=mantel&token=tokHonten");
    const paths = dbPaths(page);
    check("マンテール: 業務データを読んでいる（空振りではない）", paths.some((p) => p === "/tenants/mantel/tc5_staff.json"), paths.join(","));
    check("マンテール: /honomi へ一切アクセスしない", !paths.some((p) => p.indexOf("/honomi") === 0), paths.filter((p) => p.indexOf("/honomi") === 0).join(","));
    check("マンテール: 匿名サインインをしない", signUps(page) === 0, String(signUps(page)));
    const kiosk = page.__netLog.filter((r) => r.host === "timecard-rho.vercel.app" && r.path === "/api/auth/share");
    check("マンテール: 施設URLのトークンを施設端末トークンへ交換してから読む", kiosk.length >= 1);
    const ls = await page.evaluate(() => Object.keys(localStorage));
    check("マンテール: 端末保存のキーはすべて会社別（t.mantel.）", ls.length > 0 && ls.every((k) => k.indexOf("t.mantel.") === 0), ls.join(","));
    const idb = await page.evaluate(() => (window.PUNCH_OUTBOX_DB_NAME || ""));
    check("マンテール: 未送信打刻の IndexedDB は穂乃味と別", idb === "timecard_punch_outbox__mantel", idb);
    const st = await page.evaluate(() => ({ prefix: STORAGE_PREFIX, fb: FB_URL }));
    check("マンテール: Storage のアップロード先は tenants/mantel/ 配下", st.prefix === "tenants/mantel/");
    check("マンテール: 業務データのベースは /tenants/mantel", /\/tenants\/mantel$/.test(st.fb));
    const urls = await page.evaluate(() => [tenantUrl("https://x/", "viewer=abc"), tenantUrl("https://x/", "token=t")]);
    check("マンテール: 共有URL・施設URLに会社IDが入る", urls[0] === "https://x/?c=mantel&viewer=abc" && urls[1] === "https://x/?c=mantel&token=t", urls.join(" "));
    const theme = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--brand").trim());
    check("マンテール: ブランド色はロゴの赤", theme.toUpperCase() === "#B40000", theme);
    const title = await page.evaluate(() => document.title);
    check("マンテール: タイトルがマンテール", title.indexOf("マンテール") >= 0 && title.indexOf("穂乃味") < 0, title);
    const manifest = await page.evaluate(() => document.querySelector('link[rel="manifest"]').getAttribute("href"));
    check("マンテール: manifest はマンテール用", manifest === "manifest-mantel.json");
    await ctx.close();
  }

  // ---- 2. 穂乃味（従来どおり）----
  {
    const { ctx, page } = await openApp(browser, ROOT, "?token=tokHonten");
    const paths = dbPaths(page);
    check("穂乃味: /honomi を読んでいる", paths.some((p) => p === "/honomi/tc5_staff.json"));
    check("穂乃味: /tenants へ一切アクセスしない", !paths.some((p) => p.indexOf("/tenants") === 0));
    check("穂乃味: 従来どおり匿名サインインで起動する（施設端末トークンを使わない）",
      signUps(page) >= 1 && !page.__netLog.some((r) => r.path === "/api/auth/share"));
    const ls = await page.evaluate(() => Object.keys(localStorage));
    check("穂乃味: 端末保存のキー名は従来のまま（接頭辞なし）", ls.indexOf("tc5_staff") >= 0 && ls.every((k) => k.indexOf("t.") !== 0), ls.join(","));
    const idb = await page.evaluate(() => (window.PUNCH_OUTBOX_DB_NAME || ""));
    check("穂乃味: 未送信打刻の IndexedDB 名は従来のまま", idb === "timecard_punch_outbox");
    const st = await page.evaluate(() => ({ prefix: STORAGE_PREFIX, url: tenantUrl("https://x/", "viewer=abc") }));
    check("穂乃味: Storage の置き場所・共有URLは従来のまま", st.prefix === "" && st.url === "https://x/?viewer=abc");
    await ctx.close();
  }

  // ---- 3. 同じ端末で両社を開く（端末保存が混ざらない）----
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const a = await openApp(browser, ROOT, "?token=tokHonten", { context });
    const honomiStaff = await a.page.evaluate(() => staffList.map((s) => s.name).join(","));
    await a.page.close();
    // マンテールをサーバに届かない状態で開く（端末保存だけで画面を作る状況）
    const b = await openApp(browser, ROOT, "?c=mantel&token=tokHonten", { context, dbDown: true });
    const mantelStaff = await b.page.evaluate(() => staffList.map((s) => s.name).join(","));
    const honomiLs = await b.page.evaluate(() => localStorage.getItem("tc5_staff"));
    check("前提: 穂乃味のスタッフ一覧が端末に保存されている", !!honomiLs && honomiStaff.length > 0);
    check("サーバに届かないマンテールの画面に、穂乃味のスタッフ一覧が出ない", mantelStaff === "", mantelStaff);
    const sess = await b.page.evaluate(() => [localStorage.getItem("tc_anon_session"), localStorage.getItem("t.mantel.tc_anon_session")]);
    check("穂乃味の匿名セッションをマンテールが使わない（別キー）", !!sess[0] && sess[0] !== sess[1]);
    await context.close();
  }

  // ---- 4. 未知の会社ID ----
  {
    const { ctx, page } = await openApp(browser, ROOT, "?c=zzz&token=tokHonten");
    const paths = dbPaths(page);
    check("未知の会社ID: 業務データを一切読まない（穂乃味へ倒さない）", paths.length === 0, paths.join(","));
    check("未知の会社ID: 認証もしない", signUps(page) === 0 && !page.__netLog.some((r) => r.host === "timecard-rho.vercel.app"));
    const txt = await page.evaluate(() => document.body.innerText);
    check("未知の会社ID: その旨を表示する", txt.indexOf("このURLは正しくありません") >= 0);
    await ctx.close();
  }

  // ---- 5. マンテールの管理者（施設URLなし → 管理者PINで入る）----
  {
    const { ctx, page } = await openApp(browser, ROOT, "?c=mantel");
    const before = dbPaths(page);
    check("管理者PINの入力前は業務データを読まない", before.length === 0, before.join(","));
    await tapPin(page, "12345678");
    const after = dbPaths(page);
    const adminCall = page.__netLog.filter((r) => r.path === "/api/auth/admin");
    check("管理者PINで認証してから読む", adminCall.length >= 1 && after.some((p) => p === "/tenants/mantel/tc5_staff.json"));
    check("マンテールの管理画面も /honomi を読まない", !after.some((p) => p.indexOf("/honomi") === 0));
    const tabs = await page.evaluate(() => document.body.innerText);
    check("無効な機能（移動距離）のタブを出さない", tabs.indexOf("移動距離") < 0);
    await ctx.close();
  }

  await browser.close();
  console.log("\n==================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("==================================");
  if (fail) { console.log(failures.join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
