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
  check("朝の温度が未記録なら朝（slot 0）を聞く（出勤は温度の記録で確定）", p && p.slot === 0);
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

  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
