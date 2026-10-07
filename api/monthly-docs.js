/**
 * POST /api/monthly-docs — 打刻と月次書類（honomi-monthly-docs）の連携窓口。★株式会社 穂乃味専用。
 *
 * 入力 : { idToken, action, facility? }
 *   action "devices" … 施設の温度測定対象と最後の温度（打刻画面の温度入力用。端末で控えて使う）
 *   action "sync"    … 直近の打刻の監査回答（tc5_records/{eventId}.mdoc）を月次書類の DB へ転記する（冪等）
 * 出力 : { ok:true, ... } / 失敗は { error: <code> }
 *
 * ★ 穂乃味以外は入口で拒否する（画面で出さないだけにしない）。判定は会社コンテキスト（トークンの会社と
 *   リクエストの会社の一致は verifyIdToken が検査）の会社ID と、会社設定の機能フラグ monthlyDocs の両方。
 * ★ 打刻端末は匿名のトークンで動くため、穂乃味のトークンなら役割を問わない。どちらの action も、
 *   クライアントから記録の内容を受け取らない（sync はサーバが RTDB の打刻を読んで検証する）。
 *   書き込み先は月次書類 DB の専用関数だけで、既にある記録は上書きされない（追記のみ・一意制約）。
 */
"use strict";

const H = require("./_lib/http");
const G = require("./_lib/google");
const S = require("./_lib/secrets");
const T = require("./_lib/tenant");
const MD = require("./_lib/monthly-docs");

const MIN_MS = 40;
// 1トークン（端末）あたり10分の上限。打刻ごとの sync と起動時の取得で通常は数回〜数十回。
const LIMIT_PER_TOKEN = 120;
// 会社全体の sync の上限（10分）。打刻のピーク（朝の出勤が数十件）でも十分に余る値。
const LIMIT_ALL_SYNC = 600;

module.exports = T.handler(async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    // ★ 穂乃味専用（会社ID と機能フラグの両方）。他社はここで止め、RTDB にも月次書類にも触れない。
    const tenant = T.current();
    if (tenant.id !== "honomi" || !T.feature("monthlyDocs")) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "feature_disabled");
    }
    const body = req.body || {};
    const action = H.str(body.action, 16);
    if (action !== "devices" && action !== "sync") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_action");
    }

    let claims = null;
    try { claims = await G.verifyIdToken(H.str(body.idToken, 4096)); } catch (e) { claims = null; }
    if (!claims || typeof claims.sub !== "string") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, "unauthorized");
    }
    if (!MD.config()) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 503, "not_configured");
    }

    const n = await S.bumpAndCount("mdoc", S.sanitizeKey(claims.sub));
    if (n > LIMIT_PER_TOKEN) {
      res.setHeader("Retry-After", "600");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }

    if (action === "devices") {
      const facility = H.str(body.facility, 40);
      if (!(await MD.facilityExists(facility))) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "unknown_facility");
      }
      const r = await MD.devices(facility);
      return res.status(200).json({ ok: true, facility: facility, devices: r.devices, last: r.last });
    }

    // ★ sync は入力を持たないので、会社全体でも回数を抑える（匿名のトークンを作り直して上限を外されないように）
    const all = await S.bumpAndCount("mdoc_all", "sync");
    if (all > LIMIT_ALL_SYNC) {
      res.setHeader("Retry-After", "60");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }
    const r = await MD.syncRecent(Number(body.days));
    console.log("[monthly-docs] sync", cid, JSON.stringify(r));
    return res.status(200).json({ ok: true, inserted: r.inserted, found: r.found });
  } catch (e) {
    console.error("[monthly-docs] error", cid, e && e.message ? e.message : "unknown");
    return H.serverError(res, cid);
  }
});
