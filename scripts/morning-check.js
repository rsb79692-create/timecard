/**
 * morning-check.js — Phase 2-D rev.6
 * 朝出勤未確認施設を Firebase RTDB から取得し LINE へ Push 通知する
 * GitHub Actions から実行。Node.js 標準モジュールのみ（npm install 不要）。
 */

"use strict";

const https = require("https");

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
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
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

  if (facilities.length === 0) {
    console.log(`[OK]    ${CHECK_HOUR}時に判定する施設がありません — 未打刻通知はスキップ`);
    if (anomalySection) {
      await sendLineMessage(
        `【穂乃味タイムカード】\n朝出勤未確認（${CHECK_HOUR}時判定）\n\n` +
        `確認時刻：${getNowJST()}\n\n` + anomalySection.trimEnd()
      );
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

  // ── LINE 通知本文（設定異常があれば同じ1通へまとめる） ──
  const nowStr = getNowJST();
  const unconfirmedSection = unconfirmed.length > 0
    ? `未確認施設：${unconfirmed.length}件\n\n` +
      unconfirmed.map((n) => `・${safeFacilityLabel(n)}`).join("\n") + "\n\n" +
      "シフトミス・遅刻・事故の可能性があります。確認してください。"
    : "未確認施設：なし（判定できた施設はすべて出勤確認済み）";
  const message =
    `【穂乃味タイムカード】\n朝出勤未確認（${CHECK_HOUR}時判定）\n\n` +
    `確認時刻：${nowStr}\n\n` +
    anomalySection + unconfirmedSection;

  // ── 送信 ──
  await sendLineMessage(message);
  console.log("[DONE]  処理完了");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
