/**
 * api/_lib/mileage-punch.js — 打刻データ（/honomi/tc5_*）の読み取り専用アクセス
 *
 * ===== このファイルだけが tc5_* を参照してよい =====
 * 移動距離申請は原則として /honomi に触れない（誰でも書ける領域を金額の根拠にしないため）。
 * ただし「応援打刻を移動経路の正本にする」という業務要件のため、打刻そのものは読む必要がある。
 * そこで参照を本ファイルへ隔離し、次を機械的に守る:
 *
 *   ・**読み取りだけ**（dbPut / dbPatch / dbPatchRoot を一切呼ばない）
 *   ・参照するのは tc5_records と tc5_correction_requests の2つだけ
 *   ・tc5_staff / tc5_pins は参照しない（誰でも書けるため、本人特定に使うと成りすましが成立する。
 *     社員番号の解決は従来どおり /mileage/identity だけを正本とする）
 *
 * scripts/test-mileage.js がこの3点を静的に検証している。
 *
 * ===== 信頼できる範囲について（既知の残存リスク）=====
 * /honomi の Rules は auth != null であり、匿名認証を通せば tc5_records は書き換えられる。
 * したがって自動集計の金額は「打刻データと同じ信頼度」までしか保証できない。
 * これは勤務時間・賃金の計算が既に置かれている前提と同一であり、本機能で新たに下がるものではない。
 * 管理者が月次確定の前に日別の集計結果を確認する運用で担保する。
 */
"use strict";

const G = require("./google");

/** RTDB のノードを配列にする（キー付きオブジェクト・配列のどちらでも受ける）。 */
function toArray(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node.filter(Boolean);
  if (typeof node !== "object") return [];
  const out = [];
  for (const k of Object.keys(node)) if (node[k]) out.push(node[k]);
  return out;
}

/**
 * 対象年月の打刻を、スタッフ氏名ごとに束ねて返す。
 * ★ 全件取得してから月で絞る。tc5_records には date の索引が無く、
 *   索引の追加は Rules（database.rules.json）の変更＝人間の確認が必要なため、
 *   既存の運用スクリプト（scripts/morning-check.js 等）と同じ全件取得に合わせる。
 *   呼び出しは月次確定・差異確認のときだけで、画面表示はクライアント側で計算する。
 */
async function loadMonthPunches(ym, nameSet) {
  const raw = await G.dbGet("tc5_records");
  const all = toArray(raw);
  // ★ 索引キーは外部データ（氏名）由来。素の {} だと "__proto__" という氏名の打刻を
  //   1件書かれるだけで Object.prototype を汚染できる（/honomi は匿名認証で書ける）。
  const byStaff = Object.create(null);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r || typeof r !== "object" || r.deleted) continue;
    const d = String(r.date || "");
    if (d.slice(0, 7) !== ym) continue;
    const nm = String(r.staff || "");
    if (!nm) continue;
    if (nameSet && !Object.prototype.hasOwnProperty.call(nameSet, nm)) continue;
    if (nm === "__proto__" || nm === "prototype" || nm === "constructor") continue;
    (byStaff[nm] = byStaff[nm] || []).push(r);
  }
  // totalRecords は「打刻ノードそのものを取得できたか」の判定に使う。
  // 0 件のまま確定すると「移動が無い月」と区別できないため、呼び出し側で確定を止める。
  return { byStaff: byStaff, totalRecords: all.length };
}

/**
 * 対象年月の「未処理の打刻修正申請」を { 氏名: { 日付: true } } で返す。
 * 承認・却下が済んだ申請は対象外（打刻へ反映済み、または無効）。
 */
async function loadPendingCorrections(ym, nameSet) {
  const raw = await G.dbGet("tc5_correction_requests");
  const all = toArray(raw);
  const out = Object.create(null);
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!r || typeof r !== "object") continue;
    if (String(r.status || "") !== "pending") continue;
    const d = String(r.date || "");
    if (d.slice(0, 7) !== ym) continue;
    const nm = String(r.staff || "");
    if (!nm) continue;
    if (nameSet && !Object.prototype.hasOwnProperty.call(nameSet, nm)) continue;
    if (nm === "__proto__" || nm === "prototype" || nm === "constructor") continue;
    if (d === "__proto__" || d === "prototype" || d === "constructor") continue;
    (out[nm] = out[nm] || Object.create(null))[d] = true;
  }
  return out;
}

module.exports = { loadMonthPunches, loadPendingCorrections, toArray };
