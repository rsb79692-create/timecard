/**
 * POST /api/auth/admin-pin-set
 *
 * 管理者PINを新認証基盤（/authz/adminPin）へ設定・変更する。
 *
 * 入力 : { idToken, pin }   … pin は現行仕様どおり数字8桁
 *        { idToken, pin, scope:"system", currentPin }     … システム管理者PIN（未設定なら穂乃味の管理者がいまの管理者PINで初回設定。
 *                                                          設定済みなら sa のセッションがいまのシステム管理者PINで変更）
 *        { idToken, pin, scope:"tenantAdmin", target }    … 他社の管理者PIN（システム管理者のみ）
 * 出力 : { ok: true }
 * 失敗 : 401 invalid_credentials / 403 forbidden / 503 not_ready
 *
 * ===== 設計 =====
 *  - ★ 管理者ロール（claims.r === "a"）を必須にする。管理者PINの変更は
 *    管理画面からしか行えず、そこへ入るには既に管理者認証を通っている。
 *  - ★ 保管は scrypt + pepper。確認用の平文は AES-256-GCM で別フィールドに分離する。
 *    公開領域（/honomi/config/adminPinHash）には二度と書かない。
 *  - ★ 旧 config/adminPinHash は本APIから読まないし書かない。
 *    認証判定に公開領域の非ソルトSHA-256を使う経路を完全に断つ。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");
const T = require("../_lib/tenant");

const MIN_MS = 150;
// システム管理者PINの初回設定で、現在の管理者PINを照合するときのレート制限。
// ★ api/auth/admin.js の管理者ログインと同じ値・同じ枠（admin_ip / admin_all）にする。
const SOFT_IP = 8;
const SOFT_ALL = 40;
const HARD_IP = 40;
const HARD_ALL = 600;
const HARD_IP_UNDER_GLOBAL = 12;

module.exports = T.handler(async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const pin = H.str(body.pin, 32);

    // ★ 未知の scope を既定（自社の管理者PINの変更）へ落とさない。綴り誤りで別の PIN を書き換えないため。
    if (body.scope !== undefined && body.scope !== "system" && body.scope !== "tenantAdmin") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_request");
    }
    // 現行仕様どおり数字8桁。DB へ触る前に形式で落とす。
    if (!/^\d{8}$/.test(pin)) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_request");
    }

    let claims = null;
    try {
      claims = await G.verifyIdToken(H.str(body.idToken, 4096));
    } catch (e) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }
    if (!claims || claims.r !== "a") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "forbidden");
    }

    if (!(await S.authzReady())) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 503, "not_ready");
    }

    // ★ 管理者トークンの rotate より前に発行されたセッションを締め出す。
    //   これが無いと、漏えいした旧管理者URLで入った第三者が、URL変更後も
    //   管理者PINを書き換えて正規管理者を締め出せる。
    if (!(await S.adminSessionValid(claims))) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "session_revoked");
    }

    // ★ PIN変更も rotate イベントとして扱い、これ以前に発行された管理者セッションを失効させる。
    //   これが無いと、旧PINで入った第三者のセッションが生き残り、
    //   変更した直後にPINを奪い返せる（＝漏えい時にPIN変更が対策にならない）。
    //   /authz/adminPin と /authz/adminMinAt を1回のマルチパス更新で書き、
    //   「PINは変わったが失効していない」中間状態を作らない。
    //   ★ 操作中の管理者自身も失効対象になるため、クライアントは成功後に
    //     新しいPINでセッションを張り直す（自己ロックアウト回避）。
    // ===== システム管理者PINの変更（scope:"system"）=====
    // ★ sa クレームを持つセッションだけ。保存先は穂乃味（システム会社）の /authz。
    //   会社管理者PINとは別の値で、変更すると全社のシステム管理者セッションが失効する。
    if (body.scope === "system" && claims.sa !== true) {
      // ===== システム管理者PINの初回設定 =====
      // ★ 未設定のときに限り、穂乃味（システム会社）の管理者セッションが設定できる。
      //   鍵（pepper・暗号鍵）はサーバにしか無いので、初回もサーバ経由でしか作れない。
      // ★ 「無ければ書く」は条件付き書き込み（if-match: null_etag）の1回で行う。
      //   読んでから書くと、同時に来た2件が両方とも「未設定」を見て上書きし合う。
      // ★ 設定済みなら 409。以後の変更は sa を持つセッション（システム管理者PINで入った人）だけ。
      // ★ 現在の穂乃味の管理者PIN（currentPin）の再入力を必須にする。管理者URLだけを知る人
      //   （URL の漏えい）が先に設定して全社の管理権限を取り、正規の管理者が取り消せなくなるのを防ぐ。
      //   照合は管理者ログインと同じレート制限の枠（admin_ip / admin_all）を使う（総当たりの窓口を増やさない）。
      if (!T.current().system) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 403, "forbidden");
      }
      const currentPin = H.str(body.currentPin, 32);
      if (!/^\d{8}$/.test(currentPin)) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      const ipKey = S.sanitizeKey(H.clientIp(req));
      const [nIp, nAll] = await Promise.all([
        S.bumpAndCount("admin_ip", ipKey),
        S.bumpAndCount("admin_all", "global"),
      ]);
      if (nIp > HARD_IP || (nAll > HARD_ALL && nIp > HARD_IP_UNDER_GLOBAL)) {
        res.setHeader("Retry-After", "300");
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 429, "rate_limited");
      }
      const adminRec = await G.dbGet(S.AUTHZ + "/adminPin");
      const cur = S.verifyPinCompat(currentPin, adminRec && typeof adminRec === "object" ? adminRec : null);
      // ログインと同じく、失敗が重なるほど応答を遅らせる（上限に達するまでの速さを揃える）
      const throttleMs = Math.max(S.delayMsFor(nIp, SOFT_IP), S.delayMsFor(nAll, SOFT_ALL));
      if (throttleMs) await new Promise(function (r) { setTimeout(r, throttleMs); });
      if (!cur.ok) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      // 会社管理者PINと同じ値にしない（知る人を分けるため）
      // ★ 回数制限のリセットは書き込みの成功後に行う（拒否された試行で自分の回数を消させない）
      if (currentPin === pin) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_admin_pin");
      }
      const rec = S.makePinRecord(pin);
      // 誰が初回設定したかを残す（値は含めない）。照合は dk / salt だけを見るので影響しない。
      rec.setBy = { sub: String(claims.sub || "").slice(0, 64), at: typeof claims.at === "number" ? claims.at : 0, via: "initial" };
      const created = await G.dbPutIfAbsent(S.AUTHZ + "/systemAdminPin", rec);
      if (!created) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 409, "already_set");
      }
      await S.resetCount("admin_ip", ipKey).catch(function () {});
      console.log("[auth/admin-pin-set] system admin pin initialized by=" + String(claims.sub || "").slice(0, 64)
        + " at=" + (typeof claims.at === "number" ? claims.at : 0) + " cid=" + cid);
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({ ok: true });
    }

    // ===== 他社の管理者PINの設定（システム管理者のみ）=====
    // ★ 穂乃味側のシステム管理者セッション（sa:true）から、対象会社の /srv/<会社>/authz/adminPin を書く。
    //   停止中の会社は入口（T.handler）で全 API が止まるため、その会社のセッションからは設定できない。
    //   PIN の値はサーバ（pepper・暗号鍵）でだけ作る。
    // ★ 対象会社の認証の準備（/srv/<会社>/authz/_meta）が無ければ 503（勝手に作らない）。
    // ★ 変更時刻を adminMinAt に書き、それ以前のその会社の管理者セッションを失効させる。
    if (body.scope === "tenantAdmin") {
      const target = T.get(H.str(body.target, 32));
      if (claims.sa !== true || !T.current().system) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 403, "forbidden");
      }
      if (!target || target.system) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "bad_request");
      }
      // 知る人を分けるため、システム管理者PIN・穂乃味の管理者PINと同じ値にしない
      const [sysRec, hoRec] = await Promise.all([
        G.dbGet(S.AUTHZ + "/systemAdminPin"),
        G.dbGet(S.AUTHZ + "/adminPin"),
      ]);
      if (sysRec && typeof sysRec === "object" && S.verifyPinCompat(pin, sysRec).ok) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_system_pin");
      }
      if (hoRec && typeof hoRec === "object" && S.verifyPinCompat(pin, hoRec).ok) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_admin_pin");
      }
      const result = await T.run(target.id, async function () {
        if (!(await S.authzReady())) return "not_ready";
        await G.dbPatchRoot({
          "authz/adminPin": S.makePinRecord(pin),
          "authz/adminMinAt": Math.floor(Date.now() / 1000),
        });
        return "ok";
      });
      if (result !== "ok") {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 503, "not_ready");
      }
      console.log("[auth/admin-pin-set] tenant admin pin set by system admin tenant=" + target.id + " cid=" + cid);
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({ ok: true });
    }

    if (body.scope === "system") {
      // ===== システム管理者PINの変更（sa を持つセッション）=====
      // ★ いまのシステム管理者PIN（currentPin）の再入力を必須にする（開いたままの画面を他人に使われても変えられない）。
      //   照合は管理者ログインと同じレート制限の枠（admin_ip / admin_all。穂乃味のコンテキストで数える）。
      // ★ 穂乃味の管理者PIN・各社の管理者PINと同じ値は拒否（知る人を分ける）。
      // ★ systemAdminMinAt を進め、変更前に発行された全社のシステム管理者セッションを失効させる。
      const currentPin = H.str(body.currentPin, 32);
      if (!/^\d{8}$/.test(currentPin)) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 401, H.INVALID);
      }
      const ipKey = S.sanitizeKey(H.clientIp(req));
      const verdict = await T.run("honomi", async function () {
        const [nIp, nAll] = await Promise.all([
          S.bumpAndCount("admin_ip", ipKey),
          S.bumpAndCount("admin_all", "global"),
        ]);
        if (nIp > HARD_IP || (nAll > HARD_ALL && nIp > HARD_IP_UNDER_GLOBAL)) return { limited: true };
        const [sysRec, hoRec] = await Promise.all([
          G.dbGet(S.AUTHZ + "/systemAdminPin"),
          G.dbGet(S.AUTHZ + "/adminPin"),
        ]);
        const cur = S.verifyPinCompat(currentPin, sysRec && typeof sysRec === "object" && sysRec.dk ? sysRec : null);
        const throttleMs = Math.max(S.delayMsFor(nIp, SOFT_IP), S.delayMsFor(nAll, SOFT_ALL));
        if (throttleMs) await new Promise(function (r) { setTimeout(r, throttleMs); });
        if (!cur.ok) return { ok: false };
        // ★ 回数制限のリセットは書き込みの成功後（下）。同値で拒否された試行では回数を消さない
        if (hoRec && typeof hoRec === "object" && S.verifyPinCompat(pin, hoRec).ok) return { ok: true, same: "same_as_admin_pin" };
        return { ok: true };
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
      if (verdict.same) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, verdict.same);
      }
      // 各社（システム会社以外）の管理者PINと同じ値にしない
      const others = T.list().filter(function (t) { return !t.system; });
      const recs = await Promise.all(others.map(function (t) {
        return T.run(t.id, function () { return G.dbGet(S.AUTHZ + "/adminPin"); });
      }));
      if (recs.some(function (r) { return r && typeof r === "object" && S.verifyPinCompat(pin, r).ok; })) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_company_pin");
      }
      if (currentPin === pin) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_current");
      }
      const rec = S.makePinRecord(pin);
      rec.setBy = { sub: String(claims.sub || "").slice(0, 64), at: typeof claims.at === "number" ? claims.at : 0, via: "change" };
      await T.run("honomi", function () {
        return G.dbPatchRoot({
          "authz/systemAdminPin": rec,
          "authz/systemAdminMinAt": Math.floor(Date.now() / 1000),
        });
      });
      await T.run("honomi", function () { return S.resetCount("admin_ip", ipKey); }).catch(function () {});
      console.log("[auth/admin-pin-set] system admin pin changed by=" + String(claims.sub || "").slice(0, 64) + " cid=" + cid);
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({ ok: true });
    }

    // ★ システム管理者でログイン中（sa）は、この会社の管理者PINをシステム管理者PINと同じ値にしない
    //   （同じ画面に両方の欄が並ぶため、取り違えで「知る人を分ける」が崩れないように）。
    //   sa の無い通常の管理者には照合しない（レート制限の無いこの経路をシステム管理者PINの当て先にしない）。
    if (claims.sa === true) {
      const sysRec = await T.run("honomi", function () { return G.dbGet(S.AUTHZ + "/systemAdminPin"); });
      if (sysRec && typeof sysRec === "object" && S.verifyPinCompat(pin, sysRec).ok) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 400, "same_as_system_pin");
      }
    }
    await G.dbPatchRoot({
      "authz/adminPin": S.makePinRecord(pin),
      "authz/adminMinAt": Math.floor(Date.now() / 1000),
    });
    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[auth/admin-pin-set]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
});
