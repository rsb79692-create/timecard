/**
 * POST /api/auth/admin-pin-set
 *
 * 管理者PINを新認証基盤（/authz/adminPin）へ設定・変更する。
 *
 * 入力 : { idToken, pin }   … pin は現行仕様どおり数字8桁
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

const MIN_MS = 150;

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const pin = H.str(body.pin, 32);

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
};
