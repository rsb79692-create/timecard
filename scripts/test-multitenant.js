#!/usr/bin/env node
/**
 * scripts/test-multitenant.js — 会社間分離の回帰テスト（API・サーバ側）
 *
 * 実行: node scripts/test-multitenant.js
 *   依存パッケージなし・本番へは一切接続しない（https.request を模擬に差し替える）・送信なし。
 *   鍵は実行のたびに openssl で使い捨てを作る（Firebase の署名・検証をそのまま通すため）。
 *
 * 方式: api/*.js のハンドラと api/_lib/google.js を**本物のまま**動かし、下層の HTTPS だけを
 *   模擬の Firebase（RTDB REST / OAuth / 公開鍵）・LINE・Discord に向ける。
 *   したがって「パスの写像」「トークンの会社IDの検査」「利用停止」「機能フラグ」「通知の宛先」を
 *   実際の組み立てと同じ経路で検証できる。
 *
 * 固定すること（会社間分離の必須シナリオ・API 側）
 *   ・穂乃味: トークン・パス・PINキーが従来と同一
 *   ・mantel のデータは /tenants/mantel と /srv/mantel にだけ書かれる（/honomi・/authz に触れない）
 *   ・mantel のトークンで穂乃味の API を操作できない／その逆もできない
 *   ・system_admin は各社の管理者トークン（sa 付き）を得られる／穂乃味の一般管理者PINでは他社に入れない
 *   ・会社をまたいだ同姓同名の PIN が衝突しない（穂乃味の PIN キーは従来のまま）
 *   ・利用停止した会社はログインできない（API の入口で 403）
 *   ・施設端末トークンは自社の施設URLでしか取れない
 *   ・無効な機能（mantel の移動距離・持ち出し監視）は API が拒否する
 *   ・通知は会社ごとの宛先へ。他社の宛先が無いとき穂乃味へ倒さない
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { EventEmitter } = require("events");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
}
function section(t) { console.log("\n== " + t); }

// ===== 使い捨ての鍵（サービスアカウント兼 ID トークン署名）=====
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
execSync("openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -subj /CN=test -days 1 2>/dev/null",
  { cwd: TMP, shell: "/bin/bash" });
const KEY = fs.readFileSync(path.join(TMP, "key.pem"), "utf8");
const CERT = fs.readFileSync(path.join(TMP, "cert.pem"), "utf8");
const PROJECT = "demo-proj";

process.env.FIREBASE_DATABASE_URL = "https://db.test/honomi";
process.env.FIREBASE_PROJECT_ID = PROJECT;
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: "sa@demo-proj.test", private_key: KEY, project_id: PROJECT });
process.env.TC_PIN_PEPPER = "p".repeat(40);
process.env.TC_ENC_KEY = crypto.randomBytes(32).toString("base64");
process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token-honomi";
process.env.LINE_TO_ID = "line-to-honomi";
process.env.DISCORD_WEBHOOK_URL = "https://discord.test/honomi";
delete process.env.LINE_CHANNEL_ACCESS_TOKEN__MANTEL;
delete process.env.LINE_TO_ID__MANTEL;
delete process.env.DISCORD_WEBHOOK_URL__MANTEL;

// ===== 模擬の Firebase / LINE / Discord =====
let TREE = {};
const SENT = { line: [], discord: [] };
const DBLOG = [];
function getAt(p) {
  let cur = TREE;
  for (const k of p) { if (cur === null || typeof cur !== "object" || !(k in cur)) return null; cur = cur[k]; }
  return cur === undefined ? null : cur;
}
function setAt(p, v) {
  if (!p.length) { TREE = v === null ? {} : v; return; }
  let cur = TREE;
  for (let i = 0; i < p.length - 1; i++) {
    if (cur[p[i]] === null || typeof cur[p[i]] !== "object") cur[p[i]] = {};
    cur = cur[p[i]];
  }
  if (v === null) delete cur[p[p.length - 1]]; else cur[p[p.length - 1]] = v;
}
function resolveSv(cur, v) {
  if (v && typeof v === "object" && v[".sv"] && typeof v[".sv"] === "object" && "increment" in v[".sv"]) {
    return (typeof cur === "number" ? cur : 0) + v[".sv"].increment;
  }
  return JSON.parse(JSON.stringify(v));
}
function rtdb(method, pathname, body) {
  const p = decodeURIComponent(pathname).replace(/\.json$/, "").split("/").filter(Boolean);
  DBLOG.push(method + " /" + p.join("/"));
  if (method === "GET") return { status: 200, body: getAt(p) };
  const v = body ? JSON.parse(body) : null;
  if (method === "PUT") { setAt(p, v === null ? null : resolveSv(getAt(p), v)); return { status: 200, body: v }; }
  if (method === "PATCH") {
    Object.keys(v || {}).forEach(function (k) {
      const kp = p.concat(k.split("/").filter(Boolean));
      setAt(kp, v[k] === null ? null : resolveSv(getAt(kp), v[k]));
    });
    return { status: 200, body: v };
  }
  if (method === "DELETE") { setAt(p, null); return { status: 200, body: null }; }
  return { status: 405, body: null };
}
function fakeHandle(opts, body) {
  const host = opts.hostname;
  const u = new URL("https://" + host + opts.path);
  if (host === "oauth2.googleapis.com") return { status: 200, body: { access_token: "AT", expires_in: 3600 } };
  if (host === "www.googleapis.com") return { status: 200, body: { k1: CERT } };
  if (host === "db.test") return rtdb(opts.method || "GET", u.pathname, body);
  if (host === "api.line.me") {
    SENT.line.push({ auth: (opts.headers || {}).Authorization || (opts.headers || {}).authorization, body: JSON.parse(body || "{}") });
    return { status: 200, body: {} };
  }
  if (host === "discord.test") { SENT.discord.push({ url: u.pathname, body: JSON.parse(body || "{}") }); return { status: 204, body: "" }; }
  return { status: 404, body: null };
}
https.request = function (opts, cb) {
  const req = new EventEmitter();
  let body = "";
  req.write = function (c) { body += c; };
  req.setTimeout = function () {};
  req.destroy = function () {};
  req.end = function () {
    setImmediate(function () {
      const r = fakeHandle(opts, body);
      const res = new EventEmitter();
      res.statusCode = r.status;
      cb(res);
      const raw = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      res.emit("data", raw);
      res.emit("end");
    });
  };
  return req;
};

// ===== ここから本物のモジュール =====
const T = require(path.join(ROOT, "api", "_lib", "tenant.js"));
const G = require(path.join(ROOT, "api", "_lib", "google.js"));
const S = require(path.join(ROOT, "api", "_lib", "secrets.js"));
const H = {
  admin: require(path.join(ROOT, "api", "auth", "admin.js")),
  staff: require(path.join(ROOT, "api", "auth", "staff.js")),
  pinSet: require(path.join(ROOT, "api", "auth", "pin-set.js")),
  share: require(path.join(ROOT, "api", "auth", "share.js")),
  adminPinSet: require(path.join(ROOT, "api", "auth", "admin-pin-set.js")),
  mileage: require(path.join(ROOT, "api", "mileage.js")),
  device: require(path.join(ROOT, "api", "device.js")),
  deviceReport: require(path.join(ROOT, "api", "device-report.js")),
  line: require(path.join(ROOT, "api", "line-notify.js")),
  discord: require(path.join(ROOT, "api", "discord-notify.js")),
};

function b64u(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function idToken(uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" });
  const pl = b64u(Object.assign({ aud: PROJECT, iss: "https://securetoken.google.com/" + PROJECT, sub: uid, iat: now, exp: now + 3600 }, claims || {}));
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + pl).sign(KEY, "base64url");
  return head + "." + pl + "." + sig;
}
/** Custom Token（サーバが返したもの）の中身を読む。交換後の ID トークンはこのクレームを持つ。 */
function decodeCustom(ct) { return JSON.parse(Buffer.from(String(ct).split(".")[1], "base64url").toString("utf8")); }
/** Custom Token を「交換したことにして」ID トークンを作る（Firebase の signInWithCustomToken と同じクレーム）。 */
function exchange(ct) { const p = decodeCustom(ct); return idToken(p.uid, p.claims || {}); }

let ipSeq = 1;
function mkRes() {
  const res = { statusCode: 200, headers: {}, body: null, ended: false };
  res.setHeader = function (k, v) { res.headers[k.toLowerCase()] = v; };
  res.status = function (c) { res.statusCode = c; return res; };
  res.json = function (o) { res.body = o; res.ended = true; return res; };
  res.end = function () { res.ended = true; return res; };
  return res;
}
async function call(h, body) {
  const res = mkRes();
  await h({
    method: "POST",
    headers: { origin: "https://rsb79692-create.github.io", "content-type": "application/json", "x-real-ip": "10.0.0." + ((ipSeq++ % 200) + 1) },
    body: body,
  }, res);
  return res;
}

function seed() {
  const honomiStaff = [{ name: "山田 太郎", employeeId: "H001" }, { name: "佐藤 花子" }];
  const mantelStaff = [{ name: "山田 太郎", employeeId: "M001" }, { name: "鈴木 次郎" }];
  TREE = {
    honomi: {
      tc5_staff: honomiStaff,
      tc5_pins: {},
      master: { locations: [{ name: "本店", token: "tokHonomiFacility" }] },
      viewerTokens: { vtHonomi: { enabled: true } },
    },
    authz: { _meta: { v: 1 }, adminPin: S.makePinRecord("11111111"), systemAdminPin: S.makePinRecord("99999999") },
    tenants: {
      mantel: {
        tc5_staff: mantelStaff,
        master: { locations: [{ name: "本社", token: "tokMantelFacility" }] },
        viewerTokens: { vtMantel: { enabled: true } },
      },
    },
    srv: { mantel: { authz: { _meta: { v: 1 }, adminPin: S.makePinRecord("22222222") } } },
    tenantReg: { mantel: { active: true } },
    members: { ceo1: { role: "ceo", active: true } },
    rooms: { r1: { name: "room" } },
  };
}

async function main() {
  seed();

  section("1. 会社コンテキストとパスの写像");
  {
    let threw = false;
    try { await G.dbGet("tc5_staff"); } catch (e) { threw = /tenant context missing/.test(e.message); }
    check("会社コンテキストが無いと DB に触れない（穂乃味へ倒さない）", threw);
    DBLOG.length = 0;
    await T.run("honomi", function () { return G.dbGet("tc5_staff"); });
    await T.run("honomi", function () { return G.dbGet("authz/_meta"); });
    await T.run("mantel", function () { return G.dbGet("tc5_staff"); });
    await T.run("mantel", function () { return G.dbGet("authz/_meta"); });
    await T.run("mantel", function () { return G.dbGet("mileage/settings"); });
    await T.run("mantel", function () { return G.dbGet("devmon/settings"); });
    await T.run("mantel", function () { return G.dbGet("ratelimit/1/x"); });
    check("穂乃味の業務データは従来どおり /honomi", DBLOG[0] === "GET /honomi/tc5_staff", DBLOG[0]);
    check("穂乃味の認証データは従来どおり /authz", DBLOG[1] === "GET /authz/_meta", DBLOG[1]);
    check("mantel の業務データは /tenants/mantel", DBLOG[2] === "GET /tenants/mantel/tc5_staff", DBLOG[2]);
    check("mantel の認証データは /srv/mantel/authz", DBLOG[3] === "GET /srv/mantel/authz/_meta", DBLOG[3]);
    check("mantel の移動距離は /srv/mantel/mileage", DBLOG[4] === "GET /srv/mantel/mileage/settings", DBLOG[4]);
    check("mantel の持ち出し監視は /srv/mantel/devmon", DBLOG[5] === "GET /srv/mantel/devmon/settings", DBLOG[5]);
    check("mantel のレート制限は /srv/mantel/ratelimit（全社共有の枠を使わない）", DBLOG[6] === "GET /srv/mantel/ratelimit/1/x", DBLOG[6]);
    DBLOG.length = 0;
    await T.run("mantel", function () {
      return G.dbPatchRoot({ "authz/adminMinAt": 1, "honomi/config/adminTokenSet": true });
    });
    const patched = getAt(["srv", "mantel", "authz", "adminMinAt"]) === 1 && getAt(["tenants", "mantel", "config", "adminTokenSet"]) === true;
    check("dbPatchRoot も mantel では /srv/mantel・/tenants/mantel へ写る", patched);
    check("dbPatchRoot は mantel の書き込みで穂乃味の /authz・/honomi を変えない",
      getAt(["authz", "adminMinAt"]) === null && getAt(["honomi", "config"]) === null);
    let bad = false;
    try { await T.run("mantel", function () { return G.dbPatchRoot({ "rooms/r1": null }); }); } catch (e) { bad = true; }
    check("dbPatchRoot は許可外のトップ（ボードの rooms 等）を拒否する", bad && getAt(["rooms", "r1"]) !== null);
    seed();
  }

  section("2. 管理者ログイン（穂乃味は従来と同一 / mantel は会社ID付き）");
  let honomiAdminTok, mantelAdminTok, mantelSysTok, honomiSysTok;
  {
    const r = await call(H.admin, { pin: "11111111" });
    const p = r.body && r.body.customToken ? decodeCustom(r.body.customToken) : {};
    check("穂乃味: 管理者PINでログインできる", r.statusCode === 200, String(r.statusCode));
    check("穂乃味: uid は従来どおり a:main", p.uid === "a:main", p.uid);
    check("穂乃味: クレームは従来どおり（c・sx を付けない）", p.claims && p.claims.r === "a" && !("c" in p.claims) && !("sx" in p.claims) && !("sa" in p.claims));
    honomiAdminTok = r.body && exchange(r.body.customToken);

    const r2 = await call(H.admin, { tenant: "mantel", pin: "22222222" });
    const p2 = r2.body && r2.body.customToken ? decodeCustom(r2.body.customToken) : {};
    check("mantel: 自社の管理者PINでログインできる", r2.statusCode === 200, String(r2.statusCode));
    check("mantel: uid に会社IDが入る（a:mantel:main）", p2.uid === "a:mantel:main", p2.uid);
    check("mantel: クレームに c=mantel と期限 sx", p2.claims && p2.claims.c === "mantel" && typeof p2.claims.sx === "number" && !p2.claims.sa);
    mantelAdminTok = r2.body && exchange(r2.body.customToken);

    const r3 = await call(H.admin, { tenant: "mantel", pin: "11111111" });
    check("穂乃味の管理者PINでは mantel に入れない", r3.statusCode === 401, String(r3.statusCode));
    const r4 = await call(H.admin, { pin: "22222222" });
    check("mantel の管理者PINでは穂乃味に入れない", r4.statusCode === 401, String(r4.statusCode));
    const r5 = await call(H.admin, { tenant: "nosuch", pin: "22222222" });
    check("未登録の会社IDは 400（穂乃味へ倒さない）", r5.statusCode === 400 && r5.body.error === "unknown_tenant");
  }

  section("3. system_admin（株式会社 穂乃味）");
  {
    const r = await call(H.admin, { tenant: "mantel", scope: "system", pin: "99999999" });
    const p = r.body && r.body.customToken ? decodeCustom(r.body.customToken) : {};
    check("システム管理者PINで mantel の管理者トークン（sa 付き）を得られる",
      r.statusCode === 200 && p.claims && p.claims.c === "mantel" && p.claims.sa === true && p.claims.r === "a", JSON.stringify(p.claims));
    mantelSysTok = r.body && exchange(r.body.customToken);
    const r2 = await call(H.admin, { scope: "system", pin: "99999999" });
    const p2 = r2.body && r2.body.customToken ? decodeCustom(r2.body.customToken) : {};
    check("システム管理者PINで穂乃味の管理者トークン（sa 付き・c なし）を得られる",
      r2.statusCode === 200 && p2.claims && p2.claims.sa === true && !("c" in p2.claims));
    honomiSysTok = r2.body && exchange(r2.body.customToken);
    const r3 = await call(H.admin, { tenant: "mantel", scope: "system", pin: "11111111" });
    check("穂乃味の一般管理者PINはシステム管理者として通らない", r3.statusCode === 401);
    const r4 = await call(H.admin, { tenant: "mantel", scope: "system", pin: "22222222" });
    check("mantel の管理者PINはシステム管理者として通らない", r4.statusCode === 401);

    const l1 = await call(H.admin, { op: "tenants", idToken: honomiAdminTok });
    check("穂乃味の一般管理者は会社一覧を見られない", l1.statusCode === 403);
    const l2 = await call(H.admin, { tenant: "mantel", op: "tenants", idToken: mantelAdminTok });
    check("mantel の管理者は会社一覧を見られない", l2.statusCode === 403);
    const l3 = await call(H.admin, { op: "tenants", idToken: honomiSysTok });
    const ids = l3.body && l3.body.tenants ? l3.body.tenants.map(function (t) { return t.id + ":" + t.active; }).join(",") : "";
    check("system_admin は会社一覧を見られる", l3.statusCode === 200 && ids === "honomi:true,mantel:true", ids);
    const l4 = await call(H.admin, { op: "tenantSetActive", idToken: honomiSysTok, target: "honomi", active: false });
    check("システム会社（穂乃味）は停止できない", l4.statusCode === 400);
  }

  section("4. 別会社のトークンで API を操作できない");
  {
    // mantel の管理者トークンで穂乃味のスタッフPINを上書きしようとする
    const r1 = await call(H.pinSet, { idToken: mantelAdminTok, staffName: "山田 太郎", pin: "4321" });
    check("mantel の管理者トークン → 穂乃味の PIN 設定は拒否（401）", r1.statusCode === 401, String(r1.statusCode));
    const r2 = await call(H.pinSet, { tenant: "mantel", idToken: honomiAdminTok, staffName: "山田 太郎", pin: "4321" });
    check("穂乃味の管理者トークン → mantel の PIN 設定は拒否（401）", r2.statusCode === 401, String(r2.statusCode));
    const r3 = await call(H.pinSet, { tenant: "mantel", idToken: honomiSysTok, staffName: "山田 太郎", pin: "4321" });
    check("システム管理者でも穂乃味として得たトークンでは mantel を操作できない（会社ごとに入り直す）", r3.statusCode === 401);
    const anon = idToken("anon-x", {});
    const r4 = await call(H.pinSet, { tenant: "mantel", idToken: anon, staffName: "鈴木 次郎", pin: "1111" });
    check("匿名トークン → mantel の API は拒否（401）", r4.statusCode === 401, String(r4.statusCode));
    const other = idToken("a:other:main", { r: "a", c: "other", sx: Math.floor(Date.now() / 1000) + 3600 });
    const r5 = await call(H.pinSet, { tenant: "mantel", idToken: other, staffName: "鈴木 次郎", pin: "1111" });
    check("未登録の会社のトークン → mantel の API は拒否（401）", r5.statusCode === 401, String(r5.statusCode));
    const r6 = await call(H.adminPinSet, { idToken: mantelAdminTok, pin: "33333333" });
    check("mantel の管理者トークン → 穂乃味の管理者PIN変更は拒否", r6.statusCode === 401);
    check("穂乃味の管理者PINは変わっていない", S.verifyPinCompat("11111111", TREE.authz.adminPin).ok);
  }

  section("5. 会社をまたいだ同姓同名の PIN");
  let mantelStaffTok;
  {
    const hk = T.run("honomi", function () { return S.subjectKey("山田 太郎"); });
    const mk = T.run("mantel", function () { return S.subjectKey("山田 太郎"); });
    const legacy = "n_" + crypto.createHash("sha256").update("山田 太郎", "utf8").digest("hex").slice(0, 40);
    check("穂乃味の PIN キーは従来と同じ導出（再設定不要）", hk === legacy);
    check("同じ氏名でも会社が違えばキーが違う（hash(会社ID+氏名)）", mk !== hk && /^n_[0-9a-f]{40}$/.test(mk));

    const h = await call(H.pinSet, { idToken: honomiAdminTok, staffName: "山田 太郎", pin: "1111" });
    const m = await call(H.pinSet, { tenant: "mantel", idToken: mantelAdminTok, staffName: "山田 太郎", pin: "2222" });
    check("両社で同じ氏名に別々の PIN を設定できる", h.statusCode === 200 && m.statusCode === 200, h.statusCode + "/" + m.statusCode);
    check("穂乃味の PIN は /authz/pins に（mantel のものは入らない）",
      !!getAt(["authz", "pins", hk]) && getAt(["authz", "pins", mk]) === null);
    check("mantel の PIN は /srv/mantel/authz/pins に（穂乃味のものは入らない）",
      !!getAt(["srv", "mantel", "authz", "pins", mk]) && getAt(["srv", "mantel", "authz", "pins", hk]) === null);
    check("mantel の端末向けには「登録済み」だけを置く（PIN もハッシュも置かない）",
      JSON.stringify(Object.keys(getAt(["tenants", "mantel", "tc5_pins", "山田 太郎"]) || {}).sort()) === JSON.stringify(["set", "updatedAt"]));
    check("穂乃味の tc5_pins はサーバが書かない（従来どおりクライアントの管理）", JSON.stringify(getAt(["honomi", "tc5_pins"]) || {}) === "{}");

    const anonH = idToken("anon-h", {});
    const kioskRes = await call(H.share, { tenant: "mantel", kind: "kiosk", token: "tokMantelFacility" });
    const kioskTok = kioskRes.body && kioskRes.body.customToken ? exchange(kioskRes.body.customToken) : "";
    const s1 = await call(H.staff, { idToken: anonH, staffName: "山田 太郎", pin: "1111" });
    const s2 = await call(H.staff, { idToken: anonH, staffName: "山田 太郎", pin: "2222" });
    const s3 = await call(H.staff, { tenant: "mantel", idToken: kioskTok, staffName: "山田 太郎", pin: "2222" });
    const s4 = await call(H.staff, { tenant: "mantel", idToken: kioskTok, staffName: "山田 太郎", pin: "1111" });
    check("穂乃味の山田さんは穂乃味の PIN で入れる", s1.statusCode === 200);
    check("穂乃味の山田さんに mantel の PIN は通らない", s2.statusCode === 401);
    check("mantel の山田さんは mantel の PIN で入れる", s3.statusCode === 200);
    check("mantel の山田さんに穂乃味の PIN は通らない", s4.statusCode === 401);
    const p3 = s3.body && s3.body.customToken ? decodeCustom(s3.body.customToken) : {};
    const p1 = s1.body && s1.body.customToken ? decodeCustom(s1.body.customToken) : {};
    check("穂乃味のスタッフトークンは従来の形（uid s:<キー>・c なし）", p1.uid === "s:" + hk && !("c" in (p1.claims || {})));
    check("mantel のスタッフトークンは c=mantel・uid が穂乃味と別", p3.uid === "s:" + mk && p3.claims && p3.claims.c === "mantel");
    mantelStaffTok = s3.body && exchange(s3.body.customToken);

    const rv = await call(H.pinSet, { tenant: "mantel", idToken: mantelAdminTok, staffName: "山田 太郎", reveal: true });
    check("mantel の管理者は自社スタッフの PIN を確認できる（サーバで復号）", rv.statusCode === 200 && rv.body.pin === "2222");
    const rv2 = await call(H.pinSet, { idToken: honomiAdminTok, staffName: "山田 太郎", reveal: true });
    check("穂乃味では PIN 確認 API を使わない（従来どおり画面側）", rv2.statusCode === 403);
    const rv3 = await call(H.pinSet, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎", reveal: true });
    check("mantel のスタッフは PIN 確認 API を使えない", rv3.statusCode === 403);
  }

  section("6. 施設端末トークン（自社の施設URLだけ）");
  {
    const k1 = await call(H.share, { tenant: "mantel", kind: "kiosk", token: "tokMantelFacility" });
    const p = k1.body && k1.body.customToken ? decodeCustom(k1.body.customToken) : {};
    check("mantel の施設URLで施設端末トークンを得られる", k1.statusCode === 200 && p.claims && p.claims.r === "k" && p.claims.c === "mantel" && typeof p.claims.sx === "number");
    check("施設端末トークンは施設名を載せない（キーだけ）", p.claims && /^[0-9a-f]{16}$/.test(p.claims.fk) && JSON.stringify(p).indexOf("本社") < 0);
    const k2 = await call(H.share, { tenant: "mantel", kind: "kiosk", token: "tokHonomiFacility" });
    check("穂乃味の施設URLで mantel の施設端末トークンは得られない", k2.statusCode === 401);
    const k3 = await call(H.share, { kind: "kiosk", token: "tokHonomiFacility" });
    check("穂乃味では施設端末トークンを発行しない（従来どおり匿名で起動）", k3.statusCode === 401);
    const v1 = await call(H.share, { tenant: "mantel", kind: "viewer", token: "vtMantel" });
    const vp = v1.body && v1.body.customToken ? decodeCustom(v1.body.customToken) : {};
    check("mantel の閲覧用URL → c=mantel の閲覧トークン", v1.statusCode === 200 && vp.claims && vp.claims.c === "mantel" && vp.claims.r === "v");
    const v2 = await call(H.share, { tenant: "mantel", kind: "viewer", token: "vtHonomi" });
    check("穂乃味の閲覧用URLは mantel として通らない", v2.statusCode === 401);
    const v3 = await call(H.share, { kind: "viewer", token: "vtHonomi" });
    const v3p = v3.body && v3.body.customToken ? decodeCustom(v3.body.customToken) : {};
    check("穂乃味の閲覧用URLは従来どおり（c なし）", v3.statusCode === 200 && !("c" in (v3p.claims || {})));
  }

  section("7. 機能フラグ（mantel は移動距離・持ち出し監視が無効）");
  {
    const m1 = await call(H.mileage, { tenant: "mantel", idToken: mantelAdminTok, action: "adminBootstrap" });
    check("mantel の移動距離 API は 403 feature_disabled", m1.statusCode === 403 && m1.body.error === "feature_disabled");
    const d1 = await call(H.device, { tenant: "mantel", idToken: mantelAdminTok, action: "bootstrap" });
    check("mantel の持ち出し監視 API は 403 feature_disabled", d1.statusCode === 403 && d1.body.error === "feature_disabled");
    const d2 = await call(H.deviceReport, { tenant: "mantel", action: "report", deviceId: "dev0000000000001", deviceToken: "x" });
    check("mantel の端末報告は 403 feature_disabled", d2.statusCode === 403 && d2.body.error === "feature_disabled");
    const m2 = await call(H.mileage, { idToken: honomiAdminTok, action: "adminBootstrap" });
    check("穂乃味の移動距離 API は機能フラグで止まらない", !(m2.body && m2.body.error === "feature_disabled"), JSON.stringify(m2.body));
  }

  section("8. 通知の宛先（会社ごと・穂乃味へ倒さない）");
  {
    SENT.line.length = 0; SENT.discord.length = 0;
    const d0 = await call(H.discord, { staffName: "山田 太郎", facilityName: "本店" });
    check("穂乃味のアップロード通知は従来の宛先へ", d0.statusCode === 200 && SENT.discord.length === 1 && SENT.discord[0].url === "/honomi");
    check("穂乃味の通知本文は従来どおり（会社見出しを足さない）", SENT.discord[0] && SENT.discord[0].body.content.indexOf("📷 写真アップロード通知") === 0);
    const d1 = await call(H.discord, { tenant: "mantel", staffName: "山田 太郎" });
    check("mantel の通知はトークン無しでは送れない", d1.statusCode === 401);
    const d2 = await call(H.discord, { tenant: "mantel", idToken: honomiAdminTok, staffName: "山田 太郎" });
    check("穂乃味のトークンでは mantel の通知を鳴らせない", d2.statusCode === 401);
    const d3 = await call(H.discord, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎" });
    check("mantel の宛先が未設定なら送らない（穂乃味の宛先へ倒さない）", d3.statusCode === 500 && SENT.discord.length === 1);
    process.env.DISCORD_WEBHOOK_URL__MANTEL = "https://discord.test/mantel";
    const d4 = await call(H.discord, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎", facilityName: "本社" });
    const last = SENT.discord[SENT.discord.length - 1];
    check("mantel の通知は mantel の宛先へ", d4.statusCode === 200 && last.url === "/mantel");
    check("mantel の通知本文に穂乃味の名前・URL が入らない",
      last && last.body.content.indexOf("穂乃味") < 0 && last.body.content.indexOf("?c=mantel") > 0 && last.body.content.indexOf("マンテール") >= 0);

    const l0 = await call(H.line, { staffName: "山田 太郎" });
    check("穂乃味の LINE 通知は従来の宛先・見出し", l0.statusCode === 200 && SENT.line[0].body.to === "line-to-honomi"
      && SENT.line[0].body.messages[0].text.indexOf("【穂乃味タイムカード】") === 0 && SENT.line[0].body.messages[0].text.indexOf("?token=all") > 0);
    const l1 = await call(H.line, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎" });
    check("mantel の LINE 宛先が未設定なら送らない（穂乃味へ倒さない）", l1.statusCode === 500 && SENT.line.length === 1);
    process.env.LINE_CHANNEL_ACCESS_TOKEN__MANTEL = "line-token-mantel";
    process.env.LINE_TO_ID__MANTEL = "line-to-mantel";
    const l2 = await call(H.line, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎" });
    const ll = SENT.line[SENT.line.length - 1];
    check("mantel の LINE 通知は mantel の宛先・mantel のトークン", l2.statusCode === 200 && ll.body.to === "line-to-mantel" && ll.auth === "Bearer line-token-mantel");
    check("mantel の LINE 本文に穂乃味の名前が入らない", ll.body.messages[0].text.indexOf("穂乃味") < 0 && ll.body.messages[0].text.indexOf("マンテール") >= 0);
  }

  section("9. 利用停止（API 入口で止める）");
  {
    const s1 = await call(H.admin, { op: "tenantSetActive", idToken: honomiSysTok, target: "mantel", active: false });
    check("system_admin が mantel を停止できる", s1.statusCode === 200 && getAt(["tenantReg", "mantel", "active"]) === false);
    const a1 = await call(H.admin, { tenant: "mantel", pin: "22222222" });
    check("停止中の会社は管理者ログインできない（403 tenant_suspended）", a1.statusCode === 403 && a1.body.error === "tenant_suspended");
    const a2 = await call(H.share, { tenant: "mantel", kind: "kiosk", token: "tokMantelFacility" });
    check("停止中の会社は施設端末トークンも取れない", a2.statusCode === 403);
    const a3 = await call(H.staff, { tenant: "mantel", idToken: mantelStaffTok, staffName: "山田 太郎", pin: "2222" });
    check("停止中の会社はスタッフログインできない", a3.statusCode === 403);
    const a4 = await call(H.admin, { tenant: "mantel", scope: "system", pin: "99999999" });
    check("停止中の会社にはシステム管理者としても入れない（再開してから入る）", a4.statusCode === 403);
    const a5 = await call(H.admin, { pin: "11111111" });
    check("他社の停止は穂乃味に影響しない", a5.statusCode === 200);
    const s2 = await call(H.admin, { op: "tenantSetActive", idToken: honomiSysTok, target: "mantel", active: true });
    const a6 = await call(H.admin, { tenant: "mantel", pin: "22222222" });
    check("再開すると再びログインできる", s2.statusCode === 200 && a6.statusCode === 200);
    // 登録簿そのものが無い会社は停止扱い（キャッシュが切れるのを待つ）
    setAt(["tenantReg", "mantel"], null);
    await new Promise(function (r) { setTimeout(r, 5200); });
    const a7 = await call(H.admin, { tenant: "mantel", pin: "22222222" });
    check("登録簿が未作成の会社は停止扱い（既定で拒否）", a7.statusCode === 403);
    setAt(["tenantReg", "mantel"], { active: true });
  }

  section("10. 施設端末の定期スイープは会社ごと（無効な会社は回さない）");
  {
    const src = fs.readFileSync(path.join(ROOT, "api", "device-report.js"), "utf8");
    check("スイープは会社ごとのコンテキストで runSweep を呼ぶ", /T\.run\(t\.id, sweepOneTenant\)/.test(src));
    check("監視機能が無効な会社・停止中の会社は回さない",
      /deviceWatch === true\)\) continue;/.test(src) && /!t\.system && !\(await G\.tenantActive\(t\.id\)\)/.test(src));
  }

  section("11. 共通処理に会社固有の値を直書きしていない");
  {
    const files = ["api/line-notify.js", "api/discord-notify.js", "api/_lib/device.js", "api/auth/admin.js",
      "api/auth/staff.js", "api/auth/share.js", "api/auth/pin-set.js", "api/device-report.js", "api/device.js", "api/mileage.js"];
    const hits = files.filter(function (f) {
      const s = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /穂乃味|マンテール/.test(s) || /timecard\/\?token=all/.test(s);
    });
    check("社名・管理画面URLは会社設定（tenant.js）だけにある", hits.length === 0, hits.join(", "));
    const dev = fs.readFileSync(path.join(ROOT, "api", "_lib", "device.js"), "utf8");
    check("持ち出し検知の LINE 宛先は会社ごと（従来の環境変数を直接読まない）",
      !/process\.env\.LINE_(TO_ID|CHANNEL_ACCESS_TOKEN)/.test(dev) && /T\.notifyEnv\("LINE_TO_ID", tenant\)/.test(dev));
  }

  section("12. 会社の一覧と機能フラグがサーバ・画面・SW・スクリプトで一致");
  {
    const vm = require("vm");
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const m = html.match(/var TENANT_CONFIGS=(\{[\s\S]*?\n\});/);
    let client = null;
    try { client = vm.runInNewContext("(" + m[1] + ")"); } catch (e) { client = null; }
    const server = T.TENANTS;
    const ids = Object.keys(server).sort().join(",");
    check("画面（index.html）の会社一覧がサーバと一致", client && Object.keys(client).sort().join(",") === ids,
      client ? Object.keys(client).join(",") : "抽出失敗");
    check("会社ごとの機能フラグがサーバと画面で一致",
      client && Object.keys(server).every(function (k) {
        return JSON.stringify(server[k].features) === JSON.stringify(client[k].features);
      }));
    check("穂乃味だけが legacy（従来配置）", Object.keys(server).filter(function (k) { return server[k].legacy; }).join(",") === "honomi"
      && client && Object.keys(client).filter(function (k) { return client[k].legacy; }).join(",") === "honomi");
    const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    const swm = sw.match(/const TENANT_NOTIFY = (\{[\s\S]*?\n\});/);
    let swT = null;
    try { swT = vm.runInNewContext("const APP_URL='x';(" + swm[1] + ")"); } catch (e) { swT = null; }
    check("sw.js の通知設定の会社一覧がサーバと一致", swT && Object.keys(swT).sort().join(",") === ids);
    const nc = fs.readFileSync(path.join(ROOT, "scripts", "notify-check.js"), "utf8");
    const mc = fs.readFileSync(path.join(ROOT, "scripts", "morning-check.js"), "utf8");
    check("notify-check.js の会社一覧がサーバと一致",
      Object.keys(server).every(function (k) { return new RegExp("\\n  " + k + ": \\{").test(nc); }));
    check("morning-check.js の会社一覧がサーバと一致",
      Object.keys(server).every(function (k) { return new RegExp("\\n  " + k + ": \\{").test(mc); }));
    Object.keys(server).filter(function (k) { return !server[k].legacy; }).forEach(function (k) {
      check(k + ": manifest とロゴが在る",
        fs.existsSync(path.join(ROOT, client[k].manifest)) && fs.existsSync(path.join(ROOT, client[k].logo.src)));
    });
  }

  console.log("\n==================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("==================================");
  if (fail) { console.log(failures.join("\n")); process.exit(1); }
}

main().catch(function (e) { console.error(e); process.exit(1); });
