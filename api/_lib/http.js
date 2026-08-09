/**
 * api/_lib/http.js — 認証APIの共通HTTP処理（CORS・入力検証・応答の同一化）
 *
 * 既存 api/line-notify.js / discord-notify.js の Origin 判定は
 *   if (origin && origin !== ALLOWED_ORIGIN) → 403
 * となっており、Origin ヘッダを送らないリクエスト（curl 等）が素通りする。
 * ★ このファイルではその実装パターンを踏襲せず、Origin 不在を明確に拒否する。
 *   ただし Origin 検査は「ブラウザ経由攻撃への多層防御」であって認証ではない。
 *   非ブラウザは任意の Origin を送れるため、実効的な防御はレート制限とPIN自体である。
 */
"use strict";

// 本番オリジン。Vercel の Preview URL は許可しない（Preview は保護が弱く別オリジンになるため）。
const ALLOWED_ORIGINS = [
  "https://rsb79692-create.github.io",
  "https://timecard-rho.vercel.app",
];

function pickOrigin(req) {
  const o = req.headers["origin"] || "";
  return ALLOWED_ORIGINS.indexOf(o) >= 0 ? o : "";
}

function setCors(res, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  // 認証応答をどこにもキャッシュさせない
  res.setHeader("Cache-Control", "no-store");
  // Access-Control-Allow-Credentials は設定しない（Cookieを使わない＝CSRFが原理的に成立しない）
}

/** 認証失敗はすべて同一の応答にする（存在するスタッフ/施設の列挙を防ぐ） */
function fail(res, status, code) {
  res.status(status).json({ error: code });
}

const INVALID = "invalid_credentials";

/**
 * 共通の前処理。戻り値が null でなければ、その時点で応答済み。
 */
function guard(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    // プリフライトは Origin 許可時のみ 204
    if (!origin) { res.status(403).end(); return true; }
    res.status(204).end();
    return true;
  }
  if (req.method !== "POST") {
    fail(res, 405, "method_not_allowed");
    return true;
  }
  // ★ Origin 不在を拒否する（既存 api/*.js の穴を踏襲しない）
  if (!origin) {
    fail(res, 403, "forbidden");
    return true;
  }
  // Content-Type を application/json に限定する。
  // text/plain や form 系は CORS のシンプルリクエストに該当し、
  // プリフライトなしのクロスオリジン POST を許してしまう。
  const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    fail(res, 415, "unsupported_media_type");
    return true;
  }
  return false;
}

/** 応答時間の下限を設ける（タイミング差から実在アカウントを推測されないため） */
function withMinDuration(startedAt, minMs) {
  const elapsed = Date.now() - startedAt;
  const wait = Math.max(0, minMs - elapsed);
  return new Promise((r) => setTimeout(r, wait));
}

/** 例外を外へ漏らさない。内部情報・スタックはクライアントへ返さない。 */
function serverError(res, cid) {
  res.status(500).json({ error: "server_error", cid: cid });
}

function correlationId() {
  return require("crypto").randomBytes(8).toString("hex");
}

/**
 * クライアントIPを取り出す。
 * ★ x-forwarded-for の「左端」を使ってはならない。追記形式のプロキシでは
 *   左端はクライアントが自由に注入でき、レート制限を無効化できる。
 *   Vercel が付与する x-vercel-forwarded-for / x-real-ip を優先し、
 *   XFF を使う場合は最も右（＝最後に信頼できるプロキシが追記した値）を採る。
 */
/**
 * IPv6 アドレスを /64 プレフィクスへ丸める。丸められない（IPv4 等）なら null。
 * ★ 多くのホスティングは 1 ホストへ /64（2^64 アドレス）を割り当てる。
 *   アドレスを 1 リクエストごとに変えるだけで per-IP のレート制限を無効化できるため、
 *   レート制限のキーは /64 単位に正規化する。IPv4 は従来どおり完全一致。
 */
function ipv6Prefix64(ip) {
  let s = String(ip || "").trim();
  // [addr] / [addr]:port 形式は中身を取り出す。ポートを残すとアドレスが同じでも
  // ポート違いで別キーになり、丸めの意味が失われる。
  const br = s.match(/^\[(.+)\](?::\d+)?$/);
  if (br) s = br[1];
  s = s.split("%")[0];
  if (s.indexOf(":") < 0) return null;                  // IPv4
  // ★ "::" 始まりは IPv4-mapped / IPv4-compatible。IPv4 として扱い丸めない。
  //   ドット十進表記の分岐の中だけで判定すると、16進表記（::ffff:c000:201）が
  //   すり抜けて全件が 0:0:0:0::/64 という単一キーに合流してしまう。
  if (/^::/.test(s)) return null;
  // 末尾がドット十進の混在表記（例 2001:db8:1:2::192.0.2.1）は正規の IPv6 なので、
  // ドット十進を2グループへ変換して通常どおり /64 を取る。
  // ★ ここを一律 return null にすると、上流の表記次第で /64 回転による回避が復活する。
  const dq = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dq) {
    const o = [dq[2], dq[3], dq[4], dq[5]].map(Number);
    if (o.some((n) => !(n >= 0 && n <= 255))) return null;
    s = dq[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;                   // 不正
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    groups = left.concat(new Array(fill).fill("0"), right);
  } else {
    groups = left;
    if (groups.length !== 8) return null;   // 省略記法が無いなら必ず8グループ
  }
  if (groups.length !== 8) return null;
  // ★ 8グループすべてを検証する。先頭4つだけだと不正な文字列でもキーを返してしまう。
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function clientIp(req) {
  const h = req.headers || {};
  const vf = String(h["x-vercel-forwarded-for"] || "").trim();
  if (vf) return norm(vf.split(",").pop().trim());
  const rip = String(h["x-real-ip"] || "").trim();
  if (rip) return norm(rip);
  const xff = String(h["x-forwarded-for"] || "").trim();
  if (xff) return norm(xff.split(",").pop().trim());
  return "unknown";
}
/**
 * レート制限キー用に正規化する。
 * ★ IPv6 は /64 に丸める。丸められない（IPv4 等）場合でも、
 *   ブラケットと :port を落としてから返す。原文字列のまま返すと、
 *   送信元ポートを変えるだけで別キーになり per-IP 上限を回避できてしまう。
 */
function stripHostPort(ip) {
  let s = String(ip || "").trim();
  const br = s.match(/^\[(.+)\](?::\d+)?$/);
  if (br) return br[1].split("%")[0];
  // IPv4:port（コロンが1つだけ）。IPv6 は複数コロンなので誤爆しない。
  const m = s.match(/^([^:]+):\d+$/);
  if (m) return m[1];
  return s.split("%")[0];
}
function norm(ip) {
  return ipv6Prefix64(ip) || stripHostPort(ip);
}

function str(v, max) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > (max || 256) ? "" : s;
}

module.exports = {
  ALLOWED_ORIGINS,
  guard,
  fail,
  INVALID,
  withMinDuration,
  serverError,
  correlationId,
  clientIp,
  ipv6Prefix64,
  stripHostPort,
  str,
};
