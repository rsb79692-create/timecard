/**
 * api/_lib/secrets.js — PIN/トークンの照合とレート制限（すべてサーバ専用）
 *
 * 保管場所は RTDB の /authz 配下。/honomi の「外」に置くことが必須である。
 * 理由: RTDB Rules は浅い階層の許可を下位で取り消せない。現行 database.rules.json は
 *       /honomi に .read/.write = auth != null を与えているため、/honomi 配下へ置くと
 *       子に .read:false を書いても匿名クライアントから丸見え・書き換え自由になる。
 *       ルート直下の未定義パスは RTDB のデフォルトで拒否されるので、Rules を触らずに
 *       最初から閉じた状態で作れる。
 *
 * PIN の平文保存は本プロジェクトの確定仕様。ここで変えるのは「置き場所と保護」であり、
 * 平文を廃止するものではない（管理者のPIN確認機能を維持するため）。
 */
"use strict";

const crypto = require("crypto");
const { dbGet, dbPut, dbPatch } = require("./google");

const AUTHZ = "authz";

// ===== 比較 =====

/** 定数時間比較。長さが違っても情報を漏らさないよう、必ず同じ長さのバッファへ写す。 */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  const len = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  // 長さの差自体も結果へ織り込む
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

// ===== PIN のハッシュ化 =====
// 4桁PINは探索空間が 10,000 しかないため、KDF を重くしても DB が漏れれば全数復元できる。
// DB に存在しない鍵（pepper）を HMAC で混ぜることが、DB漏えいに対する実効的な防御になる。

function pepper() {
  const p = process.env.TC_PIN_PEPPER || "";
  if (!p || p.length < 32) throw new Error("pepper not configured");
  return p;
}

/** salt は per-record のランダム値。scrypt はメモリハードで GPU 総当たりに強い。 */
function derive(pin, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  // pepper は HMAC で先に混ぜる（KDF の入力自体を DB だけでは再現できなくする）
  const peppered = crypto.createHmac("sha256", pepper()).update(String(pin)).digest();
  const dk = crypto.scryptSync(peppered, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return dk.toString("base64");
}

function newSalt() {
  return crypto.randomBytes(16).toString("base64");
}

/** 保存用レコードを作る。plain はサーバ鍵で暗号化して保持する（確定仕様の平文保存を安全に置く）。 */
function makePinRecord(pin) {
  const salt = newSalt();
  return {
    salt: salt,
    dk: derive(pin, salt),
    plainEnc: encryptPlain(String(pin)),
    updatedAt: Date.now(),
  };
}

/** 非実在アカウント用のダミー。実在有無で処理時間が変わらないようにする。 */
const DUMMY = { salt: crypto.createHash("sha256").update("tc-dummy").digest("base64").slice(0, 24), dk: "" };
function verifyPin(pin, record) {
  const rec = record && record.salt ? record : DUMMY;
  const got = derive(pin, rec.salt);
  // 非実在時は必ず false になるが、KDF は同じだけ実行される
  return rec.dk ? timingSafeEqualStr(got, rec.dk) : false;
}

// ===== 現行方式（レガシー）との橋渡し =====
// ★ 現行アプリは PIN も管理者URLトークンも sha256("honomi_pin_v1:" + 値) で保持している。
//   このハッシュはそのまま /authz へ持ち込めるため、
//   **現在の管理者PIN・管理者URL・スタッフPINを一切変更せずに新認証へ移行できる。**
//   平文が分かる場合（tc5_pins の plain / 認証成功時の入力値）は scrypt+pepper へ自動昇格する。
const LEGACY_PREFIX = "honomi_pin_v1:";
function legacyHash(v) {
  return crypto.createHash("sha256").update(LEGACY_PREFIX + String(v), "utf8").digest("hex");
}

/**
 * scrypt レコードとレガシーハッシュの両方を受け付ける照合。
 * 返り値: { ok, upgrade } — upgrade=true なら呼び出し側が makePinRecord で置き換える。
 * ★ どちらの経路でも必ず scrypt を1回通す。方式の違いが応答時間から分からないようにする。
 */
function verifyPinCompat(pin, record) {
  const rec = record && typeof record === "object" ? record : null;
  const scryptOk = verifyPin(pin, rec); // 常に実行（タイミング差を作らない）
  if (rec && rec.dk) return { ok: scryptOk, upgrade: false };
  const lh = rec && typeof rec.legacy === "string" ? rec.legacy : "";
  if (lh) {
    const ok = timingSafeEqualStr(legacyHash(pin), lh);
    return { ok: ok, upgrade: ok };
  }
  return { ok: false, upgrade: false };
}

/**
 * スタッフPINの保管キー。
 * ★ 現行 tc5_pins が「スタッフ名」キーであることに合わせる。
 *   employeeId は未設定のスタッフ・重複するスタッフが実在する（index.html の
 *   getPaidLeaveUnregistered が両方を警告対象として実装している）ため、
 *   employeeId を必須にすると該当者が打刻不能になる。現行仕様を壊さないため名前キーとする。
 *   名前そのものは保存せず、ハッシュだけをキーに使う。
 */
function subjectKey(staffName) {
  return "n_" + crypto.createHash("sha256").update(String(staffName), "utf8").digest("hex").slice(0, 40);
}

// ===== 実在スタッフの確認 / bootstrap 完了の確認 =====

/**
 * ★ /authz が bootstrap 済みかどうか。
 *   未投入のまま API を受け付けると、
 *   (1) 全員が「レコード未存在」になり、第三者が実在スタッフのPINを先に占有できる
 *   (2) /authz/pins が生えて bootstrap-authz.js の「既存 /authz があれば停止」に掛かり
 *       --apply が永久に実行不能になる（復旧が手動削除＝破壊的操作）
 *   (3) 全ログインが失敗し続けてレート制限だけが積み上がる
 *   いずれも実害があるため、_meta が無い間は書き込みも認証も行わない。
 */
let _readyCache = { ok: false, exp: 0 };
async function authzReady() {
  const now = Date.now();
  if (_readyCache.ok && now < _readyCache.exp) return true;
  const meta = await dbGet(AUTHZ + "/_meta");
  const ok = !!(meta && typeof meta === "object");
  if (ok) _readyCache = { ok: true, exp: now + 60000 };
  return ok;
}

/**
 * スタッフ名が実在するかを /honomi/tc5_staff で確認する。
 * ★ これが無いと、任意の文字列を staffName にして「レコード未存在」経路から
 *   誰でも staff ロールを取得できてしまう（subjectKey は任意文字列の SHA-256 なので
 *   実在性を何も担保しない）。
 * 名簿は短時間メモリキャッシュして RTDB 往復を増やさない。
 */
let _staffCache = { names: null, exp: 0 };
async function loadStaffNames() {
  const raw = await dbGet("tc5_staff");
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  const set = new Set();
  for (const s of arr) {
    if (s && typeof s === "object" && typeof s.name === "string" && s.name) set.add(s.name);
  }
  _staffCache = { names: set, exp: Date.now() + 60000 };
  return set;
}
async function staffNameExists(name) {
  const key = String(name);
  let set = _staffCache.names;
  if (!set || Date.now() >= _staffCache.exp) set = await loadStaffNames();
  if (set.has(key)) return true;
  // ★ 見つからないときは1回だけ引き直す。
  //   キャッシュは最大60秒古くなるため、直前に登録された新入職員の初回PIN登録が
  //   キャッシュ由来で拒否され、そのまま /authz にレコードが作られず残ってしまう。
  //   （クライアントは失敗を再試行しないため、1回の取りこぼしが恒久化する）
  if (_staffCache.exp - Date.now() > 55000) return false; // 引き直した直後なら再取得しない
  set = await loadStaffNames();
  return set.has(key);
}

// ===== 管理者セッションの失効 =====

/**
 * 管理者URLトークンを変更しても、それ以前に発行された admin セッションは
 * Firebase の refresh token を持っている限り admin ロールのIDトークンを取り直せる。
 * ＝「資格情報を変えたのにアクセスを止められない」状態になる。
 *
 * そこで rotate 時刻（/authz/adminMinAt, UNIX秒）を置き、
 * それより前に発行された Custom Token（claims.at）を管理系APIから締め出す。
 *
 * ★ RTDB Rules は /honomi に auth != null しか課しておらず、匿名でも業務データを
 *   読み書きできる。したがって失効させる実益があるのは
 *   「管理者ロールでしかできない操作」＝以下のすべてである。
 *     - 管理者PIN変更     （admin-pin-set）
 *     - 管理者トークン変更 （admin-token-set）
 *     - 任意スタッフのPIN上書き・改名（pin-set の isAdmin 経路。
 *       現PIN照合もレート制限も通らないため、被害はむしろこちらが大きい）
 *   ★ r:"a" を特権として扱うエンドポイントを新設したら、必ずここを通すこと。
 *
 * ★ adminMinAt が未設定なら「まだ一度も rotate していない」＝失効対象なし。
 *   欠落をフェイルクローズにすると全管理者が即座に操作不能になるため、0 として扱う。
 *   （dbGet 自体が失敗した場合は throw し、呼び出し元で 500 になる＝フェイルクローズ）
 */
// サーバインスタンス間の時計ずれの許容。rotate 直後に張り直した自分自身の
// セッションが、数秒の逆行で弾かれるのを防ぐ。攻撃者の旧セッションは通常
// 数時間〜数日前に発行されているため、この程度の許容で防御力は落ちない。
const ADMIN_AT_SKEW_SEC = 30;

async function adminSessionValid(claims) {
  const min = await dbGet(AUTHZ + "/adminMinAt");
  if (typeof min !== "number" || !(min > 0)) return true;
  const at = claims && typeof claims.at === "number" ? claims.at : 0;
  return at + ADMIN_AT_SKEW_SEC >= min;
}

// ===== plain の暗号化（管理者のPIN確認機能を維持するため） =====

function encKey() {
  const k = process.env.TC_ENC_KEY || "";
  if (!k) throw new Error("enc key not configured");
  const buf = Buffer.from(k, "base64");
  // ★ 文字数ではなく「base64 デコード後の長さ」で検査する。
  //   文字数だけ見ると、短い鍵が subarray(0,32) のゼロ埋めで通ってしまう。
  if (buf.length < 32) throw new Error("enc key too short");
  return buf.subarray(0, 32);
}
function encryptPlain(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptPlain(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// ===== トークンのハッシュ保管 =====
// 施設トークン / viewer / demo / staffDemo は「再発行のみ」方針のため、
// 平文はどこにも保存しない。照合はハッシュ一致で行う。

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function randomToken() {
  // 128bit 以上。base64url 22文字。
  return crypto.randomBytes(16).toString("base64url");
}

// ===== レート制限 =====
// 「誰か1人に入れればよい」攻撃では、30名の施設で期待試行は約333回にすぎない。
// したがってスタッフ単位だけでなく施設単位の合算が必須。

const WINDOW_MS = 10 * 60 * 1000;

// ★ レート制限カウンタは /authz の「外」に置く。
//   /authz 配下だと、bootstrap-authz.js の「既存 /authz があれば停止」判定に引っかかり、
//   API を先にデプロイした瞬間（最初のリクエストで rate が生える）に --apply が
//   永久実行不能になる。復旧が Firebase コンソールでの手動削除＝破壊的操作になるため分離する。
//   /ratelimit もルート直下でルール未定義＝デフォルト拒否のため、クライアントからは読めない。
const RATE_ROOT = "ratelimit";

/**
 * カウンタのパスは「スロットを最上位」に置く。
 *
 * ★ 以前は /ratelimit/<kind>/<id>/<slot> だったため、攻撃者が IP や staffName を
 *   回転させると使い捨てのキーが無制限に残り続けた（RTDB に TTL は無い）。
 *   スロットを先頭にすると、期限切れの窓は /ratelimit/<slot> の**サブツリー1つ**を
 *   消すだけで丸ごと回収できる。どのキーが使われたかに依存しないので、
 *   識別子をハッシュで丸める必要がなくなる。
 *
 * ★ 識別子を固定数バケットへ丸める案は採らない。ハード上限(429)を持つ次元では
 *   攻撃者が任意のバケットへ意図的に着弾でき、無関係な管理者・閲覧者を
 *   巻き添えでロックアウトできてしまうため（生の識別子なら巻き添えは起きない）。
 */
function slotNow() {
  return Math.floor(Date.now() / WINDOW_MS);
}

function bucketKey(kind, id) {
  return RATE_ROOT + "/" + slotNow() + "/" + kind + "/" + sanitizeKey(id);
}

/** RTDB のキーに使えない文字を除去する（. $ # [ ] / と制御文字） */
function sanitizeKey(s) {
  return String(s).replace(/[.$#[\]/\x00-\x1f\x7f]/g, "_").slice(0, 128) || "_";
}

/**
 * 試行を1つ数え、加算後の件数を返す。
 *
 * ★ 必ず「検証の前」に呼ぶこと。
 *   以前は「読んで判定 → 検証 → 失敗したら加算」だったが、Vercel は同時実行でスケールするため
 *   並列リクエストが全員 count=0 を読み、遅延も上限判定も一切かからなかった（TOCTOU）。
 *   加算してからその戻り値で判定すれば、並列でも件数が積み上がる。
 *
 * ★ 成功時は resetCount で 0 に戻すため、正常利用者のカウンタは常に 0 近傍に留まる。
 *   朝の打刻ピークで正規利用が遅くなることはない。
 */
async function bumpAndCount(kind, id) {
  const path = bucketKey(kind, id);
  const parent = path.replace(/\/[^/]+$/, "");
  const leaf = path.split("/").pop();
  await dbPatch(parent, { [leaf]: { ".sv": { increment: 1 } } });
  const v = await dbGet(path);
  // ★ 期限切れスロットをサブツリーごと回収する。
  //   どんな識別子が使われていても1回の PUT で消えるので、
  //   IP・端末ID・スタッフ名を回転させても /ratelimit は増え続けない。
  try {
    await dbPut(RATE_ROOT + "/" + (slotNow() - 2), null);
  } catch (e) { /* 掃除の失敗は致命ではない */ }
  return typeof v === "number" ? v : 1;
}

/** 加算せず現在値だけ見る（判定に使わない参考用途）。 */
async function currentCount(kind, id) {
  const v = await dbGet(bucketKey(kind, id));
  return typeof v === "number" ? v : 0;
}

/** 認証成功時に現在スロットのカウンタを消す。 */
async function resetCount(kind, id) {
  await dbPut(bucketKey(kind, id), null);
  try {
    // 直前スロットも消しておく（窓境界をまたいだ直後の持ち越しを避ける）
    await dbPut(RATE_ROOT + "/" + (slotNow() - 1) + "/" + kind + "/" + sanitizeKey(id), null);
  } catch (e) { /* 掃除の失敗は致命ではない */ }
}

/**
 * 制限判定。★ ロックアウトは一切しない（打刻不能は賃金に直結するため）。
 *
 * 正常利用は遅延させず、異常な大量試行だけを段階的に遅らせる。
 *   - softLimit 未満（＝打ち間違い程度）: 0ms。現行と同じ体感。
 *   - 超過分に比例して遅延を増やし、上限 MAX_DELAY_MS で頭打ち。
 * これによりオンライン総当たりは実質不可能なまま、正しいPINは必ず通る。
 */
// 既定の遅延上限。クライアント側のタイムアウトを必ず下回るようにする。
//   4秒だと RTDB 往復・scrypt・コールドスタートを足してタイムアウトを超え、
//   「正しいPINなのに中断される」状態になり得た。
// ★ 完全にバックグラウンドで動く経路（staff.js）は長い上限を明示指定してよい。
//   そこは体感に影響せず、総当たりへのブレーキを強く保てる。
const MAX_DELAY_MS = 2000;
const MAX_DELAY_BG_MS = 4000;
function delayMsFor(count, softLimit, maxMs) {
  if (!(count > softLimit)) return 0;
  return Math.min(maxMs || MAX_DELAY_MS, (count - softLimit) * 250);
}

module.exports = {
  AUTHZ,
  timingSafeEqualStr,
  makePinRecord,
  verifyPin,
  encryptPlain,
  decryptPlain,
  tokenHash,
  randomToken,
  bumpAndCount,
  currentCount,
  resetCount,
  delayMsFor,
  MAX_DELAY_BG_MS,
  sanitizeKey,
  legacyHash,
  verifyPinCompat,
  subjectKey,
  authzReady,
  staffNameExists,
  adminSessionValid,
};
