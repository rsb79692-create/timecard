/**
 * morning-check.js — Phase 2-D rev.6
 * 朝出勤未確認施設を Firebase RTDB から取得し LINE へ Push 通知する
 * GitHub Actions から実行。Node.js 標準モジュールのみ（npm install 不要）。
 */

"use strict";

const https = require("https");
const crypto = require("crypto");

// ===== Secrets バリデーション =====
const REQUIRED_SECRETS = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
];
const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("[ERROR] 以下の GitHub Secret が未設定です: " + missing.join(", "));
  process.exit(1);
}

// LINE_TO_ID: 必須。未設定または "temp" の場合は明確なエラーで停止。
const LINE_TO_ENV = (process.env.LINE_TO_ID || "").trim();
if (!LINE_TO_ENV || LINE_TO_ENV === "temp") {
  console.error("[ERROR] LINE_TO_ID が未設定です");
  console.error("GitHub Secrets → LINE_TO_ID を設定してください");
  process.exit(1);
}

const FB_API_KEY  = process.env.FIREBASE_API_KEY;
const FB_DB_URL   = process.env.FIREBASE_DATABASE_URL.replace(/\/$/, ""); // 末尾スラッシュ除去
const LINE_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN; // ログ出力禁止
const LINE_TO     = LINE_TO_ENV;

// testNotify=true のとき Firebase をスキップしてテスト通知のみ送信
const TEST_NOTIFY = (process.env.TEST_NOTIFY || "").trim() === "true";

// dryRun=true のとき LINE 送信しない（判定ログのみ）
const DRY_RUN = (process.env.DRY_RUN || "").trim() === "true";

// targetDate: 任意の日付 yyyy-mm-dd。空欄なら JST 今日。
const TARGET_DATE_ENV = (process.env.TARGET_DATE || "").trim();
const IS_DATE_OVERRIDE = /^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE_ENV);

// selfTest=true のとき、二重通知防止の条件付き書き込みが本番 RTDB で機能するかだけを確かめる（LINE は送らない）
const DEDUPE_SELFTEST = (process.env.DEDUPE_SELFTEST || "").trim() === "true";

// ===== 二重通知防止の記録に使うサービスアカウント =====
// ⚠ 通知記録（/morningNotify）は database.rules.json に未定義＝クライアントからは読み書きできない。
//   匿名アカウントや一般スタッフが「送信済み」を先に書いて通知を止められないよう、そこへ置いている。
//   書けるのはルールを迂回するサービスアカウントだけ（fcm-notify / notify-check と同じ Secret）。
// ⚠ 実送信の回でこれが無ければ送らずに止める。記録なしで送ると同一枠の二重通知を防げない。
let SERVICE_ACCOUNT = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    if (sa && sa.client_email && sa.private_key) SERVICE_ACCOUNT = sa;
  } catch (_) {
    // 値そのものは出さない
  }
  if (!SERVICE_ACCOUNT) {
    console.error("[ERROR] FIREBASE_SERVICE_ACCOUNT_KEY を解釈できません（JSON / client_email / private_key）");
    process.exit(1);
  }
}
if (!SERVICE_ACCOUNT && ((!DRY_RUN && !TEST_NOTIFY) || DEDUPE_SELFTEST)) {
  console.error("[ERROR] FIREBASE_SERVICE_ACCOUNT_KEY が未設定です。");
  console.error("[ERROR] 同一日・同一施設・同一判定時刻の通知記録を確認できないため、二重通知を避けて送信しません。");
  process.exit(1);
}

// 通知記録へ残す実行ID（ログ・記録用。秘密情報ではない）
const RUN_ID = (
  (process.env.GITHUB_RUN_ID || "local") + "-" + (process.env.GITHUB_RUN_ATTEMPT || "0") + "-" +
  crypto.randomBytes(4).toString("hex")
).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);

// MORNING-CHECK-HOURS-BEGIN
// ===== 施設一覧の控え兼「監視が成立しているかの期待値」 =====
// ⚠⚠ **index.html と同期しないこと。** index.html 側の DEFAULT_FACILITIES は空配列であり
//    （実施設名を配布物へ埋め込まないため）、ここへ写すと下の2つの役割が同時に壊れる。
//    ① master/locations を取得できなかったときのフォールバック
//    ② expectedFacilityCountForHour() が使う「この判定時刻に何件在るはず」の期待値。
//       施設マスタは一般スタッフでも書けるので、期待値だけは改ざんされない場所に置く必要がある。
//       空にすると期待値が常に0になり、施設を消されても「設定異常」を検知できなくなる。
// **施設が増減したときはここを更新する。**
const DEFAULT_FACILITIES = [
  "ナナイロ", "ココラ", "ハーベスト",
  "ミュゲ貝塚", "ミュゲ春木", "ミュゲの泉", "ハルイロ",
];

// ===== 朝打刻通知から除外する施設 =====
// ハーベストは朝の未打刻通知の対象外（打刻機能・管理画面は通常通り）
const NOTIFY_EXCLUDE = ["ハーベスト"];

// ===== 施設別 未打刻判定時刻（JST時） =====
// 1回の実行は「その回の判定時刻に属する施設」だけを見る。
// 施設は必ず 1 つの判定時刻にしか属さないため、6時の回と7時の回で同じ施設へ二重通知されない。
//
// ⚠ 判定時刻の正本はこのコード（LATE_CHECK_FACILITIES）である。施設マスタ側には持たせない。
//   RTDB の master/locations は `.write` が /honomi から継承され、管理者だけでなく
//   **一般スタッフ（auth.token.r === 's'）でも書ける**（database.rules.json 参照）。
//   そこへ判定時刻を置くと、6時の回の直前に「全施設=7時」、7時の回の直前に「全施設=6時」と
//   書き換えるだけで、その日の未打刻通知を1件も出さずに Actions を success のまま終わらせられる。
//   画面のどこにも出ないフィールドなので、誰も異常に気づけない。
//   （同じ理由で移動距離申請も master/locations をサーバ側の判断材料にしていない。AGENTS.md 参照）
//   施設マスタは「どの施設が在るか」の正本として使い、判定時刻はコード側で持つ。
const DEFAULT_CHECK_HOUR = 6;

// GitHub Actions が実際に回している判定時刻。ここに無い値は採用しない（フェイルクローズ）。
// ⚠ 値を増やすときは .github/workflows/morning-check.yml の cron も必ず足すこと。
//   cron の無い時刻を書いても、その施設は誰にも判定されず通知が消える。
//   この対応は scripts/test-morning-check.js が機械的に検証する。
const CHECK_HOURS = [6, 7];

// 既定（6時）と異なる判定時刻を持つ施設。キーは施設名を normalizeFacility したもの。
// ここに書いた施設名が施設マスタに見当たらない場合は findMissingLateFacilities が警告する。
const LATE_CHECK_FACILITIES = {
  "ハルイロ": 7,
  "ミュゲの泉": 7,
};

// 施設マスタから受け入れる上限。master/locations は一般スタッフでも書けるため、
// 件数・名前の長さを無制限に信用しない（ログ肥大・LINE本文の肥大による送信失敗を防ぐ）。
const MAX_FACILITIES = 50;
const MAX_FACILITY_NAME_LEN = 40;

// ===== 施設名正規化（NFKC・空白除去） =====
function normalizeFacility(s) {
  return (s || "").normalize("NFKC").replace(/\s+/g, "").trim();
}

// 施設マスタのエントリは文字列 or {name, token, ...}。施設名だけを取り出す。
function facilityEntryName(f) {
  if (typeof f === "string") return f.trim();
  return (f && typeof f === "object" && typeof f.name === "string") ? f.name.trim() : "";
}

// 表示・ログ用の文字列。改行・制御文字・不可視文字を落として長さを詰める。
// ⚠ 施設名は一般スタッフが、打刻レコードの値は匿名でも書き換えられ、
//   そのまま LINE 通知の本文と PUBLIC な Actions ログへ入る。
//   改行を含む値を書かれると、管理者が信頼している通知経路やログへ任意の行を差し込める。
//   照合には使わない（照合は normalizeFacility 側で行う）。
function safeFacilityLabel(name) {
  const flat = String(name || "")
    // 照合側（normalizeFacility）と同じ正規化をかけてから落とす。全角の "：" 等での回避を防ぐ。
    .normalize("NFKC")
    // C0/C1 制御・DEL・行区切り・ゼロ幅・双方向制御・タグ文字・異体字セレクタ・
    // 見た目が空白のフィラー（見た目の偽装や不可視の埋め込みに使える文字）を落とす
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u115f\u1160\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu,
      " "
    )
    .replace(/[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, " ")
    // リンクとして解釈されないよう無害化する（管理者が信頼している通知経路での誘導を防ぐ）。
    // ⚠ "://" だけでは足りない。LINE は "www.example.com" や裸ドメインも自動リンクする。
    //   施設名は日本語運用なので、ASCII のスキーム記号とドットを潰しても業務表示に実害はない。
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):/g, "$1[:]")
    .replace(/\.(?=[A-Za-z0-9-])/g, "[.]")
    .trim();
  // ⚠ slice ではなくコードポイント単位で切る。UTF-16 単位で切ると絵文字の途中で割れて
  //   孤立サロゲートが LINE のペイロードへ入り、その回の送信ごと失敗しうる。
  const cps = Array.from(flat);
  return cps.length > MAX_FACILITY_NAME_LEN
    ? cps.slice(0, MAX_FACILITY_NAME_LEN).join("") + "…"
    : flat;
}

// ログ用に文字コードを可視化する（診断目的なので制御文字を消さず16進で見せる）。
// ⚠ 入力は匿名でも書ける値なので、こちらも長さを切る（公開 Actions ログの肥大を防ぐ）。
function facilityCodePoints(name) {
  const cps = Array.from(String(name || ""));
  const head = cps.slice(0, MAX_FACILITY_NAME_LEN).map((c) => c.codePointAt(0).toString(16)).join(" ");
  return cps.length > MAX_FACILITY_NAME_LEN ? head + " …" : head;
}

function isValidCheckHour(h) {
  return typeof h === "number" && Number.isInteger(h) && CHECK_HOURS.indexOf(h) !== -1;
}

// LATE_CHECK_FACILITIES のキーを正規化した索引。
// ⚠ 判定側と検知側（findMissingLateFacilities）で必ず同じ索引を使う。
//   片方だけが正規化していると、未正規化のキーを書いたときに
//   「判定は既定6時へ落ちるのに警告は出ない」という最悪の組み合わせになる。
// ⚠ 継承プロパティ（"constructor" 等の施設名）を引かないよう Object.create(null) を使う。
const LATE_CHECK_BY_NORM = (function () {
  const m = Object.create(null);
  Object.keys(LATE_CHECK_FACILITIES).forEach((k) => {
    const norm = normalizeFacility(k);
    const hour = LATE_CHECK_FACILITIES[k];
    if (!isValidCheckHour(hour)) {
      console.error(`[ERROR] LATE_CHECK_FACILITIES["${k}"] = ${JSON.stringify(hour)} は判定時刻として無効です。`);
      process.exit(1);
    }
    if (m[norm] !== undefined && m[norm] !== hour) {
      console.error(`[ERROR] LATE_CHECK_FACILITIES に正規化後同じ施設名で別の判定時刻があります: "${k}"`);
      process.exit(1);
    }
    m[norm] = hour;
  });
  return m;
})();

// 施設マスタのエントリ 1 件の判定時刻を決める。
function resolveCheckHour(f) {
  const late = LATE_CHECK_BY_NORM[normalizeFacility(facilityEntryName(f))];
  return isValidCheckHour(late) ? late : DEFAULT_CHECK_HOUR;
}

// コード側で「この判定時刻に在るはず」の施設数。DEFAULT_FACILITIES から導く。
// 施設マスタ（一般スタッフが書ける）が壊れても、この期待値は改ざんされない。
function expectedFacilityCountForHour(hour) {
  const excludeNorms = NOTIFY_EXCLUDE.map(normalizeFacility);
  return DEFAULT_FACILITIES.filter(
    (n) => !excludeNorms.includes(normalizeFacility(n)) && resolveCheckHour(n) === hour
  ).length;
}

// この回（hour）で判定する施設エントリだけを返す。
// 正規化後に同名となるエントリ（"ハルイロ" と "ハル イロ" 等）は 1 件へ寄せる。
// 施設マスタの重複チェックは完全一致だけなので、表記ゆれの重複が実際に入りうる。
function selectFacilitiesForHour(entries, hour) {
  const seen = Object.create(null);
  const out = [];
  (entries || []).forEach((f) => {
    const name = facilityEntryName(f);
    if (name === "") return;
    if (resolveCheckHour(f) !== hour) return;
    const key = normalizeFacility(name);
    if (seen[key]) return;
    seen[key] = true;
    out.push(f);
  });
  return out;
}

// LATE_CHECK_FACILITIES に書いた施設名が施設マスタに見当たらない場合、
// 改名・表記ゆれで判定時刻の指定が外れている（既定の6時側へ戻ってしまう）。気づけるようにする。
function findMissingLateFacilities(entries) {
  const norms = (entries || []).map((f) => normalizeFacility(facilityEntryName(f)));
  return Object.keys(LATE_CHECK_FACILITIES).filter(
    (k) => norms.indexOf(normalizeFacility(k)) === -1
  );
}

// この判定時刻の監視が成立しているか。成立していない理由（＝黙って落ちる原因）を返す。
// ⚠ 「その回が見るはずの施設」だけを対象にする。別の判定時刻の施設の異常を混ぜると、
//    正しく動いている回にまで「行えていません」と通知してしまう。
// fallbackReason: 施設マスタを採用できずコード側の控えで走っているときの理由（無ければ null）。
function findMonitoringAnomalies(entries, hour, selectedCount, fallbackReason) {
  const anomalies = [];
  // この判定時刻に割り当てた施設のうち、施設マスタに見当たらないもの（改名・表記ゆれ・削除）
  const missing = findMissingLateFacilities(entries).filter(
    (k) => LATE_CHECK_BY_NORM[normalizeFacility(k)] === hour
  );
  if (missing.length > 0) {
    anomalies.push(`${hour}時に判定するはずの施設が施設マスタにありません: ${missing.map(safeFacilityLabel).join(", ")}`);
  }
  // ⚠ 「0件」だけを見ては足りない。4件中3件を改名されても残り1件で成立してしまい、
  //    消された施設の未打刻通知が恒久的に消える。期待件数に満たない時点で異常とする。
  const expected = expectedFacilityCountForHour(hour);
  if (selectedCount < expected) {
    anomalies.push(
      selectedCount === 0
        ? `${hour}時に判定する施設が1件もありません（本来 ${expected} 件）`
        : `${hour}時に判定する施設が ${selectedCount} 件しかありません（本来 ${expected} 件）`
    );
  }
  // 施設マスタを採用できていない＝古い控えで走っている。新設施設は監視外になる。
  if (fallbackReason) {
    anomalies.push(`施設マスタを採用できませんでした（${fallbackReason}）。コード側の控えで判定しています。`);
  }
  return anomalies;
}
// MORNING-CHECK-HOURS-END

// MORNING-CHECK-DEDUPE-BEGIN
// ===== 同一日 × 同一施設 × 同一判定時刻の通知を最大1回にする（永続的な冪等制御） =====
// 起動経路は二重化してある（外部スケジューラの workflow_dispatch と、遅れて走る schedule の cron）。
// どちらも止めずに、2回目以降の実行が同じ枠へ再送しないことをここで保証する。
//
// 記録: RTDB /morningNotify/{判定対象日}/h{判定時刻}（1ノード）
//   slots.{枠キー}   = {state, batch, runId, leaseUntil, attempts, lastStatus, updatedAt, sentAt}
//   batches.{送信ID} = {retryKey, text, createdAt, runId, outcome, doneAt}
//   枠キー = 施設名（normalizeFacility 後）の SHA-256 先頭32桁 ／ 設定異常は "anomaly"
//
// 状態:
//   sending … ある実行が送信権を持つ（leaseUntil まで他の実行は触らない）
//   sent    … LINE が受け付けた（200）か、同じ retry key が受付済み（409）。以後送らない
//   retry   … 送れたか分からない（5xx・429・通信断・タイムアウト）。**同じ本文・同じ retry key でのみ**再送する
//   failed  … LINE が明確に拒否した（409/429 以外の 4xx）＝受け付けていない。次の実行が新しい送信として作り直してよい
//   gaveup / expired … もう自動では送らない（二重通知の危険を取らない）
//
// ⚠⚠ 競合: ノード全体を ETag の条件付き書き込み（if-match）で1回に確保する。
//    同時に走った実行は片方だけが確保に成功し、もう片方は 412 で読み直して「送信中／送信済み」を見る。
//    「読んでから書く」を条件なしで行ってはならない（両方が未送信と判断して2通出る）。
// ⚠⚠ クラッシュ: 確保 → 送信 → 記録 の途中で落ちても、送信内容と retry key を先に記録してあるので、
//    リース切れ後の実行が**同じ要求をそのまま**再送する。LINE は24時間以内の同一 retry key を 409 で弾く。
//    本文を作り直して新しい retry key で送ると二重通知になる。
// ⚠ 記録を読めない・書けないときは送らない（exit 1）。二重送信より、赤い実行として気づかせる方を選ぶ。
const DEDUPE_ROOT = "morningNotify";
const DEDUPE_ANOMALY_SLOT = "anomaly";
const DEDUPE_LEASE_MS = 10 * 60 * 1000;       // 送信権の保持時間。1回の送信（最大 約1分）より十分長く
// 他の実行が送信中なら、そのリースが切れるまで待つ（切れたら同じ要求を引き継いで再送する）。
// ⚠ リースより短く待って抜けると、送信権を持った実行が落ちていた場合に誰も再送せず、その日の通知が黙って消える。
const DEDUPE_WAIT_MS = DEDUPE_LEASE_MS + 60 * 1000;
const DEDUPE_POLL_MS = 10 * 1000;
const DEDUPE_MAX_ATTEMPTS = 3;                // 1枠あたりの送信試行（実行をまたいだ合計）
const DEDUPE_RETRY_KEY_TTL_MS = 23 * 60 * 60 * 1000; // LINE の retry key は24時間有効。余裕を持って23時間
const DEDUPE_CAS_TRIES = 8;
// 記録の読み取り・OAuth の一時的な失敗は、送信前なので何度試しても二重通知にならない。瞬断で朝の通知を落とさない
const DEDUPE_IO_TRIES = 3;
const DEDUPE_IO_RETRY_MS = [2000, 5000];
const LINE_SEND_TRIES = 3;                    // 1回の実行内の送信試行（同じ retry key）
const LINE_RETRY_DELAYS_MS = [2000, 6000];
const HTTP_TIMEOUT_MS = 15 * 1000;
const RETRY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 再送する本文の検査（多層防御）。記録はサービスアカウントしか書けないが、万一書き換えられても
// 固定の見出しで始まらない本文・LINE の上限を超える本文は管理者の LINE へ流さない。
const MORNING_MESSAGE_PREFIX = "【穂乃味タイムカード】\n朝出勤未確認（";
const MAX_MESSAGE_LEN = 5000;

// 通知記録のベース URL。
// ⚠⚠ FIREBASE_DATABASE_URL は ".../honomi" で終わる（判定データはその配下から読む）。
//    それをそのままベースにすると記録は /honomi/morningNotify になり、`/honomi` の .write を持つ
//    一般スタッフ（r==='s'）が「送信済み」を書いて通知を止めたり、再送用の本文を差し込めたりする。
//    必ずオリジン（ルート直下＝ルール未定義＝クライアントからは読み書き不可）を使う。
//    api/_lib/google.js の dbRootBase() と同じ方式。
function dedupeBaseUrl(dbUrl) {
  let u;
  try { u = new URL(String(dbUrl || "")); } catch (_) { throw new Error("dedupe: FIREBASE_DATABASE_URL を解釈できません"); }
  if (u.protocol !== "https:") throw new Error("dedupe: FIREBASE_DATABASE_URL が https ではありません");
  return u.origin;
}

function dedupeOwn(o, k) {
  return !!o && Object.prototype.hasOwnProperty.call(o, k);
}

// 施設名 → 枠キー。表記ゆれ（"ハル イロ"）は同じ枠になる。RTDB のキーに使えない文字を含まない。
function dedupeSlotKey(facilityName) {
  const norm = normalizeFacility(facilityEntryName(facilityName));
  return "f_" + crypto.createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 32);
}

function dedupePath(date, hour) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error("dedupe: 判定対象日の形式が不正です");
  if (!isValidCheckHour(hour)) throw new Error("dedupe: 判定時刻が不正です");
  return `${DEDUPE_ROOT}/${date}/h${hour}`;
}

// LINE の応答 → sent / rejected / transient
function classifyLineResult(res) {
  if (!res || res.error) return "transient";          // 通信断・タイムアウト（受け付けたか分からない）
  const s = Number(res.status);
  if (s >= 200 && s < 300) return "sent";
  if (s === 409) return "sent";                       // 同じ retry key が受付済み＝もう届いている
  if (s === 429 || s >= 500) return "transient";
  if (s >= 400 && s < 500) return "rejected";         // 受け付けていない
  return "transient";
}

function dedupeCloneNode(node) {
  const n = node && typeof node === "object" && !Array.isArray(node) ? JSON.parse(JSON.stringify(node)) : {};
  if (!n.slots || typeof n.slots !== "object" || Array.isArray(n.slots)) n.slots = {};
  if (!n.batches || typeof n.batches !== "object" || Array.isArray(n.batches)) n.batches = {};
  return n;
}

// 現在の記録と今回の通知候補から「何を送るか」と「書き込む記録」を決める（純粋関数）。
// candidates: [{slot, kind: "facility"|"anomaly", name?}]
// opts: {now, runId, newBatchId, newRetryKey, buildText(fresh) → string}
function planDedupe(node, candidates, opts) {
  const now = opts.now;
  const next = dedupeCloneNode(node);
  const out = {
    next, changed: false, resend: [], fresh: [], newBatch: null,
    skipped: [], inflight: [], terminal: [],
  };
  // 記録ノード自体の破損。空とみなすと送信済みの枠まで送り直すので、全候補を送らずに止める
  const badShape = (v) => v !== undefined && v !== null && (typeof v !== "object" || Array.isArray(v));
  if (badShape(node) || (node && (badShape(node.slots) || badShape(node.batches)))) {
    (candidates || []).forEach((c) => {
      if (!c || typeof c.slot !== "string") return;
      out.terminal.push({ cand: c, reason: "unknown_state" });
      out.skipped.push({ cand: c, reason: "unknown_state" });
    });
    return out;
  }
  const handled = Object.create(null);
  const isResendable = (st) =>
    !!st && (st.state === "retry" || (st.state === "sending" && !(Number(st.leaseUntil) > now)));

  (candidates || []).forEach((c) => {
    if (!c || typeof c.slot !== "string" || handled[c.slot]) return;
    handled[c.slot] = true;
    const st = dedupeOwn(next.slots, c.slot) ? next.slots[c.slot] : null;
    if (st === null || st === undefined) { out.fresh.push(c); return; }
    if (typeof st !== "object" || Array.isArray(st)) {
      // 記録の破損。未送信とみなして送ると二重通知になりうる
      out.terminal.push({ cand: c, reason: "unknown_state" });
      out.skipped.push({ cand: c, reason: "unknown_state" });
      return;
    }
    const attempts = Number(st.attempts) || 0;

    if (st.state === "sent" || st.state === "gaveup" || st.state === "expired") {
      out.skipped.push({ cand: c, reason: st.state });
      return;
    }
    if (st.state === "failed") {
      if (attempts >= DEDUPE_MAX_ATTEMPTS) {
        st.state = "gaveup"; st.updatedAt = now; out.changed = true;
        out.terminal.push({ cand: c, reason: "gaveup" });
        out.skipped.push({ cand: c, reason: "gaveup" });
        return;
      }
      out.fresh.push(c);
      return;
    }
    if (st.state === "sending" && Number(st.leaseUntil) > now) {
      out.inflight.push(c);
      return;
    }
    if (isResendable(st)) {
      const bid = st.batch;
      const b = typeof bid === "string" && dedupeOwn(next.batches, bid) ? next.batches[bid] : null;
      // 同じ送信に属する枠は必ずまとめて扱う（本文が1通なので、枠ごとに分けて再送できない）
      const members = typeof bid === "string" && b
        ? Object.keys(next.slots).filter((k) => next.slots[k] && next.slots[k].batch === bid && isResendable(next.slots[k]))
        : [c.slot];
      let reason = null;
      if (!b || typeof b.text !== "string" || b.text === "" || !RETRY_KEY_RE.test(String(b.retryKey)) ||
          b.text.indexOf(MORNING_MESSAGE_PREFIX) !== 0 || b.text.length > MAX_MESSAGE_LEN) {
        reason = "expired";    // 同じ要求を再現できない。作り直すと二重通知になりうるので送らない
      } else if (!(now - Number(b.createdAt) <= DEDUPE_RETRY_KEY_TTL_MS)) {
        reason = "expired";    // retry key の有効期限切れ。LINE 側で重複を弾けない
      } else if (members.some((k) => (Number(next.slots[k].attempts) || 0) >= DEDUPE_MAX_ATTEMPTS)) {
        reason = "gaveup";
      }
      members.forEach((k) => { handled[k] = true; });
      if (reason) {
        members.forEach((k) => { next.slots[k].state = reason; next.slots[k].updatedAt = now; });
        out.changed = true;
        out.terminal.push({ cand: c, reason });
        out.skipped.push({ cand: c, reason });
        return;
      }
      members.forEach((k) => {
        const s = next.slots[k];
        s.state = "sending"; s.runId = opts.runId; s.leaseUntil = now + DEDUPE_LEASE_MS;
        s.attempts = (Number(s.attempts) || 0) + 1; s.updatedAt = now;
      });
      out.changed = true;
      out.resend.push({ batchId: bid, retryKey: b.retryKey, text: b.text, slots: members });
      return;
    }
    // 想定外の状態（記録の破損）。送ると二重通知になりうるので送らない。緑で黙って終わらせない
    out.terminal.push({ cand: c, reason: "unknown_state" });
    out.skipped.push({ cand: c, reason: "unknown_state" });
  });

  if (out.fresh.length > 0) {
    // 「通知済み」と書けるのは sent の施設だけ（送信中・gaveup 等を通知済みと書かない）
    const notifiedFacilityCount = out.skipped.filter((s) => s.reason === "sent" && s.cand.kind === "facility").length;
    const text = opts.buildText(out.fresh, { notifiedFacilityCount });
    if (typeof text === "string" && text !== "") {
      const bid = opts.newBatchId;
      const retryKey = opts.newRetryKey;
      next.batches[bid] = { retryKey, text, createdAt: now, runId: opts.runId };
      out.fresh.forEach((c) => {
        const prev = dedupeOwn(next.slots, c.slot) ? next.slots[c.slot] : null;
        next.slots[c.slot] = {
          state: "sending", batch: bid, runId: opts.runId, leaseUntil: now + DEDUPE_LEASE_MS,
          attempts: ((prev && Number(prev.attempts)) || 0) + 1, updatedAt: now,
        };
      });
      out.newBatch = { batchId: bid, retryKey, text, slots: out.fresh.map((c) => c.slot) };
      out.changed = true;
    } else {
      out.fresh = [];
    }
  }
  return out;
}

// 送信結果を記録へ反映する（純粋関数）。自分が送信権を持つ枠だけを書き換える。
function finalizeDedupe(node, batch, runId, outcome, now, status) {
  const next = dedupeCloneNode(node);
  let touched = 0;
  batch.slots.forEach((k) => {
    const st = dedupeOwn(next.slots, k) ? next.slots[k] : null;
    if (!st || st.batch !== batch.batchId || st.runId !== runId || st.state !== "sending") return;
    touched++;
    if (outcome === "sent") { st.state = "sent"; st.sentAt = now; }
    else if (outcome === "rejected") { st.state = "failed"; }
    else { st.state = "retry"; st.leaseUntil = 0; }
    st.lastStatus = status;
    st.updatedAt = now;
  });
  const b = dedupeOwn(next.batches, batch.batchId) ? next.batches[batch.batchId] : null;
  if (b && touched > 0 && outcome !== "transient") {
    // もう再送しないので本文は残さない（retry key は追跡用に残す）
    delete b.text;
    b.outcome = outcome;
    b.doneAt = now;
  }
  return { next, touched };
}

// 1回の実行内の送信。transient のときだけ**同じ本文・同じ retry key**で再試行する。
async function sendBatchWithRetry(sendOnce, batch, sleep) {
  let last = null;
  for (let i = 0; i < LINE_SEND_TRIES; i++) {
    if (i > 0) await sleep(LINE_RETRY_DELAYS_MS[Math.min(i - 1, LINE_RETRY_DELAYS_MS.length - 1)]);
    let res;
    try {
      res = await sendOnce(batch.text, batch.retryKey);
    } catch (e) {
      const code = e && typeof e.code === "string" && /^[A-Z_]{1,24}$/.test(e.code) ? e.code : "NETWORK";
      res = { error: code };
    }
    const outcome = classifyLineResult(res);
    last = { outcome, status: res && res.error ? res.error : Number(res && res.status) };
    if (outcome !== "transient") return last;
  }
  return last;
}

// 通知の本文。初回（通知済みの枠が無い）は従来と1文字も違わない。
// freshNames: 今回はじめて通知する未打刻施設 / suppressedCount: 通知済み等で今回は載せない未打刻施設の数
function buildMorningMessage(p) {
  const head = `【穂乃味タイムカード】\n朝出勤未確認（${p.hour}時判定）\n\n` +
    (p.targetDate ? `判定対象日：${p.targetDate}（手動指定）\n` : "") +
    `確認時刻：${p.nowStr}\n\n`;
  const names = p.freshNames || [];
  const suppressed = Number(p.suppressedCount) || 0;
  if (names.length === 0 && !p.anomalySection) return "";
  if (p.facilitiesCount === 0) return head + p.anomalySection.trimEnd();
  let section;
  if (names.length > 0) {
    section = `未確認施設：${names.length}件\n\n` +
      names.map((n) => `・${safeFacilityLabel(n)}`).join("\n") + "\n\n" +
      (suppressed > 0 ? `（ほか ${suppressed} 件は通知済みのため省略）\n\n` : "") +
      "シフトミス・遅刻・事故の可能性があります。確認してください。";
  } else if (suppressed > 0) {
    section = `未確認施設：新たな未確認はありません（通知済み ${suppressed} 件は再送しません）`;
  } else {
    section = "未確認施設：なし（判定できた施設はすべて出勤確認済み）";
  }
  return head + (p.anomalySection || "") + section;
}

// 通知記録の読み書き（RTDB REST の ETag 条件付き書き込み）
function makeRtdbDedupeStore(request, baseUrl, path, accessToken) {
  const url = `${baseUrl}/${path}.json`;
  const auth = { Authorization: `Bearer ${accessToken}` };
  return {
    async read() {
      const res = await request(url, {
        method: "GET",
        headers: Object.assign({ "X-Firebase-ETag": "true" }, auth),
        timeoutMs: HTTP_TIMEOUT_MS,
      });
      if (res.status !== 200) throw new Error(`dedupe: 通知記録を読めません（HTTP ${res.status}）`);
      const etag = res.headers && res.headers.etag;
      if (typeof etag !== "string" || etag === "") {
        throw new Error("dedupe: ETag を取得できません（条件付き書き込みができないため送信しません）");
      }
      return { value: res.body, etag };
    },
    async cas(value, etag) {
      const res = await request(url, {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json", "if-match": etag }, auth),
        timeoutMs: HTTP_TIMEOUT_MS,
      }, JSON.stringify(value));
      if (res.status === 200) return { ok: true };
      if (res.status === 412) return { ok: false };
      throw new Error(`dedupe: 通知記録を書けません（HTTP ${res.status}）`);
    },
  };
}

// LINE push を1回だけ送る。retry key を必ず付ける。
function makeLineSendOnce(request, token, to) {
  return async function (text, retryKey) {
    const res = await request(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token,
          "X-Line-Retry-Key": retryKey,
        },
        timeoutMs: HTTP_TIMEOUT_MS,
      },
      JSON.stringify({ to, messages: [{ type: "text", text }] })
    );
    return { status: res.status };
  };
}

// 確保 → 送信 → 記録。
// o: {store, candidates, buildText, sendOnce, sleep, now, runId, newBatchId, newRetryKey, dryRun, log}
async function notifyOnce(o) {
  const log = o.log || { info() {}, warn() {}, error() {} };
  const result = { plan: null, delivered: [], failures: [], inflight: [], skipped: [], terminal: [] };
  if (!o.candidates || o.candidates.length === 0) return result;

  const readWithRetry = async () => {
    for (let i = 0; ; i++) {
      try {
        return await o.store.read();
      } catch (e) {
        if (i + 1 >= DEDUPE_IO_TRIES) throw e;
        log.warn(`[DEDUPE] 通知記録の読み取りに失敗しました（${e.message}）。再試行します`);
        await o.sleep(DEDUPE_IO_RETRY_MS[Math.min(i, DEDUPE_IO_RETRY_MS.length - 1)]);
      }
    }
  };
  // 確保の書き込みで応答が失われたとき、実は書けていたかを確かめる（原子的に1回で書くので全枠そろって入っているかどうか）
  const claimLanded = (value, p) => {
    const bs = p.resend.concat(p.newBatch ? [p.newBatch] : []);
    if (bs.length === 0 || !value || !value.slots) return false;
    return bs.every((b) => b.slots.every((k) => {
      const st = dedupeOwn(value.slots, k) ? value.slots[k] : null;
      // leaseUntil まで一致を求める。同じ実行の古い確保が遅れて届いた場合を「今回書けた」と取り違えない
      return !!st && st.runId === o.runId && st.batch === b.batchId && st.state === "sending" &&
        st.leaseUntil === p.next.slots[k].leaseUntil;
    }));
  };

  const started = o.now();
  let plan = null;
  let conflicts = 0;
  let ioFailures = 0;
  for (;;) {
    const cur = await readWithRetry();
    const p = planDedupe(cur.value, o.candidates, {
      now: o.now(), runId: o.runId, newBatchId: o.newBatchId(), newRetryKey: o.newRetryKey(), buildText: o.buildText,
    });
    if (!o.dryRun && p.inflight.length > 0 && o.now() - started < DEDUPE_WAIT_MS) {
      log.info(`[DEDUPE] 他の実行が送信中の枠が ${p.inflight.length} 件あります。結果を待ちます`);
      await o.sleep(DEDUPE_POLL_MS);
      continue;
    }
    if (o.dryRun || !p.changed) { plan = p; break; }
    let w;
    try {
      w = await o.store.cas(p.next, cur.etag);
    } catch (e) {
      // 書けたか分からない。読み直して、自分の確保が入っていれば先へ進む（入っていなければ作り直す）
      log.warn(`[DEDUPE] 確保の書き込み結果が分かりません（${e.message}）。読み直します`);
      const chk = await readWithRetry();
      if (claimLanded(chk.value, p)) { plan = p; break; }
      ioFailures++;
      if (ioFailures >= DEDUPE_IO_TRIES) throw e;
      await o.sleep(DEDUPE_IO_RETRY_MS[Math.min(ioFailures - 1, DEDUPE_IO_RETRY_MS.length - 1)]);
      continue;
    }
    if (w.ok) { plan = p; break; }
    conflicts++;
    if (conflicts >= DEDUPE_CAS_TRIES) {
      throw new Error("dedupe: 通知記録の更新が競合し続けたため送信しません（二重通知を避けるため）");
    }
    log.info("[DEDUPE] 通知記録が他の実行に更新されました。読み直します");
    await o.sleep(200 * conflicts);
  }

  result.plan = plan;
  result.inflight = plan.inflight;
  result.skipped = plan.skipped;
  result.terminal = plan.terminal;
  if (o.dryRun) return result;

  const batches = plan.resend.concat(plan.newBatch ? [plan.newBatch] : []);
  for (const b of batches) {
    const r = await sendBatchWithRetry(o.sendOnce, b, o.sleep);
    let recorded = false;
    let lostOwnership = false;
    let doneByOthers = false;
    for (let i = 0; i < DEDUPE_CAS_TRIES && !recorded && !lostOwnership; i++) {
      try {
        const cur = await o.store.read();
        const f = finalizeDedupe(cur.value, b, o.runId, r.outcome, o.now(), r.status);
        if (f.touched === 0) {
          // 送信権が他の実行へ移っていた。その実行が送り終えている（全枠 sent）なら失敗ではない
          const vs = cur.value && cur.value.slots;
          // 同じ送信（同じ本文・retry key）が確定済みのときだけ。別の送信で sent なら二重に届いた可能性があるので失敗として残す
          if (vs && b.slots.every((k) => dedupeOwn(vs, k) && vs[k] && vs[k].state === "sent" && vs[k].batch === b.batchId)) {
            recorded = true; doneByOthers = true;
          }
          else lostOwnership = true;
          break;
        }
        const w = await o.store.cas(f.next, cur.etag);
        if (w.ok) recorded = true;
      } catch (e) {
        log.warn(`[DEDUPE] 送信結果の記録に失敗しました（${e.message}）`);
        await o.sleep(1000);
      }
    }
    if (r.outcome === "sent") result.delivered.push(b);
    // 他の実行が同じ送信を確定済みなら、こちらの送信結果が未確定でも失敗にしない（届いている）
    if (r.outcome !== "sent" && !doneByOthers) result.failures.push({ batch: b, reason: r.outcome, status: r.status });
    if (!recorded) {
      // 記録できなくても、リース切れ後の実行が同じ retry key で再送するので二重通知にはならない
      result.failures.push({ batch: b, reason: lostOwnership ? "lost_ownership" : "record_failed", status: r.status });
    }
  }
  return result;
}

// 本番 RTDB で条件付き書き込みが機能するかの確認（selfTest 専用。LINE は送らない）
async function dedupeSelfTest(store, runId, now) {
  const a = await store.read();
  const w1 = await store.cas({ runId, at: now }, a.etag);
  if (!w1.ok) return { ok: false, why: "最新の ETag での書き込みが拒否されました" };
  const w2 = await store.cas({ runId, at: now, stale: true }, a.etag);
  if (w2.ok) return { ok: false, why: "古い ETag での書き込みが通りました（競合を検出できません）" };
  const b = await store.read();
  if (!b.value || b.value.runId !== runId || b.value.stale) return { ok: false, why: "読み戻した値が一致しません" };
  return { ok: true };
}
// MORNING-CHECK-DEDUPE-END

// ===== この回の判定時刻 =====
// ワークフローが起動経路（cron 式 / 手動入力）から決めて CHECK_HOUR で渡す。
// ⚠ 実行時の JST 現在時からは決めない。GitHub Actions のスケジュールは数十分〜数時間遅れるため、
//   6時の回が7時台に走ると 6時の施設が判定されないまま、7時の施設へ二重通知される。
const CHECK_HOUR_ENV = (process.env.CHECK_HOUR || "").trim();
const CHECK_HOUR = (function () {
  if (CHECK_HOUR_ENV === "") {
    // ⚠ ワークフローは全経路で CHECK_HOUR を渡す。GitHub Actions 上で空なら受け渡しが壊れている。
    //   黙って6時で走らせると、7時の施設が誰にも判定されないまま success で終わる。
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error("[ERROR] CHECK_HOUR が渡っていません（ワークフローの「判定時刻を決める」ステップを確認してください）。");
      process.exit(1);
    }
    // ローカルでの手動実行（DRY_RUN 検証）のためだけの既定。
    return DEFAULT_CHECK_HOUR;
  }
  const n = Number(CHECK_HOUR_ENV);
  if (isValidCheckHour(n)) return n;
  // ⚠ 既定へ倒さない。無効値のまま6時として走ると、6時の施設へ二重通知しつつ
  //   7時の施設は誰にも判定されないまま success で終わり、誰も気づけない。
  console.error(
    `[ERROR] CHECK_HOUR="${CHECK_HOUR_ENV}" は判定時刻として無効です（有効値: ${CHECK_HOURS.join(", ")}）。`
  );
  console.error("[ERROR] 判定時刻を確定できないため実行しません（ワークフローの受け渡しを確認してください）。");
  process.exit(1);
})();

// ===== HTTPS リクエストヘルパー =====
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: (options && options.method) || "GET",
      headers: (options && options.headers) || {},
    };
    const req = https.request(opts, (res) => {
      // ⚠ setEncoding が無いと chunk の境界で日本語が割れる（tc5_records は 1MB 超で必ず複数 chunk になる）
      res.setEncoding("utf8");
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on("error", reject);
    // タイムアウトは指定した呼び出しだけ（従来の取得処理の挙動は変えない）。
    // 「送れたか分からない」を判定するために、通知記録と LINE 送信で使う。
    if (options && options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        const e = new Error("timeout");
        e.code = "ETIMEDOUT";
        req.destroy(e);
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

// ===== JST 日付 yyyy-mm-dd =====
function getTodayJST() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// ===== JST 現在時刻文字列 YYYY/MM/DD HH:mm =====
function getNowJST() {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

// ===== JST 現在時刻文字列 YYYY/MM/DD HH:mm:ss =====
function getNowJSTWithSeconds() {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

// ===== Firebase Anonymous Auth =====
async function getFirebaseIdToken() {
  const res = await httpRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    JSON.stringify({ returnSecureToken: true })
  );
  if (res.status !== 200 || !res.body || !res.body.idToken) {
    throw new Error(
      `Firebase Anonymous Auth 失敗 (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`
    );
  }
  return res.body.idToken; // ログ出力禁止
}

// ===== Firebase RTDB GET =====
async function fetchRTDB(path, idToken) {
  // auth トークンは URL から除いてログ出力
  const logUrl = `${FB_DB_URL}/${path}.json`;
  console.log(`[RTDB]  GET ${logUrl}`);
  const fullUrl = `${logUrl}?auth=${idToken}`;
  const res = await httpRequest(fullUrl);
  console.log(`[RTDB]  HTTP ${res.status}`);
  if (res.status !== 200) {
    throw new Error(
      `RTDB fetch 失敗 (${path}): HTTP ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`
    );
  }
  return res.body;
}

// ===== LINE Push 送信 =====
async function sendLineMessage(text) {
  console.log("[LINE]  Push送信開始");
  // ⚠ 宛先の先頭文字・長さは出さない。1文字は Secret のマスク対象にならず、
  //   PUBLIC リポジトリの Actions ログへそのまま残るため。存在有無だけで足りる。
  console.log(`[LINE]  LINE_TO_ID 存在: ${!!LINE_TO}`);
  console.log(`[LINE]  LINE_CHANNEL_ACCESS_TOKEN 存在: ${!!LINE_TOKEN}`);

  if (DRY_RUN) {
    console.log("[DRY]   dryRun=true → LINE送信スキップ");
    console.log("[DRY]   送信予定メッセージ ↓");
    console.log("---");
    console.log(text);
    console.log("---");
    return;
  }

  const payload = JSON.stringify({
    to: LINE_TO,
    messages: [{ type: "text", text }],
  });
  const res = await httpRequest(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LINE_TOKEN,
      },
    },
    payload
  );

  console.log(`[LINE]  response status=${res.status}`);
  console.log(`[LINE]  response body=${JSON.stringify(res.body)}`);

  if (res.status !== 200) {
    console.error("[LINE]  Push送信失敗");
    throw new Error("LINE Push 失敗: HTTP " + res.status);
  }
  console.log("[LINE]  Push送信成功");
}

// ===== サービスアカウント → OAuth2 アクセストークン（通知記録の読み書き専用） =====
// ⚠ アクセストークンは絶対にログへ出さない。
function createGoogleJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    scope: [
      "https://www.googleapis.com/auth/firebase.database",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const sigInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(sigInput, "ascii");
  const sig = signer.sign({ key: sa.private_key, padding: crypto.constants.RSA_PKCS1_PADDING }, "base64url");
  return `${sigInput}.${sig}`;
}

async function getServiceAccessToken(sa) {
  const jwt = createGoogleJWT(sa);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res = await httpRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeoutMs: HTTP_TIMEOUT_MS,
  }, body);
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    // 応答本文は出さない（エラー詳細に鍵の情報が含まれうるため）
    throw new Error(`OAuth2 アクセストークン取得失敗 (HTTP ${res.status})`);
  }
  return res.body.access_token;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function candidateLabel(c) {
  return c.kind === "anomaly" ? "設定異常" : safeFacilityLabel(c.name);
}

// 判定結果を「同一日 × 同一施設 × 同一判定時刻で最大1回」に絞って送る。
async function sendMorningOnce(date, candidates, buildText) {
  const path = dedupePath(date, CHECK_HOUR);
  if (DRY_RUN && !SERVICE_ACCOUNT) {
    console.warn("[DEDUPE] FIREBASE_SERVICE_ACCOUNT_KEY が無いため通知記録を確認できません（dryRun なので続行）");
    await sendLineMessage(buildText(candidates, { notifiedFacilityCount: 0 }));
    return;
  }

  // ⚠⚠ 通知記録は FB_DB_URL（= .../honomi）ではなくルート直下へ置く（dedupeBaseUrl の説明を参照）
  const rootBase = dedupeBaseUrl(process.env.FIREBASE_DATABASE_URL);
  console.log(`[DEDUPE] 通知記録: /${path}（実行ID ${RUN_ID}）`);
  let accessToken = null;
  for (let i = 0; accessToken === null; i++) {
    try {
      accessToken = await getServiceAccessToken(SERVICE_ACCOUNT);
    } catch (e) {
      if (i + 1 >= DEDUPE_IO_TRIES) throw e;
      console.warn(`[DEDUPE] ${e.message}。再試行します`);
      await sleep(DEDUPE_IO_RETRY_MS[Math.min(i, DEDUPE_IO_RETRY_MS.length - 1)]);
    }
  }
  const result = await notifyOnce({
    store: makeRtdbDedupeStore(httpRequest, rootBase, path, accessToken),
    candidates,
    buildText,
    sendOnce: makeLineSendOnce(httpRequest, LINE_TOKEN, LINE_TO),
    sleep,
    now: Date.now,
    runId: RUN_ID,
    newBatchId: () => "b_" + crypto.randomBytes(8).toString("hex"),
    newRetryKey: () => crypto.randomUUID(),
    dryRun: DRY_RUN,
    log: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
  });

  const plan = result.plan;
  plan.skipped.forEach((s) => console.log(`[DEDUPE] 送信しない: ${candidateLabel(s.cand)}（${s.reason}）`));
  plan.inflight.forEach((c) =>
    console.error(`::error::他の実行のリースが切れず、送信を確定できませんでした: ${candidateLabel(c)}`));
  plan.resend.forEach((b) => console.log(`[DEDUPE] 前回の未確定の送信を同じ retry key で再送します（${b.slots.length}枠）`));
  if (plan.newBatch) {
    console.log(`[DEDUPE] 今回はじめて通知する枠: ${plan.fresh.map(candidateLabel).join(", ")}`);
  }

  if (DRY_RUN) {
    console.log("[DRY]   dryRun=true → 通知記録へ書かず、LINE も送りません");
    if (plan.newBatch) await sendLineMessage(plan.newBatch.text);
    if (!plan.newBatch && plan.resend.length === 0) console.log("[DRY]   この回で送る通知はありません");
    return;
  }

  if (!plan.newBatch && plan.resend.length === 0) {
    console.log("[OK]    同じ枠はすべて通知済み（または送信中）— LINE通知スキップ");
  }
  result.delivered.forEach(() => console.log("[LINE]  Push送信成功（または同じ retry key が受付済み）"));
  plan.terminal.forEach((t) =>
    console.error(`::error::${candidateLabel(t.cand)} の通知は自動では送りません（${t.reason}）。二重通知を避けるため停止しました。`));
  result.failures.forEach((f) =>
    console.error(`::error::LINE 通知を確定できませんでした（${f.reason} / ${f.status}）。` +
      (f.reason === "transient" || f.reason === "record_failed"
        ? "次の実行が同じ retry key で再送します。" : "")));
  if (result.failures.length > 0 || plan.terminal.length > 0 || plan.inflight.length > 0) {
    throw new Error("朝出勤未確認の通知を確定できませんでした");
  }
}

// ===== メイン =====
async function main() {
  const nowUtc = new Date();

  // ── 起動ログ ──
  console.log("========================================");
  console.log("[START] morning-check.js");
  console.log(`[TIME]  現在UTC時刻: ${nowUtc.toISOString()}`);
  console.log(`[TIME]  現在JST時刻: ${getNowJSTWithSeconds()}`);
  console.log(`[CONFIG] TEST_NOTIFY=${TEST_NOTIFY} DRY_RUN=${DRY_RUN} TARGET_DATE="${TARGET_DATE_ENV || "(なし)"}"`);
  console.log(`[CONFIG] CHECK_HOUR=${CHECK_HOUR}時${CHECK_HOUR_ENV ? "" : "（CHECK_HOUR 未指定 → 既定）"}`);
  console.log(`[FIREBASE] base URL: ${FB_DB_URL}`);
  console.log("========================================");

  // ── 二重通知防止の自己診断（LINE は送らない） ──
  if (DEDUPE_SELFTEST) {
    console.log(`[SELFTEST] ${DEDUPE_ROOT}/_selftest で条件付き書き込みを確認します`);
    const accessToken = await getServiceAccessToken(SERVICE_ACCOUNT);
    const r = await dedupeSelfTest(
      makeRtdbDedupeStore(httpRequest, dedupeBaseUrl(process.env.FIREBASE_DATABASE_URL), `${DEDUPE_ROOT}/_selftest`, accessToken),
      RUN_ID, Date.now()
    );
    if (!r.ok) throw new Error(`二重通知防止の自己診断に失敗: ${r.why}`);
    console.log("[SELFTEST] PASS（最新 ETag の書き込みは成功し、古い ETag の書き込みは 412 で拒否された）");
    return;
  }

  // ── テスト通知モード（Firebase 操作をスキップして即時送信） ──
  if (TEST_NOTIFY) {
    console.log("[TEST]  testNotify=true → Firebase スキップ・テスト通知送信");
    const testMessage =
      "【穂乃味タイムカード】\nテスト通知\n\n" +
      "LINE通知設定は正常です。\n\n" +
      `送信時刻：${getNowJSTWithSeconds()}`;
    await sendLineMessage(testMessage);
    console.log("[DONE]  テスト通知完了");
    return;
  }

  // ── 判定対象日 ──
  const today = IS_DATE_OVERRIDE ? TARGET_DATE_ENV : getTodayJST();
  console.log(`[DATE]  判定対象日: ${today}${IS_DATE_OVERRIDE ? " (手動指定)" : " (JST今日)"}`);
  // ⚠ 未来日を指定した実送信は受け付けない。打刻が無いので全施設が未打刻と判定され、
  //   その日の枠が前もって「送信済み」になり、当日の本番の通知が全部止まる。
  if (IS_DATE_OVERRIDE && !DRY_RUN && today > getTodayJST()) {
    throw new Error("targetDate に未来の日付は指定できません（当日の通知が送信済み扱いで止まるため）。dryRun でのみ指定できます");
  }

  // ── Firebase 認証 ──
  console.log("[AUTH]  Firebase Anonymous Auth 開始");
  const idToken = await getFirebaseIdToken();
  console.log("[AUTH]  idToken 取得完了");

  // ── records 取得 ──
  console.log("[RTDB]  tc5_records 参照先↓");
  const rawRecords = await fetchRTDB("tc5_records", idToken);
  const records = rawRecords == null
    ? []
    : Array.isArray(rawRecords)
      ? rawRecords
      : Object.values(rawRecords);
  const validRecords = records.filter(Boolean);
  console.log(`[RTDB]  records 総件数: ${validRecords.length}`);
  if (rawRecords == null) {
    console.warn("[WARN]  rawRecords が null です。パスが空または権限エラーの可能性があります。");
    console.warn(`[WARN]  参照 URL: ${FB_DB_URL}/tc5_records.json`);
    console.warn("[WARN]  index.html の FB_URL と FIREBASE_DATABASE_URL Secret が一致しているか確認してください。");
  }

  // ── 施設マスタ取得（Firebase 優先、なければ DEFAULT_FACILITIES） ──
  // エントリ形式（文字列 / {name, token, ...}）の差を吸収するため、そのままの形で保持する。
  // ⚠ 判定時刻は**絶対にここから読まない**（正本はコード側の LATE_CHECK_FACILITIES。冒頭の説明を参照）。
  let facilityEntries = DEFAULT_FACILITIES.slice();
  // 施設マスタを採用できなかった理由。採用できていれば null のまま。
  // ⚠ ログへ出すだけにしない。古い控えで走っている＝新設施設が監視外、という状態を
  //   誰も知らないまま毎朝続くことになる。後段で LINE の設定異常通知へ載せる。
  let fallbackReason = null;
  try {
    console.log("[RTDB]  master/locations 参照先↓");
    const rawLocs = await fetchRTDB("master/locations", idToken);
    const rawList = Array.isArray(rawLocs)
      ? rawLocs
      : (rawLocs && typeof rawLocs === "object" ? Object.values(rawLocs) : null);
    if (rawLocs == null) {
      console.log("[RTDB]  master/locations が null → DEFAULT_FACILITIES を使用");
      fallbackReason = "施設マスタが空です";
    } else if (!rawList) {
      // 配列でもオブジェクトでもない（文字列・数値など）。改ざんの痕跡を残す。
      console.warn(`[WARN]  master/locations が想定外の型です（${typeof rawLocs}）→ DEFAULT_FACILITIES を使用`);
      fallbackReason = `施設マスタが想定外の型です（${typeof rawLocs}）`;
    } else if (rawList) {
      const entries = rawList.filter((f) => facilityEntryName(f) !== "");
      const dropped = rawList.length - entries.length;
      if (dropped > 0) {
        console.warn(`[WARN]  施設名を取り出せないエントリ ${dropped} 件を除外しました`);
      }
      if (entries.length > MAX_FACILITIES) {
        // ⚠ 黙って切り詰めない。先頭へダミーを差し込むだけで実在施設を監視から外せてしまう。
        //   異常として扱い、改ざんされない DEFAULT_FACILITIES へ倒す。
        console.warn(`[WARN]  施設マスタが ${entries.length} 件あり上限 ${MAX_FACILITIES} 件を超えています。`);
        console.warn("[WARN]  施設マスタを採用せず DEFAULT_FACILITIES で判定します。");
        fallbackReason = `施設マスタが ${entries.length} 件あり上限 ${MAX_FACILITIES} 件を超えています`;
        entries.length = 0;
      }
      if (entries.length > 0) {
        facilityEntries = entries;
        console.log(
          `[RTDB]  master/locations(${Array.isArray(rawLocs) ? "配列" : "オブジェクト"}) から ${entries.length} 件取得`
        );
        // ⚠ エントリ全体は出さない。施設URLの token が Actions のログへ残るため
        //   （このリポジトリは PUBLIC で、Actions のログは未認証でも閲覧できる）。
        console.log("[DEBUG] 施設マスタ詳細:");
        entries.forEach((f, i) =>
          console.log(`  [${i}] name="${safeFacilityLabel(facilityEntryName(f))}" 判定時刻=${resolveCheckHour(f)}時`)
        );
      }
    }
  } catch (e) {
    console.warn(`[WARN]  master/locations 取得失敗 → DEFAULT_FACILITIES を使用: ${e.message}`);
    fallbackReason = "施設マスタを取得できませんでした";
  }

  // ── 朝通知除外施設を取り除く（normalize 比較） ──
  const excludeNorms = NOTIFY_EXCLUDE.map(normalizeFacility);
  facilityEntries = facilityEntries.filter(
    (f) => !excludeNorms.includes(normalizeFacility(facilityEntryName(f)))
  );

  // コード側の控え（DEFAULT_FACILITIES）に無い施設。監視はされているので LINE は鳴らさないが、
  // 期待件数の正本が古いことを示すのでログへ残す。
  {
    const defaultNorms = DEFAULT_FACILITIES.map(normalizeFacility);
    const unknown = facilityEntries
      .map(facilityEntryName)
      .filter((n) => !defaultNorms.includes(normalizeFacility(n)));
    if (unknown.length > 0) {
      console.warn(`[WARN]  DEFAULT_FACILITIES に無い施設があります: ${unknown.map(safeFacilityLabel).join(", ")}`);
      console.warn("[WARN]  scripts/morning-check.js の DEFAULT_FACILITIES を更新してください（期待件数の正本）。");
    }
  }

  console.log(`[FAC]   施設別の判定時刻（除外後 ${facilityEntries.length} 件）:`);
  facilityEntries.forEach((f) => {
    const h = resolveCheckHour(f);
    console.log(`  ${safeFacilityLabel(facilityEntryName(f))} … ${h}時${h === CHECK_HOUR ? "（今回の対象）" : "（今回は対象外）"}`);
  });

  // ── この回の判定時刻に属する施設だけを見る ──
  const facilities = selectFacilitiesForHour(facilityEntries, CHECK_HOUR).map(facilityEntryName);
  console.log(`[FAC]   ${CHECK_HOUR}時の通知対象施設 ${facilities.length} 件:`);
  facilities.forEach((name, i) => {
    console.log(`  [${i + 1}] ${safeFacilityLabel(name)}`);
  });
  const otherHours = CHECK_HOURS.filter((h) => h !== CHECK_HOUR);
  if (otherHours.length > 0) {
    console.log(`[FAC]   ${otherHours.join(" / ")}時の施設は今回の対象外です（それぞれ別の実行で判定します）。`);
  }

  // ── 監視が成立しているか。落ちているならログではなく LINE で知らせる ──
  // ⚠ ここを [WARN] のログだけで済ませてはいけない。施設マスタから施設名を消す／改名するだけで
  //   「対象0件 → 静かに正常終了」になり、その日の未打刻通知が丸ごと消えたことを誰も知れない。
  const anomalies = findMonitoringAnomalies(facilityEntries, CHECK_HOUR, facilities.length, fallbackReason);
  anomalies.forEach((a) => console.warn(`[WARN]  ${a}`));
  // ⚠ ここでは送らない。1回の実行で LINE は最大1通にまとめる。
  //   設定異常を別送にすると、(a) 送信失敗が未打刻通知まで道連れにする、
  //   (b) 異常が続くあいだ通数が倍になり本来の警告が埋もれる、の2つが起きる。
  const anomalySection = anomalies.length > 0
    ? `■ 設定異常（${CHECK_HOUR}時判定）\n` +
      anomalies.map((a) => `・${a}`).join("\n") + "\n" +
      "施設マスタ（拠点トークン管理）を確認してください。この回の未打刻チェックは一部の施設について行えていません。\n\n"
    : "";

  // ── 送信は必ずここを通す（同一日 × 同一施設 × 同一判定時刻で最大1回） ──
  // ⚠ sendLineMessage を判定経路から直接呼んではならない。cron と外部スケジューラの両方が走るため2通になる。
  const deliver = async (unconfirmedNames) => {
    const candidates = unconfirmedNames.map((n) => ({ slot: dedupeSlotKey(n), kind: "facility", name: n }));
    if (anomalySection) candidates.push({ slot: DEDUPE_ANOMALY_SLOT, kind: "anomaly" });
    if (candidates.length === 0) return;
    const nowStr = getNowJST();
    const buildText = (fresh, ctx) => {
      const freshNames = fresh.filter((c) => c.kind === "facility").map((c) => c.name);
      return buildMorningMessage({
        hour: CHECK_HOUR,
        nowStr,
        targetDate: IS_DATE_OVERRIDE ? today : "",
        anomalySection: fresh.some((c) => c.kind === "anomaly") ? anomalySection : "",
        freshNames,
        suppressedCount: (ctx && ctx.notifiedFacilityCount) || 0,
        facilitiesCount: facilities.length,
      });
    };
    await sendMorningOnce(today, candidates, buildText);
  };

  if (facilities.length === 0) {
    console.log(`[OK]    ${CHECK_HOUR}時に判定する施設がありません — 未打刻通知はスキップ`);
    if (anomalySection) {
      await deliver([]);
    }
    return;
  }

  // ── 当日 clockIn レコード取得 ──
  const todayClockIns = validRecords.filter(
    (r) => r && r.type === "clockIn" && r.date === today && !r.deleted
  );
  console.log(`[DATE]  対象日 ${today} の clockIn 件数: ${todayClockIns.length}`);

  // 施設情報なし clockIn の警告
  // ⚠ 氏名は出さない（このリポジトリは PUBLIC で Actions のログを誰でも閲覧できる）。件数だけを出す。
  const missingFacilityCount = todayClockIns.filter(
    (r) => !(r.workFacility || r.facilityName)
  ).length;
  if (missingFacilityCount > 0) {
    console.warn(`[WARN]  facility missing: 対象日 ${today} の clockIn のうち ${missingFacilityCount} 件に施設情報がありません`);
  }

  // 施設マスタの施設名文字コード確認
  console.log("[DEBUG] 施設マスタ 施設名文字コード:");
  facilities.forEach((name) => {
    // 表示は sanitize 後、文字コードは生の値から出す（見えない文字の診断が目的のため）。
    console.log(`[施設確認] "${safeFacilityLabel(name)}"`, facilityCodePoints(name));
  });

  // 本日 clockIn 施設名の文字コード確認
  console.log("[DEBUG] 本日 clockIn 施設名文字コード:");
  if (todayClockIns.length === 0) {
    console.log("  (なし)");
    // 日付ずれのデバッグ用：直近5件の clockIn を出力
    const recentClockIns = validRecords
      .filter((r) => r && r.type === "clockIn" && !r.deleted)
      .slice(-5);
    console.log("[DEBUG] 直近 clockIn レコード（最大5件・日付ずれ確認用。氏名は出さない）:");
    recentClockIns.forEach((r, i) => {
      // ⚠ tc5_records は匿名でも書ける。date も施設名も第三者が任意に設定できるため、
      //   生のまま公開ログへ出さない（改行を仕込まれると偽のログ行を注入できる）。
      const fac = safeFacilityLabel(r.workFacility || r.facilityName || "");
      console.log(`  [${i + 1}] date="${safeFacilityLabel(r.date)}" facility="${fac}"`);
    });
  } else {
    todayClockIns.forEach((r) => {
      const key = (r.workFacility || r.facilityName || "").trim();
      console.log(`[施設確認] "${safeFacilityLabel(key)}"`, facilityCodePoints(key));
    });
  }

  // ── 施設別に出勤件数を集計（NFKC 正規化で比較） ──
  // ⚠ 施設名は一般スタッフでも書き換えられる。"constructor" 等の名前で Object.prototype の
  //   継承プロパティを引き当てられないよう、素の {} ではなく Object.create(null) を使う。
  const facilityClockInCount = Object.create(null);
  const facilityNormMap = Object.create(null);
  facilities.forEach((name) => {
    facilityClockInCount[name] = 0;
    facilityNormMap[normalizeFacility(name)] = name;
  });

  // ログの取り違え防止。施設マスタには在るが今回の判定対象でない施設を、
  // 「施設マスタ外（応援先 or 表記ゆれ）」と一緒にしない。
  const otherHourNormMap = Object.create(null);
  facilityEntries.forEach((f) => {
    const name = facilityEntryName(f);
    const norm = normalizeFacility(name);
    if (!facilityNormMap[norm]) otherHourNormMap[norm] = { name, hour: resolveCheckHour(f) };
  });
  // 朝通知の除外施設（ハーベスト）も「施設マスタ外」ではない。意図的な除外として表示する。
  const excludedNormSet = Object.create(null);
  NOTIFY_EXCLUDE.forEach((n) => { excludedNormSet[normalizeFacility(n)] = true; });
  // 「今回の対象外」の集計先。施設名と衝突しない入れ物を別に持つ（旧 "__other__" キーの衝突対策）。
  const otherFacilityCount = Object.create(null);

  console.log("[DEBUG] 施設マッチング結果:");
  todayClockIns.forEach((r) => {
    const key = (r.workFacility || r.facilityName || "").trim();
    const normalized = normalizeFacility(key);
    const matchedOriginal = facilityNormMap[normalized];
    const otherHour = otherHourNormMap[normalized];
    const label = safeFacilityLabel(key);
    if (!key) {
      console.log("  workFacility/facilityName が空の clockIn をスキップ");
    } else if (matchedOriginal) {
      console.log(`  fac="${label}" (norm="${normalized}") → マッチ OK: "${safeFacilityLabel(matchedOriginal)}"`);
      facilityClockInCount[matchedOriginal]++;
    } else if (otherHour) {
      console.log(`  fac="${label}" (norm="${normalized}") → 判定時刻 ${otherHour.hour}時のため今回は対象外`);
      otherFacilityCount[key] = (otherFacilityCount[key] || 0) + 1;
    } else if (excludedNormSet[normalized]) {
      console.log(`  fac="${label}" (norm="${normalized}") → 朝通知の除外施設のため対象外`);
      otherFacilityCount[key] = (otherFacilityCount[key] || 0) + 1;
    } else {
      console.log(`  fac="${label}" (norm="${normalized}") → 施設マスタ外（応援先 or 表記ゆれ）`);
      otherFacilityCount[key] = (otherFacilityCount[key] || 0) + 1;
    }
  });

  // ── 施設別判定ログ ──
  console.log("[CHECK] 施設別出勤状況:");
  const unconfirmed = [];
  facilities.forEach((name) => {
    const count = facilityClockInCount[name] || 0;
    const status = count >= 1 ? "OK  " : "未打";
    console.log(`  [${status}] ${safeFacilityLabel(name)}  出勤 ${count} 件`);
    if (count === 0) { unconfirmed.push(name); }
  });

  // 今回の判定対象外の施設の出勤
  const otherEntries = Object.keys(otherFacilityCount);
  if (otherEntries.length > 0) {
    const others = otherEntries
      .map((k) => `${safeFacilityLabel(k)}(${otherFacilityCount[k]}件)`)
      .join(", ");
    console.log(`[CHECK] 今回の判定対象外の施設に出勤あり: ${others}`);
  }

  console.log(
    `[CHECK] 未打刻施設 ${unconfirmed.length} 件: ` +
    (unconfirmed.length > 0 ? unconfirmed.map(safeFacilityLabel).join(", ") : "なし")
  );

  // ── 未確認が 0 件なら（設定異常が無ければ）通知せず終了 ──
  if (unconfirmed.length === 0 && !anomalySection) {
    console.log("[OK]    全施設出勤確認済み — LINE通知スキップ");
    return;
  }

  // ── 送信（設定異常があれば同じ1通へまとめる。通知済みの枠は載せない） ──
  await deliver(unconfirmed);
  console.log("[DONE]  処理完了");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
