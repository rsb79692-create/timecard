/**
 * POST /api/auth/pin-set
 *
 * スタッフPINを新認証側（/authz/pins）へ反映する。
 *
 * 入力 :
 *   登録・変更  { idToken, staffName, pin, currentPin? }
 *   改名        { idToken, staffName, renameTo }        … レコードを移送する（削除ではない）
 *
 * 出力 : { ok: true }
 *
 * ===== 認可（ここが本APIの肝）=====
 * FB_API_KEY は公開値なので、誰でも匿名 ID トークンを取得できる。
 * したがって「有効な ID トークン」だけを条件にしてはならない。次の3条件のいずれかを必須にする。
 *   (a) 実在スタッフ かつ /authz にレコード未存在  … 本人の初回PIN登録（現行 sNewOk）
 *   (b) currentPin の照合に成功                    … PIN変更（本人・移行）
 *   (c) 管理者ロール（claims.r === "a"）           … 管理者によるPIN設定・変更・改名
 * 改名は (c) 必須。管理画面でしか発生しない破壊的操作を第三者に開放しない。
 *
 * ★ (a) には「実在スタッフであること」を必ず課す。
 *   subjectKey は任意文字列の SHA-256 なので、実在性を検証しないと
 *   攻撃者が架空の staffName でレコードを作り、そのPINで staff ロールを取得できる。
 *
 * ★ (b) の照合は staff.js と同じ pin_sub / pin_all カウンタを共有する。
 *   別カウンタにすると、staff.js で絞った予算を pin-set 側から回避でき、
 *   subject 次元のない PIN オラクル（403=不一致 / 200=一致）になる。
 *
 * ★ /authz が bootstrap 済みでなければ何もしない（authzReady）。
 *   未投入時は全員が「レコード未存在」になり、実在スタッフのPINを第三者が先に
 *   占有できてしまう。また /authz/pins が生えると bootstrap の --apply が実行不能になる。
 *
 * ===== その他 =====
 *  - 管理者のPIN確認機能を維持するため、平文は AES-256-GCM で暗号化して保持する
 *    （認証用の scrypt+pepper ハッシュとは別フィールドに分離）。
 *  - 現行の tc5_pins への保存はクライアント側で従来どおり行われ、本APIはそれに追随する。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");

const MIN_MS = 120;
const SOFT_SUBJECT = 8;   // staff.js と同じ予算
const SOFT_IP = 30;
const SOFT_GLOBAL = 60;
const HARD_IP = 200;

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const staffName = H.str(body.staffName, 128);
    const pin = H.str(body.pin, 32);
    const currentPin = H.str(body.currentPin, 32);
    const renameTo = H.str(body.renameTo, 128);

    if (!staffName) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    let claims = null;
    try {
      claims = await G.verifyIdToken(H.str(body.idToken, 4096));
    } catch (e) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }
    if (!claims) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }
    const isAdmin = claims.r === "a";

    // ★ 管理者ロールを特権として使う経路は、すべて失効検証を通す。
    //   この API の管理者経路は「任意スタッフのPIN上書き」と「改名」を
    //   現PIN照合なし・レート制限なしで行えるため、失効済みセッションに残すと
    //   管理者URL/PIN を変更しても全スタッフのPINを奪える。
    //   非管理者経路（現PIN照合＋レート制限）はここでは止めない。
    if (isAdmin && !(await S.adminSessionValid(claims))) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "session_revoked");
    }

    // bootstrap 未完了なら一切書かない（/authz を汚さない・占有もさせない）
    if (!(await S.authzReady())) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 503, "not_ready");
    }

    const ipKey = S.sanitizeKey(H.clientIp(req));
    const subject = S.subjectKey(staffName);

    // ---- 改名: レコードを移送する（管理者のみ）----
    // ★ 旧実装は「旧キーを削除するだけ」だったため、平文が分からないスタッフは
    //   新キーが作られず /authz からPINが消えていた。移送に変更して欠落を無くす。
    if (renameTo) {
      if (!isAdmin) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 403, "forbidden");
      }
      const existing = await G.dbGet(S.AUTHZ + "/pins/" + subject);
      if (existing && typeof existing === "object") {
        await G.dbPut(S.AUTHZ + "/pins/" + S.subjectKey(renameTo), existing);
        await G.dbPut(S.AUTHZ + "/pins/" + subject, null);
      }
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({ ok: true });
    }

    // 現行PINは4桁数字。仕様を変えないためそのまま受ける。
    if (!/^\d{4,8}$/.test(pin)) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_request");
    }

    // ---- 管理者は照合不要。レート制限にも掛けない（正規の一括設定を妨げない）----
    if (isAdmin) {
      await G.dbPut(S.AUTHZ + "/pins/" + subject, S.makePinRecord(pin));
      await H.withMinDuration(startedAt, MIN_MS);
      return res.status(200).json({ ok: true });
    }

    // ---- 非管理者。★ 検証の前に加算し、戻り値で判定する（TOCTOU 対策）----
    //   pin_sub / pin_all は staff.js と同じ次元を使い、予算を共有する。
    const [nSub, nIp, nAll] = await Promise.all([
      S.bumpAndCount("pin_sub", subject),
      S.bumpAndCount("pinset_ip", ipKey),
      S.currentCount("pin_all", "global"),
    ]);
    if (nIp > HARD_IP) {
      res.setHeader("Retry-After", "300");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }
    const throttleMs = Math.max(
      S.delayMsFor(nSub, SOFT_SUBJECT),
      S.delayMsFor(nIp, SOFT_IP),
      S.delayMsFor(nAll, SOFT_GLOBAL)
    );

    const existing = await G.dbGet(S.AUTHZ + "/pins/" + subject);
    const hasRecord = !!(existing && typeof existing === "object");

    // (a) 初回登録は「実在スタッフ」に限る。架空の名前でロールを作らせない。
    let allowed = false;
    if (!hasRecord) {
      allowed = await S.staffNameExists(staffName);
      S.verifyPinCompat("0000", null); // 経路による処理時間差を作らない
    } else {
      // (b) 現PIN照合。非実在でも同じ計算量を通す
      allowed = currentPin ? S.verifyPinCompat(currentPin, existing).ok
                           : (S.verifyPinCompat("0000", null), false);
    }

    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));

    if (!allowed) {
      // 失敗はグローバル次元にも計上する（このカウンタは成功でリセットしない）
      await S.bumpAndCount("pin_all", "global")
        .catch(function (e) { console.error("[rate] bump failed", cid, e && e.message); });
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "forbidden");
    }

    await G.dbPut(S.AUTHZ + "/pins/" + subject, S.makePinRecord(pin));
    // 成功したので、この subject の試行カウンタだけ戻す（共有次元は戻さない）
    await S.resetCount("pin_sub", subject).catch(function () {});
    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[auth/pin-set]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
