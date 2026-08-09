#!/usr/bin/env node
/**
 * scripts/bootstrap-authz.js — 新認証の初期データ投入
 *
 * RTDB の /authz 配下に、サーバ専用の認証マテリアルを作る。
 *   /authz/pins/<sha256(スタッフ名)>  → { salt, dk, plainEnc, updatedAt } または { legacy }
 *   /authz/adminPin                   → { salt, dk, plainEnc, updatedAt }（legacy は書かない）
 *   /authz/adminTokens/<現行ハッシュ> → { enabled }
 *   /authz/_meta                      → { createdAt, version, counts, planHash }
 *
 * 【現行の操作・運用を一切変えない設計】
 *  - ★ 施設トークンは扱わない。起動時のサーバ認証を行わないため、
 *    **現在の全施設の打刻URL・QRコード・端末設定はそのまま**で移行できる。
 *  - ★ 管理者PINは平文を復元して scrypt+pepper で保管する。
 *    公開領域(/honomi/config/adminPinHash)の非ソルトSHA-256を認証に使う経路を断つため、
 *    /authz へ legacy ハッシュを持ち込まない。**現在のPINはそのまま使える。**
 *    復元は config/adminPin(旧平文) があればそれを使い、無ければ4〜8桁を全探索する（数分）。
 *    ★ 復元できなかった場合と、復元できても8桁未満だった場合は adminPin を作らず
 *      「再設定が必要」と報告する（8桁未満は安全に移行できないため。--allow-short-admin-pin で上書き可）。
 *    ★ 管理者PINも管理者URLも /authz に入らない場合、--apply は既定で中止する
 *      （--allow-no-admin-credential で上書き可）。
 *  - ★ 管理者URLトークンは現行の sha256("honomi_pin_v1:"+値) をそのまま持ち込む（URL不変）。
 *  - ★ スタッフPINは現行 tc5_pins と同じ「スタッフ名」を鍵にする。
 *    employeeId は未設定・重複が実在するため、認証の必須条件にしない。
 *  - 平文が分かるものは scrypt+pepper ＋ 暗号化平文で保存し、
 *    分からないものは現行ハッシュ（legacy）のまま置く。legacy は初回の認証成功時に
 *    サーバ側が自動で scrypt+pepper へ昇格する（利用者の操作は変わらない）。
 *  - 施設・在籍状態による打刻制限は作らない（staffMeta を作らない）。
 *
 * 【安全設計】
 *  - 既定は dry-run。書き込みは --apply を明示したときだけ。
 *  - /authz 以外へ一切書き込まない。/honomi は読むだけで変更しない。
 *    唯一の例外が --purge-legacy-admin で、これは公開領域の管理者資格情報
 *      config/adminPinHash / config/adminPin / config/adminTokenHash / config/adminToken
 *    を削除し、表示用の config/adminTokenSet=true だけを書く（単一 PATCH）。
 *    いずれも非ソルトSHA-256または平文で、誰でも読めて総当たりで復元でき、
 *    復元値はサーバ認証（/api/auth/admin）にそのまま通るため残置できない。
 *    /authz/adminPin の存在と照合可否を確認してからでないと実行しない。
 *  - 既存 /authz があれば無条件停止（上書きしない）。
 *  - 書き込みは /authz への単一 PUT（RTDB のサブツリー PUT は原子的）。
 *  - PIN・pepper・暗号鍵・サービスアカウント鍵・トークン実値をログへ出さない。
 *
 * 【実行】
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
 *   $env:FIREBASE_DATABASE_URL="https://<project>.firebaseio.com/honomi"
 *   $env:TC_PIN_PEPPER="<Vercelと同一の値>"
 *   $env:TC_ENC_KEY="<Vercelと同一の値>"
 *   node scripts/bootstrap-authz.js            # dry-run
 *   node scripts/bootstrap-authz.js --apply    # 投入
 *
 *   # 投入後、本番で管理者PINログインを実測してから、公開領域の旧ハッシュを削除する
 *   # （破壊的・復元不能・要ユーザー判断。単独モードなので /authz には触れない）
 *   node scripts/bootstrap-authz.js --purge-legacy-admin                          # dry-run
 *   node scripts/bootstrap-authz.js --apply --purge-legacy-admin --verified-production-login
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APPLY = process.argv.includes("--apply");
// ★ 公開領域に残る旧管理者PINハッシュの削除。破壊的操作なので明示フラグ必須。
//   /honomi/config/adminPinHash は誰でも読める非ソルトSHA-256で、数分で平文を復元できる。
//   /authz へ移行しても、この値が残っている限り「復元したPINが新APIにそのまま通る」ため、
//   削除するまで移行は完了しない。
const PURGE_LEGACY_ADMIN = process.argv.includes("--purge-legacy-admin");
// ★ 8桁未満の管理者PINをそのまま移行することを明示的に許可する（非推奨）。
//   既定では移行せず「再設定が必要」と報告する。
const ALLOW_SHORT_ADMIN_PIN = process.argv.includes("--allow-short-admin-pin");
// ★ 管理者の資格情報（PIN・URL）が /authz に1件も入らない状態での投入を許可する。
//   既定では中止する。purge 側の --allow-no-admin-url と対になるガード。
const ALLOW_NO_ADMIN_CREDENTIAL = process.argv.includes("--allow-no-admin-credential");

// ---- サービスアカウントの読み込み（ファイルパス or 環境変数のJSON）----
(function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) return;
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  if (!p) {
    console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS か FIREBASE_SERVICE_ACCOUNT_KEY が必要です");
    process.exit(1);
  }
  if (!fs.existsSync(p)) {
    console.error("ERROR: 指定された鍵ファイルが見つかりません");
    process.exit(1);
  }
  // 内容はここでしか触らず、ログには一切出さない
  process.env.FIREBASE_SERVICE_ACCOUNT_KEY = fs.readFileSync(p, "utf8");
})();

const G = require(path.join(__dirname, "..", "api", "_lib", "google.js"));
const S = require(path.join(__dirname, "..", "api", "_lib", "secrets.js"));

function stableStringify(o) {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}
/** 値（秘密）を含めず、キー構造だけで計画の同一性を判定する */
function planFingerprint(plan) {
  const shape = {};
  for (const node of Object.keys(plan).sort()) {
    const v = plan[node];
    shape[node] = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : typeof v;
  }
  return crypto.createHash("sha256").update(stableStringify(shape)).digest("hex").slice(0, 16);
}

const isSha256 = (v) => /^[0-9a-f]{64}$/i.test(String(v || ""));

/**
 * 現行8桁PINの平文を sha256("honomi_pin_v1:"+PIN) から復元する。
 * ★ この総当たりが数分で終わること自体が、公開領域に置かれた現行ハッシュの
 *   危険性の実証である。だからこそ /authz には legacy を持ち込まない。
 */
function recoverAdminPin(hash) {
  const target = String(hash).toLowerCase();
  const prefix = Buffer.from("honomi_pin_v1:", "utf8");
  // ★ 桁数は 4〜8 を探索する。現行UIの「→」ボタンは8桁未満でも送信でき、
  //   4〜7桁の管理者PINが現存しうるため、8桁固定だと復元不能と誤判定する。
  for (let digits = 4; digits <= 8; digits++) {
    const max = Math.pow(10, digits);
    if (digits === 8) console.log("    …8桁の探索を開始します（数分かかります）");
    for (let i = 0; i < max; i++) {
      if (digits === 8 && i && i % 10000000 === 0) console.log("      …" + i / 1000000 + "M / 100M");
      const s = String(i).padStart(digits, "0");
      const h = crypto.createHash("sha256").update(Buffer.concat([prefix, Buffer.from(s, "utf8")])).digest("hex");
      if (h === target) return s;
    }
  }
  return null;
}


/**
 * 公開領域に残る旧管理者PIN資格情報を削除する（単独モード）。
 *
 * ★ /authz の投入とは独立して実行できるようにしてある。
 *   そうしないと「apply → 本番で管理者PINログインを実測 → その後 purge」という
 *   唯一安全な順序が取れない（apply は既存 /authz があると停止するため）。
 *
 * ★ 削除は復元不能で、RTDB に undelete は無い。以下をすべて満たさなければ中止する。
 *   - 人が本番でログインを実測済みであること（--verified-production-login）
 *   - /authz/adminPin が TC_ENC_KEY で復号でき、TC_PIN_PEPPER で照合できること
 *     （＝このスクリプトの実行環境と Vercel の鍵が食い違っていないことの実証）
 *   - その平文が config/adminPinHash と同一PINであること
 *   - 管理者URLによる復旧経路が残っていること
 */
async function purgeLegacyAdmin() {
  console.log("\n[PURGE] 公開領域の旧管理者PIN資格情報を削除するモードです。");

  // ★ 宣誓フラグは「実削除」のときだけ必須。dry-run は事前確認のために常に実行できる。
  if (APPLY && !process.argv.includes("--verified-production-login")) {
    console.error("\n中止: --verified-production-login が指定されていません。");
    console.error("  削除すると復元できません。先に本番で管理者PINログインが通ることを実測し、");
    console.error("  確認できた場合にのみ同フラグを付けて再実行してください。");
    process.exit(3);
  }
  const pep = process.env.TC_PIN_PEPPER || "";
  const enc = process.env.TC_ENC_KEY || "";
  if (pep.length < 32) {
    console.error("\n中止: TC_PIN_PEPPER が未設定、または32文字未満です（Vercel と同一の値が必要）。");
    process.exit(3);
  }
  if (Buffer.from(enc, "base64").length < 32) {
    console.error("\n中止: TC_ENC_KEY が未設定、またはデコード後32バイト未満です（Vercel と同一の値が必要）。");
    process.exit(3);
  }

  const [rec, legacyHashNow, legacyPlainNow, adminTokens, adminTokenHashNow] = await Promise.all([
    G.dbGet("authz/adminPin"),
    G.dbGet("config/adminPinHash"),
    G.dbGet("config/adminPin"),
    G.dbGet("authz/adminTokens"),
    G.dbGet("config/adminTokenHash"),
  ]);

  if (!(rec && typeof rec === "object" && rec.dk && rec.salt && rec.plainEnc)) {
    console.error("\n中止: /authz/adminPin が未作成、または照合可能な形式ではありません。");
    console.error("  先に管理者PINの移行（または管理画面からの再設定）を完了させてください。");
    process.exit(3);
  }

  // TC_ENC_KEY の整合
  let plain = null;
  try { plain = S.decryptPlain(rec.plainEnc); } catch (e) { plain = null; }
  if (!plain) {
    console.error("\n中止: plainEnc を復号できません（TC_ENC_KEY が移行時と異なります）。");
    process.exit(3);
  }
  // TC_PIN_PEPPER の整合
  if (!S.verifyPin(plain, rec)) {
    console.error("\n中止: scrypt 照合に失敗しました（TC_PIN_PEPPER が移行時と異なります）。");
    process.exit(3);
  }
  // 移行したPINが、これから消す旧ハッシュと同一のPINであることの証明
  if (isSha256(legacyHashNow) && S.legacyHash(plain) !== String(legacyHashNow)) {
    console.error("\n中止: /authz のPINが config/adminPinHash と一致しません。");
    console.error("  別のPINで上書きされている可能性があります。内容を確認してください。");
    process.exit(3);
  }

  // ★ 復旧経路の正本は /authz/adminTokens である。
  //   管理者URLの照合はサーバ（/api/auth/admin）が /authz だけを見るようになったため、
  //   公開領域の config/adminTokenHash は認証に一切使われない（表示すら真偽値へ移行済み）。
  //   したがって「enabled===true のキーが1件以上あるか」が、そのまま復旧可否になる。
  //   config/adminTokenHash との一致は、削除対象そのものなので判定条件にしない。
  // ★ 復旧経路が無いと判定した「理由」を区別する。
  //   一律に「空です」と出すと、操作者が回避フラグを付けて、
  //   復旧経路が実在しないまま復元不能な削除を実行してしまう。
  const tokenEntries = adminTokens && typeof adminTokens === "object" ? Object.entries(adminTokens) : [];
  const enabledTokens = tokenEntries.filter(
    ([, v]) => v && typeof v === "object" && v.enabled === true
  );
  const hasAdminUrl = enabledTokens.length > 0;
  let noUrlReason = "";
  if (!hasAdminUrl) {
    if (tokenEntries.length === 0) noUrlReason = "/authz/adminTokens が空（bootstrap 時に管理者URLが未設定だった）";
    else noUrlReason = "すべてのキーの enabled が true ではない（無効化済み）";
  }
  // 現行 config/adminTokenHash が /authz に無い場合の注意喚起（判定はしない）。
  // 旧クライアント（キャッシュ済み index.html）は削除後に管理者URLが使えなくなるため。
  const cur = isSha256(adminTokenHashNow) ? String(adminTokenHashNow) : "";
  const curInAuthz = !!(cur && adminTokens && typeof adminTokens === "object"
    && adminTokens[cur] && adminTokens[cur].enabled === true);

  // ★ サマリは中止判定より前に出す。dry-run で原因を確認できるようにするため。
  console.log("  事前検証 : 復号OK / scrypt照合OK / 旧ハッシュとの同一性OK");
  console.log("  復旧経路 : /authz/adminTokens に有効な管理者URL " +
    (hasAdminUrl ? enabledTokens.length + "件" : "★なし"));
  if (!hasAdminUrl) console.log("             理由: " + noUrlReason);
  if (hasAdminUrl && cur && !curInAuthz) {
    console.log("  ⚠ 現行 config/adminTokenHash と一致するキーが /authz にありません。");
    console.log("    サーバ認証は /authz を正とするため、いま配布中の管理者URLが");
    console.log("    削除後に使えなくなる可能性があります。先に管理画面でトークンを再設定してください。");
  }

  if (!hasAdminUrl && !process.argv.includes("--allow-no-admin-url")) {
    console.error("\n中止: 管理者URLによる復旧経路がありません。");
    console.error("  理由: " + noUrlReason);
    console.error("  削除すると、PIN と URL の両方が使えなくなったときに復旧手段がありません。");
    console.error("  原因を解消してから再実行してください。");
    console.error("  それでも実行する場合のみ --allow-no-admin-url を付けてください。");
    process.exit(3);
  }
  const legacyTokenPlain = await G.dbGet("config/adminToken");
  console.log("  削除対象 : config/adminPinHash=" + (legacyHashNow != null ? "あり" : "なし") +
    " / config/adminPin=" + (legacyPlainNow != null ? "あり" : "なし"));
  console.log("             config/adminTokenHash=" + (adminTokenHashNow != null ? "あり" : "なし") +
    " / config/adminToken=" + (legacyTokenPlain != null ? "あり" : "なし"));
  console.log("  追加書込 : config/adminTokenSet=true（管理画面の「設定済み」表示用の真偽値）");
  console.log("  ※ config/adminTokenHash も非ソルトSHA-256で誰でも読める。総当たりで平文トークンへ");
  console.log("     戻せ、復元値は /api/auth/admin にそのまま通るため、PINハッシュと同時に削除する。");

  if (!APPLY) {
    console.log("\nDRY-RUN のため削除していません。--apply を付けて実行してください。");
    return;
  }

  // ★ 単一 PATCH で原子的に消す。複数回の PUT だと片方だけ残り、
  //   より危険な旧平文だけが公開領域に取り残される事故が起きる。
  console.log("\n[PURGE] 公開領域の管理者資格情報（PIN・URLトークン）を削除します…");
  await G.dbPatch("config", {
    adminPinHash: null,
    adminPin: null,
    adminTokenHash: null,
    adminToken: null,
    adminTokenSet: true,
  });

  const [h2, p2, th2, t2] = await Promise.all([
    G.dbGet("config/adminPinHash"),
    G.dbGet("config/adminPin"),
    G.dbGet("config/adminTokenHash"),
    G.dbGet("config/adminToken"),
  ]);
  console.log("  config/adminPinHash   : " + (h2 == null ? "削除済み OK" : "★残存"));
  console.log("  config/adminPin       : " + (p2 == null ? "削除済み OK" : "★残存"));
  console.log("  config/adminTokenHash : " + (th2 == null ? "削除済み OK" : "★残存"));
  console.log("  config/adminToken     : " + (t2 == null ? "削除済み OK" : "★残存"));
  if (h2 != null || p2 != null || th2 != null || t2 != null) {
    console.error("\nERROR: 削除しきれていません。手動で確認してください。");
    process.exit(4);
  }
  console.log("\n完了。");
  console.log("※ 古い index.html をキャッシュしている端末は、管理者URLが一時的に使えません。");
  console.log("   画面を再読み込みすれば新しい版を取得します（管理者PINは影響を受けません）。");
}

async function main() {
  console.log("=".repeat(64));
  console.log("bootstrap-authz  mode=" + (APPLY ? "APPLY" : "DRY-RUN") +
    (PURGE_LEGACY_ADMIN ? " / PURGE-LEGACY-ADMIN" : ""));
  console.log("=".repeat(64));

  if (!process.env.FIREBASE_DATABASE_URL) { console.error("ERROR: FIREBASE_DATABASE_URL が未設定です"); process.exit(1); }

  // ★ purge は /authz の投入とは独立した単独モード。
  //   「apply → 本番で管理者PINログインを実測 → purge」の順序を成立させるため。
  if (PURGE_LEGACY_ADMIN) {
    await purgeLegacyAdmin();
    return;
  }

  const canHash = !!(process.env.TC_PIN_PEPPER && process.env.TC_ENC_KEY);
  if (APPLY && !canHash) {
    console.error("ERROR: --apply には TC_PIN_PEPPER と TC_ENC_KEY（Vercel と同一の値）が必要です");
    process.exit(1);
  }
  console.log("環境変数: FIREBASE_DATABASE_URL=設定あり / TC_PIN_PEPPER,TC_ENC_KEY=" +
    (canHash ? "設定あり" : "未設定（dry-runのため平文分は legacy 扱いで計画を組む）") + "（値は非表示）");

  // ---- 1) 既存 /authz の確認（あれば停止）----
  const existing = await G.dbGet("authz");
  const existingKeys = existing && typeof existing === "object" ? Object.keys(existing) : [];
  console.log("\n【既存 /authz】" + (existingKeys.length ? "★存在する: [" + existingKeys.join(", ") + "]" : "存在しない（新規作成）"));
  if (existingKeys.length && APPLY) {
    console.error("\nERROR: /authz が既に存在します。無条件上書きはしません。");
    console.error("       内容を確認し、必要なら手動で退避・削除してから再実行してください。");
    process.exit(2);
  }

  // ---- 2) 現行データの読み取り（/honomi は読むだけ）----
  const [pins, adminPinHash, adminTokenHash, adminPinLegacy] = await Promise.all([
    G.dbGet("tc5_pins"),
    G.dbGet("config/adminPinHash"),
    G.dbGet("config/adminTokenHash"),
    G.dbGet("config/adminPin"),   // 旧平文。残っていれば全探索を省ける
  ]);

  // ---- 3) pins（スタッフ名キー。平文が分かれば scrypt、分からなければ legacy のまま）----
  const pinsOut = {};
  let fromPlain = 0, asLegacy = 0, skipped = 0;
  for (const [name, v] of Object.entries(pins || {})) {
    let plain = null, legacy = null;
    if (v && typeof v === "object") {
      if (v.plain != null) plain = String(v.plain);
      if (isSha256(v.hash)) legacy = String(v.hash);
    } else if (/^\d{4}$/.test(String(v))) {
      plain = String(v);               // 旧形式（4桁平文がそのまま入っている）
    } else if (isSha256(v)) {
      legacy = String(v);
    }

    const key = S.subjectKey(name);
    if (plain != null && canHash) { pinsOut[key] = S.makePinRecord(plain); fromPlain++; }
    else if (plain != null && !canHash) { pinsOut[key] = { legacy: S.legacyHash(plain) }; fromPlain++; }
    else if (legacy) { pinsOut[key] = { legacy: legacy }; asLegacy++; }
    else { skipped++; }
  }

  // ---- 4) adminPin / adminTokens（現行の値をそのまま使う）----
  let adminPinOut = null;
  let adminPinSource = "★未設定（config/adminPinHash なし）";
  let adminPinNeedsReset = false;
  if (!isSha256(adminPinHash) && adminPinLegacy != null && String(adminPinLegacy)) {
    // 旧平文だけが残っている環境。ハッシュが無いので現行PINの正当性を検証できない。
    adminPinSource = "★config/adminPinHash が無く旧平文のみ（安全に移行できない）";
    adminPinNeedsReset = true;
  } else if (isSha256(adminPinHash)) {
    let plain = null;
    if (adminPinLegacy != null && S.legacyHash(String(adminPinLegacy)) === String(adminPinHash)) {
      plain = String(adminPinLegacy);
      adminPinSource = "現行の平文から生成（総当たり不要）";
    } else {
      console.log("\n  管理者PINの平文を現行ハッシュから復元します（数分かかります）…");
      plain = recoverAdminPin(adminPinHash);
      adminPinSource = plain ? "現行ハッシュから復元" : "★復元不可";
    }
    if (plain != null && plain.length < 8 && !ALLOW_SHORT_ADMIN_PIN) {
      // ★ 8桁未満は移行しない。サーバ側のレート制限は /64 あたり約1,728回/日まで
      //   絞れるが、探索空間が 10^4〜10^7 だと 1〜3 日で尽きる。
      //   「そのまま維持できない」ケースなので、再設定を求める。
      adminPinSource = "★現行PINが" + plain.length + "桁（8桁未満）のため移行しない";
      adminPinNeedsReset = true;
    } else if (plain != null) {
      // ★ legacy は書かない。scrypt+pepper のみ。
      adminPinOut = canHash ? S.makePinRecord(plain) : { salt: "", dk: "", plainEnc: "", updatedAt: 0 };
      if (plain.length < 8) adminPinSource += "（★8桁未満のまま移行。--allow-short-admin-pin 指定）";
    } else {
      adminPinNeedsReset = true;
    }
  }

  const adminTokens = {};
  if (isSha256(adminTokenHash)) adminTokens[String(adminTokenHash)] = { enabled: true };

  // ---- 5) plan 組み立て ----
  const plan = {
    pins: pinsOut,
    _meta: {
      createdAt: Date.now(),
      version: 2,
      counts: { pins: Object.keys(pinsOut).length, adminTokens: Object.keys(adminTokens).length },
    },
  };
  if (adminPinOut) plan.adminPin = adminPinOut;
  if (Object.keys(adminTokens).length) plan.adminTokens = adminTokens;
  const fp = planFingerprint(plan);
  plan._meta.planHash = fp;

  // ---- 6) 報告 ----
  console.log("\n【書込み予定パス】（/authz 配下のみ。/honomi へは一切書き込まない）");
  for (const k of Object.keys(plan).sort()) {
    const v = plan[k];
    const n = v && typeof v === "object" && k !== "_meta" && k !== "adminPin" ? Object.keys(v).length : 1;
    console.log("  /authz/" + k.padEnd(14) + " … " + n + " 件");
  }

  console.log("\n【スタッフPIN】（鍵はスタッフ名のハッシュ。氏名・PINは保存も表示もしない）");
  console.log("  tc5_pins の件数                 : " + Object.keys(pins || {}).length);
  console.log("    └ 平文が判明 → scrypt+pepper : " + fromPlain);
  console.log("    └ ハッシュのみ → legacy 保持  : " + asLegacy + "（初回ログイン成功時にサーバが自動昇格）");
  console.log("    └ 形式不明で除外              : " + skipped + (skipped ? "  ← 該当者は現行どおり打刻画面でPIN再設定が必要" : ""));

  console.log("\n【管理者】");
  console.log("  管理者PIN     : " + (adminPinOut ? "scrypt+pepper で保管（" + adminPinSource + "）★現在のPINをそのまま使える" : adminPinSource));
  if (adminPinNeedsReset) {
    console.log("                  → 管理者URL(?admin=)でログインし、管理画面から管理者PINを");
    console.log("                    再設定してください（PIN変更UIは8桁を強制します）。");
    console.log("                    ※ 8桁未満をそのまま移行したい場合のみ --allow-short-admin-pin");
  }
  console.log("  管理者URL     : " + (Object.keys(adminTokens).length ? "現行ハッシュをそのまま移行（★URL変更・再発行不要）" : "★未設定（config/adminTokenHash なし）"));

  console.log("\n【公開領域に残る旧管理者PINハッシュ】");
  console.log("  config/adminPinHash : " + (isSha256(adminPinHash) ? "★存在する（誰でも読める・数分で平文復元可能）" : "なし"));
  console.log("  config/adminPin     : " + (adminPinLegacy != null && String(adminPinLegacy) ? "★存在する（旧平文）" : "なし"));
  if (isSha256(adminPinHash) || (adminPinLegacy != null && String(adminPinLegacy))) {
    console.log("  ⚠ 残したままだと、復元したPINが新しい /api/auth/admin にそのまま通る。");
    console.log("    順序: --apply → 本番で管理者PINログインを実測 → 別実行で削除。");
    console.log("      node scripts/bootstrap-authz.js --apply --purge-legacy-admin --verified-production-login");
    console.log("    または、移行後に管理者PINを1回変更すれば残置ハッシュは無価値になる。");
  }

  console.log("\n【現行URL・端末への影響】");
  console.log("  施設の打刻URL / QRコード : 変更なし（施設トークンは新認証で使用しない）");
  console.log("  端末の設定・再登録        : 不要");
  console.log("  閲覧用URL / デモURL       : 変更なし（/authz へは複製せず、現行ノードをサーバ側で参照）");

  console.log("\n【安全性】");
  console.log("  既存 /authz         : " + (existingKeys.length ? "★存在（apply は停止する）" : "なし → 上書きの可能性なし"));
  console.log("  書込み先            : /authz への単一 PUT のみ（原子的。部分適用が起きない）");
  console.log("  /honomi への書込み  : なし（読み取りのみ）");
  console.log("  planHash            : " + fp);
  console.log("    ※ planHash はキー構造のみから算出する。dry-run と apply で一致すれば「同じ対象・同じ件数」であることを示す。");

  // ★ 管理者PINも管理者URLも /authz に入らないなら、投入後に管理者が
  //   どちらの経路でも入れなくなる。しかも --apply は「既存 /authz あり」で
  //   再実行できないため、復旧は本番DBの手動操作しか残らない。
  //   dry-run では警告のみ、--apply では既定で中止する。
  const noAdminCredential = !adminPinOut && Object.keys(adminTokens).length === 0;
  if (noAdminCredential) {
    // dry-run では「警告」なので stdout に出す。他の出力と混在させないと見落とされる。
    const out = APPLY ? console.error : console.log;
    out("\n★★ 管理者の資格情報が /authz に1件も入りません。");
    out("   管理者PIN : " + adminPinSource);
    // noAdminCredential が真＝adminTokens が空＝adminTokenHash は sha256 ではない
    out("   管理者URL : config/adminTokenHash が未設定（旧平文 config/adminToken のみの運用も含む）");
    out("   このまま投入すると、デプロイ後に管理者はPINでもURLでも入れなくなります。");
    // ★ /authz 未投入の状態では、管理画面の「管理者トークン変更」は使えない。
    //   admin-token-set / admin は authzReady() が false の間 503 を返すため、
    //   「管理画面で設定してから再実行」という案内は循環して実行不能になる。
    out("   ★ /authz 未投入のため、管理画面からの設定はできません（APIが 503 を返す）。");
    out("   Firebase コンソールで config/adminTokenHash に");
    out("   sha256(\"honomi_pin_v1:\" + トークン) を設定してから再実行してください。");
    if (APPLY && !ALLOW_NO_ADMIN_CREDENTIAL) {
      console.error("\n中止しました（続行するには --allow-no-admin-credential が必要です）。");
      process.exit(5);
    }
    if (APPLY) console.error("   → --allow-no-admin-credential が指定されているため続行します。");
  }

  if (!APPLY) {
    console.log("\nDRY-RUN のため書き込みは行っていません。");
    console.log("投入するには --apply を付けて実行してください。");
    return;
  }

  // ---- 7) apply（単一 PUT）----
  console.log("\n[APPLY] /authz へ単一 PUT を実行します…");
  await G.dbPut("authz", plan);

  const after = await G.dbGet("authz/_meta");
  const got = await G.dbGet("authz/pins");
  const gotN = got && typeof got === "object" ? Object.keys(got).length : 0;
  console.log("  planHash 一致 : " + (after && after.planHash === fp ? "OK" : "★不一致"));
  console.log("  pins          : " + gotN + " / 予定 " + Object.keys(pinsOut).length + (gotN === Object.keys(pinsOut).length ? "  OK" : "  ★不一致"));
  console.log("\n完了。");
}

main().catch((e) => {
  console.error("\nERROR:", e && e.message);
  process.exit(9);
});
