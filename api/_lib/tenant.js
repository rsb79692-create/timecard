/**
 * api/_lib/tenant.js — 会社（テナント）の登録簿と、リクエスト単位の会社コンテキスト
 *
 * ===== 基本方針（ここを崩すと会社間でデータが混ざる）=====
 *  - 1つのコード・1つの Firebase プロジェクトを複数の会社で共用する。
 *    会社ごとの違いは下の TENANTS（公開してよい表示設定）と、
 *    サーバ専用の /srv/{cid}（通知先など）・/tenantReg/{cid}（利用中／停止）だけで表す。
 *  - ★ 穂乃味（honomi）は「既定テナント」かつ「レガシー配置」である。
 *    データは従来どおり /honomi・/authz・/mileage・/devmon・/ratelimit に置いたまま動かさない。
 *    パスの組み立ても従来と1文字も変えない（dbRequest の legacy 分岐）。
 *  - 新しい会社（mantel 以降）は
 *      業務データ   … /tenants/{cid}/<従来と同じ相対パス>
 *      サーバ専用   … /srv/{cid}/<authz|ratelimit|mileage|devmon>/...
 *    に置く。API のハンドラは従来どおり "tc5_staff" や "authz/pins/..." と書くだけでよく、
 *    写像は google.js の dbRequest / dbPatchRoot が1か所で行う。
 *
 *  - ★ 会社コンテキストが無い状態で DB に触れたら例外にする（フェイルクローズ）。
 *    「無ければ穂乃味」にすると、コンテキストを取りこぼした新会社のリクエストが
 *    黙って穂乃味のデータを読み書きする。取りこぼしは必ず 500 で表に出す。
 *
 *  - ★ 会社IDの正本は「トークンのクレーム c」である。body の tenant は
 *    未認証の入口（PINログイン・共有URL・端末登録）でどの会社の資格情報と
 *    照合するかを選ぶためだけに使い、認証済みの操作では必ずクレームと一致を検査する
 *    （google.js の verifyIdToken が一致しないトークンを拒否する）。
 */
"use strict";

const { AsyncLocalStorage } = require("async_hooks");

// ★ 会社ID は RTDB のキーと URL にそのまま入るので、英小文字・数字のみに限る。
const CID_RE = /^[a-z][a-z0-9]{1,23}$/;

/**
 * 会社の登録簿（公開してよい値だけ）。
 * ★ 秘密（LINE のトークン・宛先・Webhook）はここへ書かない。
 *   それらは環境変数（notifyEnv）から会社ごとに引く。
 * ★ 会社を追加するときはここに1行足し、/tenantReg/{cid}/active=true を作る（scripts/bootstrap-tenant.js）。
 *   コードのコピーは作らない。
 */
const APP_BASE_URL = "https://rsb79692-create.github.io/timecard/";

const TENANTS = Object.freeze({
  honomi: Object.freeze({
    id: "honomi",
    legacy: true,       // 従来の配置（/honomi 等）をそのまま使う
    system: true,       // システム全体の管理会社。利用停止の対象にしない
    displayName: "株式会社 穂乃味",
    appName: "穂乃味タイムカード",
    appUrl: APP_BASE_URL,
    adminUrl: APP_BASE_URL + "?token=all",
    envSuffix: "",      // 通知の環境変数は従来の名前（LINE_TO_ID 等）をそのまま使う
    // 会社ごとに有効な機能。★ 穂乃味は現行の全機能。ただし monthlyDocs は 2026-10-08 から本番停止中（index.html の同じ行と2か所で切り替える）。
    features: Object.freeze({ mileage: true, deviceWatch: true, monthlyDocs: false }),
  }),
  mantel: Object.freeze({
    id: "mantel",
    legacy: false,
    system: false,
    displayName: "マンテール株式会社",
    appName: "マンテール タイムカード",
    appUrl: APP_BASE_URL + "?c=mantel",
    adminUrl: APP_BASE_URL + "?c=mantel",
    envSuffix: "__MANTEL",
    // ★ 移動距離（穂乃味の施設間距離表が前提）と端末持ち出し監視（専用アプリの配布が前提）は、
    //   マンテールでの運用準備ができるまで無効。有効化はここを true にするだけでよい（コード分岐は不要）。
    features: Object.freeze({ mileage: false, deviceWatch: false, monthlyDocs: false }),
  }),
});

const DEFAULT_TENANT = "honomi";

// サーバ専用ツリー（Rules 未定義＝クライアントから到達不能）。
const SERVER_TOPS_RE = /^(authz|ratelimit|mileage|devmon)(\/|$)/;

// 新会社のトークンに付ける業務上のセッション期限（秒）。
// ★ Firebase の refresh token は無期限に ID トークンを取り直せ、クレームもそのまま引き継ぐ。
//   期限 sx を持たせないと、会社を利用停止にしても Storage（RTDB を参照できない）側で
//   既存セッションを止められない。RTDB 側は /tenantReg の active を毎回見るので即時に止まる。
const SESSION_SEC = Object.freeze({
  k: 24 * 3600, // 施設端末（毎日1回、施設URLで取り直す）
  s: 12 * 3600, // スタッフ
  a: 12 * 3600, // 会社管理者 / システム管理者
  v: 12 * 3600, // 労務士閲覧（トークン自身の期限が短ければそちらを使う）
  d: 12 * 3600, // 管理者デモ
  x: 12 * 3600, // スタッフテスト
});

function get(cid) {
  if (typeof cid !== "string" || !CID_RE.test(cid)) return null;
  return Object.prototype.hasOwnProperty.call(TENANTS, cid) ? TENANTS[cid] : null;
}

function list() {
  return Object.keys(TENANTS).map(function (k) { return TENANTS[k]; });
}

/**
 * 未認証の入口で body から会社を選ぶ。
 * ★ tenant 未指定は穂乃味（既存の画面は tenant を送らないため。挙動を変えない）。
 * ★ 指定されたが登録簿に無い値は null（呼び出し側で 400）。穂乃味へ倒さない。
 */
function fromBody(body) {
  const raw = body && Object.prototype.hasOwnProperty.call(body, "tenant") ? body.tenant : undefined;
  if (raw === undefined || raw === null || raw === "") return TENANTS[DEFAULT_TENANT];
  return get(raw);
}

/** トークンのクレームが示す会社。c が無いのは従来の穂乃味トークン（匿名を含む）。 */
function claimTenantId(claims) {
  if (!claims || typeof claims !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(claims, "c") || claims.c === undefined || claims.c === null) {
    return DEFAULT_TENANT;
  }
  return typeof claims.c === "string" && get(claims.c) ? claims.c : null;
}

// ===== リクエスト単位のコンテキスト =====

const als = new AsyncLocalStorage();

/** 現在の会社。コンテキスト外なら例外（フェイルクローズ）。 */
function current() {
  const t = als.getStore();
  if (!t) throw new Error("tenant context missing");
  return t;
}

/** コンテキストがあれば返す（無ければ null）。判定用。 */
function peek() {
  return als.getStore() || null;
}

/** 現在の会社でその機能が有効か。コンテキスト外は false（フェイルクローズ）。 */
function feature(name) {
  const t = peek();
  return !!(t && t.features && t.features[name] === true);
}

/**
 * スクリプト・テスト用: 以降の同期処理と、そこから始まる非同期処理を指定会社のコンテキストにする。
 * ★ API のハンドラでは使わない（handler() を使う）。1プロセス1会社のバッチ処理向け。
 */
function enterForScript(cid) {
  const t = get(cid);
  if (!t) throw new Error("unknown tenant");
  als.enterWith(t);
  return t;
}

function run(cid, fn) {
  const t = get(cid);
  if (!t) throw new Error("unknown tenant");
  return als.run(t, fn);
}

/**
 * API ハンドラを会社コンテキストで包む。
 * 会社は body.tenant（未指定は穂乃味）で選ぶ。登録簿に無ければ 400。
 * ★ 認証済みの操作では、verifyIdToken がトークンの c とこのコンテキストの一致を検査する。
 */
function handler(fn, opts) {
  // opts.cors === false … CORS 応答ヘッダを一切付けないエンドポイント（端末APIの device-report）
  const cors = !(opts && opts.cors === false);
  // opts.gate === false … 入口の事前ふるい（Origin / Content-Type）を行わない。
  //   独自の CORS 処理を持ち、従来 Origin 無しも受け付けていた通知API（line/discord）用。挙動を変えないため。
  const gate = !(opts && opts.gate === false);
  return async function tenantScopedHandler(req, res) {
    // ★ OPTIONS（CORS プリフライト）や GET は本文を持たない。会社の判定は不要なので
    //   元のハンドラの応答（204 / 405 等）をそのまま返す。DB に触れる経路は無い。
    if (req && req.method && req.method !== "POST") return fn(req, res);
    // ★ 元のハンドラが入口で拒否する要求（許可外の Origin・JSON 以外）は、会社の判定（＝DB 読み取り）を
    //   せずにそのまま渡す。元のハンドラが DB に触れる前に 403 / 415 を返す。
    const H = require("./http");
    const ct = String((req && req.headers && req.headers["content-type"]) || "").split(";")[0].trim().toLowerCase();
    const origin = cors ? H.pickOrigin(req) : "";
    if (gate && (ct !== "application/json" || (cors && !origin))) return fn(req, res);
    // 早期応答にも CORS を付ける（付けないとブラウザが本文を読めず、「利用停止」が「接続できません」に化ける）
    const early = function (status, code) {
      if (cors) H.setCors(res, origin); else res.setHeader("Cache-Control", "no-store");
      return res.status(status).json({ error: code });
    };
    const UNREADABLE = {};
    const body = (function () {
      // ★ req.body の読み取りは Vercel の JSON パーサ例外を投げうる。
      //   ここで握り潰して穂乃味へ倒すと、壊れた本文が穂乃味扱いになる。
      //   そこで例外時は「会社未確定」のまま元のハンドラへ渡し、元のハンドラ側の
      //   本文検査（bad_json 等）に任せる。DB に触れればコンテキスト欠落で例外になる。
      try { return req ? req.body : undefined; } catch (e) { return UNREADABLE; }
    })();
    if (body === UNREADABLE) return fn(req, res);
    // 本文なし（undefined / null）は従来どおり {} 扱い＝穂乃味。既存の応答を変えない。
    const t = fromBody(body && typeof body === "object" ? body : {});
    if (!t) return early(400, "unknown_tenant");
    // ★ 利用停止の会社は、トークン発行も含めて全 API を入口で止める（二重チェックのサーバ側）。
    //   Rules 側（/tenantReg/{cid}/active）と合わせて二重に遮断する。
    //   システム会社（穂乃味）は停止対象外なので DB へ問い合わせない＝従来と挙動・通信量が同じ。
    if (!t.system) {
      let active = false;
      try {
        active = await require("./google").tenantActive(t.id);
      } catch (e) {
        // 取得できない＝判定不能。利用中とみなさない（フェイルクローズ）
        console.error("[tenant] active check failed", e && e.message);
        return early(503, "tenant_unavailable");
      }
      if (!active) return early(403, "tenant_suspended");
    }
    return als.run(t, function () { return fn(req, res); });
  };
}

// ===== パスの写像 =====

/**
 * 呼び出し側の相対パス（例 "tc5_staff" / "authz/pins/x" / "mileage/settings"）を、
 * 新会社用のルートからの絶対パスへ写す。穂乃味（legacy）は null を返す＝従来経路を使う。
 */
function mapPath(p) {
  const t = current();
  if (t.legacy) return null;
  const rel = String(p || "").replace(/^\/+/, "");
  if (!rel) throw new Error("empty tenant path");
  if (SERVER_TOPS_RE.test(rel)) return "srv/" + t.id + "/" + rel;
  return "tenants/" + t.id + "/" + rel;
}

/**
 * dbPatchRoot のキー（ルート相対。先頭は authz/ratelimit/mileage/devmon/<業務データ接頭辞>）を写す。
 * 穂乃味は恒等写像。
 */
function mapRootKey(key, dataPrefix) {
  const t = current();
  if (t.legacy) return key;
  const seg = key.split("/");
  if (SERVER_TOPS_RE.test(seg[0])) return "srv/" + t.id + "/" + key;
  if (seg[0] === dataPrefix) return "tenants/" + t.id + "/" + seg.slice(1).join("/");
  throw new Error("multi-path key outside tenant roots");
}

// ===== トークン =====

/**
 * Custom Token の uid。穂乃味は従来どおり（role + ":" + rest）。
 * 新会社は会社IDを挟み、Firebase Auth 上で会社をまたいで同じユーザーにならないようにする。
 * ★ スタッフ（"s:"）だけは例外で、rest（subjectKey）自体に会社IDが混ぜてあるため
 *   従来と同じ形を保つ（/api/mileage が "s:" + subject を前提に解析する）。
 */
function uid(role, rest) {
  const t = current();
  if (t.legacy || role === "s") return role + ":" + rest;
  return role + ":" + t.id + ":" + rest;
}

/**
 * 発行するクレームに会社IDとセッション期限を足す。穂乃味は従来のまま（何も足さない）。
 * ★ 既存の穂乃味トークンの形を変えると、既存の Rules・API・画面の判定が変わる。触らない。
 */
function decorateClaims(claims, role) {
  const t = current();
  const out = Object.assign({}, claims || {});
  if (t.legacy) return out;
  out.c = t.id;
  const ttl = SESSION_SEC[role];
  if (ttl) {
    const sx = Math.floor(Date.now() / 1000) + ttl;
    if (typeof out.sx !== "number" || out.sx > sx) out.sx = sx;
  }
  return out;
}

/**
 * 会社ごとの通知用環境変数名。穂乃味は従来の名前をそのまま返す。
 * ★ 見つからなければ空文字。**穂乃味の宛先へ倒してはならない**（他社の通知が穂乃味へ届く）。
 */
function notifyEnv(name, t) {
  const tt = t || current();
  const v = process.env[name + (tt.envSuffix || "")];
  return typeof v === "string" ? v : "";
}

module.exports = {
  CID_RE,
  TENANTS,
  DEFAULT_TENANT,
  SESSION_SEC,
  get,
  list,
  fromBody,
  claimTenantId,
  current,
  peek,
  run,
  enterForScript,
  feature,
  handler,
  mapPath,
  mapRootKey,
  uid,
  decorateClaims,
  notifyEnv,
};
