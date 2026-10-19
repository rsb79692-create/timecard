/**
 * tests/visual/punch-miss-fix.js — 打刻漏れの修正（候補ボタン・まとめ画面・数字4桁入力）をブラウザで確かめる
 *
 * 実行: node tests/visual/punch-miss-fix.js [スクリーンショットの出力先]
 *   ※ Playwright（Chromium）が必要。ネットワークはすべて模擬する（本番の Firebase・Vercel へは接続しない）。
 *     書き込み（PUT / PATCH）は模擬サーバのメモリにだけ反映し、送った内容を検査する。
 *
 * 確かめること（スマホ幅 375px）
 *   ①勤怠一覧の退勤漏れの欄の候補ボタン1タップで保存される（理由「打刻漏れ」・自動承認）。「元に戻す」で論理削除と承認の取り消し
 *   ②「⚠ 打刻漏れ ○件」のまとめ画面で保存すると行が消え、件数が減り、最後は「打刻漏れはありません」
 *   ③「その他」から「1800」と入力すると Enter なしで 18:00 として保存される（数字キーボード＝inputmode=numeric）
 *   ・既存の時刻の変更は理由選択画面に進む／修正履歴の画面・CSV に修正後の時刻と理由が出る
 *   ・ボタンの高さ36px以上・375px で横にはみ出さない
 */
"use strict";

const fs = require("fs");
const path = require("path");
const HN = require("./harness");
const { chromium } = HN.requirePlaywright();
const { ROOT, APP, FIXED_NOW, settle, tapPin } = HN;

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "out-punch-miss"));
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}

// 模擬サーバ（穂乃味）。harness の模擬データに打刻漏れの日と過去の傾向を足す。今日＝2026-09-24
const ts = (d, t) => Date.parse(d + "T" + t + ":00+09:00");
function seed() {
  const d = HN.dataFor("honomi");
  const add = (id, staff, type, date, time, fac) => { d.tc5_records[id] = { id, staff, type, date, time, timestamp: ts(date, time), facilityName: fac, workFacility: fac }; };
  // 山田（本店）：過去の退勤はほぼ 17:30 前後、9/23 は退勤漏れ
  ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].forEach((dt, i) => { add("y_in_" + i, "山田 太郎", "clockIn", dt, "08:3" + i, "本店"); add("y_out_" + i, "山田 太郎", "clockOut", dt, ["17:28", "17:33", "17:31", "18:02"][i], "本店"); });
  add("y_in_23", "山田 太郎", "clockIn", "2026-09-23", "08:30", "本店");
  // 佐藤（本店）：9/21 は退勤漏れ（③の「1800」で直す）
  add("s_in_21", "佐藤 花子", "clockIn", "2026-09-21", "09:00", "本店");
  // 鈴木（二号店）：9/20 は出勤漏れ（②で候補ボタンで直す）
  add("k_out_20", "鈴木 一郎", "clockOut", "2026-09-20", "17:00", "二号店");
  return d;
}
const store = seed();
const writes = [];
function getPath(obj, parts) { let c = obj; for (const p of parts) { if (c == null || typeof c !== "object") return null; c = c[decodeURIComponent(p)]; } return c === undefined ? null : c; }
function setPath(obj, parts, v) {
  let c = obj;
  for (let i = 0; i < parts.length - 1; i++) { const k = decodeURIComponent(parts[i]); if (c[k] == null || typeof c[k] !== "object") c[k] = {}; c = c[k]; }
  const last = decodeURIComponent(parts[parts.length - 1]);
  if (v === null) delete c[last]; else c[last] = v;
}
async function dbRoute(route) {
  const req = route.request(), url = new URL(req.url());
  const parts = url.pathname.replace(/\.json$/, "").split("/").filter(Boolean);
  if (parts[0] !== "honomi") return route.fallback();
  const rest = parts.slice(1);
  const m = req.method();
  if (m === "GET") {
    let v = getPath(store, rest);
    if (rest[0] === "tc5_records" && rest.length === 1 && url.searchParams.get("orderBy")) {
      const st = (url.searchParams.get("startAt") || '""').replace(/"/g, ""), en = (url.searchParams.get("endAt") || '""').replace(/"/g, "");
      v = {}; Object.keys(store.tc5_records).forEach((k) => { const r = store.tc5_records[k]; if (r.date >= st && r.date <= en) v[k] = r; });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v === undefined ? null : v) });
  }
  let body = null; try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = null; }
  writes.push({ method: m, path: rest.join("/"), body });
  if (m === "PUT") setPath(store, rest, body);
  else if (m === "PATCH" && body && typeof body === "object") {
    Object.keys(body).forEach((k) => {
      const p = rest.concat(k.split("/"));
      const base = getPath(store, p.slice(0, -1));
      if (rest.length && body[k] !== null && typeof body[k] !== "object") setPath(store, p, body[k]);
      else setPath(store, p, body[k]);
      void base;
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo", hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  await page.clock.install({ time: FIXED_NOW });
  await page.clock.pauseAt(FIXED_NOW);
  await page.addInitScript(() => { try { delete window.Notification; } catch (e) {} });
  await HN.installRoutes(page, ROOT, {});
  await page.route(/firebasedatabase\.app/, dbRoute); // 後から登録した方が先に効く（書き込みを模擬サーバへ反映する）
  await page.goto(APP + "?token=all", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.evaluate(() => window.goPin()); await settle(page);
  await tapPin(page, "12345678");
  await page.evaluate(() => { setTab("records"); }); await settle(page);
  await page.evaluate(() => { selDate = "2026-09-23"; render(); }); await settle(page);
  await settle(page);

  // ── ① 勤怠一覧：候補ボタン1タップで保存 ──
  const btns = await page.$$eval('.pm-btn[data-nm="山田 太郎"][data-type="clockOut"]', (bs) => bs.map((b) => ({ t: b.textContent, h: b.getBoundingClientRect().height })));
  check("①勤怠一覧の退勤漏れの欄に候補ボタンが出る（山田さんの傾向 17:30 が先頭）", btns.length >= 1 && btns[0].t === "17:30", JSON.stringify(btns));
  check("候補ボタンは最大3つ＋「その他」", btns.length <= 3 && (await page.$$('.pm-other[data-nm="山田 太郎"][data-type="clockOut"]')).length === 1);
  check("候補ボタンの高さは36px以上", btns.every((b) => b.h >= 36), JSON.stringify(btns));
  const layout = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = [].slice.call(document.querySelectorAll(".pm-sugg")).filter((s) => {
      const r = s.getBoundingClientRect(), td = s.closest("td").getBoundingClientRect();
      return r.left < td.left - 0.5 || r.right > td.right + 0.5;
    }).length;
    return { vw, docW: document.documentElement.scrollWidth, over };
  });
  check("375px：候補ボタンが欄からはみ出さず、ページが横にはみ出さない", layout.over === 0 && layout.docW <= layout.vw, JSON.stringify(layout));
  await page.screenshot({ path: path.join(OUT, "1-records-375.png"), fullPage: true });
  check("出勤もある日の未打刻ではない欄（出勤）には候補を出さない", (await page.$$('.pm-btn[data-nm="山田 太郎"][data-type="clockIn"]')).length === 0);
  // 当日（9/24）の山田さんの退勤漏れ（勤務中）には出さない
  writes.length = 0;
  await page.tap('.pm-btn[data-nm="山田 太郎"][data-type="clockOut"]');
  await settle(page);
  const p1 = writes.find((w) => w.method === "PATCH" && w.path === "");
  const recKey = p1 && Object.keys(p1.body).find((k) => k.indexOf("tc5_records/") === 0);
  const rec = recKey && p1.body[recKey];
  check("①1タップで保存（理由選択画面なし・時刻と承認を1回の多パス更新）",
    !!rec && rec.time === "17:30" && rec.type === "clockOut" && rec.adjustReason === "miss" && rec.adjustReasonLabel === "打刻漏れ" && rec.adjustComment === "" && p1.body["tc5_approvals/2026-09-23__山田 太郎"] === true,
    JSON.stringify(p1));
  check("理由選択画面を出していない", !(await page.evaluate(() => document.body.innerText.indexOf("修正理由を選択してください") >= 0)));
  const undoVisible = await page.isVisible("#pm-undo .pm-undo-btn");
  check("保存後に「元に戻す」を出す", undoVisible);
  await page.screenshot({ path: path.join(OUT, "2-saved-undo.png") });
  writes.length = 0;
  await page.tap("#pm-undo .pm-undo-btn");
  await settle(page);
  const p2 = writes.find((w) => w.method === "PATCH" && w.path === "");
  check("元に戻す：その打刻を論理削除し、自動承認を外す（1回の多パス更新）",
    !!p2 && p2.body[recKey] && p2.body[recKey].deleted === true && p2.body["tc5_approvals/2026-09-23__山田 太郎"] === null, JSON.stringify(p2));
  check("元に戻すと候補ボタンが再び出る", (await page.$$('.pm-btn[data-nm="山田 太郎"][data-type="clockOut"]')).length >= 1);
  // 改めて保存（以後の確認のため）
  await page.tap('.pm-btn[data-nm="山田 太郎"][data-type="clockOut"]');
  await settle(page);
  await page.waitForTimeout(50);
  try { await page.clock.runFor(7000); } catch (e) { /* 無視 */ }
  await settle(page);
  check("「元に戻す」は数秒で消える", !(await page.isVisible("#pm-undo")));

  check("保存して承認された日は読み取り専用（候補ボタンも出ない）", (await page.$$('.pm-btn[data-nm="山田 太郎"]')).length === 0 && (await page.$$('.time-cell[data-nm="山田 太郎"]')).length === 0);
  // ── 既存の時刻の変更は理由選択画面へ（9/22 佐藤さん・未承認） ──
  await page.evaluate(() => { selDate = "2026-09-22"; render(); }); await settle(page);
  await page.tap('.time-cell[data-nm="佐藤 花子"][data-type="clockIn"]');
  const inp0 = await page.$(".time-edit-input");
  check("時刻の入力欄は数字専用（type=text・inputmode=numeric）",
    !!inp0 && (await inp0.getAttribute("type")) === "text" && (await inp0.getAttribute("inputmode")) === "numeric");
  await page.keyboard.type("0815");
  await settle(page);
  check("既存の時刻を「0815」に変えると理由選択画面に進む", await page.evaluate(() => document.body.innerText.indexOf("修正理由を選択してください") >= 0));
  await page.evaluate(() => { const b = [].slice.call(document.querySelectorAll("button")).find((x) => x.textContent === "キャンセル"); if (b) b.click(); });
  await settle(page);
  check("理由をキャンセルすると元の時刻に戻る（保存しない）", (await page.textContent('.time-cell[data-nm="佐藤 花子"][data-type="clockIn"]')).trim() === "09:01");
  await page.evaluate(() => { selDate = "2026-09-23"; render(); }); await settle(page);

  // ── 個人別画面（鈴木さん 9/20 出勤漏れ）にも候補ボタン ──
  await page.evaluate(() => { selMonth = "2026-09"; openStaffDetail("鈴木 一郎", "admin"); }); await settle(page); await settle(page);
  const sd = await page.evaluate(() => {
    const bs = [].slice.call(document.querySelectorAll('.pm-btn[data-date="2026-09-20"][data-type="clockIn"]'));
    const over = [].slice.call(document.querySelectorAll(".pm-sugg")).filter((x) => { const r = x.getBoundingClientRect(), td = x.closest("td").getBoundingClientRect(); return r.left < td.left - 0.5 || r.right > td.right + 0.5; }).length;
    return { n: bs.length, t: bs.map((b) => b.textContent), h: bs.map((b) => b.getBoundingClientRect().height), other: !!document.querySelector('.pm-other[data-date="2026-09-20"]'), over: over,
      docW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
  });
  check("個人別画面：出勤漏れの日の出勤欄に候補ボタン（退勤 17:00 より前）と「その他」", sd.n >= 1 && sd.other && sd.t.every((t) => t < "17:00") && sd.h.every((h) => h >= 36) && sd.over === 0 && sd.docW <= sd.vw, JSON.stringify(sd));
  await page.screenshot({ path: path.join(OUT, "1b-staff-detail-375.png"), fullPage: true });
  await page.evaluate(() => { screen = "admin"; setTab("records"); selDate = "2026-09-23"; render(); }); await settle(page);

  // ── ② 打刻漏れまとめ画面 ──
  const sumTxt = await page.textContent("#btn-pm-summary");
  check("②勤怠一覧の上部に「⚠ 打刻漏れ 2件」（9/21 佐藤・9/20 鈴木。当日は含めない）", /⚠ 打刻漏れ 2件/.test(sumTxt), sumTxt);
  await page.tap("#btn-pm-summary");
  await settle(page);
  let rows = await page.$$eval(".pm-sum-row .pm-sum-who", (es) => es.map((e) => e.textContent));
  check("まとめ画面は日付の新しい順（9/21 → 9/20）", rows.length === 2 && /9\/21/.test(rows[0]) && /佐藤/.test(rows[0]) && /9\/20/.test(rows[1]) && /鈴木/.test(rows[1]), JSON.stringify(rows));
  check("行に施設・出勤・退勤（--:--）が出る", await page.evaluate(() => { const r = document.querySelector(".pm-sum-row"); return /本店/.test(r.textContent) && /出勤 09:00/.test(r.textContent) && /退勤 --:--/.test(r.textContent); }));
  await page.screenshot({ path: path.join(OUT, "3-summary.png") });
  const kBtn = await page.$('.pm-sum-row .pm-btn[data-nm="鈴木 一郎"][data-type="clockIn"]');
  const kTime = kBtn && await kBtn.textContent();
  writes.length = 0;
  await kBtn.tap();
  await settle(page);
  rows = await page.$$eval(".pm-sum-row .pm-sum-who", (es) => es.map((e) => e.textContent));
  const ttl = await page.textContent(".pm-sum-ttl");
  check("②候補ボタンで保存した行がすぐ消え、件数が 1件に減る", rows.length === 1 && /佐藤/.test(rows[0]) && /1件/.test(ttl), JSON.stringify(rows) + " " + ttl);
  const p3 = writes.find((w) => w.method === "PATCH" && w.path === "");
  check("まとめ画面の保存も同じ処理（理由「打刻漏れ」・自動承認）",
    !!p3 && Object.keys(p3.body).some((k) => k.indexOf("tc5_records/") === 0 && p3.body[k].time === kTime && p3.body[k].adjustReason === "miss") && p3.body["tc5_approvals/2026-09-20__鈴木 一郎"] === true, JSON.stringify(p3));

  // ── ③ 「その他」→「1800」 ──
  await page.tap('.pm-sum-row .pm-other[data-nm="佐藤 花子"]');
  const inp = await page.$(".pm-sum-row .time-edit-input");
  check("③「その他」で数字の入力欄が開く（inputmode=numeric）", !!inp && (await inp.getAttribute("inputmode")) === "numeric");
  writes.length = 0;
  await page.keyboard.type("1800");
  await settle(page);
  const p4 = writes.find((w) => w.method === "PATCH" && w.path === "");
  check("③「1800」と入れると Enter なしで 18:00 として保存される（理由「打刻漏れ」）",
    !!p4 && Object.keys(p4.body).some((k) => k.indexOf("tc5_records/") === 0 && p4.body[k].time === "18:00" && p4.body[k].adjustReason === "miss" && p4.body[k].staff === "佐藤 花子"), JSON.stringify(p4));
  check("全部片付いたら「打刻漏れはありません」", await page.evaluate(() => /打刻漏れはありません/.test(document.querySelector(".pm-sum-list").textContent)));
  await page.screenshot({ path: path.join(OUT, "4-summary-empty.png") });
  await page.tap(".pm-sum-close");
  await settle(page);
  const sumTxt2 = await page.textContent("#btn-pm-summary");
  check("閉じると勤怠一覧のボタンは「打刻漏れ 0件」（目立たない表示）",
    /打刻漏れ 0件/.test(sumTxt2) && !(await page.$eval("#btn-pm-summary", (b) => b.classList.contains("pm-sum-on"))), sumTxt2);

  // ── 修正履歴の画面と CSV ──
  await page.evaluate(() => { adjLogMonth = "2026-09"; setTab("adjustlog"); }); await settle(page);
  const logTxt = await page.evaluate(() => document.querySelector("#app").innerText);
  check("修正履歴：理由「打刻漏れ」と修正後の時刻（17:30・18:00）が出る",
    /打刻漏れ/.test(logTxt) && /08:30\s+17:30/.test(logTxt) && /09:00\s+18:00/.test(logTxt), logTxt.slice(0, 600));
  const csv = await page.evaluate(() => {
    let out = ""; const orig = window.dlCSV; window.dlCSV = function (c) { out = c; };
    try { const recs = records.filter((r) => monthKey(r.date) === "2026-09" && !r.deleted); dlStaffDetailCSV("2026-09", recs, staffList, approvals); } finally { window.dlCSV = orig; }
    return out;
  });
  const sRow = csv.split("\n").find((l) => /^佐藤 花子,.*2026-09-21/.test(l)) || "";
  check("CSV（人別明細）：修正後の退勤 18:00 が出て、打刻漏れ欄は空・承認済み", /,09:00,18:00,/.test(sRow) && /承認済,,/.test(sRow), sRow);
  check("ページの JavaScript エラーなし", errors.length === 0, errors.join(" | "));

  await context.close();
  await browser.close();
  console.log("\n================================ PASS " + pass + " / FAIL " + fail + " ================================");
  console.log("スクリーンショット: " + OUT);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
