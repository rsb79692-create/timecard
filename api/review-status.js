/**
 * GET /api/review-status?ym=YYYY-MM — 穂乃味の「月次精査完了」の状態だけを返す読み取り専用 API。
 *
 * 出力 : { ok:true, ym, reviewed:true|false, reviewedAt:"ISO"|null } の4項目だけ。
 *        記録が無い月・精査完了を解除した月は reviewed:false, reviewedAt:null。
 *        ym が YYYY-MM でなければ 400 { error:"bad_ym" }、GET 以外は 405。
 * 利用者: Claude の毎月の自動送信タスク（精査完了の翌日に労務士へ書類を送る判断に使う）。
 *
 * ★ 読むのは穂乃味の /honomi/tc5_monthly_review_status/{ym}（index.html の reviewStatusSave が書く場所）だけ。
 *   書き込みは一切しない（レート制限カウンタ /ratelimit を除く）。
 * ★ 返すのは上の4項目だけ。reviewedBy などの他の項目、打刻・スタッフの情報は返さない
 *   （記録の値をそのまま流さず、項目ごとに組み立て直す）。
 * ★ 認証なし（curl から呼ぶため）。Origin・Content-Type の検査を持つ H.guard は POST 専用なので使わず、
 *   ここで GET だけを受ける。CORS 応答ヘッダは付けない。応答はキャッシュさせない（no-store）。
 * ★ T.handler は GET を会社の判定なしに通すため、会社は穂乃味に固定して T.run で明示する
 *   （会社コンテキストの無い DB アクセスを作らない）。
 * ★ IP ごとの回数制限（10分あたり300回＝1分あたり30回程度）。DB を読む前に数える。
 */
"use strict";

const H = require("./_lib/http");
const G = require("./_lib/google");
const S = require("./_lib/secrets");
const T = require("./_lib/tenant");

const YM_RE = /^\d{4}-\d{2}$/;
// レート制限の窓は secrets.js の 10 分。1分あたり30回程度 → 10分で300回。
const LIMIT_PER_IP = 300;

/** 記録（任意の値）から返す2項目だけを取り出す。reviewed は true のときだけ真。 */
function pickStatus(entry) {
  const reviewed = !!(entry && typeof entry === "object" && entry.reviewed === true);
  let reviewedAt = null;
  if (reviewed && typeof entry.reviewedAt === "string") {
    const t = Date.parse(entry.reviewedAt);
    if (!isNaN(t)) reviewedAt = new Date(t).toISOString();
  }
  return { reviewed: reviewed, reviewedAt: reviewedAt };
}

/** ym を取り出す。配列（?ym=a&ym=b）や形式違いは null。 */
function parseYm(req) {
  const q = (req && req.query) || {};
  const v = q.ym;
  return typeof v === "string" && YM_RE.test(v) ? v : null;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return H.fail(res, 405, "method_not_allowed");
  }
  const ym = parseYm(req);
  if (!ym) return H.fail(res, 400, "bad_ym");

  const cid = H.correlationId();
  try {
    return await T.run("honomi", async function () {
      const n = await S.bumpAndCount("rvs_ip", S.sanitizeKey(H.clientIp(req)));
      if (n > LIMIT_PER_IP) {
        res.setHeader("Retry-After", "600");
        return H.fail(res, 429, "rate_limited");
      }
      const entry = await G.dbGet("tc5_monthly_review_status/" + ym);
      const st = pickStatus(entry);
      return res.status(200).json({ ok: true, ym: ym, reviewed: st.reviewed, reviewedAt: st.reviewedAt });
    });
  } catch (e) {
    console.error("[review-status] error", cid, e && e.message ? e.message : "unknown");
    return H.serverError(res, cid);
  }
}

module.exports = T.handler(handler, { cors: false });
module.exports.pickStatus = pickStatus;
module.exports.parseYm = parseYm;
