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

const MIN_MS = 200;
const SOFT_IP = 8;
const SOFT_ALL = 40;
const HARD_IP = 40;    // ここを超えたら明確な総当たり。429 を返す
// ★ IP を回転されると per-IP 上限は無効化される。分散総当たりを止める最後の砦として
//   グローバルにも上限を置く。正規の管理者ログインでは到達しない水準にする。
const HARD_ALL = 600;
// グローバル過熱時に適用する、IPあたりの厳しい上限
const HARD_IP_UNDER_GLOBAL = 12;

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
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
    const customToken = G.createCustomToken("a:main", { r: "a", at: now, cv: 1 });

    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ customToken: customToken, role: "a" });
  } catch (e) {
    console.error("[auth/admin]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
