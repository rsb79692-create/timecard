/**
 * api/_lib/google.js — Google/Firebase のサーバ側資格情報まわり（依存ゼロ）
 *
 * scripts/fcm-check.js が本番稼働させている RS256 自己署名JWTの手法を流用する。
 * firebase-admin を導入しないため package.json が不要で、既存 api/*.js（CommonJS）を壊さない。
 *
 * 提供するもの:
 *   - createCustomToken(uid, claims)  Firebase Custom Token（クライアントへ返す）
 *   - getDbAccessToken()              RTDB を Rules 迂回で読み書きする OAuth2 アクセストークン
 *   - dbGet / dbPut / dbPatch         RTDB REST（Admin権限）
 *
 * ★ このファイルが扱う値はすべてサーバ専用。クライアントへ返してはならない。
 */
"use strict";

const https = require("https");
const crypto = require("crypto");

const IDENTITY_TOOLKIT_AUD =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const DB_SCOPES =
  "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";

let _sa = null;
function serviceAccount() {
  if (_sa) return _sa;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "";
  if (!raw) throw new Error("service account not configured");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 例外メッセージに鍵の中身が混ざらないよう、内容には触れない
    throw new Error("service account parse failed");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("service account incomplete");
  }
  _sa = parsed;
  return _sa;
}

/** 業務データ用のベース（FIREBASE_DATABASE_URL は通常 ".../honomi" で終わる） */
function dbUrlBase() {
  const u = process.env.FIREBASE_DATABASE_URL || "";
  if (!u) throw new Error("database url not configured");
  // ★ 業務データのベースは必ず /honomi のようなパスを含む。
  //   ルートURLを登録すると tc5_pins 等をルート直下（ルール未定義＝拒否）へ読みに行き、
  //   share 認証だけが静かに全滅し、bootstrap は空の plan を書き込む。
  //   /authz 側は dbRootBase() を使うため正常に見えてしまい、誤設定に気づけない。
  let p = "";
  try { p = new URL(u).pathname || ""; } catch (e) { throw new Error("database url malformed"); }
  if (p.replace(/\/+$/, "") === "") throw new Error("database url must include the data path");
  return u.replace(/\/+$/, "");
}

/**
 * ルート直下のベース（パス部分を落とす）。
 * ★ /authz は必ずここを使う。FIREBASE_DATABASE_URL の配下（= /honomi）へ置くと、
 *   現行 Rules の「/honomi に auth != null」がカスケードして匿名クライアントから
 *   丸見え・書き換え自由になる。RTDB は親の許可を子で取り消せないため、
 *   認証マテリアルは /honomi の外（ルール未定義＝デフォルト拒否の領域）に置く必要がある。
 */
function dbRootBase() {
  const u = process.env.FIREBASE_DATABASE_URL || "";
  if (!u) throw new Error("database url not configured");
  const parsed = new URL(u);
  return parsed.origin;
}

function b64url(objOrStr) {
  const s = typeof objOrStr === "string" ? objOrStr : JSON.stringify(objOrStr);
  return Buffer.from(s).toString("base64url");
}

function signRs256(sigInput, privateKey) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(sigInput, "ascii");
  return signer.sign(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    "base64url"
  );
}

/**
 * Firebase Custom Token を発行する。
 * クライアントは identitytoolkit の accounts:signInWithCustomToken でIDトークンへ交換する。
 * @param {string} uid   1〜128文字。氏名・PIN・トークン実値を含めないこと。
 * @param {object} claims 追加クレーム（Rules から auth.token.<name> で参照）。予約語不可・1000バイト以内。
 */
function createCustomToken(uid, claims) {
  if (typeof uid !== "string" || !uid || uid.length > 128) {
    throw new Error("invalid uid");
  }
  const sa = serviceAccount();
  // サーバ時刻が数秒進んでいても拒否されないよう iat を少し戻し、exp は上限3600に余裕を持たせる
  const now = Math.floor(Date.now() / 1000) - 10;
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: IDENTITY_TOOLKIT_AUD,
    iat: now,
    exp: now + 3500, // Custom Token の交換期限（Firebase 仕様の上限は 3600）
    uid: uid,
  };
  if (claims && Object.keys(claims).length) {
    // 1000バイト上限（Firebase 仕様）に対する保険。★代入より先に検査する
    if (Buffer.byteLength(JSON.stringify(claims)) > 900) {
      throw new Error("claims too large");
    }
    payload.claims = claims;
  }
  const sigInput = header + "." + b64url(payload);
  return sigInput + "." + signRs256(sigInput, sa.private_key);
}

// ===== OAuth2（RTDB を Admin 権限で操作するためのアクセストークン）=====

let _tokenCache = { value: "", exp: 0 };

function httpRequest(url, options, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: (options && options.method) || "GET",
        headers: (options && options.headers) || {},
      },
      function (res) {
        let data = "";
        res.on("data", function (c) { data += c; });
        res.on("end", function () {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = null; }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    // fcm-check.js の httpRequest にはタイムアウトが無い。Serverless では必須のため追加する。
    req.setTimeout(8000, function () { req.destroy(new Error("upstream timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getDbAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.value && now < _tokenCache.exp - 60) return _tokenCache.value;

  const sa = serviceAccount();
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    scope: DB_SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const sigInput = header + "." + b64url(payload);
  const jwt = sigInput + "." + signRs256(sigInput, sa.private_key);

  const body =
    "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" +
    encodeURIComponent(jwt);
  const res = await httpRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );
  if (!res.body || !res.body.access_token) {
    // 上流の応答本文は秘密を含みうるため、ステータスのみ残す
    throw new Error("oauth token failed: HTTP " + res.status);
  }
  _tokenCache = {
    value: res.body.access_token,
    exp: now + (parseInt(res.body.expires_in, 10) || 3600),
  };
  return _tokenCache.value;
}

// ===== RTDB REST（Admin権限。Rules を迂回する）=====

async function dbRequest(path, method, payload) {
  const token = await getDbAccessToken();
  const p = String(path).replace(/^\/+/, "");
  // "authz"（認証マテリアル）と "ratelimit"（レート制限カウンタ）はルート直下に置く。
  // どちらも /honomi の外＝ルール未定義のデフォルト拒否領域。それ以外は業務データ（/honomi）配下。
  const base = /^(authz|ratelimit)(\/|$)/.test(p) ? dbRootBase() : dbUrlBase();
  const url = base + "/" + p + ".json";
  const bodyStr = payload === undefined ? null : JSON.stringify(payload);
  const headers = { Authorization: "Bearer " + token };
  if (bodyStr) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(bodyStr);
  }
  const res = await httpRequest(url, { method: method, headers: headers }, bodyStr);
  if (res.status < 200 || res.status >= 300) {
    // パスは種別のみ残し、値は残さない
    throw new Error("rtdb " + method + " failed: HTTP " + res.status);
  }
  return res.body;
}

const dbGet = (path) => dbRequest(path, "GET");
const dbPut = (path, value) => dbRequest(path, "PUT", value);
const dbPatch = (path, value) => dbRequest(path, "PATCH", value);

/**
 * FIREBASE_DATABASE_URL のパス部分（例 "honomi"）を、前後のスラッシュ無しで返す。
 * ★ "honomi" をコードへ直書きしない。環境変数を正とする。
 *   dbUrlBase() 経由なので、パスを含まない誤設定はここでも throw する。
 */
function dataPathPrefix() {
  return new URL(dbUrlBase()).pathname.replace(/^\/+|\/+$/g, "");
}

// ルート直下へのマルチパス更新で許可するキーの形。
// ★ 空文字・先頭スラッシュ・".." などを弾く。ルートへの PATCH は
//   キーが "" だとデータベース全体を置換しうるため、ここは必ず閉じておく。
// ★ さらに「2セグメント以上」を必須にする。1セグメント（"authz" / "honomi"）を許すと、
//   マルチパス更新は各パスを置換するため、サブツリー全体（全スタッフPIN・全打刻データ）を
//   1回の呼び出しで消せてしまう。現在の呼び出し元は固定キーしか渡さないが、
//   将来の呼び出し追加でこの足元の穴を踏まないよう、関数側で閉じておく。
const ROOT_PATH_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)+$/;

/**
 * マルチパス更新で書き込んでよいトップレベル。
 * ★ dbPatchRoot は dbRequest のルーティング（authz/ratelimit はルート、他は /honomi 配下）を
 *   通らないため、呼び出し側が "tc5_records" のつもりで渡すと、ルート直下という
 *   まったく別の場所（Rules 未定義領域）へ静かに書かれる。許可リストで防ぐ。
 */
function allowedRootTops() {
  return ["authz", "ratelimit", dataPathPrefix()];
}

/**
 * ルート直下での原子的なマルチパス更新。キーは「ルートからの相対パス」。
 *
 * ★ /authz（認証マテリアル）と /honomi（業務データ）は兄弟なので、
 *   両方を書き換える操作を2回のリクエストに分けると、片方だけ成功した時点で
 *   「config と /authz が食い違う」状態が残る（管理者URLがどちらか一方でしか通らなくなる）。
 *   RTDB のマルチパス更新は全パスが一括で適用されるため、その不整合が原理的に起きない。
 *
 * 各パスの値は「マージではなく置換」。値 null はそのパスの削除。
 */
async function dbPatchRoot(map) {
  const keys = Object.keys(map || {});
  if (!keys.length) throw new Error("empty multi-path update");
  const tops = allowedRootTops();
  for (const k of keys) {
    if (!ROOT_PATH_KEY.test(k)) throw new Error("unsafe multi-path key");
    if (tops.indexOf(k.split("/")[0]) < 0) throw new Error("multi-path key outside allowed roots");
  }
  const token = await getDbAccessToken();
  const bodyStr = JSON.stringify(map);
  const res = await httpRequest(
    dbRootBase() + "/.json",
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    },
    bodyStr
  );
  if (res.status < 200 || res.status >= 300) {
    // 値は残さない（パス種別のみ）
    throw new Error("rtdb multi-path update failed: HTTP " + res.status);
  }
  return res.body;
}

/** RTDB のサーバー値インクリメント。同時実行でも失われない原子的カウンタ。 */
async function dbIncrement(path, delta) {
  return dbPatch(path.replace(/\/[^/]+$/, ""), {
    [path.split("/").pop()]: { ".sv": { increment: delta } },
  });
}

// ===== Firebase ID トークンの検証（クライアントが提示するトークンを信用する前に必ず通す）=====

const X509_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let _certCache = { keys: null, exp: 0 };
// 未知 kid による強制再取得の最短間隔（偽トークン連投での外部フェッチ増幅を防ぐ）
const CERT_FORCE_MIN_MS = 5 * 60 * 1000;
let _lastCertForce = 0;

async function googleCerts(force) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && _certCache.keys && now < _certCache.exp) return _certCache.keys;
  const res = await httpRequest(X509_URL, { method: "GET" });
  // ★ ステータスと中身を検査する。エラー応答をキャッシュすると、
  //   Google の鍵ローテーション直後や一時障害で正当なIDトークンが最大1時間 401 になる。
  if (res.status !== 200 || !res.body || typeof res.body !== "object") {
    throw new Error("certs fetch failed: HTTP " + res.status);
  }
  const keys = Object.keys(res.body);
  if (!keys.length || !/BEGIN CERTIFICATE/.test(String(res.body[keys[0]] || ""))) {
    throw new Error("certs malformed");
  }
  _certCache = { keys: res.body, exp: now + 3600 };
  return res.body;
}

/**
 * Firebase ID トークンを検証し、payload を返す。不正なら throw。
 * projectId は FIREBASE_PROJECT_ID か、サービスアカウントの project_id を使う。
 */
async function verifyIdToken(idToken) {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4096) {
    throw new Error("bad token");
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("bad token");

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) {
    throw new Error("bad token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad token");

  const projectId =
    process.env.FIREBASE_PROJECT_ID || serviceAccount().project_id || "";
  if (!projectId) throw new Error("project id not configured");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("bad token");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("bad token");
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("bad token");
  if (!(payload.exp > now)) throw new Error("expired");
  if (!(payload.iat <= now + 60)) throw new Error("bad token");

  let certs = await googleCerts();
  let pem = certs[header.kid];
  if (!pem) {
    // 鍵ローテーション直後はキャッシュに新しい kid が無い。1回だけ強制再取得する。
    // ★ ただし最短間隔を設ける。任意の kid を載せた偽トークンを連投されると、
    //   その都度 Google への外部フェッチが発生し、増幅攻撃の踏み台になる。
    const nowMs = Date.now();
    if (nowMs - _lastCertForce > CERT_FORCE_MIN_MS) {
      _lastCertForce = nowMs;
      certs = await googleCerts(true);
      pem = certs[header.kid];
    }
  }
  if (!pem) throw new Error("bad token");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(parts[0] + "." + parts[1], "ascii");
  const ok = verifier.verify(pem, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("bad token");

  return payload;
}

module.exports = {
  createCustomToken,
  verifyIdToken,
  getDbAccessToken,
  dbGet,
  dbPut,
  dbPatch,
  dbIncrement,
  dbPatchRoot,
  dataPathPrefix,
  httpRequest,
};
