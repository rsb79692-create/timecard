/**
 * 従業員向けマニュアル（ミュゲの泉・打刻と衛生・温度・保存食）の PDF を組む。
 * 画像は manual-shots.js が撮った実画面（模擬データ）。押す場所の番号・赤枠・矢印と、氏名の隠しをここで重ねる。
 *   node build-manual.js <撮影の出力先> <PDF の出力先>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SHOTS = path.resolve(process.argv[2]);
const PDF = path.resolve(process.argv[3]);
const VW = 390, VH = 844;

function img(name, opt) {
  const o = opt || {};
  const png = fs.readFileSync(path.join(SHOTS, name + ".png")).toString("base64");
  const meta = JSON.parse(fs.readFileSync(path.join(SHOTS, name + ".json"), "utf8"));
  const only = o.only; // 表示する番号（省略時はすべて）
  let crop = o.crop || [0, VH]; // 縦の切り出し（CSS px）
  if (o.cropBox) { const bx = meta.boxes.find((t) => t.n === o.cropBox); if (bx && bx.box) crop = [Math.max(0, bx.box.y - 20), Math.min(VH, bx.box.y + bx.box.height + 20)]; }
  const noMark = !!o.cropBox; // 切り出し（完了表示の確認用）は番号を付けない
  const h = crop[1] - crop[0];
  let svg = "";
  svg += '<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#e00000"/></marker></defs>';
  for (const m of meta.mask) {
    svg += `<rect x="${m.x - 3}" y="${m.y - 2}" width="${m.w + 6}" height="${m.h + 4}" rx="4" fill="#6b7280"/>`;
    const fsz = Math.min(m.h * 0.55, 30);
    svg += `<text x="${m.x + m.w / 2}" y="${m.y + m.h / 2 + fsz * 0.36}" font-size="${fsz}" text-anchor="middle" fill="#fff" font-weight="700">氏名</text>`;
  }
  for (const t of meta.boxes) {
    if (!t.box) continue;
    if (noMark || (only && only.indexOf(t.n) < 0 && !t.info)) continue;
    const label = (o.labels && o.labels[t.n]) || t.n;
    const b = t.box, pad = 5;
    const x = b.x - pad, y = b.y - pad, w = b.width + pad * 2, hh = b.height + pad * 2;
    if (t.info) { svg += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="10" fill="none" stroke="#e00000" stroke-width="3" stroke-dasharray="8 6"/>`; continue; }
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="10" fill="none" stroke="#e00000" stroke-width="5"/>`;
    // 番号の丸の位置: 指定 > 左 > 上 > 下 > 右
    const R = 19, gap = 46;
    const cands = {
      left: [x - gap, y + hh / 2], right: [x + w + gap, y + hh / 2],
      above: [x + Math.min(w / 2, 30), y - gap], below: [x + Math.min(w / 2, 30), y + hh + gap],
    };
    const ok = (p) => p[0] >= R + 2 && p[0] <= VW - R - 2 && p[1] >= crop[0] + R + 2 && p[1] <= crop[1] - R - 2;
    const order = o.pos && o.pos[t.n] ? [o.pos[t.n]] : (w > 200 ? ["below", "above", "left", "right"] : ["left", "above", "below", "right"]);
    let c = null;
    for (const k of order) if (ok(cands[k])) { c = cands[k]; break; }
    if (!c) c = [Math.max(R + 2, Math.min(VW - R - 2, x)), Math.max(crop[0] + R + 2, y - gap)];
    // 矢印: 丸の縁から枠の最も近い点へ
    const tx = Math.max(x, Math.min(x + w, c[0])), ty = Math.max(y, Math.min(y + hh, c[1]));
    const dx = tx - c[0], dy = ty - c[1], d = Math.hypot(dx, dy) || 1;
    const sx = c[0] + (dx / d) * (R + 1), sy = c[1] + (dy / d) * (R + 1), ex = tx - (dx / d) * 4, ey = ty - (dy / d) * 4;
    if (d > R + 8) svg += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#e00000" stroke-width="5" marker-end="url(#ah)"/>`;
    svg += `<circle cx="${c[0]}" cy="${c[1]}" r="${R}" fill="#e00000" stroke="#fff" stroke-width="3"/>`;
    svg += `<text x="${c[0]}" y="${c[1] + 8}" font-size="23" text-anchor="middle" fill="#fff" font-weight="900">${label}</text>`;
  }
  const wmm = o.w || 84;
  return `<div class="shot" style="width:${wmm}mm"><div class="frame" style="aspect-ratio:${VW}/${h}">` +
    `<svg viewBox="0 ${crop[0]} ${VW} ${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">` +
    `<image href="data:image/png;base64,${png}" x="0" y="0" width="${VW}" height="${VH}"/>${svg}</svg></div>` +
    (o.cap ? `<div class="cap">${o.cap}</div>` : "") + `</div>`;
}
const n = (x) => `<span class="no">${x}</span>`;
const btn = (t, ng) => `<span class="btn${ng ? " ng" : ""}">${t}</span>`;
function page(kind, title, body) {
  return `<section class="page"><div class="band ${kind}">${kind === "in" ? "出勤" : kind === "out" ? "退勤" : "ミュゲの泉"}</div><h2>${title}</h2>${body}<div class="foot">ミュゲの泉 打刻のしかた（2026年10月版）</div></section>`;
}

const pages = [];
pages.push(`<section class="page cover"><div class="band in">ミュゲの泉</div>
<h1>打刻のしかた<br><small>衛生・温度・保存食</small></h1>
<div class="flow"><div class="lane in"><div class="lt">出勤</div>
<ol><li>名前 → 暗証番号（PIN）</li><li>${btn("出　勤")} を押す</li><li>衛生・感染症の確認</li><li>${btn("問題なし")}<br><b class="red">ここで出勤完了</b></li><li>朝の温度が出たら入力<br>${btn("温度を記録")}</li></ol></div>
<div class="lane out"><div class="lt">退勤</div>
<ol><li>名前 → 暗証番号（PIN）</li><li>${btn("退　勤", 1)} を押す</li><li>温度が出たら入力</li><li>最後の人は保存食の確認</li><li>退勤完了</li></ol></div></div>
<ul class="notes"><li>温度・保存食の画面は、<b>出たときだけ</b>入力します。</li><li>困ったら<b>責任者に連絡</b>してください。</li></ul>
<p class="tiny">画面は見本です（氏名は隠しています）。</p>
<div class="foot">ミュゲの泉 打刻のしかた（2026年10月版）</div></section>`);

pages.push(page("in", "① 出勤のしかた", `<div class="row">
${img("01-home", { pos: { 1: "above" }, cap: n(1) + " 自分の名前を押す" })}
${img("03-punch", { cap: n(2) + " 暗証番号（PIN）を入れて<br>" + btn("出　勤") + " を押す" })}
</div>`));

pages.push(page("in", "② 衛生・感染症の確認　③「問題なし」", `<div class="row">
${img("04-hyg", { pos: { 3: "below" }, cap: n(3) + " 全部問題なければ<br>" + btn("問題なし") })}
${img("09-hyg-ng", { labels: { 1: "!" }, cap: n("!") + " 問題があるときは " + btn("問題あり", 1) + "<br><b class='red'>責任者に連絡</b>して「閉じる」<br><span class='sm'>（出勤はまだ記録されていません）</span>" })}
</div>`));

pages.push(page("in", "④ 出勤完了", `<p class="lead">${btn("問題なし")} を押した時点で<b class="red">出勤は完了</b>です。<br>押した時刻が出勤時刻になります。</p><div class="row">
${img("05-temp-empty", { labels: { 4: "A" }, pos: { 4: "right" }, cap: n("A") + " 朝の温度がまだの日は<br>「出勤しました」のあと温度の画面" })}
${img("08-clockin-done", { labels: { 1: "B" }, cap: n("B") + " 温度が記録済みの日は<br>この画面で完了" })}
</div>`));

pages.push(page("in", "⑤ 朝の冷蔵庫・冷凍庫の温度", `<div class="row">
${img("06-temp-filled", { w: 86 })}
<div class="side"><ol class="big"><li>${n(1)} 温度計を見て<b>数字だけ</b>入れる<div class="ex">冷蔵 3.5℃ →「3.5」<br>冷凍 −19℃ →「19」</div><span class="sm">冷凍の「−」は自動で付きます</span></li>
<li>${n(2)} ${btn("温度を記録")}</li>
<li>${n(3)} 「温度を記録しました」で完了${img("07-saved", { cropBox: 3, w: 84 })}</li></ol>
<p class="memo">「前回」は参考です。今の温度を入れてください。</p>
<p class="memo">入れられないときは「記録しないで閉じる」。<b>出勤は記録済み</b>です。</p></div>
</div>`));

pages.push(page("out", "⑥ 退勤のしかた・日中の温度", `<div class="row">
${img("10-punch-out", { cap: n(1) + " 名前・暗証番号（PIN）のあと<br>" + btn("退　勤", 1) + " を押す" })}
${img("11-temp-day", { labels: { 2: 2, 3: 3 }, cap: "温度の画面が出たら<br>" + n(2) + " 数字を入れて " + n(3) + " " + btn("記録して退勤") })}
</div><p class="memo2">温度の画面が出ないときは、そのまま退勤完了です。</p>`));

pages.push(page("out", "⑦ 夕方の温度・⑧ 保存食の確認（最後の人）", `<div class="row">
${img("13-temp-eve", { cap: "最後に退勤する人は夕方の温度<br>" + n(1) + " 数字を入れて " + n(2) + " " + btn("次へ") })}
${img("14-hozon", { pos: { 3: "below" }, cap: n(3) + " 保存も廃棄もできていれば " + btn("はい") + "<br><span class='sm'>できていないときは点線の「いいえ」（次のページ）</span>" })}
</div>`));

pages.push(page("out", "保存食で「いいえ」のとき・退勤完了", `<div class="row">
${img("15-hozon-no", { labels: { 1: "!" }, cap: n("!") + " <b class='red'>責任者に連絡</b>してから<br>" + btn("退勤する") })}
${img("12-out-done", { labels: { 4: "✓" }, cap: n("✓") + " 「打刻完了」が出たら<br>退勤完了" })}
</div>`));

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page{size:A4 portrait;margin:0}
*{box-sizing:border-box}
body{margin:0;font-family:"Yu Gothic UI","Yu Gothic","Meiryo",sans-serif;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;height:297mm;padding:10mm 11mm 12mm;position:relative;page-break-after:always;overflow:hidden}
.band{display:inline-block;font-size:17pt;font-weight:900;color:#fff;padding:1.5mm 6mm;border-radius:3mm}
.band.in{background:#1e40af}.band.out{background:#b91c1c}
h1{font-size:40pt;line-height:1.25;margin:10mm 0 8mm}h1 small{font-size:24pt}
h2{font-size:23pt;margin:3mm 0 4mm;line-height:1.3}
.row{display:flex;gap:7mm;justify-content:center;align-items:flex-start}
.shot{flex:none}.frame{width:100%;border:1.2mm solid #222;border-radius:4mm;overflow:hidden;background:#fff}
.frame svg{display:block;width:100%;height:100%}
.cap{font-size:15.5pt;font-weight:700;line-height:1.5;margin-top:3mm;text-align:center}
.no{display:inline-block;width:9mm;height:9mm;line-height:9mm;border-radius:50%;background:#e00000;color:#fff;text-align:center;font-weight:900;font-size:14pt;vertical-align:middle}
.btn{display:inline-block;background:#1e40af;color:#fff;font-weight:900;border-radius:2mm;padding:.5mm 3mm;font-size:.95em;white-space:nowrap}
.btn.ng{background:#fff;color:#b91c1c;border:.6mm solid #b91c1c}
.red{color:#c00000}.lead{font-size:17pt;font-weight:700;line-height:1.6;margin:0 0 4mm}
.side{width:90mm}.side .shot{margin-top:2mm}.big{list-style:none;padding:0;margin:0;font-size:17pt;font-weight:700;line-height:1.6}.big li{margin-bottom:6mm}
.ex{font-size:16pt;background:#f1f5f9;border-radius:2mm;padding:2mm 3mm;margin:2mm 0}
.sm{font-size:12.5pt;font-weight:700;color:#333}
.memo{font-size:14.5pt;font-weight:700;line-height:1.55;border-left:2mm solid #f59e0b;padding-left:3mm;margin:0 0 5mm}
.memo2{font-size:15pt;font-weight:700;text-align:center;margin-top:4mm}
.flow{display:flex;gap:6mm}.lane{flex:1;border:1mm solid;border-radius:4mm;padding:4mm}
.lane.in{border-color:#1e40af}.lane.out{border-color:#b91c1c}
.lt{font-size:22pt;font-weight:900;margin-bottom:2mm}.lane.in .lt{color:#1e40af}.lane.out .lt{color:#b91c1c}
.lane ol{margin:0;padding-left:8mm;font-size:16.5pt;font-weight:700;line-height:1.55}.lane li{margin-bottom:3.5mm}
.notes{font-size:16pt;font-weight:700;line-height:1.7;margin-top:8mm}
.tiny{font-size:11pt;color:#444;margin-top:6mm}
.foot{position:absolute;bottom:6mm;left:11mm;right:11mm;font-size:10pt;color:#555;border-top:.3mm solid #999;padding-top:1.5mm}
</style></head><body>${pages.join("")}</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.setContent(html, { waitUntil: "load" });
  await p.pdf({ path: PDF, format: "A4", printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(PDF.replace(/\.pdf$/, ".html"), html);
  await browser.close();
  console.log("pdf", PDF, pages.length, "pages");
})().catch((e) => { console.error(e); process.exit(1); });
