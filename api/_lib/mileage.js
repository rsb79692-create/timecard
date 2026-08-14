/**
 * api/_lib/mileage.js — 移動距離申請の共通ロジック（データモデル・権限解決・計算）
 *
 * ===== なぜ /honomi の外（ルート直下 /mileage）に置くのか =====
 * 現行の RTDB Rules は /honomi に対して .read/.write = "auth != null" しか課していない。
 * 匿名サインインは誰でも通るため、/honomi 配下へ置いたデータは
 *   ・他職員の申請を読む
 *   ・自分の利用ON/OFFフラグを true に書き換える
 *   ・区間距離やkm単価を書き換えて支給額を吊り上げる
 *   ・承認状態を勝手に approved にする
 * のすべてが開発者ツールから可能になる。
 * したがって移動距離申請のデータは /honomi の外（ルール未定義＝デフォルト拒否）へ置き、
 * 読み書きはすべてサービスアカウント権限を持つこのサーバ経由に限定する。
 * ＝「UI上の非表示」ではなくサーバ側の権限制御になる。
 *
 * ===== データモデル（すべて RTDB ルート直下 /mileage 配下）=====
 *   _meta                                  : { createdAt, version }
 *   settings                               : { ratePerKm, roundMode, updatedAt, updatedBy }
 *   enabled/{employeeId}                   : true             （未存在＝OFF。既定は必ずOFF）
 *   identity/{subject}                     : { employeeId, name, ... } ★認証サブジェクト→社員番号の唯一の正本
 *   staff/{employeeId}                     : { name, subject, ... }    ★社員番号→氏名（表示用）
 *   places/{placeId}                       : { name, order, active, createdAt }
 *   legs/{fromId}__{toId}                  : { km, updatedAt, updatedBy }  ★方向別が正本
 *   requests/{ym}/{employeeId}/{requestId} : 申請1件（1日1件。requestId = "d_YYYYMMDD"）
 *   monthly/{employeeId}/{ym}              : 月次確定スナップショット（給与計算の正本）
 *   closings/{ym}                          : { closedAt, closedBy, ratePerKm, roundMode }
 *   audit/{ym}/{logId}                     : 変更履歴（誰が・いつ・何を）
 *
 * ===== 方向別を正本にする根拠（推測ではない）=====
 * 現行Excel（■移動距離申請（谷村）.xlsm の baseT シート）の距離マトリクスは
 * 大半が対称だが、実データで非対称な組が存在する。
 *   ハーベスト→貝塚 = 5.3 / 貝塚→ハーベスト = 11.9
 *   ハーベスト→春木 = 11.9 / 春木→ハーベスト = 13.9
 * 対称と決め打つとどちらかの金額が必ず狂うため、方向別を正本にする。
 * 管理画面には「逆方向にも同じ距離を登録」の補助操作を用意する（強制はしない）。
 */
"use strict";

const G = require("./google");
const S = require("./secrets");

const ROOT = "mileage";

// ===== 端数処理 =====
// ★★ 現行Excelは金額の1円未満を「丸めていない」。実測で確定。★★
//   日別 R列 = IF(Q="","",$J$5*Q) / 月合計 K39 = SUM(R8:R38) のどちらにも丸め関数が無く、
//   キャッシュ値も小数のまま保存されている（実測値の例）:
//     日別  : 105.6 / 89.6 / 198.4 / 201.6 / 252.8 / 390.4
//     月合計: 202603=1379.2 / 202604=2590.4 / 202605=2339.2 / 202606=1782.4 / 202607=2604.8
//   表示書式は ##.0"Km"（小数1桁。"Km" は金額欄に付いた書式の誤り）で、
//   「整数に見せている」のではなく本当に小数を保持している。
//   ※ シート内に CEILING は 48 箇所あるが、すべて CEILING(x,"0:30") ＝ 勤務時間の30分丸めで、
//     しかも全て #REF! エラー。移動距離の金額とは無関係。
//
//   したがって既定は "none"（丸めない）＝ 現行Excelと同じ結果になる。
//   円単位で支給したい場合は管理画面で四捨五入・切り捨て・切り上げへ変更できる。
//   コードへ固定しない（設定変更しても過去の確定済み月は変わらない＝スナップショット）。
const ROUND_MODES = ["round", "floor", "ceil", "none"];
const DEFAULT_RATE = 16;        // 現行Excel baseT/月次シート J5 の実値（Km/円 = 16）
const DEFAULT_ROUND = "none";   // 現行Excelと同じ（丸めない）

function applyRound(v, mode) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  switch (mode) {
    case "floor": return Math.floor(n);
    case "ceil": return Math.ceil(n);
    case "none": return round1(n);
    default: return Math.round(n);
  }
}

/** 距離は 0.1km 刻み。浮動小数の誤差（6.2+4.4=10.600000000000001）を持ち回らない。 */
function round1(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

// ===== 入力検証 =====

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * ★ プロトタイプを触りにいく特殊キーは、正規表現を通ってしまうので明示的に弾く。
 *   ID・社員番号は素の {} の索引キーとして使われる箇所があり、弾かないと次が起きる:
 *   ・placeById["constructor"] が truthy になり、存在しない地点が存在検査を通る
 *   ・enabled["__proto__"]=true が黙って無視され、その職員が要確認にもならず
 *     自動集計から消える（フェイルクローズではなくフェイルサイレント＝支給漏れ）
 *   共有ブロックの mileageAutoSafeKey と同じ規律をサーバ側の入口にも置く。
 */
function isUnsafeKey(v) { return v === "__proto__" || v === "prototype" || v === "constructor"; }
function isId(v) { return typeof v === "string" && !isUnsafeKey(v) && ID_RE.test(v); }
function isYm(v) { return typeof v === "string" && YM_RE.test(v); }
function isDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  // 2026-02-31 のような存在しない日付を弾く
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function ymOf(dateStr) { return String(dateStr).slice(0, 7); }

/** RTDB のキーに使えない文字と、社員番号として不自然な値を弾く。 */
function isEmployeeId(v) { return typeof v === "string" && !isUnsafeKey(v) && /^[A-Za-z0-9_-]{1,32}$/.test(v); }

/** 距離 km。0 より大きく 1000 未満、0.1 刻みへ丸めて返す。不正なら null。 */
function normKm(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || n >= 1000) return null;
  return round1(n);
}

/** km単価。0 より大きく 1000 未満の整数または小数1桁。不正なら null。 */
function normRate(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || n >= 1000) return null;
  return round1(n);
}

/** 制御文字（改行・CSVインジェクションの足がかりになる文字）を落として長さを制限する。 */
function normText(v, max) {
  if (typeof v !== "string") return "";
  var out = "";
  for (var i = 0; i < v.length; i++) {
    var c = v.charCodeAt(i);
    out += (c < 0x20 || c === 0x7f) ? " " : v.charAt(i);
  }
  const s = out.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 旧施設名リストの正規化。上限10件。空・重複・`facility` 自身と同じものは落とす。 */
const MAX_ALIASES = 10;
function normFacilityList(v, exclude) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length && out.length < MAX_ALIASES; i++) {
    const s = normText(v[i], 40);
    if (!s || s === exclude || out.indexOf(s) >= 0) continue;
    out.push(s);
  }
  return out;
}

// ===== 権限解決 =====

/**
 * ID トークンを検証し、役割を返す。
 *   { role: "a"|"s"|"v"|"d"|"x"|"", claims }
 * ★ role は必ずトークンの claims から取る。body の申告は一切信用しない。
 */
async function resolveIdentity(idToken) {
  let claims = null;
  try { claims = await G.verifyIdToken(idToken); } catch (e) { return null; }
  if (!claims || typeof claims.sub !== "string") return null;
  return { role: typeof claims.r === "string" ? claims.r : "", claims: claims };
}

/**
 * 管理者として有効か。
 * ★ /authz/adminMinAt による失効判定を必ず通す。
 *   （r:"a" を特権として扱うエンドポイントを新設したら必ずここを通す、という既存の取り決め）
 */
async function isValidAdmin(ident) {
  if (!ident || ident.role !== "a") return false;
  return await S.adminSessionValid(ident.claims);
}

/**
 * 労務士（閲覧用URL）として有効か。
 *
 * ★ 読み取り専用。share.js が claims.ro = true を付けているので、それも要求する。
 * ★ セッション期限 claims.sx を過ぎていたら拒否する（フェイルクローズ）。
 * ★★ さらに、呼び出しのたびに閲覧用トークンの現在の有効性を引き直す。★★
 *   Firebase の refresh token は「トークンを無効化した」だけでは失効しない。
 *   viewerTokens/{token}.enabled = false にしても、既に発行済みのセッションは
 *   r:"v" のIDトークンを取り直せてしまう。移動距離は氏名・社員番号・実支給額を
 *   返すため、無効化が効かない状態を残さない。
 *   claims.t は tokenHash(token) の先頭16桁なので、同じ導出で突き合わせる。
 *
 * 取得できない・見つからない場合は拒否側へ倒す。
 */
async function isValidViewer(ident) {
  if (!ident || ident.role !== "v") return false;
  if (ident.claims.ro !== true) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const sx = ident.claims.sx;
  if (typeof sx === "number" && sx > 0 && nowSec > sx) return false;

  const tid = typeof ident.claims.t === "string" ? ident.claims.t : "";
  if (!/^[0-9a-f]{16}$/.test(tid)) return false;

  const raw = await G.dbGet("viewerTokens");
  if (!raw || typeof raw !== "object") return false;
  const today = todayJst();
  for (const token of Object.keys(raw)) {
    if (S.tokenHash(token).slice(0, 16) !== tid) continue;
    const rec = raw[token];
    if (!rec || typeof rec !== "object") return false;
    if (rec.enabled !== true) return false;                      // 無効化が即座に効く
    if (rec.expiresAt && String(rec.expiresAt) < today) return false;
    // デモ発行の閲覧用URLは発行元デモの有効性にも連動させる（share.js と同じ判定）
    if (rec.issuedByDemoTokenId) {
      // ★ 形式検証を share.js と揃える。検証せずにパスへ連結すると、
      //   値次第で別ノードを引きに行く（読み取り専用でも実装を不揃いにしない）。
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(rec.issuedByDemoTokenId))) return false;
      const src = await G.dbGet("demoTokens/" + String(rec.issuedByDemoTokenId));
      if (!src || typeof src !== "object" || src.enabled === false) return false;
      if (!src.expiresAt || String(src.expiresAt) < today) return false;
    }
    return true;
  }
  return false;   // 該当トークンが見つからない＝削除済み
}

/**
 * スタッフ本人を解決する。トークンの uid（"s:" + subjectKey(氏名)）から社員番号を引く。
 *
 * ★★ 対応表は `/mileage/identity/{subject}` だけを見る。`/honomi/tc5_staff` は見ない。★★
 *
 *   tc5_staff は `/honomi` 配下にあり、Rules が `auth != null` のため
 *   匿名サインインした第三者でも行を追加・書き換えできる。そこから社員番号を引くと、
 *     1) 攻撃者が tc5_staff へ「任意の氏名 ＋ 被害者の社員番号」の行を足す
 *     2) その氏名で PIN を登録して staff ロールのトークンを取る
 *     3) 社員番号が被害者のものとして解決される
 *   という経路が成立し、「自分の申請だけ」という保証も「利用ONの職員だけ」という
 *   保証も同時に破れる。body の申告を使わないだけでは足りない。
 *
 *   そこで対応表は管理者が明示的に「使用する」にしたときだけ `/mileage` 側へ書く。
 *   `/mileage` は Rules 未定義＝デフォルト拒否なので、サーバ以外は誰も書けない。
 *
 * ★ 未登録（管理者が一度も許可していない）なら null を返す＝フェイルクローズ。
 */
async function resolveStaff(ident) {
  if (!ident || ident.role !== "s") return null;
  const uid = String(ident.claims.sub || "");
  if (uid.slice(0, 2) !== "s:") return null;
  const subject = uid.slice(2);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(subject)) return null;   // パス組み立ての安全性

  const rec = await G.dbGet(ROOT + "/identity/" + subject);
  if (!rec || typeof rec !== "object") return null;
  const eid = typeof rec.employeeId === "string" ? rec.employeeId.trim() : "";
  // ★ 形式検証を必ず通す。ここを抜けると employeeId がそのまま RTDB のパスへ入る。
  if (!isEmployeeId(eid)) return null;
  return { name: String(rec.name || ""), employeeId: eid, subject: subject };
}

/**
 * 氏名 → 認証サブジェクト（`/api/auth/staff` が発行する uid の後半と同じ導出）。
 * ★ ログイン側は tc5_staff の氏名を「そのまま」subjectKey へ通す。
 *   ここで trim や全角空白の正規化を挟むとサブジェクトが食い違い、
 *   当人だけが恒久的に 403 になる（原因が画面から見えない形で壊れる）。
 */
function subjectOf(staffName) { return S.subjectKey(String(staffName)); }

/**
 * サブジェクト導出に使う氏名の最小限の無害化。
 * 制御文字の除去と長さ制限だけを行い、**trim はしない**（上記の理由）。
 */
function normName(v, max) {
  if (typeof v !== "string") return "";
  var out = "";
  for (var i = 0; i < v.length; i++) {
    var c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) continue;
    out += v.charAt(i);
  }
  return out.length > max ? out.slice(0, max) : out;
}

/** 社員番号 → 氏名（`/mileage/staff` のスナップショット。tc5_staff は参照しない）。 */
async function loadStaffNames() {
  const raw = await G.dbGet(ROOT + "/staff");
  const out = {};
  if (raw && typeof raw === "object") {
    for (const eid of Object.keys(raw)) {
      const r = raw[eid];
      if (r && typeof r === "object" && typeof r.name === "string") out[eid] = r.name;
    }
  }
  return out;
}

/** 利用許可（既定 OFF）。未存在・false・その他はすべて OFF として扱う（フェイルクローズ）。 */
async function isEnabled(employeeId) {
  if (!isEmployeeId(employeeId)) return false;
  const v = await G.dbGet(ROOT + "/enabled/" + employeeId);
  return v === true;
}

// ===== マスタ =====

async function loadPlaces() {
  const raw = await G.dbGet(ROOT + "/places");
  const out = [];
  if (raw && typeof raw === "object") {
    for (const id of Object.keys(raw)) {
      const p = raw[id];
      if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
      // facility ＝ この地点に対応する「打刻の施設名」（現在の名前）。応援打刻からの自動集計で使う。
      // aliases ＝ 同じ地点を指す**旧施設名**。施設マスタには改名機能が無く「削除＋追加」になるため、
      //   改名すると過去の tc5_records.workFacility は旧名のまま残る。旧名をここへ入れておくと、
      //   過去打刻と新規打刻の両方が同じ地点として集計される（過去の打刻は書き換えない）。
      // 未設定の地点は、地点名と施設名が完全一致する場合だけ対応づける（mileage-auto.placeMap）。
      // ★ trim する。placeMap は trim して突き合わせるのに、重複検査が生値だと規則がずれる。
      const facility = typeof p.facility === "string" ? p.facility.trim() : "";
      const aliases = normFacilityList(p.aliases, facility);
      out.push({ id: id, name: p.name, order: Number(p.order) || 0, active: p.active !== false,
                 facility: facility, aliases: aliases,
                 // facilities ＝ この地点に対応づくすべての施設名。集計側はこれだけを見る。
                 facilities: (facility ? [facility] : []).concat(aliases) });
    }
  }
  out.sort(function (a, b) {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name, "ja");
  });
  return out;
}

function legKey(fromId, toId) { return fromId + "__" + toId; }

async function loadLegs() {
  const raw = await G.dbGet(ROOT + "/legs");
  const out = {};
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) {
      const l = raw[k];
      const km = l && typeof l === "object" ? normKm(l.km) : null;
      if (km == null) continue;
      out[k] = km;
    }
  }
  return out;
}

async function loadSettings() {
  const raw = await G.dbGet(ROOT + "/settings");
  const rate = raw && typeof raw === "object" ? normRate(raw.ratePerKm) : null;
  const mode = raw && typeof raw === "object" && ROUND_MODES.indexOf(raw.roundMode) >= 0
    ? raw.roundMode : DEFAULT_ROUND;
  return {
    ratePerKm: rate == null ? DEFAULT_RATE : rate,
    roundMode: mode,
    updatedAt: (raw && raw.updatedAt) || "",
    // 既定値のままか（管理画面で「未設定」と出し分けるため）
    configured: !!(raw && typeof raw === "object" && normRate(raw.ratePerKm) != null),
  };
}

// ===== 経路 → 区間 → 距離 =====

/**
 * 地点IDの並び（例 [本社, ナナイロ, ハルイロ, 本社]）から区間を組み立て、距離を引く。
 * 戻り値 { legs:[{from,to,km|null}], totalKm, missing:[{from,to}] }
 *
 * ★ 未登録区間を 0km として扱ってはならない。km=null のまま返し、
 *   呼び出し側が「申請として確定できない」と判断できるようにする。
 */
function buildRoute(placeIds, legMap, placeById) {
  const legs = [];
  const missing = [];
  let total = 0;
  for (let i = 0; i + 1 < placeIds.length; i++) {
    const from = placeIds[i], to = placeIds[i + 1];
    const km = Object.prototype.hasOwnProperty.call(legMap, legKey(from, to)) ? legMap[legKey(from, to)] : null;
    legs.push({
      from: from,
      to: to,
      fromName: placeById[from] ? placeById[from].name : "",
      toName: placeById[to] ? placeById[to].name : "",
      km: km,
    });
    if (km == null) missing.push({ from: from, to: to });
    else total = round1(total + km);
  }
  return { legs: legs, totalKm: round1(total), missing: missing };
}

/**
 * 申請1件の経路を検証する。エラーなら { error } を返す。
 * ・地点は2つ以上（＝区間が1つ以上）
 * ・同じ地点の連続は不可（距離0の無意味な区間になるため）
 * ・存在しない/無効な地点IDは不可
 */
const MAX_PLACES = 20; // 1日あたりの地点数上限（Excelは11区間＝12地点。余裕をみて20）

function validateRoute(placeIds, placeById) {
  if (!Array.isArray(placeIds)) return { error: "bad_route" };
  if (placeIds.length < 2) return { error: "route_too_short" };
  if (placeIds.length > MAX_PLACES) return { error: "route_too_long" };
  for (let i = 0; i < placeIds.length; i++) {
    const id = placeIds[i];
    if (!isId(id) || !placeById[id]) return { error: "unknown_place" };
    if (i > 0 && placeIds[i - 1] === id) return { error: "duplicate_consecutive_place" };
  }
  return { ok: true };
}

// ===== 金額 =====

/**
 * 月間支給額。★ 丸めは「月合計距離 × 単価」に対して1回だけ行う。
 *   日ごとに丸めて合計すると、同じ距離でも日の分け方で金額が変わってしまう。
 *   現行Excelは丸めていない（日別金額の単純合計＝月合計距離×単価と一致）ので、
 *   丸め位置を月次1回にしても現行と最も近い結果になる。
 */
function monthlyAmount(totalKm, ratePerKm, roundMode) {
  return applyRound(round1(totalKm) * Number(ratePerKm), roundMode);
}

// ===== 監査ログ =====

function nowIso() { return new Date().toISOString(); }

/** JST の "YYYY-MM" / "YYYY-MM-DD"（既存クライアントの getTodayJSTStr と同じ考え方）。 */
function todayJst() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }

/**
 * 申請できる日付の範囲（JST基準）。
 * ★ 範囲を設けないと、打ち間違いや誤操作で 2019 年や 2040 年の申請が作れてしまう。
 *   月次確定は月単位なので、そのような行は誰にも気づかれないまま残る。
 *   過去12か月〜翌月末までに限定する（締め遅れの遡り入力は通す）。
 */
const BACK_MONTHS = 12;
function dateWindow() {
  const t = todayJst();
  const y = parseInt(t.slice(0, 4), 10), m = parseInt(t.slice(5, 7), 10);
  let by = y, bm = m - BACK_MONTHS;
  while (bm < 1) { bm += 12; by--; }
  let fy = y, fm = m + 1;
  if (fm > 12) { fm = 1; fy++; }
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return { minYm: by + "-" + p(bm), maxYm: fy + "-" + p(fm) };
}
function isDateInWindow(dateStr) {
  const w = dateWindow();
  const ym = ymOf(dateStr);
  return ym >= w.minYm && ym <= w.maxYm;
}

/**
 * 変更履歴を残す。金額に関わるため「誰が・いつ・何を」を追跡できるようにする。
 * ★ 失敗しても本処理は止めない（履歴の書込失敗で申請ができなくなる方が実害が大きい）。
 *   ただし失敗はサーバログへ残す。
 */
function audit(actor, action, target, detail) {
  const ym = todayJst().slice(0, 7);
  const id = "log_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  return G.dbPut(ROOT + "/audit/" + ym + "/" + id, {
    at: nowIso(),
    actor: actor,
    action: action,
    target: target || "",
    detail: detail === undefined ? null : detail,
  }).catch(function (e) {
    console.error("[mileage audit]", action, e && e.message);
  });
}

/** /mileage が初期化済みか。未初期化なら管理者の最初の操作で作る。 */
async function ensureMeta() {
  const meta = await G.dbGet(ROOT + "/_meta");
  if (meta && typeof meta === "object") return;
  await G.dbPut(ROOT + "/_meta", { createdAt: nowIso(), version: 1 });
}

module.exports = {
  ROOT,
  ROUND_MODES,
  DEFAULT_RATE,
  DEFAULT_ROUND,
  applyRound,
  round1,
  isId,
  isYm,
  isDate,
  isEmployeeId,
  ymOf,
  normKm,
  normRate,
  normText,
  normName,
  normFacilityList,
  resolveIdentity,
  isValidAdmin,
  isValidViewer,
  resolveStaff,
  loadStaffNames,
  isEnabled,
  subjectOf,
  loadPlaces,
  loadLegs,
  loadSettings,
  legKey,
  buildRoute,
  validateRoute,
  monthlyAmount,
  audit,
  ensureMeta,
  nowIso,
  todayJst,
  dateWindow,
  isDateInWindow,
  MAX_PLACES,
};
