/**
 * tests/visual/admin-close.js — 管理画面を「閉じる」ときの権限の解除と打刻（穂乃味・マンテール共通）
 *
 * 実行: node tests/visual/admin-close.js
 *   ※ Playwright（Chromium）が必要（visual-regression.js と同じ）。ネットワークはすべて模擬する（本番へ接続しない）。
 *
 * 固定すること（docs/features/multitenant.md「管理画面を閉じたときの権限の解除」）
 *   ・管理者URLは PC・スマホとも管理画面で開き、「閉じる」で打刻トップ（上部に管理者メニュー・下に全スタッフ）へ戻る
 *   ・閉じた後は管理者の権限を持たない（メモリの役割が a でない／管理画面は PIN を経ないと開けない）
 *   ・閉じた後の打刻ログイン・PIN新規登録は管理者トークンで送らない
 *   ・閉じた後の再読み込み（自動更新を含む）で管理画面へ戻らない。管理者URLを新しいタブで開けば管理画面
 *   ・マンテールの施設URLの端末は施設トークンの施設端末トークンへ戻る（管理者からの交換を使わない）
 *   ・マンテールで交換に失敗したら閉じない（管理者の状態のまま案内する）
 */
"use strict";

const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle, tapPin, tapStaffPin } = HN;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}
function claimsOf(tok) {
  try { return JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString("utf8")); } catch (e) { return null; }
}
const VIEWPORTS = [["スマホ", 390, 844], ["PC", 1280, 900]];

async function newPage(browser, w, h, query, opts) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const { page } = await openApp(browser, ROOT, query, Object.assign({ context: context }, opts || {}));
  const api = page.__api = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.host !== "timecard-rho.vercel.app" || req.method() !== "POST") return;
    let b = {}; try { b = JSON.parse(req.postData() || "{}"); } catch (e) { b = {}; }
    api.push({ path: u.pathname, body: b });
  });
  return { context, page };
}
const state = (p) => p.evaluate(() => ({
  screen: screen, admin: isAdminAuthenticated, role: _authRole,
  claims: (function () { try { return _jwtClaims(_fbIdToken); } catch (e) { return null; } })(),
  adminBtn: !!document.querySelector("#app .btn-admin"), staffBtns: document.querySelectorAll("#app .btn-staff").length,
}));
async function clickClose(p) {
  await p.evaluate(() => { const b = document.querySelector(".admin-close-btn"); if (b) b.click(); });
  await settle(p);
}

async function main() {
  const browser = await chromium.launch();

  for (const [tn, q] of [["穂乃味", "?admin=abc"], ["マンテール", "?c=mantel&admin=abc"]]) {
    const mantel = tn === "マンテール";
    for (const [vn, w, h] of VIEWPORTS) {
      const L = tn + "・" + vn + ": ";
      const { context, page } = await newPage(browser, w, h, q);
      let st = await state(page);
      check(L + "管理者URLは管理画面で開く", st.screen === "admin" && st.admin === true && st.role === "a", JSON.stringify(st));
      await clickClose(page);
      st = await state(page);
      check(L + "閉じると打刻トップ（上部に管理者メニュー・下に全スタッフ3名）", st.screen === "home" && st.adminBtn && st.staffBtns === 3, JSON.stringify(st));
      check(L + "閉じた後は管理者の権限を持たない", st.admin === false && st.role !== "a" && (!st.claims || st.claims.r !== "a"), JSON.stringify(st));
      if (mantel) {
        check(L + "閉じた後は管理者から交換した施設端末トークン（書き込み不可）", st.role === "k" && st.claims && st.claims.r === "k" && st.claims.ka === true);
        check(L + "交換は管理者のIDトークンで1回だけ", page.__api.filter((a) => a.body.kind === "adminKiosk").length === 1
          && claimsOf(page.__api.find((a) => a.body.kind === "adminKiosk").body.idToken).r === "a");
      }
      // 管理者メニューを押すと PIN 画面（そのまま管理画面には入れない）
      await page.evaluate(() => { document.querySelector("#app .btn-admin").click(); });
      await settle(page);
      st = await state(page);
      check(L + "閉じた後の「管理者メニュー」は管理者PIN画面", st.screen === "pin" && st.admin === false, JSON.stringify(st));
      await page.evaluate(() => window.cancelPin());
      await settle(page);
      // 管理画面へ直接入ろうとしても入れない
      await page.evaluate(() => { screen = "admin"; render(); });
      await settle(page);
      st = await state(page);
      check(L + "管理画面へ直接切り替えても入れない", st.screen === "home", JSON.stringify(st));
      // 打刻（登録済みスタッフ）
      page.__api.length = 0;
      await page.evaluate(() => window.selStaff("山田 太郎"));
      await settle(page);
      await tapStaffPin(page, mantel ? "1234" : "1234");
      st = await state(page);
      check(L + "閉じた後もスタッフのPINで打刻画面へ入れる", st.screen === "punch", JSON.stringify(st));
      const staffCall = page.__api.find((a) => a.path === "/api/auth/staff");
      check(L + "打刻ログインは管理者トークンで送らない", !!staffCall && claimsOf(staffCall.body.idToken) && claimsOf(staffCall.body.idToken).r !== "a",
        staffCall ? JSON.stringify(claimsOf(staffCall.body.idToken)) : "staff 呼び出しなし");
      await page.evaluate(() => window.goHome());
      await settle(page);
      // PIN新規登録（未登録スタッフ）
      page.__api.length = 0;
      await page.evaluate(() => window.selStaff("佐藤 花子"));
      await settle(page);
      st = await state(page);
      check(L + "未登録スタッフは PIN新規登録画面", st.screen === "staffPinNew", JSON.stringify(st));
      for (const d of "56785678") { await page.evaluate((x) => window.sNewTap(x), d); try { await page.clock.runFor(200); } catch (e) {} }
      await settle(page);
      const setCall = page.__api.find((a) => a.path === "/api/auth/pin-set");
      check(L + "PIN新規登録は管理者トークンで送らない（他人のPINを上書きできない）",
        !!setCall && claimsOf(setCall.body.idToken) && claimsOf(setCall.body.idToken).r !== "a",
        setCall ? JSON.stringify(claimsOf(setCall.body.idToken)) : "pin-set 呼び出しなし");
      await page.evaluate(() => window.goHome());
      await settle(page);
      // 再読み込み（自動更新と同じ location.reload）で管理画面へ戻らない
      await page.reload({ waitUntil: "domcontentloaded" });
      await settle(page);
      st = await state(page);
      check(L + "閉じた後の再読み込みは打刻トップのまま（管理者の権限なし）", st.screen === "home" && st.admin === false && st.role !== "a" && st.staffBtns === 3, JSON.stringify(st));
      // 管理者URLを新しいタブで開くと管理画面（★ 同じタブで同じURLを開き直すと、ブラウザは再読み込みとして扱う）
      const { page: page2 } = await openApp(browser, ROOT, q, { context: context });
      st = await state(page2);
      check(L + "管理者URLを新しいタブで開けば管理画面", st.screen === "admin" && st.admin === true, JSON.stringify(st));
      await context.close();
    }
  }

  // ---- マンテールの施設URLの端末: 管理者PINで入って閉じる → 施設トークンの施設端末トークンへ ----
  for (const [vn, w, h] of VIEWPORTS) {
    const L = "マンテール施設URL・" + vn + ": ";
    const { context, page } = await newPage(browser, w, h, "?c=mantel&token=tokHonten");
    let st = await state(page);
    check(L + "施設URLの打刻トップ（上部に管理者メニュー・スタッフ一覧）", st.screen === "home" && st.adminBtn && st.role === "k", JSON.stringify(st));
    await page.evaluate(() => window.goPin());
    await settle(page);
    await tapPin(page, "12345678");
    st = await state(page);
    check(L + "管理者PINで管理画面", st.screen === "admin" && st.role === "a", JSON.stringify(st));
    page.__api.length = 0;
    const urlBefore = page.url();
    await clickClose(page);
    st = await state(page);
    check(L + "閉じると再読み込みせず打刻トップへ", st.screen === "home" && page.url() === urlBefore, JSON.stringify(st));
    check(L + "施設端末トークンへ戻る（施設トークンで交換・管理者からの交換は使わない）",
      st.admin === false && st.role === "k" && st.claims && st.claims.r === "k" && st.claims.ka !== true
      && !page.__api.some((a) => a.body.kind === "adminKiosk"), JSON.stringify(st) + " " + JSON.stringify(page.__api.map((a) => a.body.kind)));
    await context.close();
  }

  // ---- マンテール: 交換に失敗したら閉じない ----
  {
    const L = "マンテール交換失敗: ";
    const opts = { share: (b) => (b.kind === "adminKiosk" ? { status: 503, body: { error: "x" } } : null) };
    const { context, page } = await newPage(browser, 390, 844, "?c=mantel&admin=abc", opts);
    await clickClose(page);
    const st = await state(page);
    const alertShown = await page.evaluate(() => /閉じられませんでした/.test(document.body.innerText));
    check(L + "管理画面のまま案内を出す（打刻トップへ管理者の権限を持ち込まない）", st.screen === "admin" && st.role === "a" && alertShown, JSON.stringify(st));
    await context.close();
  }

  // ---- マンテール: サーバが交換を拒否（失効）したら権限を落として閉じる ----
  {
    const L = "マンテール交換拒否: ";
    const opts = { share: (b) => (b.kind === "adminKiosk" ? { status: 401, body: { error: "invalid_credentials" } } : null) };
    const { context, page } = await newPage(browser, 390, 844, "?c=mantel&admin=abc", opts);
    await clickClose(page);
    const st = await state(page);
    check(L + "管理者の権限を落として打刻トップへ（失敗を権限を残す側に倒さない）", st.screen === "home" && st.admin === false && st.role !== "a" && (!st.claims || st.claims.r !== "a"), JSON.stringify(st));
    await context.close();
  }

  // ---- 穂乃味の施設URLの打刻トップには従来どおり管理者メニューを出さない ----
  {
    const { context, page } = await newPage(browser, 390, 844, "?token=tokHonten");
    const st = await state(page);
    check("穂乃味の施設URLの打刻トップは管理者メニューを出さない（従来どおり）", st.screen === "home" && !st.adminBtn && st.staffBtns === 3, JSON.stringify(st));
    await context.close();
  }

  await browser.close();
  console.log("\n" + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
