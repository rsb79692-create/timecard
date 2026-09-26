/**
 * POST /api/auth/admin
 *
 * 管理者PIN または 管理者URLトークン → admin 役割の Custom Token。
 * 照合はサーバ側のみ。ハッシュ・ソルト・平文をクライアントへ配信しない。
 *
 * 入力  : { pin: string }  または  { adminToken: string }
 * 出力  : { customToken, role:"a" }
 * 失敗  : 401 { error: "invalid_credentials" } / 429 { error: "rate_limited" }
 *
 * ===== 既存仕様の維持（重要）=====
 *  - ★ 現在の管理者PINをそのまま使う。再設定は不要。
 *    /authz/adminPin には現行の sha256("honomi_pin_v1:"+PIN) をそのまま持ち込み、
 *    初回の認証成功時に scrypt+pepper へ自動昇格する。
 *  - ★ 現在の管理者URLをそのまま使う。URL変更・再発行は不要。
 *    /authz/adminTokens のキーは現行 config/adminTokenHash の値そのもの。
 *  - セッションに 8 時間等の固定期限は設けない。現行どおり Firebase のトークン更新に任せる。
 *
 * レート制限は IP とグローバルのみ。
 * ★ グローバル次元「だけ」を根拠に 429 を返してはならない。
 *   admin_all は誰でも未認証で加算でき、成功でリセットもしないため、
 *   約1req/s を送り続けるだけで正規管理者のログインを無期限に封鎖できてしまう。
 *   そこで 429 は「そのIP自身も試行を重ねている」場合に限定する。
 *   攻撃者はIPを回転できても被害者のIPのカウンタは増やせないので、締め出しは成立しない。
 *   分散総当たり側はグローバル過熱時に 1IP あたりの許容が縮むため、むしろ強くなる。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");
const T = require("../_lib/tenant");

const MIN_MS = 200;
const SOFT_IP = 8;
const SOFT_ALL = 40;
const HARD_IP = 40;    // ここを超えたら明確な総当たり。429 を返す
// ★ IP を回転されると per-IP 上限は無効化される。分散総当たりを止める最後の砦として
//   グローバルにも上限を置く。正規の管理者ログインでは到達しない水準にする。
const HARD_ALL = 600;
// グローバル過熱時に適用する、IPあたりの厳しい上限
const HARD_IP_UNDER_GLOBAL = 12;

module.exports = T.handler(async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    // ===== システム管理者（穂乃味）による会社の管理 =====
    // ★ ログインとは別の操作。sa クレームを持つ管理者トークンが必須。
    if (body.op !== undefined) {
      return await handleTenantOp(req, res, body, startedAt, cid);
    }
    // ===== システム管理者ログイン（scope:"system"）=====
    // 資格情報は穂乃味の /authz/systemAdminPin（会社管理者PINとは別）。
    // 発行するトークンは「対象会社（body.tenant）の管理者」＋ sa:true。
    // ★ 会社管理者PINでは sa は付かない＝穂乃味の一般管理者は他社へ入れない。
    if (body.scope === "system") {
      return await handleSystemLogin(req, res, body, startedAt, cid);
    }
    const pin = H.str(body.pin, 32);
    const adminToken = H.str(body.adminToken, 128);

    // ★ DB へ触る前に形式で落とす。未認証で到達できる経路なので、
    //   明らかに不正な入力で RTDB 操作を増幅させない（可用性の保護）。
    //   管理者PINは現行仕様どおり数字8桁、URLトークンは4文字以上。
    if (!adminToken && !/^\d{4,8}$/.test(pin)) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }
    if (adminToken && adminToken.length < 4) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    // ★ bootstrap 未完了を「PINが違います」に化けさせない。
    //   /authz/adminPin が無いと verifyPinCompat は必ず false になり、
    //   移行直後に最も起きやすい障害が最も誤解を招く表示になってしまう。
    if (!(await S.authzReady())) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 503, "not_ready");
    }

    const ipKey = S.sanitizeKey(H.clientIp(req));
    // ★ 検証の前に加算し、その戻り値で判定する（TOCTOU 対策）。
    //   並列リクエストが全員 count=0 を読んで上限を素通りするのを防ぐ。
    const [nIp, nAll] = await Promise.all([
      S.bumpAndCount("admin_ip", ipKey),
      S.bumpAndCount("admin_all", "global"),
    ]);
    if (nIp > HARD_IP || (nAll > HARD_ALL && nIp > HARD_IP_UNDER_GLOBAL)) {
      res.setHeader("Retry-After", "300");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }
    const throttleMs = Math.max(S.delayMsFor(nIp, SOFT_IP), S.delayMsFor(nAll, SOFT_ALL));

    let ok = false;
    let upgrade = false;
    if (adminToken) {
      // ★ 現行アプリと同じ sha256("honomi_pin_v1:"+token) をキーにするので、
      //   いま配布済みの管理者URLがそのまま通る。
      const rec = await G.dbGet(S.AUTHZ + "/adminTokens/" + S.legacyHash(adminToken));
      // ★ フェイルクローズ。オブジェクトかつ enabled===true のときだけ通す
      //   （rec===true のようなスカラーを通さない）。
      ok = !!(rec && typeof rec === "object" && rec.enabled === true);
    } else {
      const rec = await G.dbGet(S.AUTHZ + "/adminPin");
      // ★ レコード自体が無い＝移行されていない状態を「PINが違います」にしない。
      //   その表示は再試行を誘発し、admin_ip カウンタを押し上げて
      //   唯一の復旧経路（?admin= の昇格）まで 429 で塞いでしまう。
      if (!rec || typeof rec !== "object") {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 503, "not_ready");
      }
      const v = pin ? S.verifyPinCompat(pin, rec) : (S.verifyPinCompat("00000000", null), { ok: false, upgrade: false });
      ok = v.ok;
      upgrade = v.upgrade;
    }

    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));

    if (!ok) {
      // 加算は検証前に済ませてある（TOCTOU 対策）。
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    // ★ admin_all（グローバル次元）はリセットしない。正規の管理者ログイン1件で
    //   全体ブレーキが解除されると、分散総当たりへの対策として機能しなくなる。
    await S.resetCount("admin_ip", ipKey)
      .catch(function (e) { console.error("[rate] reset failed", cid, e && e.message); });

    // 現行方式で通った＝この時点で平文が分かるので scrypt+pepper へ昇格する。
    // 管理者の操作・PINの値は何も変わらない。
    if (upgrade) {
      G.dbPut(S.AUTHZ + "/adminPin", S.makePinRecord(pin))
        .catch(function (e) { console.error("[adminPin upgrade]", cid, e && e.message); });
    }

    const now = Math.floor(Date.now() / 1000);
    // ★ 穂乃味は従来と同一（uid "a:main"・クレーム {r,at,cv}）。新会社だけ c と sx が付く。
    const customToken = G.createCustomToken(T.uid("a", "main"), T.decorateClaims({ r: "a", at: now, cv: 1 }, "a"));

    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ customToken: customToken, role: "a" });
  } catch (e) {
    console.error("[auth/admin]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
});

/**
 * システム管理者ログイン。
 * PIN の照合とレート制限は穂乃味（システム会社）のコンテキストで行い、
 * トークンは対象会社のコンテキストで発行する。
 */
async function handleSystemLogin(req, res, body, startedAt, cid) {
  const target = T.current();
  const pin = H.str(body.pin, 32);
  if (!/^\d{8}$/.test(pin)) {
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 401, H.INVALID);
  }
  const ipKey = S.sanitizeKey(H.clientIp(req));
  const verdict = await T.run("honomi", async function () {
    // ★ 穂乃味の管理者ログインと同じ枠（admin_ip / admin_all）を使う。
    //   別枠にすると、穂乃味の管理者権限への総当たりの実効速度が2倍になる。
    const [nIp, nAll] = await Promise.all([
      S.bumpAndCount("admin_ip", ipKey),
      S.bumpAndCount("admin_all", "global"),
    ]);
    if (nIp > HARD_IP || (nAll > HARD_ALL && nIp > HARD_IP_UNDER_GLOBAL)) return { limited: true };
    const throttleMs = Math.max(S.delayMsFor(nIp, SOFT_IP), S.delayMsFor(nAll, SOFT_ALL));
    const rec = await G.dbGet(S.AUTHZ + "/systemAdminPin");
    // ★ レコードが無い（未設定）ときも同じ計算量を通して 401。システム管理者は存在しないものとして扱う。
    const v = S.verifyPinCompat(pin, rec && typeof rec === "object" && rec.dk ? rec : null);
    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    if (v.ok) await S.resetCount("admin_ip", ipKey).catch(function () {});
    return { ok: v.ok };
  });
  if (verdict.limited) {
    res.setHeader("Retry-After", "300");
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 429, "rate_limited");
  }
  if (!verdict.ok) {
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 401, H.INVALID);
  }
  // 監査用（値は出さない）。どの会社へシステム管理者として入ったかを残す。
  console.log("[auth/admin] system admin login tenant=" + target.id + " cid=" + cid);
  const now = Math.floor(Date.now() / 1000);
  const customToken = G.createCustomToken(T.uid("a", "sys"),
    T.decorateClaims({ r: "a", at: now, cv: 1, sa: true }, "a"));
  await H.withMinDuration(startedAt, MIN_MS);
  return res.status(200).json({ customToken: customToken, role: "a", system: true, tenant: target.id });
}

/**
 * 会社の一覧・利用停止（システム管理者のみ）。
 *   { op:"tenants", idToken }                      → { tenants:[{id,displayName,system,active}] }
 *   { op:"tenantSetActive", idToken, target, active } → { ok:true }
 * ★ 穂乃味（システム会社）は停止できない。
 */
async function handleTenantOp(req, res, body, startedAt, cid) {
  let claims = null;
  try {
    claims = await G.verifyIdToken(H.str(body.idToken, 4096));
  } catch (e) {
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 401, H.INVALID);
  }
  if (!claims || claims.r !== "a" || claims.sa !== true) {
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 403, "forbidden");
  }
  if (!(await S.adminSessionValid(claims))) {
    await H.withMinDuration(startedAt, MIN_MS);
    return H.fail(res, 403, "session_revoked");
  }
  if (body.op === "tenants") {
    const reg = await G.tenantRegAll();
    const out = T.list().map(function (t) {
      const r = reg && typeof reg[t.id] === "object" && reg[t.id] ? reg[t.id] : {};
      return { id: t.id, displayName: t.displayName, system: !!t.system, active: t.system ? true : r.active === true };
    });
    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ tenants: out });
  }
  if (body.op === "tenantSetActive") {
    const target = T.get(H.str(body.target, 32));
    if (!target || target.system || typeof body.active !== "boolean") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_request");
    }
    await G.tenantRegSetActive(target.id, body.active, T.current().id + ":sys");
    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ ok: true });
  }
  await H.withMinDuration(startedAt, MIN_MS);
  return H.fail(res, 400, "bad_request");
}
