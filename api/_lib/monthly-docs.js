/**
 * api/_lib/monthly-docs.js — 打刻と月次書類（honomi-monthly-docs）の連携。★株式会社 穂乃味（会社ID honomi）専用。
 *
 * ===== 流れ（詳細: docs/features/monthly-docs.md）=====
 *  - 打刻画面で答えた監査の回答（衛生・新興感染症／温度／保存食）は、打刻レコード（tc5_records/{eventId}）の
 *    mdoc に入れて、打刻と同じ端末保存・再送の経路で RTDB へ届く（打刻と監査記録が食い違わない）。
 *  - このサーバは RTDB の直近 SYNC_DAYS 日の打刻を date 索引で読み、mdoc を検証して月次書類の DB へ転記する。
 *    転記は冪等（event_id = 打刻の eventId + 種別。月次書類 DB の一意制約で二重にならない）。
 *  - 月次書類 DB へは公開キー＋合言葉（MDOC_INGEST_KEY）で専用の2関数だけを呼ぶ。service role key は使わない。
 *
 * ★ 会社の判定はここではなく api/monthly-docs.js の入口（T.current().id === "honomi" かつ機能フラグ）で行う。
 *   このファイルの関数は穂乃味のコンテキストからしか呼ばれない前提で、RTDB のパスも穂乃味（/honomi）だけを読む。
 */
"use strict";

const G = require("./google");

/** 転記の対象にする日数（今日を含む）。端末に残った未送信打刻が数日後に届いても拾えるように。 */
const SYNC_DAYS = 7;
/** 保存食の廃棄日は保存日の何日前か（月次書類 src/lib/sheets/calendar.ts の HOZON_OFFSET_DAYS と同じ値）。 */
const HOZON_OFFSET_DAYS = 15;
/** 1施設×種別の機器の上限（月次書類の帳票の欄＝冷蔵庫1〜4）。打刻1件に載せられる機器は冷蔵・冷凍で8台まで。 */
const MAX_DEVS = 8;

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint 等は無いが、制御文字は月次書類 DB の CHECK でも拒否される
const CTRL_RE = /[\u0000-\u001f\u007f]/;

function isText(s, max) {
  return typeof s === "string" && s.length >= 1 && Array.from(s).length <= max && !CTRL_RE.test(s);
}

/** "YYYY-MM-DD" の暦日として正しいか。 */
function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 日付の加算（暦日・UTC 計算でタイムゾーンに依存しない）。 */
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 日本時間の今日。 */
function todayJst(nowMs) {
  return new Date((nowMs == null ? Date.now() : nowMs) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 保存食の廃棄対象日（保存日の HOZON_OFFSET_DAYS 日前）。 */
function hozonDiscardDate(storeYmd) {
  return addDays(storeYmd, -HOZON_OFFSET_DAYS);
}

/** 施設マスタ（master/locations）から施設名の集合。要素は文字列または {name}。 */
function facilityNames(raw) {
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  const out = new Set();
  for (const f of arr) {
    const n = typeof f === "string" ? f : (f && typeof f === "object" && typeof f.name === "string" ? f.name : "");
    if (isText(n, 40)) out.add(n);
  }
  return out;
}

/** 従業員マスタ（tc5_staff）から 氏名 → 社員番号（未登録は ""）の対応。 */
function staffNames(raw) {
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  const out = new Map();
  for (const s of arr) {
    if (!s || typeof s !== "object" || !isText(s.name, 40)) continue;
    const eid = typeof s.employeeId === "string" ? s.employeeId.trim() : "";
    out.set(s.name, SID_RE.test(eid) ? eid : "");
  }
  return out;
}

/** 温度1台分の検証（-50〜50、0.1℃単位に丸める）。 */
function cleanDev(d) {
  if (!d || typeof d !== "object") return null;
  if (typeof d.id !== "string" || !UUID_RE.test(d.id)) return null;
  if (d.k !== "r" && d.k !== "f") return null;
  if (!isText(d.n, 12)) return null;
  const o = Number(d.o);
  if (!Number.isInteger(o) || o < 0 || o > 99) return null;
  if (typeof d.v !== "number" || !isFinite(d.v) || d.v < -50 || d.v > 50) return null;
  return { id: d.id, k: d.k, n: d.n, o: o, v: Math.round(d.v * 10) / 10 };
}

/**
 * 打刻レコードの mdoc を検証して、月次書類 DB へ送る記録へ変換する（純関数）。
 * 不正なものは捨てて数える（1件の不正で他を落とさない）。
 * @param {Object} records  tc5_records の範囲取得の結果（{ノード名: レコード}）
 * @param {{staff:Set<string>, facilities:Set<string>}} master
 */
function eventsFromRecords(records, master) {
  const events = [];
  let rejected = 0;
  const entries = records && typeof records === "object" ? Object.entries(records) : [];
  // 同じ人・同じ日の打刻に現れる施設（退勤の記録は打刻した端末の施設しか持たないため、出勤・施設変更の勤務先も認める）
  const dayFacs = {};
  for (const [, r] of entries) {
    if (!r || typeof r !== "object" || r.deleted || typeof r.staff !== "string" || typeof r.date !== "string") continue;
    const k = r.staff + "|" + r.date;
    const set = dayFacs[k] || (dayFacs[k] = new Set());
    [r.workFacility, r.facilityName, r.homeFacility, r.fromFacility].forEach(function (x) { if (typeof x === "string" && x) set.add(x); });
  }
  for (const [key, r] of entries) {
    if (!r || typeof r !== "object" || !r.mdoc || typeof r.mdoc !== "object") continue;
    // 管理者が削除した打刻（deleted）は転記しない（訂正後の打刻の記録を一意制約で塞がないため）
    if (r.deleted) continue;
    const md = r.mdoc;
    const bad = function () { rejected++; };
    // 打刻としての整合（ノード名 = eventId、種別、日付、本人、施設）
    if (!EVENT_ID_RE.test(key) || r.eventId !== key) { bad(); continue; }
    if (r.type !== "clockIn" && r.type !== "clockOut") { bad(); continue; }
    if (!isDate(r.date)) { bad(); continue; }
    const at = typeof r.timestamp === "string" ? new Date(r.timestamp) : null;
    if (!at || isNaN(at.getTime())) { bad(); continue; }
    if (!isText(r.staff, 40) || !master.staff.has(r.staff)) { bad(); continue; }
    // 確認した職員の正式な識別子（社員番号）。端末の申告（md.sid）は使わず、常に従業員マスタの値を記録する
    // （端末の職員一覧が古く食い違っても、記録そのものは落とさない）。
    const sid = master.staff.get(r.staff) || "";
    const who = sid ? { sid: sid } : {};
    const fac = md.f;
    if (!isText(fac, 40) || !master.facilities.has(fac)) { bad(); continue; }
    // 打刻の施設と食い違う申告は受けない。出勤はその打刻の施設、退勤はその日の本人の打刻に現れた施設のいずれか。
    // 施設の項目が1つも無い打刻は受けない。
    const recFacs = [r.workFacility, r.facilityName, r.homeFacility].filter(function (x) { return typeof x === "string" && x; });
    const allowed = r.type === "clockOut" ? (dayFacs[r.staff + "|" + r.date] || new Set()) : new Set(recFacs);
    if (!allowed.has(fac)) { bad(); continue; }

    const base = {
      punch_type: r.type,
      facility: fac,
      target_date: r.date,
      staff_name: r.staff,
      recorded_at: at.toISOString(),
      punch_received_at: typeof r.serverReceivedAt === "number" && isFinite(r.serverReceivedAt)
        ? new Date(r.serverReceivedAt).toISOString() : null,
    };

    if (md.hyg !== undefined) {
      const a = md.hyg && md.hyg.a;
      if (r.type !== "clockIn" || (a !== "ok" && a !== "ng")) bad();
      else events.push(Object.assign({}, base, { event_id: key + ":hyg", kind: "hygiene", slot: 0, answer: a, payload: who }));
    }
    if (md.temp !== undefined) {
      const t = md.temp || {};
      const s = t.s;
      const slotOk = r.type === "clockIn" ? s === 0 : (s === 1 || s === 2);
      const devs = Array.isArray(t.d) && t.d.length >= 1 && t.d.length <= MAX_DEVS ? t.d.map(cleanDev) : null;
      const ids = devs ? new Set(devs.filter(Boolean).map(function (d) { return d.id; })) : null;
      if (!slotOk || !devs || devs.some(function (d) { return !d; }) || ids.size !== devs.length) bad();
      else {
        // 出勤の朝の温度は打刻の後に記録するため、温度を確定した時刻 t.at を記録日時にする（打刻の時刻〜24時間以内だけ認める）
        const tAt = typeof t.at === "string" ? new Date(t.at) : null;
        const okAt = tAt && !isNaN(tAt.getTime()) && tAt.getTime() >= at.getTime() - 60000 && tAt.getTime() <= at.getTime() + 86400000;
        events.push(Object.assign({}, base, okAt ? { recorded_at: tAt.toISOString() } : {},
          { event_id: key + ":temp", kind: "temp", slot: s, answer: "recorded", payload: Object.assign({ devs: devs }, who) }));
      }
    }
    if (md.hozon !== undefined) {
      const h = md.hozon || {};
      const ok = r.type === "clockOut" && (h.a === "yes" || h.a === "no")
        && h.store === r.date && h.discard === hozonDiscardDate(r.date);
      if (!ok) bad();
      else events.push(Object.assign({}, base, {
        event_id: key + ":hozon", kind: "hozon", slot: 0, answer: h.a, payload: Object.assign({ store: h.store, discard: h.discard }, who),
      }));
    }
  }
  return { events: events, rejected: rejected };
}

// ===== 月次書類 DB（Supabase）=====

function config() {
  const url = process.env.MDOC_SUPABASE_URL || "";
  const key = process.env.MDOC_SUPABASE_KEY || "";
  const ingest = process.env.MDOC_INGEST_KEY || "";
  // ★ 公開キー以外（sb_secret_ / service_role JWT）が設定されていたら使わない（フェイルクローズ）
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) return null;
  if (!/^sb_publishable_/.test(key)) return null;
  if (ingest.length < 32) return null;
  return { url: url, key: key, ingest: ingest };
}

/** 専用の RPC を呼ぶ。失敗は throw（呼び出し側で 502）。応答の本文はログへ出さない。 */
async function rpc(name, args) {
  const c = config();
  if (!c) throw new Error("mdoc not configured");
  const body = JSON.stringify(Object.assign({ p_key: c.ingest }, args));
  const res = await G.httpRequest(c.url + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: c.key,
      "Content-Type": "application/json",
      "Content-Profile": "monthly_docs",
      "Accept-Profile": "monthly_docs",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  if (res.status < 200 || res.status >= 300) throw new Error("mdoc rpc failed: HTTP " + res.status);
  return res.body;
}

/** 施設の測定対象と最後の温度。 */
async function devices(facility) {
  const r = await rpc("tc_devices", { p_facility: facility });
  const list = r && Array.isArray(r.devices) ? r.devices : [];
  const last = r && r.last && typeof r.last === "object" ? r.last : null;
  return {
    devices: list.filter(function (d) { return d && UUID_RE.test(String(d.id)) && (d.kind === "r" || d.kind === "f"); })
      .map(function (d) { return { id: d.id, k: d.kind, n: String(d.name || ""), o: Number(d.order) || 0 }; }),
    last: last && Array.isArray(last.devs) ? { at: String(last.at || ""), devs: last.devs.map(cleanDevLoose).filter(Boolean) } : null,
  };
}
function cleanDevLoose(d) {
  return d && typeof d === "object" && typeof d.id === "string" && typeof d.v === "number" ? { id: d.id, v: d.v } : null;
}

/** 記録の転記（500件ずつ）。 */
async function ingest(events) {
  let inserted = 0, skipped = 0, invalid = 0;
  for (let i = 0; i < events.length; i += 500) {
    const r = await rpc("tc_ingest", { p_events: events.slice(i, i + 500) });
    inserted += Number(r && r.inserted) || 0;
    skipped += Number(r && r.skipped) || 0;
    invalid += Number(r && r.invalid) || 0;
  }
  return { inserted: inserted, skipped: skipped, invalid: invalid };
}

/** 直近の打刻（打刻後は当日と前日の2日、起動時は SYNC_DAYS 日）を読み、mdoc を転記する。RTDB の読み取りは並列の3回（打刻は date 索引の範囲取得）。 */
async function syncRecent(days, nowMs) {
  // 2〜SYNC_DAYS 日に丸める（入力で読み込み範囲を広げさせない）
  const n = Math.min(SYNC_DAYS, Math.max(2, Math.floor(Number(days)) || 2));
  const to = todayJst(nowMs);
  const from = addDays(to, -(n - 1));
  const [recs, staffRaw, locRaw] = await Promise.all([
    G.dbGetRange("tc5_records", "date", from, to),
    G.dbGet("tc5_staff"),
    G.dbGet("master/locations"),
  ]);
  const { events, rejected } = eventsFromRecords(recs, { staff: staffNames(staffRaw), facilities: facilityNames(locRaw) });
  const r = events.length ? await ingest(events) : { inserted: 0, skipped: 0, invalid: 0 };
  return Object.assign({ found: events.length, rejected: rejected }, r);
}

/** 施設名が施設マスタにあるか（測定対象の取得前の確認）。 */
async function facilityExists(name) {
  if (!isText(name, 40)) return false;
  return facilityNames(await G.dbGet("master/locations")).has(name);
}

module.exports = {
  SYNC_DAYS,
  HOZON_OFFSET_DAYS,
  eventsFromRecords,
  hozonDiscardDate,
  addDays,
  todayJst,
  facilityNames,
  staffNames,
  config,
  devices,
  ingest,
  syncRecent,
  facilityExists,
};
