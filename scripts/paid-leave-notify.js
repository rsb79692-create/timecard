/**
 * paid-leave-notify.js — 有給の付与日 LINE通知（docs/features/paid-leave-grant-notify.md）
 *
 * 有給管理の「付与予定（未登録）」と同じ判定で、付与日を迎えたのに付与行（tc5_paid_leave_balances）が
 * まだ無いものを管理者の LINE へ知らせる。GitHub Actions（paid-leave-notify.yml）から1日1回実行する。
 *   ・毎朝: 今日が付与日の未登録があれば「有給の付与日です」
 *   ・毎週月曜: 付与日を過ぎてまだ未登録のもの（期限切れを除く）をまとめて1通（今日の分も同じ1通に入れる）
 *   ・対象が無ければ送らない
 * ★ 読むだけ（RTDB へは GET だけ。書き込みはしない）。通知記録も持たない（1日1回の cron 前提）。
 * ★ 付与日数は出さない（出勤日数の全履歴が要るため。日数は有給管理の画面で確認して登録する）。
 * Node.js 標準モジュールのみ（npm install 不要）。
 */

"use strict";

const https = require("https");
const crypto = require("crypto");

// PAID-LEAVE-NOTIFY-PURE-BEGIN
// ===== 会社（テナント）=====
// ★ notify-check.js / morning-check.js と同じ。既定は穂乃味（TENANT_ID 未指定）。
//   他社は TENANT_ID=<会社ID> で起動し、その会社の Secrets（末尾 __<会社ID大文字>）と
//   その会社のデータ（/tenants/<会社ID>）だけを使う。穂乃味の宛先・データ・社名へは倒さない。
const TENANTS = {
  honomi: { appName: "穂乃味タイムカード" },
  mantel: { appName: "マンテール タイムカード" },
};

// 1つの見出しに載せる最大行数（超える分は「他 N 件」）。LINE の1通は5000文字まで。
const MAX_LINES_PER_SECTION = 30;
const MAX_NAME_LEN = 40;

function pad2(n) { return String(n).padStart(2, "0"); }

// UTC のミリ秒 → "YYYY-MM-DD"（UTC の暦。タイムゾーンに依存しない計算だけに使う）
function utcYmd(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

// "YYYY-MM-DD" が実在する日付か
function isValidYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  return utcYmd(Date.UTC(+m[1], +m[2] - 1, +m[3])) === s;
}

// 入社日の読み取り。★ index.html の parsePaidLeaveHireDate と同じ結果になるようにしている
//   （"/" "." を "-" に直す・8桁は YYYYMMDD・月は1〜12・日は1〜31で、31日に満たない月は翌月へ繰り越す
//    ＝ new Date("2019-02-30") が 2019-03-02 になるのと同じ）。
//   それ以外の形（時刻付きなど）は読まない（null）＝通知しない。件数だけログへ出す。
function parseHireDate(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  let s = String(raw).trim().replace(/\//g, "-").replace(/\./g, "-");
  if (/^\d{8}$/.test(s)) s = s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, mo - 1, d)); // 繰り越しを確定させてから月を足す（index.html と同じ順）
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

// 付与日の一覧。★ index.html の calcPaidLeaveSchedule と同じ式
//   （第n回 = 入社日 + 6 + (n-1)*12 か月。日が無い月は翌月へ繰り越す。期限は2年後の前日。今日より後は含めない）。
//   index.html は端末の「今日」を使うが、ここは JST の今日を引数で受ける（test-paid-leave-notify.js が一致を検査する）。
function calcGrantSchedule(hireRaw, todayYmd) {
  const hd = parseHireDate(hireRaw);
  if (!hd) return [];
  const out = [];
  for (let n = 1; n <= 30; n++) {
    const off = 6 + (n - 1) * 12;
    const g = new Date(Date.UTC(hd.y, hd.m + off, hd.d));
    const gs = utcYmd(g.getTime());
    if (gs > todayYmd) break;
    const ex = new Date(Date.UTC(g.getUTCFullYear(), g.getUTCMonth() + 24, g.getUTCDate()));
    ex.setUTCDate(ex.getUTCDate() - 1);
    out.push({ grantNum: n, grantDate: gs, expiresAt: utcYmd(ex.getTime()) });
  }
  return out;
}

// RTDB の値（配列・オブジェクト・null）→ オブジェクトの配列
function toList(v) {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
  if (v && typeof v === "object") return Object.keys(v).map((k) => v[k]).filter((x) => x && typeof x === "object");
  return [];
}

function trimStr(v) { return (v === undefined || v === null) ? "" : String(v).trim(); }

// 付与行の社員番号。★ index.html の normalizePaidLeaveBalance と同じ解決
//   （staffId が社員番号として在ればそのまま。無ければ旧形式＝氏名とみなし、同名で社員番号を持つ人が1人だけならその番号）。
function balanceStaffId(b, staff) {
  const raw = (b.staffId === undefined || b.staffId === null) ? "" : String(b.staffId);
  const sid = raw.trim();
  if (!sid) return raw;
  if (staff.some((s) => trimStr(s.employeeId) === sid)) return raw;
  const resolve = (name) => {
    const hit = staff.filter((s) => s.name === name && trimStr(s.employeeId) !== "");
    return hit.length === 1 ? trimStr(hit[0].employeeId) : null;
  };
  const r = resolve(sid) || (b.staffName ? resolve(trimStr(b.staffName)) : null);
  return r || raw;
}

// 未登録の付与。★ index.html の getPaidLeaveUnregistered と同じ対象
//   （退職・社員番号なし・社員番号の重複・入社日なしは除く。社員番号＋付与日の付与行があれば登録済み）。
function findUnregisteredGrants(staffRaw, balancesRaw, todayYmd) {
  const staff = toList(staffRaw);
  const idCounts = Object.create(null);
  staff.forEach((s) => { const k = trimStr(s.employeeId); if (k) idCounts[k] = (idCounts[k] || 0) + 1; });
  const dupIds = Object.keys(idCounts).filter((k) => idCounts[k] > 1);
  const have = Object.create(null);
  toList(balancesRaw).forEach((b) => { have[balanceStaffId(b, staff) + "\u0000" + b.grantDate] = true; });
  const grants = [];
  let noIdCount = 0, badHireCount = 0;
  staff.forEach((s) => {
    if (s.status === "退職") return;
    const sid = trimStr(s.employeeId);
    if (!sid) { noIdCount++; return; }
    if (dupIds.indexOf(sid) >= 0) return;
    if (!s.hireDate) return;
    if (!parseHireDate(s.hireDate)) { badHireCount++; return; }
    calcGrantSchedule(s.hireDate, todayYmd).forEach((it) => {
      if (have[sid + "\u0000" + it.grantDate]) return;
      grants.push({ staffId: sid, staffName: typeof s.name === "string" ? s.name : "", grantNum: it.grantNum, grantDate: it.grantDate, expiresAt: it.expiresAt });
    });
  });
  return { grants, dupIds, noIdCount, badHireCount };
}

// 実行時刻（UTC ミリ秒）→ JST の "YYYY-MM-DD"
function jstYmd(nowMs) { return utcYmd(nowMs + 9 * 60 * 60 * 1000); }

// "YYYY-MM-DD" が月曜か（暦の計算だけ。タイムゾーンに依存しない）
function isMondayYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return !!m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() === 1;
}

function byDateThenName(a, b) {
  return a.grantDate < b.grantDate ? -1 : a.grantDate > b.grantDate ? 1
    : a.staffName < b.staffName ? -1 : a.staffName > b.staffName ? 1 : a.grantNum - b.grantNum;
}

// 送るかどうかと載せる内容。送らないときは null。
//   today:   今日が付与日の未登録（毎日）
//   overdue: 付与日を過ぎて未登録・期限内（月曜だけ）
//   expiredCount: 期限切れで未登録（登録不要。月曜に件数だけ添える）
function planNotification(unreg, todayYmd) {
  const grants = (unreg && unreg.grants) || [];
  // 付与日が今日の回は期限内（期限は2年後の前日）なので、期限は見なくてよい
  const today = grants.filter((g) => g.grantDate === todayYmd).sort(byDateThenName);
  const monday = isMondayYmd(todayYmd);
  if (!monday) return today.length ? { kind: "today", today, overdue: [], expiredCount: 0, idIssueCount: 0 } : null;
  const overdue = grants.filter((g) => g.grantDate < todayYmd && g.expiresAt >= todayYmd).sort(byDateThenName);
  if (!today.length && !overdue.length) return null;
  return {
    kind: "weekly",
    today,
    overdue,
    expiredCount: grants.filter((g) => g.expiresAt < todayYmd).length,
    idIssueCount: ((unreg && unreg.dupIds) || []).length + ((unreg && unreg.noIdCount) || 0),
  };
}

// LINE 本文に入れる氏名（改行・制御文字を除き、長さを抑える）
function safeName(s) {
  const t = String(s || "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "（氏名なし）";
  return t.length > MAX_NAME_LEN ? t.slice(0, MAX_NAME_LEN) + "…" : t;
}

function jpDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : ymd;
}

// mask: 公開ログ用。氏名だけでなく第n回・付与日も伏せる（付与日と回から入社日を逆算できるため）
function grantLines(items, mask) {
  const shown = items.slice(0, MAX_LINES_PER_SECTION);
  const lines = shown.map((g) => mask ? "・＊＊＊（氏名・回・付与日は伏せています）"
    : `・${safeName(g.staffName)}　第${g.grantNum}回（付与日 ${g.grantDate}）`);
  if (items.length > shown.length) lines.push(`　他 ${items.length - shown.length} 件`);
  return lines.join("\n");
}

const REGISTER_GUIDE = "管理画面の「有給管理」→「付与予定（未登録）」から登録してください。";

// 本文。mask=true は公開ログ用の伏せ字（送信には使わない）
function buildMessage(plan, appName, todayYmd, mask) {
  const nm = !!mask;
  if (!plan || (!plan.today.length && !plan.overdue.length)) return ""; // 載せるものが無ければ本文を作らない
  const head = `【${appName}】\n`;
  if (plan.kind === "today") {
    return head + `有給の付与日です（${jpDate(todayYmd)}）\n\n` +
      grantLines(plan.today, nm) + "\n\n" + REGISTER_GUIDE;
  }
  let body = head + `有給付与の登録待ち（毎週月曜のお知らせ・${jpDate(todayYmd)}）\n`;
  if (plan.today.length) body += `\n▼今日が付与日（${plan.today.length}件）\n` + grantLines(plan.today, nm) + "\n";
  if (plan.overdue.length) body += `\n▼付与日を過ぎて未登録（${plan.overdue.length}件）\n` + grantLines(plan.overdue, nm) + "\n";
  body += "\n" + REGISTER_GUIDE;
  if (plan.expiredCount > 0) body += `\n（期限切れの付与回 ${plan.expiredCount} 件は登録不要のため載せていません）`;
  if (plan.idIssueCount > 0) body += `\n（社員番号が未設定・重複のため判定できない人がいます。有給管理の警告を確認してください）`;
  return body;
}
// PAID-LEAVE-NOTIFY-PURE-END

// ===== ここから下は実行時だけ（require されたときは動かない）=====

const HTTP_TIMEOUT_MS = 15 * 1000;
const LINE_SEND_TRIES = 3;
const LINE_RETRY_DELAYS_MS = [2000, 6000];

function fail(msg) {
  console.error("[ERROR] " + msg);
  process.exit(1);
}

function loadConfig(env) {
  const tenantId = trimStr(env.TENANT_ID) || "honomi";
  if (!Object.prototype.hasOwnProperty.call(TENANTS, tenantId)) fail("未登録の TENANT_ID です");
  const legacy = tenantId === "honomi";
  const suffix = legacy ? "" : ("__" + tenantId.toUpperCase());
  const dryRun = trimStr(env.DRY_RUN) === "true";
  const testNotify = trimStr(env.TEST_NOTIFY) === "true";

  // ⚠ 名前だけを出す。値は出さない。LINE は dryRun なら無くてよい（送らないため）。
  const need = [];
  if (!dryRun) need.push("LINE_CHANNEL_ACCESS_TOKEN" + suffix, "LINE_TO_ID" + suffix);
  if (!testNotify) need.push("FIREBASE_DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT_KEY");
  const missing = need.filter((k) => !trimStr(env[k]) || trimStr(env[k]) === "temp");
  if (missing.length) fail("以下の GitHub Secret が未設定です: " + missing.join(", "));

  let sa = null, dbUrl = null;
  if (!testNotify) {
    try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY); } catch (_) { sa = null; }
    if (!sa || typeof sa !== "object") fail("FIREBASE_SERVICE_ACCOUNT_KEY が有効な JSON ではありません");
    const lack = ["client_email", "private_key"].filter((k) => !sa[k]);
    if (lack.length) fail("FIREBASE_SERVICE_ACCOUNT_KEY に次のキーがありません: " + lack.join(", "));
    let origin;
    try { origin = new URL(env.FIREBASE_DATABASE_URL).origin; } catch (_) { fail("FIREBASE_DATABASE_URL を解釈できません"); }
    // 穂乃味は従来どおり Secret の値（.../honomi）。他社はオリジン + /tenants/<会社ID>。
    dbUrl = legacy ? String(env.FIREBASE_DATABASE_URL).trim().replace(/\/$/, "") : (origin + "/tenants/" + tenantId);
  }

  const targetDate = trimStr(env.TARGET_DATE);
  if (targetDate && !isValidYmd(targetDate)) fail("TARGET_DATE は実在する yyyy-mm-dd で指定してください");

  return {
    tenantId, appName: TENANTS[tenantId].appName, dryRun, testNotify, targetDate, sa, dbUrl,
    lineToken: env["LINE_CHANNEL_ACCESS_TOKEN" + suffix], // ログ出力禁止
    lineTo: trimStr(env["LINE_TO_ID" + suffix]),            // ログ出力禁止
    onActions: trimStr(env.GITHUB_ACTIONS) === "true",
  };
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: (options && options.method) || "GET",
      headers: (options && options.headers) || {},
    }, (res) => {
      res.setEncoding("utf8"); // chunk の境界で日本語が割れないように
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (_) { /* 文字列のまま */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => { const e = new Error("timeout"); e.code = "ETIMEDOUT"; req.destroy(e); });
    if (body) req.write(body);
    req.end();
  });
}

// サービスアカウント → OAuth2 アクセストークン（notify-check.js と同じ方式）。⚠ トークンはログへ出さない。
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email,
    sub: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(input, "ascii");
  const jwt = input + "." + signer.sign({ key: sa.private_key, padding: crypto.constants.RSA_PKCS1_PADDING }, "base64url");
  const res = await httpRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt);
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    // 応答本文は出さない（鍵の情報が含まれうるため）
    throw new Error("OAuth2 アクセストークンを取得できません（HTTP " + res.status + "）");
  }
  return res.body.access_token;
}

// 読むだけ（GET）。⚠ URL は出さない（Secret の一部を含むため）。パス名だけ出す。
async function fetchRTDB(cfg, path, token) {
  const res = await httpRequest(`${cfg.dbUrl}/${path}.json`, { headers: { Authorization: "Bearer " + token } });
  console.log(`[RTDB]  GET ${path} → HTTP ${res.status}`);
  if (res.status !== 200) throw new Error(`RTDB の読み取りに失敗しました（${path}: HTTP ${res.status}）`);
  return res.body;
}

// LINE push。同じ retry key で最大3回（LINE 側で同じ key は1通にまとめられる）。
async function sendLine(cfg, text) {
  const retryKey = crypto.randomUUID();
  const payload = JSON.stringify({ to: cfg.lineTo, messages: [{ type: "text", text }] });
  for (let i = 0; i < LINE_SEND_TRIES; i++) {
    let status = 0;
    try {
      const res = await httpRequest("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + cfg.lineToken,
          "X-Line-Retry-Key": retryKey,
        },
      }, payload);
      status = res.status;
    } catch (e) {
      console.warn("[LINE]  通信エラー（" + (e.code || "error") + "）");
    }
    console.log(`[LINE]  response status=${status || "なし"}（${i + 1}回目）`);
    if (status === 200) { console.log("[LINE]  送信成功"); return; }
    if (status === 409) { console.log("[LINE]  受付済み（同じ retry key の再送）"); return; }
    if (status >= 400 && status < 500) break; // 4xx は再送しても直らない
    if (i < LINE_SEND_TRIES - 1) await new Promise((r) => setTimeout(r, LINE_RETRY_DELAYS_MS[i]));
  }
  throw new Error("LINE Push に失敗しました");
}

async function deliver(cfg, text, maskedText) {
  if (cfg.dryRun) {
    console.log("[DRY]   dryRun=true → LINE送信スキップ。送信予定メッセージ ↓");
    // ⚠ 公開リポジトリの Actions ログには氏名を出さない（伏せ字の本文を出す）。手元の実行だけ実名で出す。
    console.log("---\n" + (cfg.onActions ? maskedText : text) + "\n---");
    return;
  }
  await sendLine(cfg, text);
}

async function main() {
  const cfg = loadConfig(process.env);
  console.log("[START] paid-leave-notify.js");
  console.log(`[CONFIG] TENANT=${cfg.tenantId} DRY_RUN=${cfg.dryRun} TEST_NOTIFY=${cfg.testNotify}`);

  if (cfg.testNotify) {
    const t = `【${cfg.appName}】\nテスト通知（有給の付与日のお知らせ）\n\nLINE通知設定は正常です。`;
    await deliver(cfg, t, t);
    console.log("[DONE]  テスト通知完了");
    return;
  }

  const today = cfg.targetDate || jstYmd(Date.now());
  console.log(`[DATE]  基準日（JST）: ${today}${cfg.targetDate ? "（手動指定）" : ""} 月曜=${isMondayYmd(today)}`);

  const token = await getAccessToken(cfg.sa);
  const staff = await fetchRTDB(cfg, "tc5_staff", token);
  const balances = await fetchRTDB(cfg, "tc5_paid_leave_balances", token);

  const unreg = findUnregisteredGrants(staff, balances, today);
  // ⚠ ログは件数だけ（氏名・社員番号・入社日は出さない）
  console.log(`[CHECK] 未登録の付与: ${unreg.grants.length} 件（社員番号の重複 ${unreg.dupIds.length} 件・社員番号なし ${unreg.noIdCount} 名・入社日を読めない ${unreg.badHireCount} 名）`);

  const plan = planNotification(unreg, today);
  if (!plan) {
    console.log("[OK]    通知対象なし — LINE送信スキップ");
    return;
  }
  console.log(`[PLAN]  ${plan.kind === "today" ? "付与日のお知らせ" : "月曜のまとめ"}: 今日 ${plan.today.length} 件・過ぎて未登録 ${plan.overdue.length} 件・期限切れ ${plan.expiredCount} 件`);
  const text = buildMessage(plan, cfg.appName, today);
  const masked = buildMessage(plan, cfg.appName, today, true);
  await deliver(cfg, text, masked);
  console.log("[DONE]  処理完了");
}

if (require.main === module) {
  main().catch((err) => {
    // 通信エラー（code あり）はホスト名などを含みうるので code だけ出す。自前のエラー文は値を含まない。
    console.error("[FATAL]", err && err.code ? ("通信エラー " + err.code) : (err && err.message ? err.message : "error"));
    process.exit(1);
  });
}

module.exports = {
  TENANTS, MAX_LINES_PER_SECTION,
  parseHireDate, calcGrantSchedule, findUnregisteredGrants, balanceStaffId, toList,
  jstYmd, isMondayYmd, isValidYmd, planNotification, buildMessage, safeName, loadConfig, main,
};
