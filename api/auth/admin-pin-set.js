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

    await G.dbPut(S.AUTHZ + "/adminPin", S.makePinRecord(pin));
    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[auth/admin-pin-set]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
