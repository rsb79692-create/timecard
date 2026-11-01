/**
 * tests/visual/support-pick.js — 応援ありのスタッフの「施設を選ぶ画面」（機能フラグ supportPick）
 *
 * 実行: node tests/visual/support-pick.js [スクリーンショットの出力先]
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬する（本番へ接続しない）。
 *
 * 固定すること（docs/features/support-pick.md）
 *   ・穂乃味: 応援ありのスタッフがその日まだ出勤していなければ、打刻画面の代わりに施設を選ぶ画面を出す
 *   ・この端末の施設を先頭に、目立たせて出す
 *   ・施設を押すと打刻画面になり、選んだ施設が出勤先として表示される（プルダウンは出さない）
 *   ・「施設を選び直す」で施設を選ぶ画面へ戻れる
 *   ・選んだ施設で出勤が記録される（workFacility）
 *   ・出勤済みの日・応援なしのスタッフには出さない。スタッフが替わると選び直しになる
 *   ・マンテール（supportPick:false）は従来どおり打刻画面のプルダウン
 */
"use strict";

const fs = require("fs");
const path = require("path");
const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle } = HN;

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "out-support-pick"));
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}

// 打刻画面をスタッフ本人として開く（PIN の通信は通さず、画面の状態だけを作る）
async function openPunch(page, name, opts) {
  await page.evaluate(([nm, o]) => {
    let s = staffList.find((x) => x.name === nm);
    // マンテールはログイン前にスタッフ一覧を読まないため、ここで足す
    if (!s) { s = { name: nm, location: "本店", status: "在籍" }; staffList.push(s); }
    if (!masterLocs.length) { masterLocs = ["本店", "二号店"]; }
    s.canSupportWork = !!o.support;
    if (o.clockedIn) {
      records.push({ id: "t_in", staff: nm, type: "clockIn", date: getTodayJSTStr(), time: "08:30", timestamp: Date.now() - 3600e3, facilityName: o.clockedIn, workFacility: o.clockedIn });
    }
    recordsReady = true;
    staffName = nm; screen = "punch"; render();
  }, [name, opts || {}]);
  await settle(page);
}
const state = (page) => page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("#support-pick .btn-support-pick"));
  return {
    picker: !!document.getElementById("support-pick"),
    order: btns.map((b) => b.dataset.fac),
    firstBig: btns.length ? getComputedStyle(btns[0]).backgroundColor !== getComputedStyle(btns[btns.length - 1]).backgroundColor : false,
    firstLabel: btns.length ? /この端末の施設/.test(btns[0].innerText) : false,
    chosen: (document.getElementById("support-pick-chosen") || {}).textContent || null,
    dropdown: !!document.getElementById("sel-work-facility"),
    inBtn: !!document.querySelector(".btn-in"),
    text: document.getElementById("app").innerText,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  };
});

(async () => {
  const browser = await chromium.launch();
  try {
    // ── 穂乃味・二号店の端末 ─────────────────────────────────
    let { ctx, page } = await openApp(browser, ROOT, "?token=tokNigo");
    await page.setViewportSize({ width: 375, height: 812 });
    await openPunch(page, "鈴木 一郎", { support: true });
    let st = await state(page);
    check("応援ありで未出勤なら施設を選ぶ画面が出る", st.picker && !st.inBtn, JSON.stringify({ picker: st.picker, inBtn: st.inBtn }));
    check("この端末の施設（二号店）が先頭で目立つ", st.order[0] === "二号店" && st.firstBig && st.firstLabel, JSON.stringify(st.order));
    check("全部の施設が並ぶ", st.order.length === 2 && st.order.includes("本店"), JSON.stringify(st.order));
    check("375px で横にはみ出さない", !st.overflow);
    await page.screenshot({ path: path.join(OUT, "1-pick-375.png"), fullPage: true });

    await page.click('#support-pick .btn-support-pick[data-fac="本店"]'); await settle(page);
    st = await state(page);
    check("施設を押すと打刻画面になり、選んだ施設が出る", !st.picker && st.inBtn && st.chosen === "本店", JSON.stringify({ picker: st.picker, chosen: st.chosen }));
    check("打刻画面にプルダウンは出さない", !st.dropdown);
    check("「施設を選び直す」が出る", /施設を選び直す/.test(st.text));
    await page.screenshot({ path: path.join(OUT, "2-punch-375.png"), fullPage: true });

    await page.click("text=施設を選び直す"); await settle(page);
    st = await state(page);
    check("選び直すと施設を選ぶ画面へ戻る", st.picker && !st.inBtn);
    await page.click('#support-pick .btn-support-pick[data-fac="二号店"]'); await settle(page);
    st = await state(page);
    check("選び直した施設が出る", st.chosen === "二号店", st.chosen);

    // 出勤を記録すると選んだ施設が勤務先になる
    await page.click("text=施設を選び直す"); await settle(page);
    await page.click('#support-pick .btn-support-pick[data-fac="本店"]'); await settle(page);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click(".btn-in"); await settle(page);
    const rec = await page.evaluate(() => records.filter((r) => r.staff === "鈴木 一郎" && r.type === "clockIn").map((r) => ({ wf: r.workFacility, fac: r.facilityName })));
    check("出勤は選んだ施設（本店）で記録される", rec.length === 1 && rec[0].wf === "本店", JSON.stringify(rec));

    // スタッフが替わったら選び直し（打刻後はホームへ戻る）
    await page.evaluate(() => { goHome(); }); await settle(page);
    const reset = await page.evaluate(() => ({ picked: workFacilityPicked, sel: selectedWorkFacility }));
    check("ホームへ戻ると選んだ状態を消す", reset.picked === false && reset.sel === null, JSON.stringify(reset));

    // 出勤済みの日は出さない
    await openPunch(page, "山田 太郎", { support: true });
    st = await state(page);
    check("出勤済みの日は施設を選ぶ画面を出さない", !st.picker && st.inBtn);
    await page.evaluate(() => goHome()); await settle(page);

    // 応援なしのスタッフには出さない
    await openPunch(page, "佐藤 花子", { support: false });
    st = await state(page);
    check("応援なしのスタッフには出さない", !st.picker && st.inBtn && !st.chosen);
    await ctx.close();

    // ── マンテール（supportPick:false）─────────────────────────
    ({ ctx, page } = await openApp(browser, ROOT, "?c=mantel"));
    await openPunch(page, "鈴木 一郎", { support: true });
    st = await state(page);
    check("マンテールは施設を選ぶ画面を出さず、従来のプルダウン", !st.picker && st.inBtn && st.dropdown, JSON.stringify({ picker: st.picker, dropdown: st.dropdown }));
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
