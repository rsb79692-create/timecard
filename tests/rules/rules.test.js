/**
 * tests/rules/rules.test.js — Firebase Rules の会社間分離テスト（エミュレータ専用）
 *
 * 実行: cd tests/rules && npm install && npm test
 *   （firebase emulators:exec が Database / Storage エミュレータを起動して本ファイルを走らせる）
 *
 * ★ 本番の Firebase へは一切接続しない。projectId は "demo-" で始まる（エミュレータ専用の予約名）。
 *
 * 検証すること
 *   A. 穂乃味の従来動作の維持
 *      ・穂乃味と honomi-board の全シナリオについて、**変更前の Rules と結果が完全一致**すること
 *        （tests/rules/fixtures/*.pre-tenant を正本として並べて比べる）
 *   B. 会社間の遮断（必須シナリオ）
 *      ・mantel → mantel は可 / mantel → honomi は拒否
 *      ・穂乃味の一般管理者 → mantel は拒否
 *      ・system_admin → 穂乃味・mantel の両方に可（それぞれの会社のトークンで）
 *      ・匿名 → mantel は拒否 / マンテールの施設端末 → 他社は拒否
 *      ・利用停止した会社は拒否 / 期限切れ・期限なし・別会社のトークンは拒否
 *      ・Storage: マンテールから他社ファイルを取得できない
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");

const ROOT = path.join(__dirname, "..", "..");
const PROJECT = "demo-timecard-rules";
// RULES_DB_NEW を指定すると別の Rules を「新」として読む（ミューテーション確認用。通常は使わない）
const DB_NEW = fs.readFileSync(process.env.RULES_DB_NEW || path.join(ROOT, "database.rules.json"), "utf8");
const DB_OLD = fs.readFileSync(path.join(__dirname, "fixtures", "database.rules.pre-tenant.json"), "utf8");
const ST_NEW = fs.readFileSync(path.join(ROOT, "storage.rules"), "utf8");
const ST_OLD = fs.readFileSync(path.join(__dirname, "fixtures", "storage.rules.pre-tenant"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name); console.log("  FAIL  " + name); }
}
function section(t) { console.log("\n== " + t); }

const NOW = Math.floor(Date.now() / 1000);
const FUT = NOW + 3600;
const PAST = NOW - 60;

// ===== 登場人物 =====
// claims が null の要素は未認証。
const ACTORS = {
  unauth: null,
  honomiAnon: { uid: "anon1", claims: {} },
  honomiStaff: { uid: "s:n_honomistaff", claims: { r: "s", at: NOW, cv: 1 } },
  honomiAdmin: { uid: "a:main", claims: { r: "a", at: NOW, cv: 1 } },
  honomiViewer: { uid: "v:tokhonomi", claims: { r: "v", ro: true, at: NOW, cv: 1, sx: FUT } },
  honomiSys: { uid: "a:sys", claims: { r: "a", sa: true, at: NOW, cv: 1 } },
  boardCeo: { uid: "ceo1", claims: {} },
  boardMgr: { uid: "mgr1", claims: {} },
  mantelKiosk: { uid: "k:mantel:kiosk1", claims: { r: "k", c: "mantel", fk: "0123456789abcdef", at: NOW, cv: 1, sx: FUT } },
  mantelStaff: { uid: "s:n_mantelstaff", claims: { r: "s", c: "mantel", at: NOW, cv: 1, sx: FUT } },
  mantelAdmin: { uid: "a:mantel:main", claims: { r: "a", c: "mantel", at: NOW, cv: 1, sx: FUT } },
  mantelSys: { uid: "a:mantel:sys", claims: { r: "a", c: "mantel", sa: true, at: NOW, cv: 1, sx: FUT } },
  mantelViewer: { uid: "v:mantel:tok", claims: { r: "v", c: "mantel", ro: true, at: NOW, cv: 1, sx: FUT } },
  mantelExpired: { uid: "a:mantel:exp", claims: { r: "a", c: "mantel", at: NOW, cv: 1, sx: PAST } },
  mantelNoSx: { uid: "a:mantel:nosx", claims: { r: "a", c: "mantel", at: NOW, cv: 1 } },
  mantelAnonLike: { uid: "anon2", claims: { c: "mantel", sx: FUT } },
  otherTenant: { uid: "a:other:main", claims: { r: "a", c: "other", at: NOW, cv: 1, sx: FUT } },
};
const PRE_TENANT_ACTORS = ["unauth", "honomiAnon", "honomiStaff", "honomiAdmin", "honomiViewer", "honomiSys", "boardCeo", "boardMgr"];
const MANTEL_ACTORS = ["mantelKiosk", "mantelStaff", "mantelAdmin", "mantelSys", "mantelViewer"];

// ===== 操作 =====
// kind: "r"=読み取り（once('value')）/ "w"=set / "u"=update
const HONOMI_OPS = [
  ["r", "honomi/tc5_staff"], ["r", "honomi/tc5_pins"], ["r", "honomi/tc5_records"],
  ["r", "honomi/master/locations"], ["r", "honomi/tc_master_depts"],
  ["r", "honomi/tc5_paid_leave_requests"], ["r", "honomi/config"], ["r", "honomi/viewerTokens/vt1"],
  ["r", "honomi"],
  ["w", "honomi/tc5_records/r2", { staff: "x", type: "clockIn", date: "2026-09-26" }],
  ["w", "honomi/tc5_records", null],
  ["w", "honomi/tc5_paid_leave_requests/p2", { staffName: "x", status: "pending" }],
  ["u", "honomi/tc5_pins", { "山田": { hash: "h" } }],
  ["w", "honomi/viewerTokens/vt2", { enabled: true }],
  ["w", "honomi/tc5_staff", [{ name: "x" }]],
];
const BOARD_OPS = [
  ["r", "members"], ["r", "rooms"], ["r", "rooms/r1"], ["r", "config"], ["r", "field"],
  ["w", "field/f2", { a: 1 }], ["w", "config/k", 1], ["r", "shares"], ["r", "guestOf/anon1"],
];
const TENANT_OPS = [
  ["r", "tenants/mantel/tc5_staff"], ["r", "tenants/mantel/tc5_pins"], ["r", "tenants/mantel/tc5_records"],
  ["r", "tenants/mantel/master/locations"], ["r", "tenants/mantel/tc_master_depts"],
  ["r", "tenants/mantel/tc5_paid_leave_requests"], ["r", "tenants/mantel/config"],
  ["r", "tenants/mantel/viewerTokens/vt1"], ["r", "tenants/mantel"], ["r", "tenants"],
  ["w", "tenants/mantel/tc5_records/r2", { staff: "x", type: "clockIn", date: "2026-09-26" }],
  ["w", "tenants/mantel/tc5_records", null],
  ["w", "tenants/mantel/tc5_paid_leave_requests/p2", { staffName: "x", status: "pending" }],
  ["w", "tenants/mantel/tc5_pins/山田", { set: true }],
  ["w", "tenants/mantel/viewerTokens/vt2", { enabled: true }],
  ["w", "tenants/mantel/demoTokens/d2", { enabled: true }],
  ["w", "tenants/mantel/config/adminTokenSet", true],
  ["w", "tenants/mantel/unknownNode/x", 1],
  ["w", "tenants/mantel", { tc5_staff: [] }],
  ["r", "tenantReg"], ["r", "tenantReg/mantel"], ["w", "tenantReg/mantel/active", true],
  ["r", "srv/mantel/authz"], ["r", "srv"], ["r", "authz"],
];

function seedData() {
  const base = {
    tc5_staff: [{ name: "山田" }],
    tc5_pins: { "山田": { set: true } },
    tc5_records: { r1: { staff: "山田", type: "clockIn", date: "2026-09-25" } },
    master: { locations: [{ name: "本店", token: "tokA" }] },
    tc_master_depts: ["厨房"],
    tc5_paid_leave_requests: { p1: { staffName: "山田", status: "pending" } },
    config: { adminTokenSet: true },
    viewerTokens: { vt1: { enabled: true } },
  };
  return {
    honomi: base,
    tenants: { mantel: base },
    tenantReg: { mantel: { active: true } },
    srv: { mantel: { authz: { _meta: { v: 1 } } } },
    authz: { _meta: { v: 1 } },
    members: {
      ceo1: { role: "ceo", active: true },
      mgr1: { role: "mgr", active: true, rooms: { r1: true } },
    },
    rooms: { r1: { name: "room", members: { mgr1: true } } },
    config: { boardSetting: 1 },
    field: { f1: { a: 1 } },
    shares: { s1: { rid: "r1", token: "t".repeat(22), acct: "a".repeat(16) } },
  };
}

function ctxOf(env, actor) {
  const a = ACTORS[actor];
  if (!a) return env.unauthenticatedContext();
  return env.authenticatedContext(a.uid, a.claims);
}

async function outcome(env, actor, op) {
  const db = ctxOf(env, actor).database();
  const ref = db.ref(op[1]);
  let p;
  if (op[0] === "r") p = ref.once("value");
  else if (op[0] === "w") p = ref.set(op[2]);
  else p = ref.update(op[2]);
  try { await p; return "ALLOW"; } catch (e) { return "DENY"; }
}

async function reseed(env) {
  await env.withSecurityRulesDisabled(async function (ctx) {
    await ctx.database().ref().set(seedData());
  });
}

async function withEnv(dbRules, stRules, fn) {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    database: { rules: dbRules, host: "127.0.0.1", port: 9000 },
    storage: { rules: stRules, host: "127.0.0.1", port: 9199 },
  });
  try { return await fn(env); } finally { await env.cleanup(); }
}

async function matrix(env, actors, ops) {
  const out = {};
  for (const a of actors) {
    for (const op of ops) {
      await reseed(env);
      out[a + " " + op[0] + " " + op[1]] = await outcome(env, a, op);
    }
  }
  return out;
}

// ===== Storage =====
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const ST_OPS = [
  ["r", "documents/h.pdf"], ["r", "staff_uploads/h.pdf"],
  ["r", "tenants/mantel/documents/m.pdf"], ["r", "tenants/mantel/staff_uploads/m.pdf"],
  ["w", "documents/new.pdf"], ["w", "staff_uploads/new.pdf"],
  ["w", "tenants/mantel/documents/new.pdf"], ["w", "tenants/mantel/staff_uploads/new.pdf"],
  ["r", "tenants/other/documents/o.pdf"],
];
async function seedStorage(env) {
  await env.withSecurityRulesDisabled(async function (ctx) {
    const st = ctx.storage();
    for (const p of ["documents/h.pdf", "staff_uploads/h.pdf", "tenants/mantel/documents/m.pdf",
      "tenants/mantel/staff_uploads/m.pdf", "tenants/other/documents/o.pdf"]) {
      await st.ref(p).put(PDF, { contentType: "application/pdf" });
    }
  });
}
async function stOutcome(env, actor, op) {
  const st = ctxOf(env, actor).storage();
  const ref = st.ref(op[1]);
  const p = op[0] === "r" ? ref.getMetadata() : ref.put(PDF, { contentType: "application/pdf" });
  try { await p; return "ALLOW"; } catch (e) { return "DENY"; }
}
async function stMatrix(env, actors) {
  await seedStorage(env);
  const out = {};
  for (const a of actors) for (const op of ST_OPS) out[a + " " + op[0] + " " + op[1]] = await stOutcome(env, a, op);
  return out;
}

async function main() {
  const allActors = Object.keys(ACTORS);

  section("A-1. 穂乃味・honomi-board の全シナリオが変更前の Rules と一致する");
  const oldM = await withEnv(DB_OLD, ST_OLD, function (env) {
    return matrix(env, PRE_TENANT_ACTORS, HONOMI_OPS.concat(BOARD_OPS));
  });
  const newM = await withEnv(DB_NEW, ST_NEW, function (env) {
    return matrix(env, PRE_TENANT_ACTORS, HONOMI_OPS.concat(BOARD_OPS));
  });
  let diff = 0;
  Object.keys(oldM).forEach(function (k) {
    if (oldM[k] !== newM[k]) { diff++; console.log("    差異: " + k + " 旧=" + oldM[k] + " 新=" + newM[k]); }
  });
  check("穂乃味／ボードの " + Object.keys(oldM).length + " 通りがすべて同じ結果", diff === 0 && Object.keys(oldM).length > 100);
  // 従来どおりであることの具体例（比較が空振りしていないことの確認）
  check("匿名の打刻端末は従来どおり tc5_staff を読める", newM["honomiAnon r honomi/tc5_staff"] === "ALLOW");
  check("匿名の打刻端末は従来どおり打刻を書ける", newM["honomiAnon w honomi/tc5_records/r2"] === "ALLOW");
  check("匿名は従来どおり有給申請を読めない（役割つきの領域）", newM["honomiAnon r honomi/tc5_paid_leave_requests"] === "DENY");
  check("穂乃味の管理者は従来どおり有給申請を読める", newM["honomiAdmin r honomi/tc5_paid_leave_requests"] === "ALLOW");
  check("ボードのCEOは従来どおり rooms を読める", newM["boardCeo r rooms"] === "ALLOW");

  section("A-2. ボードの Rules は他社トークンでも変更前と同じ判定");
  const oldB = await withEnv(DB_OLD, ST_OLD, function (env) { return matrix(env, MANTEL_ACTORS, BOARD_OPS); });
  const newB = await withEnv(DB_NEW, ST_NEW, function (env) { return matrix(env, MANTEL_ACTORS, BOARD_OPS); });
  let diffB = 0;
  Object.keys(oldB).forEach(function (k) { if (oldB[k] !== newB[k]) { diffB++; console.log("    差異: " + k); } });
  check("ボード " + Object.keys(oldB).length + " 通りが一致", diffB === 0);

  section("B. 会社間の遮断（新しい Rules）");
  const T = await withEnv(DB_NEW, ST_NEW, async function (env) {
    const m = await matrix(env, allActors, HONOMI_OPS.concat(TENANT_OPS));
    // 利用停止
    const susp = {};
    for (const a of ["mantelAdmin", "mantelKiosk", "mantelStaff", "mantelSys"]) {
      for (const op of [["r", "tenants/mantel/tc5_staff"], ["r", "tenants/mantel/tc5_records"],
        ["w", "tenants/mantel/tc5_records/r3", { staff: "x" }]]) {
        await reseed(env);
        await env.withSecurityRulesDisabled(function (ctx) { return ctx.database().ref("tenantReg/mantel/active").set(false); });
        susp[a + " " + op[0] + " " + op[1]] = await outcome(env, a, op);
      }
    }
    // 登録簿そのものが無い（未作成）会社
    const noreg = {};
    await reseed(env);
    await env.withSecurityRulesDisabled(function (ctx) { return ctx.database().ref("tenantReg").remove(); });
    noreg.admin = await outcome(env, "mantelAdmin", ["r", "tenants/mantel/tc5_staff"]);
    return { m: m, susp: susp, noreg: noreg };
  });
  const M = T.m;
  const allow = function (a, k, p) { return M[a + " " + k + " " + p] === "ALLOW"; };
  const deny = function (a, k, p) { return M[a + " " + k + " " + p] === "DENY"; };

  // mantel → mantel
  check("mantel 管理者 → mantel の有給申請を読める", allow("mantelAdmin", "r", "tenants/mantel/tc5_paid_leave_requests"));
  check("mantel 管理者 → mantel の打刻を書ける", allow("mantelAdmin", "w", "tenants/mantel/tc5_records/r2"));
  check("mantel 管理者 → mantel の閲覧用トークンを発行できる", allow("mantelAdmin", "w", "tenants/mantel/viewerTokens/vt2"));
  check("mantel スタッフ → mantel の打刻を書ける", allow("mantelStaff", "w", "tenants/mantel/tc5_records/r2"));
  check("mantel スタッフ → mantel の有給申請を書ける", allow("mantelStaff", "w", "tenants/mantel/tc5_paid_leave_requests/p2"));
  check("mantel 労務士 → mantel を読める", allow("mantelViewer", "r", "tenants/mantel/tc5_records"));
  check("mantel 労務士 → mantel へは書けない", deny("mantelViewer", "w", "tenants/mantel/tc5_records/r2"));

  // mantel → honomi は全拒否
  for (const a of MANTEL_ACTORS.concat(["mantelAnonLike", "otherTenant"])) {
    const bad = HONOMI_OPS.filter(function (op) { return M[a + " " + op[0] + " " + op[1]] !== "DENY"; });
    check(a + " → 穂乃味の全操作（" + HONOMI_OPS.length + "件）が拒否", bad.length === 0);
    if (bad.length) console.log("    許可されてしまった: " + bad.map(function (o) { return o[0] + " " + o[1]; }).join(", "));
  }

  // 穂乃味（一般管理者・匿名・スタッフ・労務士）→ mantel は全拒否
  for (const a of ["unauth", "honomiAnon", "honomiStaff", "honomiAdmin", "honomiViewer", "honomiSys", "boardCeo", "boardMgr", "otherTenant", "mantelAnonLike", "mantelExpired", "mantelNoSx"]) {
    const bad = TENANT_OPS.filter(function (op) { return M[a + " " + op[0] + " " + op[1]] !== "DENY"; });
    check(a + " → mantel の全操作（" + TENANT_OPS.length + "件）が拒否", bad.length === 0);
    if (bad.length) console.log("    許可されてしまった: " + bad.map(function (o) { return o[0] + " " + o[1]; }).join(", "));
  }

  // system_admin は各社のトークンで両方に入れる
  check("system_admin（穂乃味として）→ 穂乃味の有給申請を読める", allow("honomiSys", "r", "honomi/tc5_paid_leave_requests"));
  check("system_admin（穂乃味として）→ 穂乃味の打刻を書ける", allow("honomiSys", "w", "honomi/tc5_records/r2"));
  check("system_admin（mantel として）→ mantel の有給申請を読める", allow("mantelSys", "r", "tenants/mantel/tc5_paid_leave_requests"));
  check("system_admin（mantel として）→ mantel の打刻を書ける", allow("mantelSys", "w", "tenants/mantel/tc5_records/r2"));

  // マンテールの施設端末
  check("施設端末 → mantel のスタッフ一覧を読める", allow("mantelKiosk", "r", "tenants/mantel/tc5_staff"));
  check("施設端末 → mantel の施設マスタを読める", allow("mantelKiosk", "r", "tenants/mantel/master/locations"));
  check("施設端末 → mantel の PIN 登録済みフラグを読める", allow("mantelKiosk", "r", "tenants/mantel/tc5_pins"));
  check("施設端末 → mantel の打刻を読める", allow("mantelKiosk", "r", "tenants/mantel/tc5_records"));
  check("施設端末 → mantel の有給申請は読めない", deny("mantelKiosk", "r", "tenants/mantel/tc5_paid_leave_requests"));
  check("施設端末 → mantel の設定は読めない", deny("mantelKiosk", "r", "tenants/mantel/config"));
  check("施設端末 → mantel 全体は読めない", deny("mantelKiosk", "r", "tenants/mantel"));
  check("施設端末 → 打刻を書けない（スタッフのログインが必要）", deny("mantelKiosk", "w", "tenants/mantel/tc5_records/r2"));
  check("施設端末 → PIN フラグを書けない", deny("mantelKiosk", "w", "tenants/mantel/tc5_pins/山田"));

  // 書き込みの許可リスト
  check("スタッフでも PIN フラグは書けない（サーバだけが書く）", deny("mantelStaff", "w", "tenants/mantel/tc5_pins/山田"));
  check("管理者でも PIN フラグは書けない（サーバだけが書く）", deny("mantelAdmin", "w", "tenants/mantel/tc5_pins/山田"));
  check("打刻の全消去は拒否", deny("mantelAdmin", "w", "tenants/mantel/tc5_records"));
  check("会社ノード全体の上書きは拒否", deny("mantelAdmin", "w", "tenants/mantel"));
  check("許可リストに無いノードへは書けない", deny("mantelAdmin", "w", "tenants/mantel/unknownNode/x"));
  check("config はクライアントから書けない（サーバだけ）", deny("mantelAdmin", "w", "tenants/mantel/config/adminTokenSet"));
  check("スタッフはデモURLを発行できない", deny("mantelStaff", "w", "tenants/mantel/demoTokens/d2"));
  check("会社の一覧（/tenants）は誰も読めない", allActors.every(function (a) { return M[a + " r tenants"] === "DENY"; }));
  check("会社の登録簿（/tenantReg）はクライアントから読めない", allActors.every(function (a) { return M[a + " r tenantReg"] === "DENY" && M[a + " r tenantReg/mantel"] === "DENY"; }));
  check("会社の登録簿（/tenantReg）はクライアントから書けない", allActors.every(function (a) { return M[a + " w tenantReg/mantel/active"] === "DENY"; }));
  check("サーバ専用（/srv・/authz）はクライアントから読めない", allActors.every(function (a) { return M[a + " r srv/mantel/authz"] === "DENY" && M[a + " r srv"] === "DENY" && M[a + " r authz"] === "DENY"; }));

  // 利用停止
  check("利用停止した会社は、管理者・端末・スタッフ・system_admin のすべてが拒否",
    Object.keys(T.susp).length === 12 && Object.keys(T.susp).every(function (k) { return T.susp[k] === "DENY"; }));
  check("登録簿が未作成の会社は拒否（既定は停止扱い）", T.noreg.admin === "DENY");

  section("C. Storage");
  const stOld = await withEnv(DB_OLD, ST_OLD, function (env) { return stMatrix(env, PRE_TENANT_ACTORS); });
  const stNew = await withEnv(DB_NEW, ST_NEW, function (env) { return stMatrix(env, allActors); });
  let sdiff = 0;
  Object.keys(stOld).forEach(function (k) {
    if (/tenants\//.test(k)) return; // 旧 Rules ではそもそも存在しないパス
    if (stOld[k] !== stNew[k]) { sdiff++; console.log("    差異: " + k + " 旧=" + stOld[k] + " 新=" + stNew[k]); }
  });
  check("穂乃味の Storage 操作は変更前と同じ結果", sdiff === 0);
  const sa = function (a, k, p) { return stNew[a + " " + k + " " + p]; };
  check("穂乃味の匿名は従来どおり documents を読める", sa("honomiAnon", "r", "documents/h.pdf") === "ALLOW");
  check("mantel 管理者 → mantel の書類を読める", sa("mantelAdmin", "r", "tenants/mantel/documents/m.pdf") === "ALLOW");
  check("mantel スタッフ → mantel へアップロードできる", sa("mantelStaff", "w", "tenants/mantel/staff_uploads/new.pdf") === "ALLOW");
  for (const a of MANTEL_ACTORS) {
    check(a + " → 穂乃味の書類は取得できない", sa(a, "r", "documents/h.pdf") === "DENY" && sa(a, "r", "staff_uploads/h.pdf") === "DENY");
    check(a + " → 穂乃味へアップロードできない", sa(a, "w", "documents/new.pdf") === "DENY" && sa(a, "w", "staff_uploads/new.pdf") === "DENY");
    check(a + " → 他社（other）の書類は取得できない", sa(a, "r", "tenants/other/documents/o.pdf") === "DENY");
  }
  check("施設端末 → mantel の書類も読めない（役割外）", sa("mantelKiosk", "r", "tenants/mantel/documents/m.pdf") === "DENY");
  for (const a of ["unauth", "honomiAnon", "honomiStaff", "honomiAdmin", "honomiSys", "otherTenant", "mantelExpired", "mantelNoSx", "mantelAnonLike"]) {
    check(a + " → mantel の書類を取得できない",
      sa(a, "r", "tenants/mantel/documents/m.pdf") === "DENY" && sa(a, "r", "tenants/mantel/staff_uploads/m.pdf") === "DENY");
  }

  console.log("\n==================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("==================================");
  if (fail) { console.log(failures.join("\n")); process.exit(1); }
}

main().catch(function (e) { console.error(e); process.exit(1); });
