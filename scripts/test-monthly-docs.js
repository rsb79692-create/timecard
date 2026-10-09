#!/usr/bin/env node
/**
 * 打刻と月次書類の連携（MONTHLY-DOCS・穂乃味専用）の回帰テスト。
 * 依存パッケージなし・送信なし・本番データ非アクセス（通信関数はすべて差し替える）。
 *
 *   node scripts/test-monthly-docs.js
 *
 * 確認すること
 *  1. 画面側: 聞く内容の判定（衛生・感染症／朝・日中・夕方の温度／保存食・最後の退勤者）
 *  2. 画面側: 穂乃味以外・テスト画面では判定も通信も一切しない
 *  3. サーバ側: 打刻レコードの mdoc の検証（本人・施設・種別・日付・機器・廃棄日）
 *  4. API: 穂乃味以外は入口で拒否し、RTDB にも月次書類 DB にも触れない
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
function block(start, end) {
  const s = html.indexOf(start), e = html.indexOf(end, s);
  if (s < 0 || e < 0) { console.error("ERROR: 抽出できません: " + start); process.exit(1); }
  return html.slice(s, e + end.length);
}
function fnSrc(head, nextHead) {
  const s = html.indexOf(head), e = html.indexOf(nextHead, s + head.length);
  if (s < 0 || e < 0) { console.error("ERROR: 関数を抽出できません: " + head); process.exit(1); }
  return html.slice(s, e);
}
const MDOC = block("// ===== MONTHLY-DOCS-BEGIN =====", "// ===== MONTHLY-DOCS-END =====");
const GCWF = fnSrc("function getCurrentWorkFacility(staff,date){", "// 施設別勤務の明細行を構築");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

// ── 画面側の環境 ─────────────────────────────────────────
function makeClient(opts) {
  const o = opts || {};
  const calls = { fetch: 0, ls: 0 };
  const store = {};
  const ctx = {
    console,
    TENANT_ID: o.tenant || "honomi",
    TENANT: { legacy: (o.tenant || "honomi") === "honomi" },
    records: o.records || [],
    facilityName: o.facilityName || "",
    staffList: [],
    tenantFeature: (n) => n === "monthlyDocs" && (o.tenant || "honomi") === "honomi",
    punchOutboxEnabled: () => o.outbox !== false,
    fmtDateKey: (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"),
    getAuthToken: async () => "tok",
    tenantPayload: (x) => x,
    fetch: async () => { calls.fetch++; return { ok: true, json: async () => ({ ok: true, devices: [] }) }; },
    AbortController: AbortController,
    TLS: {
      getItem: (k) => { calls.ls++; return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: (k, v) => { calls.ls++; store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    Date, Promise, Math, Number, String, JSON, Array, Object, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(GCWF + "\n" + MDOC, ctx, { filename: "index.html#monthly-docs" });
  ctx.__calls = calls;
  ctx.__store = store;
  return ctx;
}
const at = (dk, hh, mm) => new Date(dk + "T" + String(hh).padStart(2, "0") + ":" + String(mm || 0).padStart(2, "0") + ":00+09:00");
const rec = (staff, type, dk, hh, extra) => Object.assign({
  id: staff + type + hh, eventId: staff + type + hh, staff: staff, type: type, date: dk,
  timestamp: at(dk, hh).toISOString(), facilityName: "ミュゲの泉", workFacility: type === "clockIn" ? "ミュゲの泉" : undefined,
}, extra || {});
const D = "2026-10-09";
const FAC = "ミュゲの泉";

console.log("■ 出勤（衛生・新興感染症／朝の温度）");
{
  const c = makeClient();
  const p = c.mdocPlan("clockIn", "山田", FAC, at(D, 6, 10));
  check("その日最初の出勤は衛生・感染症を聞く", p && p.hyg === true && p.hygNg === false);
  check("朝の温度が未記録なら朝（slot 0）を聞く（出勤の確定後に聞く）", p && p.slot === 0);
  check("出勤では保存食を聞かない", p && p.hozon === false);
}
{
  const c = makeClient({ records: [rec("山田", "clockIn", D, 6, { mdoc: { f: FAC, hyg: { a: "ok" }, temp: { s: 0, d: [] } } })] });
  check("同じ日の2回目（他施設の出勤など）は衛生を聞かない、朝の温度も記録済みなら何も聞かない",
    c.mdocPlan("clockIn", "山田", FAC, at(D, 9)) === null);
  const p2 = c.mdocPlan("clockIn", "佐藤", FAC, at(D, 7));
  check("別の人の初回出勤は衛生だけ聞く（朝の温度は施設で1回）", p2 && p2.hyg === true && p2.slot === null);
}
{
  const c = makeClient();
  c.__store["mdoc.ng." + D + ".山田"] = "1";
  const p = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
  check("「問題あり」の後に開き直したら聞き直さない（記録は ng として残す）", p && p.hyg === true && p.hygNg === true);
}
{
  const c = makeClient();
  const p = c.mdocPlan("clockIn", "伊藤", FAC, at(D, 15));
  check("正午以降の出勤では朝の温度を聞かない", p && p.slot === null && p.hyg === true);
}

console.log("■ 退勤（日中・夕方の温度／保存食／最後の退勤者）");
{
  const recs = [rec("山田", "clockIn", D, 6), rec("佐藤", "clockIn", D, 7)];
  const c = makeClient({ records: recs });
  const p = c.mdocPlan("clockOut", "山田", FAC, at(D, 13));
  check("日中勤務の退勤は日中（slot 1）。他に勤務中がいれば保存食は聞かない", p && p.slot === 1 && p.hozon === false);
}
{
  const c = makeClient({ records: [rec("山田", "clockIn", D, 6)] });
  const p = c.mdocPlan("clockOut", "山田", FAC, at(D, 12));
  check("日中勤務が昼に1人で退勤しても最後とみなさない（夕方勤務が後から来るため）", p && p.slot === 1 && p.hozon === false);
}
{
  const recs = [rec("伊藤", "clockIn", D, 15), rec("高橋", "clockIn", D, 15)];
  const c = makeClient({ records: recs });
  const p = c.mdocPlan("clockOut", "伊藤", FAC, at(D, 18));
  check("夕方勤務の退勤で他に勤務中がいれば夕方の温度だけ（保存食なし）", p && p.slot === 2 && p.hozon === false);
  recs.push(rec("伊藤", "clockOut", D, 18, { mdoc: { f: FAC, temp: { s: 2, d: [] } } }));
  const p2 = c.mdocPlan("clockOut", "高橋", FAC, at(D, 18));
  check("最後の夕方勤務の退勤は保存食を聞く（夕方の温度は記録済みなので聞かない）", p2 && p2.hozon === true && p2.slot === null);
  recs.push(rec("高橋", "clockOut", D, 18, { mdoc: { f: FAC, hozon: { a: "yes" } } }));
  check("保存食が記録済みなら同じ日にもう聞かない", c.mdocPlan("clockOut", "高橋", FAC, at(D, 19)) === null);
}
{
  const recs = [rec("山田", "clockIn", D, 6), rec("田中", "clockIn", D, 8, { workFacility: "ナナイロ", facilityName: "ナナイロ" })];
  const c = makeClient({ records: recs });
  const p = c.mdocPlan("clockOut", "山田", FAC, at(D, 18));
  check("他施設の勤務中の人は数えない（日中勤務でも16時以降1人なら最後）", p && p.slot === 2 && p.hozon === true);
}
{
  const recs = [rec("伊藤", "clockIn", D, 15), rec("伊藤", "clockOut", D, 18, { mdoc: { f: FAC, hozon: { a: "no" } } }), rec("高橋", "clockIn", D, 15)];
  const c = makeClient({ records: recs });
  const p = c.mdocPlan("clockOut", "高橋", FAC, at(D, 18));
  check("前の人が「いいえ」なら確認済みにしない（次の最後の人にまた聞く）", p && p.hozon === true);
}

console.log("■ 保存食の日付（廃棄日＝保存日の15日前・月次書類の帳票と同じ）");
{
  const c = makeClient();
  check("10月7日 → 9月22日", c.mdocDiscardDate("2026-10-07") === "2026-09-22");
  check("3月1日 → 2月14日（月をまたぐ）", c.mdocDiscardDate("2026-03-01") === "2026-02-14");
  check("1月10日 → 前年12月26日（年をまたぐ）", c.mdocDiscardDate("2026-01-10") === "2025-12-26");
}

console.log("■ 送信後の転記の範囲（遅れて届いた打刻の日付を含める・2〜7日）");
{
  const c = makeClient();
  const dk = (n) => { const t = new Date(Date.now() + 9 * 3600e3 - n * 86400e3); return t.toISOString().slice(0, 10); };
  check("今日の打刻は2日", c.mdocSyncDaysFor(dk(0)) === 2);
  check("3日前の打刻は4日", c.mdocSyncDaysFor(dk(3)) === 4);
  check("10日前でも7日まで", c.mdocSyncDaysFor(dk(10)) === 7);
  check("日付が不正なら2日", c.mdocSyncDaysFor("x") === 2);
}

console.log("■ 温度入力欄の表示順（表示だけ。冷蔵庫の番号順・同じ番号は冷蔵→冷凍）");
{
  const c = makeClient();
  // 記録の並び（従来どおり冷蔵→冷凍、各番号順）
  const devs = [
    { id: "r1", k: "r", n: "冷蔵庫1 冷蔵", o: 1 }, { id: "r2", k: "r", n: "冷蔵庫2 冷蔵", o: 2 },
    { id: "f1", k: "f", n: "冷蔵庫1 冷凍", o: 1 }, { id: "f3", k: "f", n: "冷蔵庫3 冷凍", o: 3 },
  ];
  const before = JSON.stringify(devs);
  const v = c.mdocViewOrder(devs).map((x) => x.n);
  check("冷蔵庫1 冷蔵 → 冷蔵庫1 冷凍 → 冷蔵庫2 冷蔵 → 冷蔵庫3 冷凍", JSON.stringify(v) === JSON.stringify(["冷蔵庫1 冷蔵", "冷蔵庫1 冷凍", "冷蔵庫2 冷蔵", "冷蔵庫3 冷凍"]), v.join(","));
  check("元の配列（記録する temp.d の並び・機器ID）は変えない", JSON.stringify(devs) === before);
  check("並べ替えても機器ID・種別・番号の組はそのまま", c.mdocViewOrder(devs).every((x) => devs.some((d) => d.id === x.id && d.k === x.k && d.o === x.o && d.n === x.n)));
}
{
  // 記録する値は表示順でなく devs の並びで作る（mdocCollect のソース上の確認）
  check("記録する temp.d は devs の並びから作る（表示順の view を使わない）", /var vs=devs\.map\(/.test(MDOC) && /view\.forEach\(function\(x,i\)/.test(MDOC));
}

// 確認画面を動かすための最小の DOM（ボタンを文字で探して押す）
function fakeDom() {
  const mk = (tag) => {
    const e = {
      tag, children: [], parentNode: null, className: "", _text: "", listeners: {}, attrs: {}, disabled: false, value: "",
      appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; },
      addEventListener(n, fn) { (e.listeners[n] = e.listeners[n] || []).push(fn); },
      setAttribute(k, v) { e.attrs[k] = v; }, focus() {}, blur() {},
      get textContent() { return e._text + e.children.map((c) => c.textContent).join(""); },
      set textContent(v) { e._text = String(v); e.children.forEach((c) => (c.parentNode = null)); e.children = []; },
    };
    return e;
  };
  const body = mk("body");
  const all = (n, out) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  return {
    document: { createElement: mk, createTextNode: (t) => Object.assign(mk("#text"), { _text: t }), body },
    find: (text) => all(body, []).find((n) => n.tag === "button" && n._text === text),
    inputs: () => all(body, []).filter((n) => n.tag === "input"),
    open: () => body.children.length > 0,
  };
}
function uiClient(opts) {
  const c = makeClient(Object.assign({ facilityName: FAC }, opts));
  const dom = fakeDom();
  c.document = dom.document;
  c.fmtTime = (d) => d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  c.__timers = [];
  c.setTimeout = (fn, ms) => { c.__timers.push({ fn, ms }); return c.__timers.length; }; // 放置タイマー等は自動では進めない
  c.__dom = dom;
  return c;
}
const DEVS = [{ id: "11111111-1111-4111-8111-111111111111", k: "r", n: "冷蔵庫1 冷蔵", o: 1 }, { id: "22222222-2222-4222-8222-222222222222", k: "f", n: "冷蔵庫1 冷凍", o: 1 }];
const tick = () => new Promise((r) => setImmediate(r));
// 後半の API テストの最後で待ち合わせる（結果の集計より前に終える）
const uiTests = (async () => {
  console.log("■ 出勤は「問題なし」で確定し、朝の温度は確定後に聞く（2026-10-09 ユーザー指示）");
  {
    const c = uiClient();
    c.__store["mdoc.dev." + FAC] = JSON.stringify({ at: Date.now(), devices: DEVS, last: null });
    const plan = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
    check("朝・初回の出勤の判定は従来どおり（衛生＋朝の温度 slot 0）", plan && plan.hyg && plan.slot === 0);
    plan.pressedAt = at(D, 6);
    const pr = c.mdocCollect(plan);
    check("出勤の確認画面は衛生・感染症から始まる", !!c.__dom.find("問題なし") && !!c.__dom.find("問題あり"));
    c.__dom.find("問題なし").onclick();
    const md = await pr;
    check("「問題なし」を押した時点で確認画面が閉じて回答が返る（温度の画面を挟まない）", md && md.hyg && md.hyg.a === "ok" && !c.__dom.open());
    check("出勤の回答に温度は入らない（温度は出勤の条件にしない）", md && md.temp === undefined);
    check("出勤の時刻は「問題なし」を押した時刻（_punchAt）", md && md._punchAt instanceof Date);
    check("出勤の確認画面で測定対象の通信をしない", c.__calls.fetch === 0);
  }
  {
    const c = uiClient();
    const plan = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
    let resolved = false;
    c.mdocCollect(plan).then(() => { resolved = true; });
    c.__dom.find("問題あり").onclick();
    const txt = c.__dom.document.body.textContent;
    check("「問題あり」は従来どおり打刻しない（責任者に連絡）", /責任者に連絡してください/.test(txt) && /出勤はまだ記録されていません/.test(txt));
    check("「問題あり」は端末に印を残す（開き直した出勤では聞かずに ng を記録）", !!c.__store["mdoc.ng." + D + ".山田"]);
    c.__dom.find("閉じる").onclick();
    await tick();
    check("「問題あり」→閉じる は回答なし（打刻しない）", resolved && !c.__dom.open());
  }
  // 出勤の後の朝の温度は、出勤とは独立した記録（2026-10-09 追加指示: 出勤は保留せず「問題なし」ですぐ送る）
  const NORM = fnSrc("function _punchOutboxNormalize(e){", "// 送信待ちのイベントを");
  function postClient(parentEntry) {
    const c = uiClient();
    c.__store["mdoc.dev." + FAC] = JSON.stringify({ at: Date.now(), devices: DEVS, last: null });
    vm.runInContext(NORM, c);
    const nr = rec("山田", "clockIn", D, 6, { mdoc: { f: FAC, sid: "E1", hyg: { a: "ok" } } });
    c.records.push(nr);
    c.punchOutbox = parentEntry ? { [nr.id]: Object.assign({ eventId: nr.id, rec: nr }, parentEntry) } : {};
    c.__saved = []; c.__puts = []; c.__flushed = []; c.__alerts = [];
    c._punchOutboxSave = (e) => { c.__saved.push(JSON.parse(JSON.stringify(e))); return Promise.resolve(true); };
    c._punchOutboxIdbPut = (e) => { c.__puts.push(JSON.parse(JSON.stringify(e))); return Promise.resolve(c.__idbOk !== false); };
    c.punchOutboxFlush = (r) => { c.__flushed.push(r); return Promise.resolve(); };
    c.showAlert = (m) => c.__alerts.push(m);
    c._lsSet = () => {};
    return { c, nr };
  }
  async function recordTemp(c, nr) {
    const plan = Object.assign(c.mdocPlan("clockIn", "佐藤", FAC, at(D, 6)), { staff: "山田", sid: "E1" });
    const done = c.mdocAfterClockIn(plan, nr);
    await tick();
    const ins = c.__dom.inputs();
    ins[0].value = "3.5"; ins[0].oninput(); ins[1].value = "18"; ins[1].oninput();
    const go = c.__dom.find("温度を記録");
    go.onclick();
    const msg = /温度を記録しました/.test(c.__dom.document.body.textContent);
    const tm = c.__timers.filter((x) => x.ms === 1200).pop();
    check("記録の完了表示のタイマーがある", !!tm);
    if (tm) tm.fn();
    await done;
    return msg;
  }
  {
    // 通常: 出勤はすでに送信済み（端末保存のエントリが無い）→ 温度は付属のエントリにする
    const { c, nr } = postClient(null);
    const plan = Object.assign(c.mdocPlan("clockIn", "佐藤", FAC, at(D, 6)), { staff: "山田" });
    const pDone = c.mdocAfterClockIn(plan, nr);
    await tick();
    const txt = c.__dom.document.body.textContent;
    check("出勤の確定後に朝の温度の画面が出る（「出勤しました」）", /出勤しました/.test(txt) && /温度の記録（朝）/.test(txt), txt.slice(0, 80));
    check("誰の出勤かを表示する（共用端末で別の人が入れない）", /山田 さん/.test(txt));
    check("打刻後の温度の画面に衛生・保存食は出ない", !c.__dom.find("問題なし") && !c.__dom.find("はい"));
    check("閉じても出勤は取り消されない（取り消しの確認を出さない）", !!c.__dom.find("記録しないで閉じる") && !/取り消/.test(txt));
    const go = c.__dom.find("温度を記録");
    check("値が入るまで記録ボタンは押せない", !!go && go.disabled === true);
    c.__dom.find("記録しないで閉じる").onclick();
    await pDone;
  }
  {
    const { c, nr } = postClient(null);
    const msg = await recordTemp(c, nr);
    const te = c.__puts[0];
    check("記録すると「温度を記録しました」を短く出す", msg);
    check("出勤が送信済みなら、温度は付属のエントリ（kind mdocTemp）として端末へ保存する", c.__puts.length === 1 && te.kind === "mdocTemp" && te.parentId === nr.id && te.eventId === nr.id + "~t" && te.fac === FAC && te.state === "pending" && te.retryCount === 0);
    check("付属のエントリの値は温度だけ（s=0・冷凍はマイナス・devs の並び・temp.at）", te.value.s === 0 && te.value.d[0].v === 3.5 && te.value.d[1].v === -18 && typeof te.value.at === "string");
    check("付属のエントリは打刻ではない（rec は並び順と日付だけ）", JSON.stringify(Object.keys(te.rec).sort()) === '["date","timestamp"]');
    check("付属のエントリは送信待ちに入る", !!c.punchOutbox[nr.id + "~t"]);
    check("出勤の端末保存（親）は書き換えない", c.__saved.length === 0);
    check("手元の表示にも温度を重ねる（他の人に同じ朝の温度を聞かない）", nr.mdoc.temp && nr.mdoc.hyg.a === "ok" && c.mdocPlan("clockIn", "佐藤", FAC, at(D, 7)).slot === null);
    check("打刻の時刻は変えない", nr.timestamp === at(D, 6).toISOString());
    check("記録後に送信を促す（待たない）", c.__flushed.length === 1 && !c.__dom.open());
  }
  {
    // 出勤がまだ一度も送信を試していない（順番待ち）→ 出勤レコードに同梱（通信を増やさない）
    const { c, nr } = postClient({ state: "pending", retryCount: 0 });
    await recordTemp(c, nr);
    check("送信を試す前の出勤には同梱し、付属のエントリを作らない", c.__puts.length === 0 && c.__saved.length === 1 && c.__saved[0].rec.mdoc.temp && c.__saved[0].rec.mdoc.hyg.a === "ok" && c.__saved[0].rec.mdoc.f === FAC);
  }
  for (const [label, ent] of [["送信中の出勤", { state: "syncing", retryCount: 1 }], ["一度送ろうとした出勤", { state: "pending", retryCount: 1 }]]) {
    const { c, nr } = postClient(ent);
    await recordTemp(c, nr);
    check(label + ": 出勤には書き足さず付属のエントリにする（サーバの打刻を上書きしない）", c.__saved.length === 0 && c.__puts.length === 1 && c.__puts[0].kind === "mdocTemp");
  }
  {
    const { c, nr } = postClient(null);
    c.__idbOk = false;
    await recordTemp(c, nr);
    check("温度を端末へ保存できないときは知らせる（出勤は記録済みと伝える）", c.__alerts.length === 1 && /出勤は記録されています/.test(c.__alerts[0]) && !c.punchOutbox[nr.id + "~t"]);
  }
  for (const [label, act] of [["「記録しないで閉じる」", "close"], ["放置（3分）", "idle"]]) {
    const { c, nr } = postClient(null);
    const plan = Object.assign(c.mdocPlan("clockIn", "佐藤", FAC, at(D, 6)), { staff: "山田" });
    const done = c.mdocAfterClockIn(plan, nr);
    await tick();
    if (act === "close") c.__dom.find("記録しないで閉じる").onclick();
    else { const tm = c.__timers.filter((x) => x.ms === c.MDOC_POST_TEMP_IDLE_MS).pop(); if (tm) tm.fn(); }
    await done;
    check(label + ": 温度は記録せず、出勤はそのまま", !nr.mdoc.temp && c.__puts.length === 0 && c.__saved.length === 0 && !c.__dom.open());
  }
  {
    // 測定対象を読み込めない（控えなし・取得失敗）ときの出勤後の画面は「閉じる」1つ
    const { c, nr } = postClient(null);
    delete c.__store["mdoc.dev." + FAC];
    c.fetch = async () => ({ ok: false, json: async () => ({}) });
    const done = c.mdocAfterClockIn(c.mdocPlan("clockIn", "山田", FAC, at(D, 6)), nr);
    for (let i = 0; i < 5; i++) await tick();
    check("読み込めないときは「閉じる」1つだけ（同じ結果のボタンを並べない）", !!c.__dom.find("閉じる") && !c.__dom.find("記録しないで閉じる"));
    c.__dom.find("閉じる").onclick();
    await done;
    check("読み込めず閉じても出勤はそのまま", !nr.mdoc.temp && c.__puts.length === 0);
  }
  {
    // 端末保存・送信（PUNCH-OUTBOX）の付属のエントリの扱い
    const OB = block("// ===== PUNCH-OUTBOX-BEGIN =====", "// ===== PUNCH-OUTBOX-END =====");
    const calls = [];
    const ctx = {
      console: { log() {}, warn() {}, error() {} }, Date, Promise, Math, JSON, Object, Array, String, Number, isNaN, encodeURIComponent, setTimeout, clearTimeout,
      FB_URL: "https://db.example/honomi", TENANT_IDB_SUFFIX: "", writePolicy: "full", viewerMode: false, window: { addEventListener() {} }, document: { hidden: false, addEventListener() {}, querySelector() { return null; } }, showPaidLeaveForm: false, records: [], _lsSet() {}, TLS: { getItem: () => null, setItem() {}, removeItem() {} }, indexedDB: undefined,
      authFetch: (url, o) => { calls.push({ url, method: (o && o.method) || "GET", body: o && o.body }); return Promise.resolve({ ok: true, status: 200, json: async () => (/\/type\.json$/.test(url) ? (calls.__parentGone ? null : "clockIn") : (calls.__exists ? { s: 0 } : null)) }); },
      mdocFacilityOn: (f) => f === FAC, mdocScheduleSync: (d) => calls.push({ sync: d }), mdocSyncDaysFor: () => 2, render() {},
    };
    vm.createContext(ctx);
    vm.runInContext(OB, ctx);
    vm.runInContext("var __po=function(){return punchOutbox;};var __set=function(k,v){punchOutbox[k]=v;};", ctx);
    const parent = ctx._punchOutboxNormalize({ eventId: "EV1", rec: { id: "EV1", staff: "山田", type: "clockIn", date: D, timestamp: at(D, 6).toISOString() }, state: "pending", retryCount: 0 });
    const temp = ctx._punchOutboxNormalize({ eventId: "EV1~t", kind: "mdocTemp", parentId: "EV1", fac: FAC, value: { s: 0, d: [], at: "x" }, rec: { timestamp: at(D, 6).toISOString(), date: D }, state: "pending", retryCount: 0 });
    check("付属のエントリは正規化で kind・parentId・値を保つ（再起動後も再送できる）", temp && temp.kind === "mdocTemp" && temp.parentId === "EV1" && temp.value.s === 0 && temp.fac === FAC);
    check("値の無い付属のエントリは捨てる", ctx._punchOutboxNormalize({ eventId: "x~t", kind: "mdocTemp", parentId: "x", rec: { timestamp: "t" } }) === null);
    ctx.__set("EV1", parent); ctx.__set("EV1~t", temp);
    check("出勤が未送信の間は温度を送らない（出勤の無いノードに温度だけを作らない）", ctx._punchOutboxDue(temp, Date.now()) === false && ctx._punchOutboxDue(parent, Date.now()) === true);
    temp.retryCount = 99; parent.retryCount = 99; // 警告が出る状態にして件数を見る
    { const w = ctx.punchOutboxWarning(); check("未送信の警告（打刻の件数）に温度は数えない", !!w && w.count === 1, JSON.stringify(w)); }
    temp.retryCount = 0; parent.retryCount = 0;
    const merged = ctx.punchOutboxMergeInto([]);
    check("合流: 温度を打刻として積まない（出勤だけが積まれる）", merged.length === 1 && merged[0].id === "EV1");
    await ctx.punchOutboxFlush("punch");
    await new Promise((r) => setTimeout(r, 80));
    check("出勤を送った回の後に、続けて温度を送る（次の契機を待たない）", calls.filter((x) => x.method === "PUT").length === 2);
    const puts = calls.filter((x) => x.method === "PUT");
    check("出勤を先に送り、届いた後に温度を mdoc/temp だけへ PUT", puts.length === 2 && /\/tc5_records\/EV1\.json$/.test(puts[0].url) && /\/tc5_records\/EV1\/mdoc\/temp\.json$/.test(puts[1].url));
    check("温度の PUT の本文は温度だけ（出勤の他の項目を送らない）", JSON.parse(puts[1].body).s === 0 && !("staff" in JSON.parse(puts[1].body)));
    check("温度が届いたら月次書類へ転記を頼む", calls.some((x) => x.sync === 2));
    check("送れた付属のエントリは消える", !ctx.__po()["EV1~t"] && !ctx.__po()["EV1"]);
    // サーバから取り直した記録への重ね合わせ（未送信の温度だけ）
    ctx.__set("EV2~t", ctx._punchOutboxNormalize({ eventId: "EV2~t", kind: "mdocTemp", parentId: "EV2", fac: FAC, value: { s: 0, d: [], at: "y" }, rec: { timestamp: at(D, 7).toISOString(), date: D }, state: "pending", retryCount: 1, lastAttemptAt: new Date().toISOString(), lastError: "network" }));
    const srv = [{ id: "EV2", staff: "佐藤", type: "clockIn", date: D, mdoc: { f: FAC, hyg: { a: "ok" } } }];
    ctx.punchOutboxMergeInto(srv);
    check("合流: 未送信の温度はサーバの出勤記録の表示に重ねる（衛生の回答は残す）", srv.length === 1 && srv[0].mdoc.temp && srv[0].mdoc.temp.at === "y" && srv[0].mdoc.hyg.a === "ok");
    // 再送: 2回目以降は存在確認し、あれば上書きしない（温度の重複・上書きを防ぐ）
    calls.length = 0; calls.__exists = true;
    const r2 = await ctx._punchOutboxSendOne(ctx.__po()["EV2~t"], true);
    check("温度の再送は存在確認し、既にあれば PUT しない", r2.ok && r2.already && calls.every((x) => x.method === "GET") && /\/EV2\/mdoc\/temp\.json$/.test(calls[0].url));
    calls.length = 0; calls.__exists = false; calls.__parentGone = true;
    const r3 = await ctx._punchOutboxSendOne(ctx.__po()["EV2~t"], true);
    check("温度の再送で出勤のノードが無ければ送らずに終える（温度だけのノードを作らない）", r3.ok && r3.dropped && calls.every((x) => x.method === "GET") && calls.some((x) => /\/EV2\/type\.json$/.test(x.url)));
    calls.length = 0; calls.__parentGone = false;
    const r4 = await ctx._punchOutboxSendOne(ctx.__po()["EV2~t"], true);
    check("温度の再送で出勤があり温度が無ければ PUT する", r4.ok && !r4.already && calls.filter((x) => x.method === "PUT").length === 1);
    calls.length = 0;
    const r5 = await ctx._punchOutboxSendOne(ctx.__po()["EV2~t"], false);
    check("温度の初回送信は確認なしで PUT 1回だけ", r5.ok && calls.length === 1 && calls[0].method === "PUT");
    // 通信断: 出勤が届かない間は温度を送らず、温度の送信が失敗しても続けて送り直さない（連打しない）
    calls.length = 0;
    const realFetch = ctx.authFetch;
    ctx.authFetch = (url, o) => { calls.push({ url, method: (o && o.method) || "GET" }); return Promise.reject(new Error("offline")); };
    for (const k of Object.keys(ctx.__po())) delete ctx.__po()[k];
    ctx.__set("EV5", ctx._punchOutboxNormalize({ eventId: "EV5", rec: { id: "EV5", staff: "山田", type: "clockIn", date: D, timestamp: at(D, 9).toISOString(), mdoc: { f: FAC, hyg: { a: "ok" } } }, state: "pending", retryCount: 0 }));
    ctx.__set("EV5~t", ctx._punchOutboxNormalize({ eventId: "EV5~t", kind: "mdocTemp", parentId: "EV5", fac: FAC, value: { s: 0, d: [], at: "z" }, rec: { timestamp: at(D, 9).toISOString(), date: D }, state: "pending", retryCount: 0 }));
    await ctx.punchOutboxFlush("punch");
    await new Promise((r) => setTimeout(r, 80));
    check("通信断: 出勤が届かない間は温度を送らない", calls.length === 1 && /\/EV5\.json$/.test(calls[0].url) && !!ctx.__po()["EV5~t"] && ctx.__po()["EV5~t"].retryCount === 0);
    // 出勤が届いた後、温度だけが通信断で失敗 → この回では送り直さない
    ctx.authFetch = (url, o) => { const m = (o && o.method) || "GET"; calls.push({ url, method: m }); return /mdoc\/temp/.test(url) ? Promise.reject(new Error("offline")) : realFetch(url, o); };
    ctx.__po()["EV5"].lastAttemptAt = new Date(0).toISOString(); // 再送の待ち時間が過ぎた
    calls.length = 0;
    await ctx.punchOutboxFlush("online");
    await new Promise((r) => setTimeout(r, 120));
    const tempTries = calls.filter((x) => /mdoc\/temp/.test(x.url)).length;
    check("通信が戻ると出勤の後に温度を送る", !ctx.__po()["EV5"] && tempTries >= 1);
    check("温度の送信が通信断で失敗しても続けて送り直さない（失敗の連打にならない）", tempTries === 1 && ctx.__po()["EV5~t"] && ctx.__po()["EV5~t"].retryCount === 1, String(tempTries));
    ctx.authFetch = realFetch;
    // 転記の依頼は回答を含む送信のときだけ（施設だけの mdoc では空振りさせない）
    calls.length = 0;
    ctx.__set("EV3", ctx._punchOutboxNormalize({ eventId: "EV3", rec: { id: "EV3", staff: "佐藤", type: "clockIn", date: D, timestamp: at(D, 8).toISOString(), mdoc: { f: FAC, sid: "E2" } }, state: "pending", retryCount: 0 }));
    ctx.__set("EV4", ctx._punchOutboxNormalize({ eventId: "EV4", rec: { id: "EV4", staff: "鈴木", type: "clockIn", date: D, timestamp: at(D, 8, 5).toISOString() }, state: "pending", retryCount: 0 }));
    await ctx.punchOutboxFlush("punch");
    check("回答の無い出勤（施設だけの mdoc・mdoc なし）の送信では転記を頼まない", calls.filter((x) => x.method === "PUT").length >= 2 && !calls.some((x) => x.sync));
  }
  {
    // _execPunch の順序（ソース上の確認）: 確認 → 二重打刻の再確認 → 端末保存 → 画面 → 送信 → 打刻後の温度（出勤の送信は止めない）
    const EP = fnSrc("async function _execPunch(type,d){", "function doPunch(type){");
    const iCollect = EP.indexOf("await mdocCollect(_mdPlan)"), iDup = EP.indexOf("var _mdDup"),
      iCommit = EP.indexOf("await punchOutboxCommit(nr)"), iPush = EP.indexOf("records.push(nr)"), iFlush = EP.indexOf('punchOutboxFlush("punch")'),
      iAfter = EP.indexOf("mdocAfterClockIn(_mdPost,nr)");
    check("出勤: 確認 → 二重打刻の再確認 → 端末保存 → 画面 → 送信 → 朝の温度 の順", iCollect > 0 && iCollect < iDup && iDup < iCommit && iCommit < iPush && iPush < iFlush && iFlush < iAfter);
    check("出勤の送信を止める仕組みが無い（朝出勤確認で未出勤と誤らない）", !/_mdocHold|mdocHeld/.test(html));
    check("打刻後の温度は待たない（await しない）", !/await\s+mdocAfterClockIn/.test(EP));
    check("朝の温度を後で聞くのは出勤で slot 0 のときだけ", /if\(type==="clockIn"&&_mdPlan\.slot===0\)_mdPost=_mdPlan;/.test(EP));
    check("回答の無い出勤には mdoc を付けない（朝の温度を後で記録する出勤だけ施設を持たせる）", /if\(_md\.hyg\|\|_md\.temp\|\|_md\.hozon\|\|_mdPost\)nr\.mdoc=_md;/.test(EP));
    const zs = /strip\.id="facecam-strip";[\s\S]{0,400}?z-index:(\d+);/.exec(html), zo = /\.mdoc-ov\{[^}]*z-index:(\d+);/.exec(html);
    check("顔撮影の開示表示は確認画面（.mdoc-ov）より前面", !!(zs && zo && Number(zs[1]) > Number(zo[1])), zs && zo ? zs[1] + " vs " + zo[1] : "not found");
    check("自動更新の再読み込みは確認画面（.mdoc-ov）の表示中は待つ", /function _appOverlayOpen\(\)\{[^}]*?if\(document\.querySelector\("\.mdoc-ov"\)\)return true;/.test(html) && /if\(_appOverlayOpen\(\)\)return "modal";/.test(html));
    check("二重打刻の見直しは mdocDupPunch を使う", /var _mdDup=mdocDupPunch\(type,_mdName,nr\.date,_mdFn\);/.test(EP));
  }
  {
    // 「問題あり」の後に開き直した出勤（聞かずに ng を記録）でも、朝の温度は確定後に聞く
    const c = uiClient();
    c.__store["mdoc.ng." + D + ".山田"] = JSON.stringify(Date.now());
    const plan = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
    const md = await c.mdocCollect(plan);
    check("問題ありの後の出勤: 画面を出さずに hyg ng を返し、朝の温度は後で聞く（slot 0）", plan.hygNg && md.hyg && md.hyg.a === "ng" && md.temp === undefined && !c.__dom.open() && plan.slot === 0);
  }
  {
    // 二重打刻の見直し（実際の判定）
    const FOC = fnSrc("function findOpenClockInAcrossFacilities(staff,date){", "// ===== ストレージ =====");
    const mk = (recs) => { const c = uiClient({ records: recs }); vm.runInContext(FOC, c); return c; };
    let c = mk([rec("山田", "clockIn", D, 7)]);
    check("二重打刻: 同じ施設の出勤が届いていれば止める", !!c.mdocDupPunch("clockIn", "山田", D, FAC));
    check("二重打刻: 別の人の出勤では止めない", c.mdocDupPunch("clockIn", "佐藤", D, FAC) === null);
    c = mk([rec("山田", "clockIn", D, 7, { facilityName: "ナナイロ", workFacility: "ナナイロ" })]);
    const d1 = c.mdocDupPunch("clockIn", "山田", D, FAC);
    check("二重打刻: 他施設で出勤中なら止める", !!d1 && d1.facilityName === "ナナイロ");
    c = mk([rec("山田", "clockIn", D, 7, { facilityName: "ナナイロ", workFacility: "ナナイロ" }), rec("山田", "clockOut", D, 9, { facilityName: "ナナイロ" })]);
    check("二重打刻: 他施設で退勤済みなら出勤できる（doPunch と同じ）", c.mdocDupPunch("clockIn", "山田", D, FAC) === null);
    check("二重打刻: その日の退勤は施設を問わず止める", !!c.mdocDupPunch("clockOut", "山田", D, FAC));
    c = mk([rec("山田", "clockIn", D, 7, { deleted: true })]);
    check("二重打刻: 削除された打刻は数えない", c.mdocDupPunch("clockIn", "山田", D, FAC) === null);
  }
  {
    // 退勤（最後の退勤者）: 温度 → 保存食を1つの画面で聞き、すべて答えてから回答を返す。送信停止はしない
    const c = uiClient({ records: [rec("山田", "clockIn", D, 7)] });
    c.__store["mdoc.dev." + FAC] = JSON.stringify({ at: Date.now(), devices: DEVS, last: null });
    const plan = c.mdocPlan("clockOut", "山田", FAC, at(D, 17));
    check("退勤（最後）: 夕方の温度と保存食を聞く", plan && plan.slot === 2 && plan.hozon === true && !plan.post);
    let out = "pending";
    const pr = c.mdocCollect(plan).then((v) => { out = v; });
    check("退勤: 温度の画面（記録して退勤ではなく次へ）", !!c.__dom.find("次へ") && !/出勤しました/.test(c.__dom.document.body.textContent));
    const ins = c.__dom.inputs(); ins[0].value = "4"; ins[0].oninput(); ins[1].value = "19"; ins[1].oninput();
    c.__dom.find("次へ").onclick();
    await tick();
    check("退勤: 温度の後もまだ打刻しない（保存食の回答待ち）", out === "pending" && !!c.__dom.find("はい"));
    c.__dom.find("はい").onclick();
    await pr;
    check("退勤: すべて答えると温度と保存食がそろって返る", out && out.temp && out.temp.s === 2 && out.hozon && out.hozon.a === "yes" && !c.__dom.open());
    const c2 = uiClient({ records: [rec("山田", "clockIn", D, 7)] });
    c2.__store["mdoc.dev." + FAC] = JSON.stringify({ at: Date.now(), devices: DEVS, last: null });
    const pr2 = c2.mdocCollect(c2.mdocPlan("clockOut", "山田", FAC, at(D, 17)));
    c2.__dom.find("やめる").onclick();
    check("退勤: 「やめる」は打刻しない（null）", (await pr2) === null);
    check("打刻後の温度の画面は開いてから一定時間で閉じる（操作で延びない）", /if\(plan\.post\)idleTimer=setTimeout\(function\(\)\{finish\(null\);\},MDOC_POST_TEMP_IDLE_MS\);/.test(MDOC) && !/addEventListener\("input",idle/.test(MDOC));
    check("退勤は従来どおり確認画面の中で温度・保存食を聞き、そろってから端末保存する",/var wantTemp=plan\.slot!==null&&\(plan\.type!=="clockIn"\|\|!!plan\.post\);/.test(MDOC));
  }
})().catch((e) => { check("出勤の確定と打刻後の温度のテストが例外なく終わる", false, String(e && e.stack)); });

console.log("■ 前回の温度（手元の打刻とサーバの最後の記録の新しい方）");
{
  const devA = "11111111-1111-4111-8111-111111111111";
  const recs = [rec("山田", "clockIn", D, 6, { mdoc: { f: FAC, temp: { s: 0, d: [{ id: devA, k: "r", n: "冷蔵庫①", o: 0, v: 3.5 }] } } })];
  const c = makeClient({ records: recs });
  check("手元の打刻が新しければそれを使う", c.mdocLastTemps(FAC, { last: { at: "2026-10-08T09:00:00Z", devs: [{ id: devA, v: 9 }] } })[devA] === 3.5);
  check("サーバの記録が新しければそれを使う", c.mdocLastTemps(FAC, { last: { at: "2026-10-09T23:00:00Z", devs: [{ id: devA, v: 5 }] } })[devA] === 5);
  check("他の施設の記録は使わない", c.mdocLastTemps("ナナイロ", null)[devA] === undefined);
}

console.log("■ 穂乃味以外・テスト画面では何もしない（判定・通信・端末保存なし）");
(async () => {
  for (const [label, o] of [["マンテール", { tenant: "mantel" }], ["スタッフテスト・デモ（端末保存なし）", { outbox: false }]]) {
    const c = makeClient(Object.assign({ facilityName: FAC }, o));
    const p1 = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
    const p2 = c.mdocPlan("clockOut", "山田", FAC, at(D, 18));
    c.mdocPrefetch(FAC);
    c.mdocStartup();
    c.mdocScheduleSync();
    await c.mdocLoadDevices(FAC, true);
    await new Promise((r) => setImmediate(r));
    check(label + ": 確認画面を出さない（判定は常に null）", p1 === null && p2 === null);
    check(label + ": /api/monthly-docs へ通信しない", c.__calls.fetch === 0, "fetch=" + c.__calls.fetch);
    check(label + ": 端末に何も保存しない", Object.keys(c.__store).length === 0);
  }
  {
    const c = makeClient({ facilityName: FAC });
    c.mdocStartup();
    await new Promise((r) => setImmediate(r));
    check("穂乃味は起動時に先読み・転記を行う（通信あり）", c.__calls.fetch >= 1);
  }

  console.log("■ ミュゲの泉だけ・2026-10-09 以降だけ（2026-10-09 再開。他施設は従来の打刻画面）");
  for (const OF of ["ナナイロ", "ミュゲ貝塚", "ミュゲ春木", ""]) {
    const c = makeClient({ facilityName: OF, records: [rec("山田", "clockIn", D, 6, { workFacility: OF, facilityName: OF })] });
    const p1 = c.mdocPlan("clockIn", "佐藤", OF, at(D, 6));
    const p2 = c.mdocPlan("clockOut", "山田", OF, at(D, 18));
    c.mdocPrefetch(OF);
    c.mdocStartup();
    await c.mdocLoadDevices(OF, true);
    await new Promise((r) => setImmediate(r));
    const lbl = "施設「" + (OF || "未設定") + "」";
    check(lbl + ": 確認画面を出さない", p1 === null && p2 === null);
    check(lbl + ": /api/monthly-docs へ通信しない・端末に保存しない", c.__calls.fetch === 0 && Object.keys(c.__store).length === 0, "fetch=" + c.__calls.fetch);
  }
  {
    // 個人のスマホ（施設リンクなし）でも、打刻の施設（所属・選んだ出勤先）がミュゲの泉なら聞く・先読みする（施設で限定し、端末では限定しない）
    const c = makeClient({ facilityName: "" });
    const p = c.mdocPlan("clockIn", "山田", FAC, at(D, 6));
    c.mdocPrefetch(FAC);
    c.mdocStartup();
    await new Promise((r) => setImmediate(r));
    check("個人スマホでミュゲの泉の打刻は聞き、測定対象を先読みする（起動時の転記はしない）", p && p.hyg === true && c.__calls.fetch === 1, "fetch=" + c.__calls.fetch);
  }
  {
    const c = makeClient();
    check("ミュゲの泉でも 2026-10-08 以前の打刻では聞かない", c.mdocPlan("clockIn", "山田", FAC, at("2026-10-08", 6)) === null && c.mdocPlan("clockOut", "山田", FAC, at("2026-10-08", 18)) === null);
    const p = c.mdocPlan("clockIn", "山田", FAC, at("2026-10-09", 6));
    check("ミュゲの泉の 2026-10-09 の出勤は聞く", p && p.hyg === true);
  }
  {
    const MD0 = require(path.join(ROOT, "api/_lib/monthly-docs.js"));
    const SRV_FAC = JSON.stringify(MD0.ENABLED_FACILITIES);
    const c = makeClient();
    check("画面とサーバの対象施設・開始日が同じ", JSON.stringify(Array.from(c.MDOC_FACILITIES)) === SRV_FAC && c.MDOC_START_DATE === MD0.START_DATE, SRV_FAC);
    const T0 = require(path.join(ROOT, "api/_lib/tenant.js"));
    const hon = /honomi:\{[\s\S]*?features:\{([^}]*)\}/.exec(html);
    check("穂乃味の monthlyDocs は画面・API の2か所とも有効", !!hon && /monthlyDocs:true/.test(hon[1]) && T0.TENANTS.honomi.features.monthlyDocs === true && T0.TENANTS.mantel.features.monthlyDocs === false);
  }

  // ── サーバ側の検証 ───────────────────────────────────────
  console.log("■ サーバ: 打刻レコードの mdoc の検証");
  const MD = require(path.join(ROOT, "api/_lib/monthly-docs.js"));
  const master = { staff: new Map([["山田", "E001"], ["佐藤", ""]]), facilities: new Set([FAC, "ナナイロ"]) };
  const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
  const R = (id, o) => Object.assign({ eventId: id, staff: "山田", type: "clockIn", date: D, timestamp: "2026-10-08T21:10:00.000Z", workFacility: FAC, facilityName: FAC, serverReceivedAt: 1791320000000 }, o);
  const recs = {
    ok1: R("ok1", { mdoc: { f: FAC, hyg: { a: "ok" }, temp: { s: 0, d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 4.04 }, { id: U2, k: "f", n: "冷凍庫①", o: 0, v: -19 }] } } }),
    ok2: R("ok2", { type: "clockOut", workFacility: undefined, mdoc: { f: FAC, temp: { s: 2, d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 5 }] }, hozon: { a: "yes", store: D, discard: "2026-09-24" } } }),
    nomdoc: R("nomdoc", {}),
    badkey: R("other", { mdoc: { f: FAC, hyg: { a: "ok" } } }),
    unknownStaff: R("unknownStaff", { staff: "知らない人", mdoc: { f: FAC, hyg: { a: "ok" } } }),
    unknownFac: R("unknownFac", { mdoc: { f: "架空施設", hyg: { a: "ok" } } }),
    otherFac: R("otherFac", { mdoc: { f: "ナナイロ", hyg: { a: "ok" } } }),
    hygOut: R("hygOut", { type: "clockOut", mdoc: { f: FAC, hyg: { a: "ok" } } }),
    tempSlot: R("tempSlot", { mdoc: { f: FAC, temp: { s: 2, d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 4 }] } } }),
    tempUuid: R("tempUuid", { mdoc: { f: FAC, temp: { s: 0, d: [{ id: "x", k: "r", n: "冷蔵庫①", o: 0, v: 4 }] } } }),
    tempRange: R("tempRange", { mdoc: { f: FAC, temp: { s: 0, d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 99 }] } } }),
    tempDup: R("tempDup", { mdoc: { f: FAC, temp: { s: 0, d: [{ id: U1, k: "r", n: "a", o: 0, v: 4 }, { id: U1, k: "r", n: "b", o: 1, v: 4 }] } } }),
    hozonDate: R("hozonDate", { type: "clockOut", workFacility: undefined, mdoc: { f: FAC, hozon: { a: "yes", store: D, discard: "2026-09-25" } } }),
    hozonIn: R("hozonIn", { mdoc: { f: FAC, hozon: { a: "yes", store: D, discard: "2026-09-24" } } }),
  };
  const { events, rejected } = MD.eventsFromRecords(recs, master);
  const ids = events.map((e) => e.event_id).sort();
  check("正しい回答だけを記録にする", JSON.stringify(ids) === JSON.stringify(["ok1:hyg", "ok1:temp", "ok2:hozon", "ok2:temp"]), ids.join(","));
  check("不正なものは数えて捨てる（11件）", rejected === 11, "rejected=" + rejected);
  const t = events.find((e) => e.event_id === "ok1:temp");
  check("温度は0.1℃に丸め、記録時点の機器名を持つ", t && t.payload.devs[0].v === 4 && t.payload.devs[0].n === "冷蔵庫①");
  {
    const r3 = MD.eventsFromRecords({ ta: R("ta", { mdoc: { f: FAC, temp: { s: 0, at: "2026-10-08T21:11:30.000Z", d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 4 }] } } }) }, master);
    check("出勤後に記録した温度は、温度を確定した時刻を記録日時にする", r3.events[0] && r3.events[0].recorded_at === "2026-10-08T21:11:30.000Z");
    const r4 = MD.eventsFromRecords({ tb: R("tb", { mdoc: { f: FAC, temp: { s: 0, at: "2026-10-01T00:00:00.000Z", d: [{ id: U1, k: "r", n: "冷蔵庫①", o: 0, v: 4 }] } } }) }, master);
    check("打刻より前など範囲外の確定時刻は使わない（打刻の時刻にする）", r4.events[0] && r4.events[0].recorded_at === "2026-10-08T21:10:00.000Z");
  }
  check("確認者・施設・対象日・記録日時・打刻の受信時刻を持つ",
    t && t.staff_name === "山田" && t.facility === FAC && t.target_date === D && t.recorded_at === "2026-10-08T21:10:00.000Z" && typeof t.punch_received_at === "string");
  const hz = events.find((e) => e.event_id === "ok2:hozon");
  check("確認した職員の社員番号を記録に持つ（帳票の表示は氏名）", t && t.payload.sid === "E001" && t.staff_name === "山田");
  {
    const bad = MD.eventsFromRecords({ x1: R("x1", { mdoc: { f: FAC, sid: "E999", hyg: { a: "ok" } } }) }, master);
    check("端末の社員番号が食い違っても記録は落とさず、従業員マスタの社員番号を記録する", bad.events.length === 1 && bad.events[0].payload.sid === "E001" && bad.rejected === 0);
  }
  check("保存食は保存日と廃棄日を持つ", hz && hz.payload.store === D && hz.payload.discard === "2026-09-24" && hz.answer === "yes");
  {
    // 応援勤務の人が自分のスマホ（施設リンクなし）で出勤先 X を選び、退勤時に X の温度と保存食に答えた
    const sup = {
      cin: R("cin", { staff: "佐藤", workFacility: FAC, facilityName: "ナナイロ", homeFacility: "ナナイロ" }),
      cout: R("cout", { staff: "佐藤", type: "clockOut", workFacility: undefined, facilityName: "ナナイロ",
        mdoc: { f: FAC, hozon: { a: "yes", store: D, discard: "2026-09-24" } } }),
      del: R("del", { staff: "佐藤", type: "clockOut", deleted: true, workFacility: undefined, facilityName: FAC,
        mdoc: { f: FAC, hozon: { a: "yes", store: D, discard: "2026-09-24" } } }),
      nofac: R("nofac", { workFacility: undefined, facilityName: undefined, homeFacility: undefined, mdoc: { f: FAC, hyg: { a: "ok" } } }),
    };
    const r2 = MD.eventsFromRecords(sup, master);
    check("退勤: その日の出勤先（応援先）の回答は受ける", r2.events.some((e) => e.event_id === "cout:hozon" && e.facility === FAC));
    check("管理者が削除した打刻は転記しない", !r2.events.some((e) => e.event_id.startsWith("del:")));
    check("施設の項目が無い打刻は受けない", !r2.events.some((e) => e.event_id.startsWith("nofac:")) && r2.rejected === 1, "rejected=" + r2.rejected);
  }
  {
    const scope = {
      nana: R("nana", { workFacility: "ナナイロ", facilityName: "ナナイロ", mdoc: { f: "ナナイロ", hyg: { a: "ok" } } }),
      old: R("old", { date: "2026-10-08", mdoc: { f: FAC, hyg: { a: "ok" } } }),
      now: R("now", { mdoc: { f: FAC, hyg: { a: "ok" } } }),
    };
    const r5 = MD.eventsFromRecords(scope, master);
    check("サーバ: ミュゲの泉以外・2026-10-08 以前の回答は転記しない（不正には数えない）",
      r5.events.length === 1 && r5.events[0].event_id === "now:hyg" && r5.outOfScope === 2 && r5.rejected === 0, JSON.stringify(r5));
    let rng = null;
    const G0 = require(path.join(ROOT, "api/_lib/google.js"));
    const keep = [G0.dbGetRange, G0.dbGet];
    G0.dbGetRange = async (p, k, f, t) => { rng = [f, t]; return {}; };
    G0.dbGet = async () => null;
    await MD.syncRecent(7, Date.parse("2026-10-10T03:00:00Z"));
    check("サーバ: 転記の読み込みは 2026-10-09 より前を読まない", rng && rng[0] === "2026-10-09" && rng[1] === "2026-10-10", JSON.stringify(rng));
    [G0.dbGetRange, G0.dbGet] = keep;
  }
  check("廃棄日の計算（サーバ）", MD.hozonDiscardDate("2026-03-01") === "2026-02-14");
  check("日本時間の今日", MD.todayJst(Date.parse("2026-10-06T15:30:00Z")) === "2026-10-07");

  // ── API の入口 ─────────────────────────────────────────
  console.log("■ API: 穂乃味以外は入口で拒否し、DB に触れない");
  const G = require(path.join(ROOT, "api/_lib/google.js"));
  const S = require(path.join(ROOT, "api/_lib/secrets.js"));
  const touched = { db: 0, http: 0 };
  G.tenantActive = async () => true;
  G.verifyIdToken = async () => ({ sub: "anon-uid" });
  G.dbGet = async () => { touched.db++; return null; };
  G.dbGetRange = async () => { touched.db++; return {}; };
  G.dbPatch = async () => { touched.db++; };
  G.dbPut = async () => { touched.db++; };
  G.httpRequest = async () => { touched.http++; return { status: 200, body: {} }; };
  S.bumpAndCount = async () => { touched.db++; return 1; };
  const handler = require(path.join(ROOT, "api/monthly-docs.js"));
  function call(body) {
    return new Promise((resolve) => {
      const res = {
        code: 0, headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        status(c) { this.code = c; return this; },
        json(b) { resolve({ code: this.code, body: b }); },
        end() { resolve({ code: this.code }); },
      };
      handler({ method: "POST", headers: { origin: "https://rsb79692-create.github.io", "content-type": "application/json" }, body: body }, res);
    });
  }
  let r = await call({ tenant: "mantel", idToken: "x".repeat(40), action: "sync" });
  check("マンテール: 403 feature_disabled", r.code === 403 && r.body && r.body.error === "feature_disabled", JSON.stringify(r));
  r = await call({ tenant: "mantel", idToken: "x".repeat(40), action: "devices", facility: FAC });
  check("マンテール: 測定対象も取れない（403）", r.code === 403);
  check("マンテール: RTDB・月次書類 DB・レート制限のいずれにも触れていない", touched.db === 0 && touched.http === 0, JSON.stringify(touched));
  r = await call({ tenant: "unknown", idToken: "x".repeat(40), action: "sync" });
  check("未知の会社: 拒否（穂乃味へ倒さない）", r.code >= 400 && r.code < 500 && touched.db === 0);
  // 会社設定の monthlyDocs が false の間は、穂乃味でも入口で止まる（2026-10-08 本番停止）
  const T = require(path.join(ROOT, "api/_lib/tenant.js"));
  const realFeature = T.feature;
  T.feature = (n) => (n === "monthlyDocs" ? false : realFeature(n));
  r = await call({ idToken: "x".repeat(40), action: "sync" });
  check("穂乃味: monthlyDocs が false なら 403 feature_disabled", r.code === 403 && r.body && r.body.error === "feature_disabled", JSON.stringify(r));
  r = await call({ idToken: "x".repeat(40), action: "devices", facility: FAC });
  check("穂乃味: monthlyDocs が false なら測定対象も取れず、DB に触れない", r.code === 403 && touched.db === 0 && touched.http === 0, JSON.stringify(touched));
  // 以下は monthlyDocs が true のときの入口の検査
  T.feature = (n) => (n === "monthlyDocs" ? true : realFeature(n));
  r = await call({ idToken: "x".repeat(40), action: "devices", facility: "ナナイロ" });
  check("穂乃味: ミュゲの泉以外の測定対象は 403 facility_disabled で、DB に触れない", r.code === 403 && r.body && r.body.error === "facility_disabled" && touched.db === 0 && touched.http === 0, JSON.stringify(r) + JSON.stringify(touched));
  delete process.env.MDOC_SUPABASE_URL;
  r = await call({ idToken: "x".repeat(40), action: "sync" });
  check("穂乃味でも接続設定が無ければ 503（フェイルクローズ）", r.code === 503);
  r = await call({ idToken: "x".repeat(40), action: "write" });
  check("穂乃味: 未知の action は 400", r.code === 400);
  G.verifyIdToken = async () => { throw new Error("bad token"); };
  r = await call({ idToken: "x".repeat(40), action: "sync" });
  check("穂乃味: トークン不正は 401", r.code === 401);
  T.feature = realFeature;
  process.env.MDOC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
  process.env.MDOC_SUPABASE_KEY = "sb_secret_xxxxxxxx";
  process.env.MDOC_INGEST_KEY = "k".repeat(40);
  check("公開キー以外（sb_secret_）は使わない", MD.config() === null);
  process.env.MDOC_SUPABASE_KEY = "sb_publishable_xxxxxxxx";
  check("公開キー＋合言葉なら設定あり", MD.config() !== null);
  await uiTests;

  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
