/**
 * 施設変更の押し忘れを後から足す（buildManualFacilityChange）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-manual-facility-change.js
 *
 * 目的:
 *   職員の時刻修正申請の承認・管理者の「➕ 打刻を追加」で作る施設変更が、
 *   打刻ボタンの施設変更と同じ項目（移動元・移動先・応援の判定）を持ち、
 *   勤務中でない時刻・休憩中・同じ施設への変更を作らないことを固定する。
 *   あわせて、承認と追加の経路がその日の打刻を取り終えるまで作らないことを確かめる。
 *
 * 方式:
 *   index.html の MANUAL-FACILITY-CHANGE ブロックだけを抜き出して vm で評価する。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

const S = html.indexOf("// ===== MANUAL-FACILITY-CHANGE =====");
const E = html.indexOf("// ===== MANUAL-FACILITY-CHANGE-END =====");
if (S < 0 || E < 0) { console.error("ERROR: MANUAL-FACILITY-CHANGE ブロックが見つかりません。"); process.exit(1); }
const CODE = html.slice(S, E);

let seq = 0;
function makeCtx(records) {
  const ctx = {
    records,
    masterLocs: ["本店", "支店A", "支店B"],
    approvals: {},
    staffList: [{ name: "山田", location: "本店", canSupportWork: true }],
    generateRecordId: () => "rec_" + (++seq),
    parseJstDateTime: (date, time) => (!date || !time) ? null : new Date(date + "T" + time + ":00+09:00"),
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return ctx;
}
function rec(type, time, extra) {
  return Object.assign({ id: "r_" + type + time, staff: "山田", date: "2026-10-28", type, time,
    timestamp: new Date("2026-10-28T" + time + ":00+09:00").toISOString() }, extra || {});
}

console.log("\n[1] 勤務中の時刻なら、打刻ボタンと同じ項目で作る");
{
  const c = makeCtx([rec("clockIn", "09:00", { workFacility: "本店", facilityName: "本店" }), rec("clockOut", "18:00")]);
  const r = c.buildManualFacilityChange("山田", "2026-10-28", "13:00", "支店A");
  check("エラーなし", !r.error, r.error);
  const x = r.rec || {};
  check("種類は facilityChange", x.type === "facilityChange");
  check("移動元は出勤の施設", x.fromFacility === "本店" && x.facilityName === "本店");
  check("移動先", x.workFacility === "支店A");
  check("登録施設と応援の判定", x.homeFacility === "本店" && x.isSupportWork === true && x.wageType === "support_zero");
  check("日時", x.date === "2026-10-28" && x.time === "13:00" && x.timestamp === new Date("2026-10-28T13:00:00+09:00").toISOString());
  check("手入力の印", x.manualAdd === true);
  check("records へは積まない", c.records.length === 2);
}

console.log("\n[2] 登録施設へ戻る変更は応援にしない");
{
  const c = makeCtx([rec("clockIn", "09:00", { workFacility: "本店" }),
    rec("facilityChange", "11:00", { fromFacility: "本店", workFacility: "支店A" })]);
  const r = c.buildManualFacilityChange("山田", "2026-10-28", "15:00", "本店");
  check("移動元は直前の施設変更の移動先", r.rec && r.rec.fromFacility === "支店A");
  check("応援でない", r.rec && r.rec.isSupportWork === false && r.rec.wageType === "normal");
}

console.log("\n[3] 作らない場合");
{
  const base = [rec("clockIn", "09:00", { workFacility: "本店" }), rec("breakStart", "12:00"), rec("breakEnd", "13:00"), rec("clockOut", "18:00")];
  const c = makeCtx(base);
  check("出勤より前", !!c.buildManualFacilityChange("山田", "2026-10-28", "08:00", "支店A").error);
  check("出勤と同じ時刻", !!c.buildManualFacilityChange("山田", "2026-10-28", "09:00", "支店A").error);
  check("退勤より後", !!c.buildManualFacilityChange("山田", "2026-10-28", "19:00", "支店A").error);
  check("休憩中", !!c.buildManualFacilityChange("山田", "2026-10-28", "12:30", "支店A").error);
  check("休憩後は作れる", !c.buildManualFacilityChange("山田", "2026-10-28", "14:00", "支店A").error);
  check("同じ施設", !!c.buildManualFacilityChange("山田", "2026-10-28", "10:00", "本店").error);
  check("移動先が施設マスタに無い", !!c.buildManualFacilityChange("山田", "2026-10-28", "10:00", "どこか").error);
  check("移動先が空", !!c.buildManualFacilityChange("山田", "2026-10-28", "10:00", "").error);
  check("時刻が空", !!c.buildManualFacilityChange("山田", "2026-10-28", "", "支店A").error);
  const d = makeCtx([rec("clockIn", "09:00", { workFacility: "本店", deleted: true })]);
  check("削除済みの出勤は数えない", !!d.buildManualFacilityChange("山田", "2026-10-28", "10:00", "支店A").error);
  const e = makeCtx([rec("clockIn", "09:00", { workFacility: "本店" })]);
  check("別の日の打刻は使わない", !!e.buildManualFacilityChange("山田", "2026-10-29", "10:00", "支店A").error);
  check("別の職員の打刻は使わない", !!e.buildManualFacilityChange("佐藤", "2026-10-28", "10:00", "支店A").error);
}

console.log("\n[3b] 未来の時刻・承認済みの日・登録施設");
{
  const c = makeCtx([rec("clockIn", "09:00", { workFacility: "本店" })]);
  const fut = new Date(Date.now() + 3 * 3600000);
  const fd = new Date(fut.getTime() + 9 * 3600000).toISOString();
  c.records.push({ id: "fin", staff: "山田", date: fd.slice(0, 10), type: "clockIn", time: "00:00", timestamp: new Date(Date.now() - 60000).toISOString(), workFacility: "本店" });
  check("これから先の時刻は作らない", !!c.buildManualFacilityChange("山田", fd.slice(0, 10), fd.slice(11, 16), "支店A").error);
  c.approvals["2026-10-28__山田"] = true;
  check("承認済みの日は作らない", !!c.buildManualFacilityChange("山田", "2026-10-28", "10:00", "支店A").error);
  const h = makeCtx([rec("clockIn", "09:00", { workFacility: "支店B", homeFacility: "支店B" })]);
  const hr = h.buildManualFacilityChange("山田", "2026-10-28", "10:00", "支店A");
  check("登録施設はその日の出勤の値を優先", hr.rec && hr.rec.homeFacility === "支店B" && hr.rec.isSupportWork === true);
  const d2 = makeCtx([rec("clockIn", "09:00", { workFacility: "本店" }), rec("facilityChange", "10:00", { workFacility: "支店A" })]);
  check("同じ時刻・同じ移動先の施設変更があれば作らない", !!d2.buildManualFacilityChange("山田", "2026-10-28", "10:00", "支店A").error);
}

console.log("\n[4] 承認・追加の経路");
{
  const ap = html.indexOf("if(req.type===\"facilityChange\"){");
  const apBlock = ap < 0 ? "" : html.slice(ap, html.indexOf("var d=parseJstDateTime(req.date,req.requestedTime);", ap));
  check("承認は施設変更を新しく足す（既存を書き換えない）", apBlock.includes("buildManualFacilityChange(req.staff,req.date,req.requestedTime,req.toFacility") && apBlock.includes("records.push(fr)"));
  check("承認はその日の打刻を取り終えるまで作らない", apBlock.indexOf("recordsRangeCovers(req.date,req.date)") >= 0 && apBlock.indexOf("recordsRangeCovers") < apBlock.indexOf("buildManualFacilityChange"));
  const ad = html.indexOf("var _fca=buildManualFacilityChange(");
  const adBlock = ad < 0 ? "" : html.slice(ad - 400, ad);
  check("追加はその日の打刻を取り終えるまで作らない", adBlock.includes("recordsRangeCovers(date,date)"));
  check("申請の選択肢は応援勤務ができる職員だけ", /if\(_crqSo\.canSupportWork&&!_fromNotif\)_crqTypes\.push\(\{v:"facilityChange"/.test(html));
  check("申請に移動先を持たせる", html.includes("if(_isFc)req.toFacility=_toFac;"));
  check("承認済み・却下済みの申請は扱わない", apBlock.includes('if(req.status!=="pending")'));
}

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
