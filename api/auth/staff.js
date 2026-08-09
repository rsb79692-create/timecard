/**
 * POST /api/auth/staff
 *
 * スタッフ名 ＋ PIN → staff 役割の Firebase Custom Token。
 * PIN 照合はサーバ側のみで行い、PIN・ハッシュ・ソルトを一切クライアントへ返さない。
 *
 * 入力  : { idToken: string, staffName: string, pin: string, deviceId?: string }
 * 出力  : { customToken, role:"s" }
 * 失敗  : 401 { error: "invalid_credentials" }
 *
 * ===== 既存仕様の維持（重要）=====
 *  - 施設による打刻制限は行わない。複数施設勤務・応援勤務は現行どおり、
 *    どの施設の端末からでも打刻できる。
 *  - location と施設マスタの一致も要求しない。
 *  - 在籍状態（退職/休職）でも拒否しない。対象の絞り込みは現行どおり
 *    打刻画面のスタッフ一覧（filteredStaff）が行う。
 *  - employeeId は要求しない。スタッフに社員番号を入力させないため、
 *    現行 tc5_pins と同じ「スタッフ名」を鍵にする（保存するのはハッシュのみ）。
 *  - ★ ロックアウトは一切しない。大量失敗時に段階的な遅延を入れるだけで、
 *    正しいPINは必ず通る（打刻不能＝賃金事故を作らない）。
 *  - セッションに業務上の有効期限（15分等）は設けない。現行どおり
 *    Firebase のトークン更新に任せる。
 */
"use strict";

const H = require("../_lib/http");
const G = require("../_lib/google");
const S = require("../_lib/secrets");

const MIN_MS = 120; // タイミング差を潰す下限。画面遷移はブロックしないので体感に影響しない

// 遅延を掛け始める閾値（10分窓）。通常の打ち間違いはここに届かない。
const SOFT_EMPLOYEE = 8;
const SOFT_DEVICE = 25;
const SOFT_IP = 25;
const SOFT_GLOBAL = 60;

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const staffName = H.str(body.staffName, 128);
    const pin = H.str(body.pin, 32);

    // 呼び出し元が正当な Firebase セッションであることは確認する
    // （現行 Rules の auth != null と同じ強さ。ここを緩めない）。
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

    // bootstrap 未完了なら認証を試みない。
    // 全員が失敗してレート制限だけが積み上がり、全リクエストが最大遅延を踏み続けるため。
    if (!(await S.authzReady())) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 503, "not_ready");
    }

    // IP は http.js 側で IPv6 を /64 に丸めてある（アドレス回転による回避を防ぐため）。
    // ★ この経路はハード上限(429)を持たず遅延だけなので、丸めによる巻き添えでも
    //   打刻がロックアウトされることはない。
    // 回転による /ratelimit の増殖はスロット単位のサブツリー回収で防いでいる。
    const deviceId = S.sanitizeKey(H.str(body.deviceId, 64) || "unknown");
    const ipKey = S.sanitizeKey(H.clientIp(req));
    const subject = staffName ? S.subjectKey(staffName) : "";

    // ★ 検証の「前」に加算し、その戻り値で判定する（TOCTOU 対策）。
    //   以前は「読んで判定 → 検証 → 失敗時に加算」だったため、並列リクエストが
    //   全員 count=0 を読んで遅延を素通りできた（4桁PINの並列総当たりが成立していた）。
    //   成功時は subject/device/ip をリセットするので、正規利用者のカウンタは常に 0 近傍に戻る。
    //
    // ★ deviceId はクライアントの自己申告なので、回転させれば無効化できる。
    //   単独では信頼せず、詐称しにくい IP 次元と併用する。
    // ★ グローバル次元(pin_all)だけは「失敗のみ計上・成功でリセットしない」。
    //   全次元を成功でリセットすると、正規利用者の成功が1件あるたびに 0 に戻り、
    //   「誰か1人に入れればよい」攻撃への唯一の全体ブレーキが無力化される。
    const [nSub, nDev, nIp, nAll] = await Promise.all([
      subject ? S.bumpAndCount("pin_sub", subject) : Promise.resolve(0),
      S.bumpAndCount("pin_dev", deviceId),
      S.bumpAndCount("pin_ip", ipKey),
      S.currentCount("pin_all", "global"),
    ]);
    // ★ 429 は返さない。遅延だけ。誰もロックアウトされない（打刻不能を作らない）。
    const throttleMs = Math.max(
      S.delayMsFor(nSub, SOFT_EMPLOYEE, S.MAX_DELAY_BG_MS),
      S.delayMsFor(nDev, SOFT_DEVICE, S.MAX_DELAY_BG_MS),
      S.delayMsFor(nIp, SOFT_IP, S.MAX_DELAY_BG_MS),
      S.delayMsFor(nAll, SOFT_GLOBAL, S.MAX_DELAY_BG_MS)
    );

    // 非実在のスタッフ名でも同じ計算量を通す（実在の推測を防ぐ）
    const rec = subject ? await G.dbGet(S.AUTHZ + "/pins/" + subject) : null;
    const v = pin ? S.verifyPinCompat(pin, rec) : (S.verifyPinCompat("0000", null), { ok: false, upgrade: false });

    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));

    if (!v.ok) {
      // subject/device/ip の加算は検証前に済ませてある（TOCTOU 対策）。
      // グローバル次元は失敗時のみここで計上する。
      await S.bumpAndCount("pin_all", "global")
        .catch(function (e) { console.error("[rate] bump failed", cid, e && e.message); });
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 401, H.INVALID);
    }

    // 成功したら全次元をリセットする。
    // 一部だけ残すと、攻撃者が別次元を積み上げて正規利用者を遅くできてしまう。
    // ★ pin_all はリセットしない（上記のとおり全体ブレーキを残すため）。
    //   施設は共有NATで1つのIPになるため pin_ip は戻す。戻さないと
    //   人数の多い施設が正常利用だけで遅延を踏み続ける。
    await Promise.all([
      S.resetCount("pin_sub", subject),
      S.resetCount("pin_dev", deviceId),
      S.resetCount("pin_ip", ipKey),
    ]).catch(function (e) { console.error("[rate] reset failed", cid, e && e.message); });

    // 現行方式（sha256）で通った場合は、この時点で平文が分かるので
    // scrypt+pepper へ静かに昇格する。利用者の操作は何も変わらない。
    if (v.upgrade) {
      G.dbPut(S.AUTHZ + "/pins/" + subject, S.makePinRecord(pin))
        .catch(function (e) { console.error("[pin upgrade]", cid, e && e.message); });
    }

    const now = Math.floor(Date.now() / 1000);
    const customToken = G.createCustomToken("s:" + subject, { r: "s", at: now, cv: 1 });

    await H.withMinDuration(startedAt, MIN_MS);
    return res.status(200).json({ customToken: customToken, role: "s" });
  } catch (e) {
    console.error("[auth/staff]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
