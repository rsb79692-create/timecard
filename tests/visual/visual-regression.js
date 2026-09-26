/**
 * tests/visual/visual-regression.js — 画面の見た目の比較（穂乃味が変わっていないことの確認）
 *
 * 変更前の index.html（git の指定コミット）と作業ツリーの index.html を、同じ模擬データ・同じ時刻で
 * 描画し、スクリーンショットを1画素単位で比べる。あわせてマンテール版の画面も保存する（目視確認用）。
 *
 * 実行:
 *   node tests/visual/visual-regression.js [比較元コミット=HEAD] [出力先=tests/visual/out]
 *   ※ Playwright（Chromium）が必要。本リポジトリは npm プロジェクトではないため、
 *     グローバルに入っている playwright を使う。
 *
 * ★ ネットワークはすべて模擬する（本番の Firebase・Vercel・LINE へは一切接続しない）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, openApp, settle, shot, tapPin, tapStaffPin } = HN;

const BASE_REF = process.argv[2] || "HEAD";
const OUT = path.resolve(process.argv[3] || path.join(__dirname, "out"));
fs.mkdirSync(OUT, { recursive: true });

// 比べる画面（穂乃味）
const SCENES = [
  { id: "home-all", query: "?token=all", steps: async () => {} },
  { id: "home-facility", query: "?token=tokHonten", steps: async () => {} },
  { id: "staff-pin", query: "?token=tokHonten", steps: async (p) => { await p.evaluate(() => window.selStaff("山田 太郎")); await settle(p); } },
  { id: "punch", query: "?token=tokHonten", steps: async (p) => { await p.evaluate(() => window.selStaff("山田 太郎")); await settle(p); await tapStaffPin(p, "1234"); } },
  { id: "admin-pin", query: "?token=all", steps: async (p) => { await p.evaluate(() => window.goPin()); await settle(p); } },
  { id: "admin-records", query: "?token=all", steps: async (p) => { await p.evaluate(() => window.goPin()); await settle(p); await tapPin(p, "12345678"); } },
  { id: "admin-master", query: "?token=all", steps: async (p) => { await p.evaluate(() => window.goPin()); await settle(p); await tapPin(p, "12345678"); await p.evaluate(() => window.setTab("master")); await settle(p); } },
  { id: "admin-staff", query: "?token=all", steps: async (p) => { await p.evaluate(() => window.goPin()); await settle(p); await tapPin(p, "12345678"); await p.evaluate(() => window.setTab("staff")); await settle(p); } },
  { id: "admin-paidleave", query: "?token=all", steps: async (p) => { await p.evaluate(() => window.goPin()); await settle(p); await tapPin(p, "12345678"); await p.evaluate(() => window.setTab("paidleave")); await settle(p); } },
  { id: "viewer", query: "?viewer=vtok1", steps: async () => {} },
];

function pngEqual(a, b) { return Buffer.compare(a, b) === 0; }

async function main() {
  const baseDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "vr-base-"));
  execSync("git archive " + BASE_REF + " | tar -x -C " + JSON.stringify(baseDir), { cwd: ROOT, stdio: "ignore", shell: "/bin/bash" });
  const browser = await chromium.launch();
  let same = 0, diff = 0;
  const diffs = [];
  for (const sc of SCENES) {
    const shots = [];
    for (const [label, dir] of [["before", baseDir], ["after", ROOT]]) {
      const { ctx, page } = await openApp(browser, dir, sc.query);
      await sc.steps(page);
      shots.push(await shot(page, path.join(OUT, "honomi-" + sc.id + "-" + label + ".png")));
      await ctx.close();
    }
    if (pngEqual(shots[0], shots[1])) { same++; console.log("  SAME  honomi " + sc.id); }
    else { diff++; diffs.push(sc.id); console.log("  DIFF  honomi " + sc.id); }
  }
  // マンテール（目視確認用に保存。比較はしない）
  const MSCENES = [
    { id: "home", query: "?c=mantel&token=tokHonten", steps: async () => {} },
    { id: "staff-pin", query: "?c=mantel&token=tokHonten", steps: async (p) => { await p.evaluate(() => window.selStaff("山田 太郎")); await settle(p); } },
    { id: "punch", query: "?c=mantel&token=tokHonten", steps: async (p) => { await p.evaluate(() => window.selStaff("山田 太郎")); await settle(p); await tapStaffPin(p, "1234"); } },
    { id: "admin-gate", query: "?c=mantel", steps: async () => {} },
    { id: "admin-records", query: "?c=mantel", steps: async (p) => { await tapPin(p, "12345678"); } },
    { id: "admin-master", query: "?c=mantel", steps: async (p) => { await tapPin(p, "12345678"); await p.evaluate(() => window.setTab("master")); await settle(p); } },
    { id: "admin-staff", query: "?c=mantel", steps: async (p) => { await tapPin(p, "12345678"); await p.evaluate(() => window.setTab("staff")); await settle(p); } },
    { id: "system-gate", query: "?c=mantel&sys", steps: async () => {} },
    { id: "viewer", query: "?c=mantel&viewer=vtok1", steps: async () => {} },
    { id: "unknown-company", query: "?c=zzz", steps: async () => {} },
  ];
  for (const sc of MSCENES) {
    const { ctx, page } = await openApp(browser, ROOT, sc.query);
    await sc.steps(page);
    await shot(page, path.join(OUT, "mantel-" + sc.id + ".png"));
    await ctx.close();
    console.log("  SAVED mantel " + sc.id);
  }
  await browser.close();
  console.log("\n  穂乃味: 同一 " + same + " / 差異 " + diff + (diffs.length ? "（" + diffs.join(", ") + "）" : ""));
  process.exit(diff ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
