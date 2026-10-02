/**
 * POST /api/auth/employee-verify — サーバ間（honomi-shift の Supabase Edge Function）専用の本人確認
 *
 * 入力（本文・生バイト列で署名）: { "employeeId": string, "pin": string, "nameHash": string }
 * 出力: 200 {"ok":true} ／ それ以外は {"ok":false[,"error":code]}（下表）。応答に識別情報を一切含めない。
 *
 *   405 method_not_allowed … POST 以外
 *   503 not_configured     … EMPLOYEE_VERIFY_SECRET が未設定・不正（DB・レート制限に触れない）
 *   413 too_large          … 本文が 2048 バイト超
 *   401 bad_signature      … 時刻・nonce・署名の不一致（レート制限に触れない）
 *   400 bad_request        … 署名は正しいが本文の形式が不正（計上しない）
 *   429 rate_limited       … 本人単位 / 全体の上限超過（照合しない）
 *   401 {"ok":false}       … 本人確認の失敗（理由によらず同一応答・最小 300ms）
 *   503 unavailable        … RTDB 等の取得失敗（判定不能。成功へ倒さない）
 *
 * ===== 署名 =====
 *  canonical = "employee-verify/v1\nPOST\n/api/auth/employee-verify\n" + ts + "\n" + nonce + "\n" + sha256hex(rawBody)
 *  X-Hv-Sig  = hex(HMAC-SHA256(hexdecode(EMPLOYEE_VERIFY_SECRET), canonical))
 *  X-Hv-Ts は UNIX 秒（|now - ts| <= 60）、X-Hv-Nonce は 32 桁 16 進。nonce の再利用は記録しない（60 秒窓のみ）。
 *
 * ===== 既存の打刻・PIN との関係（★変えない）=====
 *  - 打刻の認証（/api/auth/staff）とレート制限の予算を共有しない（pin_sub / pin_dev / pin_ip / pin_all を読まない・消さない）。
 *  - /honomi/tc5_pins を読まない。照合は /authz/pins の記録だけで行い、レガシー記録の昇格（書き込み）をしない。
 *  - 書き込むのはレート制限のカウンタ（/ratelimit 配下）だけ。
 *  - H.guard（ブラウザの Origin 必須）と T.handler（本文で会社を選ぶ）は使わない。会社は穂乃味に固定する。
 *  - CORS 応答ヘッダを返さない（ブラウザからのクロスオリジン呼び出しを想定しない）。
 *
 * ★ ログには相関 ID と失敗の種類だけを出す（PIN・氏名・社員番号・nameHash・署名を出さない）。
 */
"use strict";

const crypto = require("crypto");
const G = require("../_lib/google");
const S = require("../_lib/secrets");
const T = require("../_lib/tenant");

const TENANT = "honomi";
const PATH = "/api/auth/employee-verify";
const SIG_PREFIX = "employee-verify/v1\nPOST\n" + PATH + "\n";
const NAME_HASH_PREFIX = "honomi-staff-name/v1:";
const MAX_BODY = 2048;
const TS_SKEW_SEC = 60;
const MIN_IDENTITY_MS = 300;

// レート制限（打刻とは別の予算。kind 名も別にする）
const KIND_EMP = "evf_emp";
const KIND_ALL = "evf_all";
const LIMIT_EMP_10M = 5;
const LIMIT_EMP_DAY = 20;
const LIMIT_ALL_10M = 100;
const LIMIT_ALL_DAY = 300;
const RATE_ROOT = "ratelimit";
const DAY_PREFIX = "evd_"; // /ratelimit/<10分スロット番号> と衝突しない接頭辞

// ===== 小さな補助 =====

function sha256hex(bufOrStr) {
  return crypto.createHash("sha256").update(bufOrStr).digest("hex");
}

/** 16 進文字列どうしを 32 バイトへ復号して定数時間比較する（形式不正は false）。 */
function hex32Equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[0-9a-fA-F]{64}$/.test(a) || !/^[0-9a-fA-F]{64}$/.test(b)) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== 32 || bb.length !== 32) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeCode(s) {
  return String(s).normalize("NFKC").trim();
}
const CODE_RE = /^[0-9A-Za-z_-]{1,32}$/;

function normName(s) {
  return String(s).normalize("NFKC").replace(/\s+/gu, "");
}

/** 行の氏名（姓＋名が両方あればそれ、無ければ name）。index.html の表示規則と同じ判定。 */
function rowNameOf(row) {
  if (row.lastName && row.firstName) return normName((row.lastName ?? "") + (row.firstName ?? ""));
  return normName(row.name ?? "");
}

/** 社員番号の正規化。未設定（null/undefined/空/オブジェクト）は "" とし、照合対象にしない。 */
function rowCodeOf(row) {
  const v = row.employeeId;
  if (typeof v !== "string" && typeof v !== "number") return "";
  return normalizeCode(v);
}

function headerOf(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return typeof v === "string" ? v : "";
}

/** 応答。helpers の有無に依存しないよう node 標準 API だけで書く。CORS ヘッダは付けない。 */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function waitUntil(startedAt, minMs) {
  const wait = Math.max(0, minMs - (Date.now() - startedAt));
  return new Promise((r) => setTimeout(r, wait));
}

function correlationId() {
  return crypto.randomBytes(8).toString("hex");
}

function logKind(cid, kind) {
  console.error("[employee-verify]", cid, kind);
}

/** 秘密鍵（64 桁 16 進＝32 バイト）。不正なら null。 */
function secretKey() {
  const s = process.env.EMPLOYEE_VERIFY_SECRET || "";
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  const k = Buffer.from(s, "hex");
  return k.length === 32 ? k : null;
}

/**
 * 本文を生バイト列のまま読む（上限 MAX_BODY）。
 * ★ req.body には触れない（JSON として解析・再シリアライズすると署名対象のバイト列が変わる）。
 * ★ @vercel/node の helpers は本文を先に読み込んだ後、同じバイト列を data/end イベントで再生する
 *   （restoreBody）。helpers が無い実行環境では実際のストリームを読む。どちらでも on("data"/"end") で同じ結果になる。
 * 戻り値: Buffer、上限超過は "too_large"、読み取り失敗は "read_error"。
 */
function readRawBody(req) {
  const declared = parseInt(headerOf(req, "content-length"), 10);
  if (Number.isFinite(declared) && declared > MAX_BODY) return Promise.resolve("too_large");
  return new Promise(function (resolve) {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    req.on("data", function (c) {
      if (done) return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8");
      size += b.length;
      if (size > MAX_BODY) { finish("too_large"); return; }
      chunks.push(b);
    });
    req.on("end", function () { finish(Buffer.concat(chunks)); });
    req.on("error", function () { finish("read_error"); });
  });
}

/** 署名の検証。成功で true。I/O を伴わない。 */
function verifySignature(req, key, raw, nowSec) {
  const ts = headerOf(req, "x-hv-ts");
  const nonce = headerOf(req, "x-hv-nonce");
  const sig = headerOf(req, "x-hv-sig");
  if (!/^\d{1,12}$/.test(ts)) return false;
  if (!/^[0-9a-fA-F]{32}$/.test(nonce)) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  if (Math.abs(nowSec - parseInt(ts, 10)) > TS_SKEW_SEC) return false;
  const canonical = SIG_PREFIX + ts + "\n" + nonce + "\n" + sha256hex(raw);
  const expected = crypto.createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  return hex32Equal(expected, sig);
}

/** 本文の検証。成功で {code, pin, nameHash}、失敗で null。 */
function parseBody(raw) {
  let o;
  try { o = JSON.parse(raw.toString("utf8")); } catch (e) { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.employeeId !== "string" || typeof o.pin !== "string" || typeof o.nameHash !== "string") return null;
  const code = normalizeCode(o.employeeId);
  if (!CODE_RE.test(code)) return null;
  if (!/^\d{4,8}$/.test(o.pin)) return null;
  if (!/^[0-9a-f]{64}$/.test(o.nameHash)) return null;
  return { code: code, pin: o.pin, nameHash: o.nameHash };
}

// ===== 日単位のカウンタ =====
// S.bumpAndCount は 10 分の固定窓（/ratelimit/<スロット>/<kind>/<id>）しか持たない。
// 共有ライブラリを変えないため、同じ仕組み（サーバ値インクリメント → 読み直し）で
// 日付（JST）を鍵に含めたカウンタをここに置く: /ratelimit/evd_YYYYMMDD/<kind>/<id>
// 読み直した値は同時実行分も含む（数え漏れは起きない側に倒れる）。

function jstDayKey(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}

async function bumpDaily(kind, id, cleanup) {
  const now = Date.now();
  const parent = RATE_ROOT + "/" + DAY_PREFIX + jstDayKey(now) + "/" + kind;
  const leaf = S.sanitizeKey(id);
  await G.dbPatch(parent, { [leaf]: { ".sv": { increment: 1 } } });
  const v = await G.dbGet(parent + "/" + leaf);
  if (cleanup) {
    // 2 日前の日次ツリーを丸ごと回収する（失敗は致命ではない）
    try { await G.dbPut(RATE_ROOT + "/" + DAY_PREFIX + jstDayKey(now - 2 * 86400000), null); } catch (e) { /* noop */ }
  }
  return typeof v === "number" ? v : 1;
}

// ===== 本人確認 =====

/**
 * 名簿の行から対象の1行を決める。失敗は理由（ログ用）を返す。
 * ★ 退職者を含む全行で社員番号が一意であること、同名の別行が無いことを要求する（フェイルクローズ）。
 */
function resolveRow(rows, code, nameHash) {
  const hits = [];
  for (let i = 0; i < rows.length; i++) if (rowCodeOf(rows[i]) === code) hits.push(i);
  if (hits.length !== 1) return { fail: hits.length === 0 ? "code_not_found" : "code_duplicate" };
  const idx = hits[0];
  const row = rows[idx];
  if (String(row.status ?? "").trim() === "退職") return { fail: "retired" };
  if (typeof row.name !== "string" || !row.name) return { fail: "no_name" };
  const rowName = rowNameOf(row);
  if (!rowName) return { fail: "no_name" };
  const expected = sha256hex(Buffer.from(NAME_HASH_PREFIX + rowName, "utf8"));
  if (!hex32Equal(expected, nameHash)) return { fail: "name_mismatch" };
  // 同名の別行（在籍状態によらない）。PIN 記録は氏名で引くため、同名があると本人を特定できない。
  const mine = new Set([rowName, normName(row.name)]);
  for (let i = 0; i < rows.length; i++) {
    if (i === idx) continue;
    const r = rows[i];
    const theirs = [rowNameOf(r), normName(r.name ?? "")];
    if (theirs.some((n) => n && mine.has(n))) return { fail: "same_name" };
  }
  return { row: row };
}

async function handle(req, res) {
  const startedAt = Date.now();
  const cid = correlationId();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "method_not_allowed" });
  }

  // ① 設定の確認（DB・レート制限に触れない）
  const key = secretKey();
  if (!key) {
    logKind(cid, "not_configured");
    return send(res, 503, { ok: false, error: "not_configured" });
  }

  // ② 生の本文
  const raw = await readRawBody(req);
  if (raw === "too_large") return send(res, 413, { ok: false, error: "too_large" });
  if (raw === "read_error") { logKind(cid, "read_error"); return send(res, 400, { ok: false, error: "bad_request" }); }

  // ③ 署名（レート制限に触れない）
  if (!verifySignature(req, key, raw, Math.floor(Date.now() / 1000))) {
    logKind(cid, "bad_signature");
    return send(res, 401, { ok: false, error: "bad_signature" });
  }

  // ④ 本文の形式（計上しない）
  const input = parseBody(raw);
  if (!input) return send(res, 400, { ok: false, error: "bad_request" });

  return T.run(TENANT, async function () {
    // ⑤ レート制限（照合の前に加算し、その値で判定する）
    let counts;
    try {
      counts = await Promise.all([
        S.bumpAndCount(KIND_EMP, input.code),
        bumpDaily(KIND_EMP, input.code, false),
        S.bumpAndCount(KIND_ALL, "global"),
        bumpDaily(KIND_ALL, "global", true),
      ]);
    } catch (e) {
      logKind(cid, "rate_error");
      return send(res, 503, { ok: false, error: "unavailable" });
    }
    if (counts[0] > LIMIT_EMP_10M || counts[1] > LIMIT_EMP_DAY || counts[2] > LIMIT_ALL_10M || counts[3] > LIMIT_ALL_DAY) {
      logKind(cid, "rate_limited");
      return send(res, 429, { ok: false, error: "rate_limited" });
    }

    // ⑥ 本人確認（失敗はすべて同一応答・最小時間つき）
    let ok = false;
    let kind = "";
    try {
      const raw2 = await G.dbGet("tc5_staff");
      const list = Array.isArray(raw2) ? raw2 : Object.values(raw2 || {});
      const rows = list.filter((r) => r && typeof r === "object");
      const r = resolveRow(rows, input.code, input.nameHash);
      if (r.row) {
        const rec = await G.dbGet(S.AUTHZ + "/pins/" + S.subjectKey(r.row.name));
        if (!rec || typeof rec !== "object") {
          S.verifyPinCompat(input.pin, null); // 計算量をそろえる
          kind = "no_pin_record";
        } else {
          const v = S.verifyPinCompat(input.pin, rec);
          ok = v.ok === true;
          if (!ok) kind = "pin_mismatch";
          // ★ v.upgrade でも書き込まない（レガシー記録の昇格は打刻側の経路だけが行う）
        }
      } else {
        S.verifyPinCompat(input.pin, null); // 計算量をそろえる
        kind = r.fail;
      }
    } catch (e) {
      logKind(cid, "lookup_error");
      await waitUntil(startedAt, MIN_IDENTITY_MS);
      return send(res, 503, { ok: false, error: "unavailable" });
    }

    if (!ok) {
      logKind(cid, "denied:" + kind);
      await waitUntil(startedAt, MIN_IDENTITY_MS);
      return send(res, 401, { ok: false });
    }

    // 成功時は本人単位の 10 分カウンタだけ戻す（全体・日次は戻さない）
    try { await S.resetCount(KIND_EMP, input.code); } catch (e) { logKind(cid, "reset_error"); }
    await waitUntil(startedAt, MIN_IDENTITY_MS);
    return send(res, 200, { ok: true });
  });
}

module.exports = async function employeeVerify(req, res) {
  try {
    return await handle(req, res);
  } catch (e) {
    const cid = correlationId();
    logKind(cid, "server_error");
    if (!res.headersSent) return send(res, 500, { ok: false, error: "server_error" });
  }
};

// テスト用（ルーティングには影響しない）
module.exports._internal = { normalizeCode, normName, rowNameOf, resolveRow, verifySignature, parseBody, jstDayKey, SIG_PREFIX };
