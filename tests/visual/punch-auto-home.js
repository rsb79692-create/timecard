/**
 * tests/visual/punch-auto-home.js — 打刻画面の自動復帰（PUNCH-AUTO-HOME）を実画面で確かめる
 *
 * 実行: node tests/visual/punch-auto-home.js [スクリーンショットの出力先]
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬する（本番へ接続しない）。時計は固定して進める。
 *
 * 固定すること（docs/features/punch-auto-home.md）
 *   ・開いたばかりの打刻画面で「戻してはいけない理由」が立っていない（立っていると放置しても戻らない）
 *   ・何も押さずに60秒で一覧へ戻る。触れると数え直す
 *   ・出勤を押したら打刻完了を見せ、5秒で一覧へ戻る
 *   ・ダイアログの表示中は戻らず、閉じてから数え直す
 *   ・PC幅・スマホ幅の両方
 */
"use strict";

const fs = require("fs");
const path = require("path");
const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle } = HN;

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "out-punch-auto-home"));
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}
async function openPunch(page, name) {
  await page.evaluate((nm) => { recordsReady = true; staffName = nm; screen = "punch"; render(); }, name);
  await page.clock.runFor(100);
}
const st = (page) => page.evaluate(() => ({
  screen, staffName, punchMsg, why: punchHomeBlockReason(),
  pin: staffPinInput, sel: selectedWorkFacility,
}));

(async () => {
  const browser = await chromium.launch();
  try {
    for (const vp of [{ w: 1280, h: 900, tag: "PC" }, { w: 375, h: 812, tag: "スマホ" }]) {
      const { ctx, page } = await openApp(browser, ROOT, "?token=tokHonten");
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.evaluate(() => { window.confirm = () => true; });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

      // 放置
      await openPunch(page, "佐藤 花子");
      let s = await st(page);
      check(vp.tag + "：開いた打刻画面で戻してはいけない理由が立っていない", s.screen === "punch" && s.why === "", JSON.stringify(s));
      await page.screenshot({ path: path.join(OUT, vp.tag + "-1-punch.png") });
      await page.clock.runFor(30000);
      await page.mouse.click(5, vp.h - 5); // 画面に触れる
      await page.clock.runFor(45000);
      s = await st(page);
      check(vp.tag + "：触れたら数え直す（開いてから75秒でもまだ戻らない）", s.screen === "punch" && s.staffName === "佐藤 花子", JSON.stringify(s));
      await page.clock.runFor(16000);
      s = await st(page);
      check(vp.tag + "：最後に触れてから60秒で一覧へ戻る", s.screen === "home" && s.staffName === null, JSON.stringify(s));
      const homeText = await page.evaluate(() => document.getElementById("app").innerText);
      check(vp.tag + "：一覧画面になっている（打刻ボタンが無い）", !(await page.$(".btn-in")) && homeText.length > 0);

      // 出勤 → 5秒で戻る
      await openPunch(page, "佐藤 花子");
      await page.click(".btn-in");
      await page.clock.runFor(300);
      s = await st(page);
      check(vp.tag + "：出勤すると打刻完了を見せる", s.screen === "punch" && !!s.punchMsg, JSON.stringify(s));
      await page.screenshot({ path: path.join(OUT, vp.tag + "-2-done.png") });
      const doneText = await page.evaluate(() => document.getElementById("app").innerText);
      check(vp.tag + "：打刻完了の表示中は申請・カード類を出さない（本日の打刻履歴は出す）",
        !/修正申請|有給申請|今月の打刻/.test(doneText) && /本日の打刻履歴/.test(doneText), doneText.slice(0, 200));
      await page.clock.runFor(3500);
      s = await st(page);
      check(vp.tag + "：5秒たつまでは打刻完了のまま", s.screen === "punch" && !!s.punchMsg, JSON.stringify(s));
      await page.clock.runFor(2000);
      s = await st(page);
      check(vp.tag + "：打刻から5秒で一覧へ戻り、前の人を残さない", s.screen === "home" && s.staffName === null && s.punchMsg === null && s.sel === null, JSON.stringify(s));

      // ダイアログの表示中は戻らない
      await openPunch(page, "佐藤 花子");
      await page.evaluate(() => showAlert("確認のテスト"));
      await page.clock.runFor(120000);
      s = await st(page);
      check(vp.tag + "：ダイアログの表示中は放置しても戻らない", s.screen === "punch" && s.why === "modal", JSON.stringify(s));
      await page.click("text=OK");
      await page.clock.runFor(30000);
      s = await st(page);
      check(vp.tag + "：閉じてから60秒たつまでは戻らない", s.screen === "punch", JSON.stringify(s));
      await page.clock.runFor(31000);
      s = await st(page);
      check(vp.tag + "：閉じてから60秒で戻る", s.screen === "home" && s.staffName === null, JSON.stringify(s));
      check(vp.tag + "：ページのエラーが出ない", errors.length === 0, errors.join(" / "));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
