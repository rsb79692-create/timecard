/**
 * POST /api/auth/share
 *
 * 共有URLトークン（労務士閲覧 / 管理者デモ / スタッフテスト）→ 対応する役割の Custom Token。
 *
 * 入力  : { kind: "viewer"|"demo"|"sandbox", token: string }
 * 出力  : { customToken, role, sessionExpiresAt }
 * 失敗  : 401 { error: "invalid_credentials" } / 410 { error: "expired" }
 *
 * ===== 既存仕様の維持（重要）=====
 *  - ★ 有効期限は現行仕様のまま。トークンレコードの expiresAt（JSTの日付文字列）だけを使い、
 *    12時間・24時間といった固定TTLを新設しない。セッションの期限も expiresAt の当日末に合わせる。
 *  - ★ 判定条件は index.html の現行ロジックと同一にする。
 *      viewer  : enabled 必須 / expiresAt があり当日より前なら期限切れ（未設定は有効のまま）
 *      demo    : enabled 必須 / expiresAt 未設定または当日より前なら期限切れ（フェイルクローズ）
 *      sandbox : enabled 必須 / expiresAt 未設定または当日より前なら期限切れ
 *      さらに viewer がデモ発行由来なら、発行元デモの有効性にも連動させる。
 *  - トークンは現行どおり生のトークンをキーにしたノードを引く。
 *    ★ 既存の閲覧用URL・デモURLをそのまま使えるようにするため、鍵の作り直しはしない。
 *  - 参照は Admin 権限のサーバ側だけで行う。クライアントへ判定材料を配らない。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");
const T = require("../_lib/tenant");
const crypto = require("crypto");

const MIN_MS = 150;
const SOFT_IP = 20;
const SOFT_ALL = 100;
const HARD_IP = 100;

const KINDS = {
  viewer: { node: "viewerTokens", role: "v", requireExpiry: false },
  demo: { node: "demoTokens", role: "d", requireExpiry: true },
  sandbox: { node: "staffDemoTokens", role: "x", requireExpiry: true },
  // ★ 施設端末（新会社のみ）。施設URLのトークンを、会社ID付きの端末トークン（r:"k"）へ交換する。
  //   穂乃味は従来どおり匿名サインインで起動するので、この種別は穂乃味では受け付けない。
  kiosk: { node: null, role: "k", requireExpiry: false, tenantOnly: true },
};

/** 施設名 → 16桁のキー（将来の facility_manager 用に端末トークンへ載せる。施設名そのものは載せない） */
function facilityKey(name) {
  const n = String(name || "").normalize("NFKC").replace(/\s+/g, "");
  return crypto.createHash("sha256").update(n, "utf8").digest("hex").slice(0, 16);
}

/** master/locations から施設トークンに一致する施設を探す（全件を定数時間比較で走査する） */
async function findFacilityByToken(token) {
  const raw = await G.dbGet("master/locations");
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  let found = null;
  for (const f of arr) {
    if (!f || typeof f !== "object" || typeof f.token !== "string" || !f.token) continue;
    if (S.timingSafeEqualStr(f.token, token) && !found) found = f;
  }
  return found;
}

/** JST基準の当日文字列。既存実装（getTodayJSTStr）と同じ判定にそろえる。 */
function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** expiresAt（JSTの日付）の当日末を UNIX 秒で返す。現行の期限仕様をそのままセッション期限にする。 */
function sessionExpiryFor(expiresAt) {
  if (!expiresAt) return null;
  const t = Date.parse(String(expiresAt) + "T23:59:59+09:00");
  return isNaN(t) ? null : Math.floor(t / 1000);
}

/** 現行 index.html の isSafeTokenStr と同じ制約（RTDBキーに使えない文字を弾く）。 */
function safeToken(t) {
  // クライアント側 isSafeTokenStr（1〜64文字）と同じ制約にそろえる。サーバを緩くしない。
  return /^[A-Za-z0-9_-]{1,64}$/.test(t);
}

module.exports = T.handler(async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const kind = H.str(body.kind, 16);
    const token = H.str(body.token, 128);
    const spec = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;

    // ★ 施設端末（kiosk）は新会社だけ。穂乃味では従来どおりレート制限へ触れる前に 401。
    if (!spec || !token || !safeToken(token) || (spec.role === "k" && T.current().legacy)) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    const ipKey = S.sanitizeKey(H.clientIp(req));
    // ★ 検証の前に加算し、その戻り値で判定する（TOCTOU 対策）。
    const [nIp, nAll] = await Promise.all([
      S.bumpAndCount("share_ip", ipKey),
      S.bumpAndCount("share_all", "global"),
    ]);
    if (nIp > HARD_IP) {
      res.setHeader("Retry-After", "300");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }
    const throttleMs = Math.max(S.delayMsFor(nIp, SOFT_IP), S.delayMsFor(nAll, SOFT_ALL));

    // ===== 施設端末（新会社のみ）=====
    if (spec.role === "k") {
      if (T.current().legacy) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      const fac = await findFacilityByToken(token);
      if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
      if (!fac) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      await S.resetCount("share_ip", ipKey)
        .catch(function (e) { console.error("[rate] reset failed", cid, e && e.message); });
      const nowK = Math.floor(Date.now() / 1000);
      const tidK = S.tokenHash(token).slice(0, 16);
      const claimsK = T.decorateClaims({ r: "k", fk: facilityKey(fac.name), at: nowK, cv: 1 }, "k");
      const customTokenK = G.createCustomToken(T.uid("k", tidK), claimsK);
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({
        customToken: customTokenK,
        role: "k",
        sessionExpiresAt: claimsK.sx || null,
      });
    }

    const rec = await G.dbGet(spec.node + "/" + token);
    const today = todayJst();

    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));

    // ★ enabled の判定は現行クライアントと厳密に一致させる。
    //   viewer は index.html が `if(!_vtd||!_vtd.enabled)` ＝ truthy 必須なので、
    //   ここも enabled!==true を拒否にする（!==false だと enabled 欠落レコードを通してしまい、
    //   /honomi/viewerTokens へ書ける者が viewer ロールを取得できる）。
    //   demo / sandbox は現行が enabled===false のみ拒否なのでそれに合わせる。
    const enabledOk = spec.role === "v"
      ? (!!rec && typeof rec === "object" && rec.enabled === true)
      : (!!rec && typeof rec === "object" && rec.enabled !== false);
    if (!enabledOk) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    // 期限判定は現行と同一。requireExpiry の種別は expiresAt 未設定もフェイルクローズ。
    const expired = spec.requireExpiry
      ? (!rec.expiresAt || String(rec.expiresAt) < today)
      : (!!rec.expiresAt && String(rec.expiresAt) < today);
    if (expired) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 410, "expired");
    }

    // デモ画面から発行された閲覧用URLは、発行元デモの有効性に連動させる（現行と同じ）。
    let effectiveExpiry = rec.expiresAt || null;
    let demoIssued = false;
    if (spec.role === "v" && rec.issuedByDemoTokenId) {
      const src = safeToken(String(rec.issuedByDemoTokenId))
        ? await G.dbGet("demoTokens/" + rec.issuedByDemoTokenId)
        : null;
      if (!src || typeof src !== "object" || src.enabled === false) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      if (!src.expiresAt || String(src.expiresAt) < today) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 410, "expired");
      }
      demoIssued = true;
      // 発行元の期限の方が早ければそちらに合わせる
      if (!effectiveExpiry || String(src.expiresAt) < String(effectiveExpiry)) effectiveExpiry = src.expiresAt;
    }

    // ★ share_all（グローバル次元）はリセットしない。全体ブレーキを残す。
    await S.resetCount("share_ip", ipKey)
      .catch(function (e) { console.error("[rate] reset failed", cid, e && e.message); });

    const now = Math.floor(Date.now() / 1000);
    const sx = sessionExpiryFor(effectiveExpiry); // 固定TTLは設けない
    const tokenId = S.tokenHash(token).slice(0, 16); // uid にトークン実値を載せない
    const claims = { r: spec.role, t: tokenId, at: now, cv: 1 };
    if (sx) claims.sx = sx;
    if (spec.role !== "x") claims.ro = true;      // viewer / demo は読み取り専用
    if (demoIssued) claims.di = true;             // デモ発行の閲覧用URL（完全読み取り専用）

    // ★ 穂乃味は従来と同一。新会社は c が付き、uid に会社IDが入る。
    //   sx はトークン自身の期限（expiresAt 当日末）のままとし、新会社でも延ばさない。
    const outClaims = T.decorateClaims(claims, spec.role);
    const customToken = G.createCustomToken(T.uid(spec.role, tokenId), outClaims);

    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({
      customToken: customToken,
      role: spec.role,
      expiresAt: rec.expiresAt || null,
      sessionExpiresAt: typeof outClaims.sx === "number" ? outClaims.sx : null,
    });
  } catch (e) {
    console.error("[auth/share]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
});
