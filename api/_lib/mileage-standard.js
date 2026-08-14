/**
 * api/_lib/mileage-standard.js — 7施設42方向の「標準区間距離」と、その取り込み計画（純粋関数）
 *
 * ===== このデータの出所 =====
 * ・30方向: 現行Excel `■通勤距離（穂乃味）.xlsm` の `baseT` シート（行=出発地／列=到着地）の実測値。
 *   Excel 上の「貝塚」＝現在の「ミュゲ貝塚」、「春木」＝現在の「ミュゲ春木」（2026-08-14 ユーザー確認）。
 * ・12方向: ハルイロ関連。baseT に距離が無く、ユーザーが実測値を確認（2026-08-14）。
 *   往復が同じ距離であることもユーザー確認済みだが、**A→B と B→A は別レコードとして明示的に列挙する**
 *   （片方から他方を導出しない。将来どちらかだけ直したいときに、導出だと直せなくなるため）。
 *
 * ===== 変更してはならないこと =====
 * ★ 非対称な値を「対称のはずだ」と補正してはならない。Excel 実測で次の2組は方向で距離が違う。
 *     ハーベスト → ミュゲ貝塚 = 5.3  /  ミュゲ貝塚 → ハーベスト = 11.9
 *     ハーベスト → ミュゲ春木 = 11.9 /  ミュゲ春木 → ハーベスト = 13.9
 *   これは入力誤りに見えるが、実測値としてそのまま保持する（推測で直さない）。
 * ★ 0km を含めてはならない。0 は「距離が無い」ではなく「未登録」として扱うのが本機能の前提。
 *
 * ===== 使い方 =====
 * planLegImport() は**計算だけ**を行い、DB へは書かない。呼び出し側（api/mileage.js）が
 * status==="new" の行だけを書き込む。既存値は同値でも相違でも**絶対に上書きしない**。
 */
"use strict";

const AU = require("./mileage-auto.js");

/** 施設名は打刻の `workFacility`（＝施設マスタ `master/locations` の name）と同じ表記で持つ。 */
const STANDARD_LEGS = [
  // ── ミュゲの泉 ──（Excel baseT 行2）
  { from: "ミュゲの泉", to: "ハーベスト", km: 6.2, src: "excel" },
  { from: "ミュゲの泉", to: "ナナイロ", km: 4.4, src: "excel" },
  { from: "ミュゲの泉", to: "ココラ", km: 2.8, src: "excel" },
  { from: "ミュゲの泉", to: "ミュゲ貝塚", km: 6.2, src: "excel" },
  { from: "ミュゲの泉", to: "ミュゲ春木", km: 13.9, src: "excel" },
  // ── ハーベスト ──（Excel baseT 行3）
  { from: "ハーベスト", to: "ミュゲの泉", km: 6.2, src: "excel" },
  { from: "ハーベスト", to: "ナナイロ", km: 6.3, src: "excel" },
  { from: "ハーベスト", to: "ココラ", km: 4.0, src: "excel" },
  { from: "ハーベスト", to: "ミュゲ貝塚", km: 5.3, src: "excel" },   // ★非対称（逆は 11.9）
  { from: "ハーベスト", to: "ミュゲ春木", km: 11.9, src: "excel" },  // ★非対称（逆は 13.9）
  // ── ナナイロ ──（Excel baseT 行4）
  { from: "ナナイロ", to: "ミュゲの泉", km: 4.4, src: "excel" },
  { from: "ナナイロ", to: "ハーベスト", km: 6.3, src: "excel" },
  { from: "ナナイロ", to: "ココラ", km: 2.8, src: "excel" },
  { from: "ナナイロ", to: "ミュゲ貝塚", km: 6.2, src: "excel" },
  { from: "ナナイロ", to: "ミュゲ春木", km: 13.9, src: "excel" },
  // ── ココラ ──（Excel baseT 行5）
  { from: "ココラ", to: "ミュゲの泉", km: 2.8, src: "excel" },
  { from: "ココラ", to: "ハーベスト", km: 4.0, src: "excel" },
  { from: "ココラ", to: "ナナイロ", km: 2.8, src: "excel" },
  { from: "ココラ", to: "ミュゲ貝塚", km: 5.9, src: "excel" },
  { from: "ココラ", to: "ミュゲ春木", km: 13.6, src: "excel" },
  // ── ミュゲ貝塚 ──（Excel baseT 行6「貝塚」）
  { from: "ミュゲ貝塚", to: "ミュゲの泉", km: 6.2, src: "excel" },
  { from: "ミュゲ貝塚", to: "ハーベスト", km: 11.9, src: "excel" },  // ★非対称（逆は 5.3）
  { from: "ミュゲ貝塚", to: "ナナイロ", km: 6.2, src: "excel" },
  { from: "ミュゲ貝塚", to: "ココラ", km: 5.9, src: "excel" },
  { from: "ミュゲ貝塚", to: "ミュゲ春木", km: 9.0, src: "excel" },
  // ── ミュゲ春木 ──（Excel baseT 行7「春木」）
  { from: "ミュゲ春木", to: "ミュゲの泉", km: 13.9, src: "excel" },
  { from: "ミュゲ春木", to: "ハーベスト", km: 13.9, src: "excel" },  // ★非対称（逆は 11.9）
  { from: "ミュゲ春木", to: "ナナイロ", km: 13.9, src: "excel" },
  { from: "ミュゲ春木", to: "ココラ", km: 13.6, src: "excel" },
  { from: "ミュゲ春木", to: "ミュゲ貝塚", km: 9.0, src: "excel" },
  // ── ハルイロ ──（Excel に無し。2026-08-14 ユーザー確認値。往復同値もユーザー確認済み）
  { from: "ハルイロ", to: "ナナイロ", km: 3.2, src: "user" },
  { from: "ナナイロ", to: "ハルイロ", km: 3.2, src: "user" },
  { from: "ハルイロ", to: "ココラ", km: 0.8, src: "user" },
  { from: "ココラ", to: "ハルイロ", km: 0.8, src: "user" },
  { from: "ハルイロ", to: "ハーベスト", km: 3.7, src: "user" },
  { from: "ハーベスト", to: "ハルイロ", km: 3.7, src: "user" },
  { from: "ハルイロ", to: "ミュゲ貝塚", km: 5.7, src: "user" },
  { from: "ミュゲ貝塚", to: "ハルイロ", km: 5.7, src: "user" },
  { from: "ハルイロ", to: "ミュゲ春木", km: 14.0, src: "user" },
  { from: "ミュゲ春木", to: "ハルイロ", km: 14.0, src: "user" },
  { from: "ハルイロ", to: "ミュゲの泉", km: 6.7, src: "user" },
  { from: "ミュゲの泉", to: "ハルイロ", km: 6.7, src: "user" },
];

/** 標準データに現れる施設名（重複なし・定義順）。 */
function standardFacilities() {
  const seen = Object.create(null);
  const out = [];
  for (const s of STANDARD_LEGS) {
    for (const nm of [s.from, s.to]) {
      if (!Object.prototype.hasOwnProperty.call(seen, nm)) { seen[nm] = 1; out.push(nm); }
    }
  }
  return out;
}

/**
 * 取り込み計画を作る（DB へは書かない）。
 *
 *   places … M.loadPlaces() の戻り（facilities を含む）
 *   legs   … M.loadLegs() の戻り（{ "fromId__toId": km }）
 *
 * 戻り値 rows[].status
 *   "new"      … 未登録。取り込み対象
 *   "same"     … 既に同じ値。書かない（再実行しても重複しない＝冪等）
 *   "conflict" … 既存値が違う。★自動上書きしない。管理者が個別に判断する
 *   "no_place" … 施設に対応する地点が無い／一意に決まらない。書けない
 */
function planLegImport(places, legs) {
  const map = AU.placeMap(places || []);
  const legMap = legs || {};
  const rows = [];
  const counts = { new: 0, same: 0, conflict: 0, no_place: 0 };
  const missing = [];

  // ★ 先に key の出現数を数える。2件目以降だけを弾くと**1件目が書かれてしまい**、
  //   どちらの距離が入るかが STANDARD_LEGS の定義順で決まる（＝推測で確定することになる）。
  //   2つの施設名が同じ地点へ寄っている等で衝突したら、その key の行は1本も書かない。
  const keyCount = Object.create(null);
  for (const s of STANDARD_LEGS) {
    const f = AU.has(map, s.from) ? map[s.from] : "";
    const t = AU.has(map, s.to) ? map[s.to] : "";
    if (!f || !t || f === t) continue;
    const k = f + "__" + t;
    keyCount[k] = (keyCount[k] || 0) + 1;
  }

  for (const s of STANDARD_LEGS) {
    const fromId = AU.has(map, s.from) ? map[s.from] : "";
    const toId = AU.has(map, s.to) ? map[s.to] : "";
    const row = { from: s.from, to: s.to, km: AU.round1(s.km), src: s.src,
                  key: "", currentKm: null, status: "", reason: "" };
    if (!fromId || !toId) {
      row.status = "no_place";
      // reason ＝ 管理者が何を直せばよいかの手掛かり。件数だけ出して理由を出さないと、
      //   画面の案内（「先に施設マスタから取り込む」）と実際の原因が噛み合わず行き止まりになる。
      row.reason = "missing_place";
      for (const nm of [!fromId ? s.from : "", !toId ? s.to : ""]) {
        if (nm && missing.indexOf(nm) < 0) missing.push(nm);
      }
    } else if (fromId === toId) {
      // 2つの施設名が同じ地点へ対応づけられている場合に起きる。0km を書かないため弾く。
      row.status = "no_place";
      row.reason = "same_place";
    } else {
      row.key = fromId + "__" + toId;
      // 同じ key へ複数の標準区間が落ちる場合は、どれを採るか推測せず**全行**を弾く。
      if (keyCount[row.key] > 1) {
        row.status = "no_place";
        row.reason = "dup_key";
        row.key = "";   // 書き込み対象にしない（buildLegImportPatch は key 空を除外する）
      } else {
        const cur = Object.prototype.hasOwnProperty.call(legMap, row.key) ? legMap[row.key] : null;
        row.currentKm = cur == null ? null : AU.round1(cur);
        row.status = (cur == null) ? "new" : (row.currentKm === row.km ? "same" : "conflict");
      }
    }
    counts[row.status]++;
    rows.push(row);
  }
  return { rows: rows, counts: counts, missingFacilities: missing, total: STANDARD_LEGS.length };
}

/**
 * 取り込みで実際に書き込む patch を組み立てる（純粋関数・DB へは触らない）。
 *
 * ★★ この関数がこの機能の唯一の書き込み口である。**status==="new" 以外を絶対に含めない。** ★★
 *   ハンドラ側に書き込みループを持たせると、ガード行を残したまま別ループを足すだけで
 *   既存値を上書きでき、しかもテストが素通りする（実際に変異解析で検出された）。
 *   純粋関数にして「patch のキー集合」をテストで固定できる形にしてある。
 */
function buildLegImportPatch(plan, legsPath, now, actor) {
  const patch = Object.create(null);
  for (const r of (plan && plan.rows) || []) {
    if (r.status !== "new") continue;
    if (!r.key) continue;
    patch[legsPath + "/" + r.key] = { km: r.km, updatedAt: now, updatedBy: actor };
  }
  return patch;
}

module.exports = { STANDARD_LEGS, standardFacilities, planLegImport, buildLegImportPatch };
