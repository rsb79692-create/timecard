/**
 * POST /api/auth/admin-token-set
 *
 * 管理者URLトークン（?admin=<token>）を変更する。
 *
 * 入力 : { idToken, adminToken }   … adminToken は英数字と _ - のみ、4〜128文字の生トークン
 * 出力 : { ok: true }
 * 失敗 : 400 bad_request / 401 invalid_credentials / 403 forbidden(session_revoked 含む) /
 *        500 server_error（置換の読み戻し検証に失敗）/ 503 not_ready
 *
 * ===== このAPIが必要な理由 =====
 * 以前はクライアントが config/adminTokenHash へ直接 PUT するだけで、
 * /authz/adminTokens を更新していなかった。そのため管理者URLを変更すると
 *   - 新URL : クライアント側の比較は通るが、サーバ認証（/api/auth/admin）は通らない
 *   - 旧URL : /authz 側に残り続け、サーバから見ると有効なまま
 * という食い違いが残り、さらに bootstrap-authz.js の --purge-legacy-admin が
 * 「復旧経路なし」と判定して中止する状態になっていた。
 *
 * ===== 設計 =====
 *  - ★ 書き手をサーバ1箇所に集約する。クライアントは公開領域へ直接書かない。
 *  - ★ /authz/adminTokens と config/adminTokenHash を1回のマルチパス更新で書く。
 *    2回に分けると片方だけ成功した時点で上記の食い違いが再発する。
 *  - ★ /authz/adminTokens は「パスごと置換」する。これにより旧トークンは
 *    同じ1回の更新で無効になる（消し忘れが原理的に起きない）。
 *  - ★ 旧平文 config/adminToken も同じ更新で削除する（現行UIと同じ挙動）。
 *  - 管理者ロール（claims.r === "a"）必須。トークン変更は管理画面からしか行えない。
 *  - 施設トークン・QRコード・スタッフPIN・管理者PIN には一切触れない。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");

const MIN_MS = 150;

/**
 * ★ URL セーフな文字だけを許可する（既存の isSafeTokenStr / share.js の safeToken と同じ集合）。
 *   制御文字だけを弾く方式では、"+" や "&" "#" "%" や不可視文字を含むトークンを保存できてしまう。
 *   それらは ?admin=<token> を URLSearchParams が復号した時点で別の文字列になるため、
 *   保存直後から一致しなくなる。旧トークンは同じ更新で失効済みなので、
 *   管理者URLでの入場手段を恒久的に失う（自己ロックアウト）。
 */
const SAFE_TOKEN = /^[A-Za-z0-9_-]{4,128}$/;

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const adminToken = H.str(body.adminToken, 128);

    if (!SAFE_TOKEN.test(adminToken)) {
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

    // ★ 失効済みの管理者セッションからの操作を拒否する。
    //   管理者URLが漏れて第三者が一度入ると、その端末は refresh token を持ち続け、
    //   トークンを変更しても admin ロールのIDトークンを取り直せてしまう。
    //   rotate 時刻より前に発行されたセッションは、ここで締め出す。
    if (!(await S.adminSessionValid(claims))) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "session_revoked");
    }

    // 現行アプリと同じ sha256("honomi_pin_v1:"+token)。
    const h = S.legacyHash(adminToken);
    const prefix = G.dataPathPrefix();
    const now = Math.floor(Date.now() / 1000);

    // ★ 1回のマルチパス更新。部分適用が起きない。
    //   - authz/adminTokens : パスごと置換＝旧トークンは同じ更新で失効
    //   - authz/adminMinAt  : これより前に発行された admin セッションを失効させる
    //   - config/adminTokenSet : 管理画面の「設定済み」表示用（真偽値。秘密ではない）
    //   - config/adminTokenHash / adminToken : ★公開領域から削除する
    //     非ソルトSHA-256は誰でも読めて総当たりで平文へ戻せるため、
    //     残すと「復元したトークンが /api/auth/admin にそのまま通る」状態が続く。
    await G.dbPatchRoot({
      "authz/adminTokens": { [h]: { enabled: true } },
      "authz/adminMinAt": now,
      [prefix + "/config/adminTokenSet"]: true,
      [prefix + "/config/adminTokenHash"]: null,
      [prefix + "/config/adminToken"]: null,
    });

    // ★ 書き込み後に読み戻して「旧トークンが本当に消えたか」を確認する。
    //   ここを省くと、置換がマージに化けた場合でも 200 を返し、UI は
    //   「以前のURLは使えなくなります」と表示する。管理者は失効したと信じるのに
    //   旧URLで入れ続ける、という静かな破綻になる。
    const after = await G.dbGet(S.AUTHZ + "/adminTokens");
    const keys = after && typeof after === "object" ? Object.keys(after) : [];
    if (keys.length !== 1 || keys[0] !== h) {
      console.error("[auth/admin-token-set] replace verification failed", cid, "keys=" + keys.length);
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 500, "server_error");
    }

    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[auth/admin-token-set]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
