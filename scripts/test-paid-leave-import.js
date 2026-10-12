/**
 * 有給残日数CSVの一括登録の回帰テスト（docs/features/paid-leave-import.md）
 * 依存パッケージなし・送信なし・本番データ非アクセス（合成データのみ）
 *
 * 実行: node scripts/test-paid-leave-import.js
 *
 * 方式:
 *   index.html の「CSV一括登録（施設・従業員）: 純粋関数 BEGIN〜END」（CSVIMP）と、
 *   法定の付与日数の表（calculatePaidLeaveGrantDays・judgeWeeklyEquivByAnnualDays）、
 *   付与日の一覧（calcPaidLeaveSchedule）を抜き出して vm で評価する。
 *   登録処理（csvImpPlCommit）は模擬の authFetch で動かす。
 */
"use strict";
// ★ 既存の calcPaidLeaveSchedule は new Date("YYYY-MM-DD")（UTC 解釈）を使うため、UTC より西の TZ では1日ずれる。
//   運用は JST の端末なので、比較は JST に固定する（Date を使う前に設定する）。
process.env.TZ = "Asia/Tokyo";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}
function slice(a, b) {
  const s = html.indexOf(a), e = s < 0 ? -1 : html.indexOf(b, s);
  if (s < 0 || e < 0) { console.error("ERROR: index.html から抽出できませんでした: " + a); process.exit(1); }
  return html.slice(s, e);
}
const PURE = slice("// ===== CSV一括登録（施設・従業員）: 純粋関数 BEGIN =====", "// ===== CSV一括登録（施設・従業員）: 純粋関数 END =====");
const UI = slice("// ===== CSV一括登録: 画面と登録処理 =====", "// ===== 資料管理 =====");
// 付与日の一覧・法定の表（index.html の実物）
const SCHED = slice("function parsePaidLeaveHireDate(dateStr){", "// 指定月(YYYY-MM)の出勤日数を返す。");
const FMT = slice("function fmtDateKey(d){", "\n");

const ctx = vm.createContext({ TextDecoder, Uint8Array, Date, JSON, Object, Array, String, Math, console, parseInt, isNaN });
vm.runInContext(PURE + "\n" + FMT + "\nfunction pad(n){return String(n).padStart(2,'0');}\n" + SCHED +
  "\nthis.CSVIMP=CSVIMP;this.calcPaidLeaveSchedule=calcPaidLeaveSchedule;this.calculatePaidLeaveGrantDays=calculatePaidLeaveGrantDays;this.judgeWeeklyEquivByAnnualDays=judgeWeeklyEquivByAnnualDays;this.fmtDateKey=fmtDateKey;", ctx);
const C = ctx.CSVIMP;
const DEPS = { grantDays: ctx.calculatePaidLeaveGrantDays, weeklyByAnnual: ctx.judgeWeeklyEquivByAnnualDays };
const TODAY = "2026-10-12";
const HEAD = "社員番号,氏名,有給残日数,年間出勤日数,直近付与日数,前回付与日数";
const enc = (s, bom) => { const b = Buffer.from(s, "utf8"); return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), b]) : b); };
function prep(text, bom) { const d = C.decode(enc(text, bom)); if (!d.ok) return d; return C.prepare("pl", d.text); }
function run(text, staff, balances, today) {
  const p = prep(text, true);
  if (!p.ok) return p;
  return C.validatePaidLeave(p.rows, staff, balances, today || TODAY, DEPS, p.fileWarnings);
}
function item(res, line) { return res.items.find(x => x.line === line); }
function msgs(res, line) { const it = item(res, line); return it ? it.msgs.map(m => m.lv + ":" + m.t).join(" | ") : ""; }

// 合成スタッフ（実在の人物ではない）
const STAFF = [
  { name: "山田太郎", employeeId: "1001", hireDate: "2015/04/01", status: "在籍" },          // 長期: 第11回 2025-10-01, 第12回 2026-10-01
  { name: "佐藤花子", employeeId: "1002", hireDate: "2025/09/15", status: "在籍" },          // 第1回 2026-03-15 だけ
  { name: "鈴木一郎", employeeId: "", hireDate: "2020/04/01", status: "在籍" },              // 社員番号なし
  { name: "高橋次郎", employeeId: "1004", hireDate: "", status: "在籍" },                    // 入社日なし
  { name: "田中三郎", employeeId: "1005", hireDate: "2026/08/01", status: "在籍" },          // 付与前
  { name: "伊藤四郎", employeeId: "1006", hireDate: "2018/01/10", status: "退職" },
  { name: "渡辺五郎", employeeId: "1007", hireDate: "2019/05/20", status: "在籍" },
  { name: "中村六郎", employeeId: "1007", hireDate: "2019/05/20", status: "在籍" },          // 社員番号重複
  { name: "小林 七子", employeeId: "1009", hireDate: "2019/05/20", status: "在籍" },         // 空白入りで登録
  { name: "加藤八子", employeeId: "1010", hireDate: "2020/02/01", status: "在籍", weeklyWorkDays: 3 },
];

console.log("■ 付与日の一覧は calcPaidLeaveSchedule と一致する");
{
  const today = ctx.fmtDateKey(new Date());
  const hires = ["2015-04-01", "2020-01-31", "2020-02-29", "2019-08-31", "2024-12-31", "2026-03-01", "2010-07-15", "2025-04-30"];
  hires.forEach(h => {
    const a = JSON.stringify(C.plSchedule(h, today)), b = JSON.stringify(ctx.calcPaidLeaveSchedule(h));
    check("入社 " + h + " の付与日・期限が既存の算出と同じ", a === b, a + " vs " + b);
  });
}

console.log("■ 文字コード・見出し");
{
  const p = prep(HEAD + "\r\n,山田太郎,10,250,,\r\n", true);
  check("BOM付きUTF-8を読める・日本語の氏名", p.ok && p.rows[0].v["氏名"] === "山田太郎");
  const miss = prep("氏名,有給残日数\r\n山田太郎,1\r\n", true);
  check("列不足はエラー", !miss.ok && /列が不足しています/.test(miss.error));
}

console.log("■ 正常系（直近の付与分の残り・超える分は前回の付与分へ）");
{
  const r = run(HEAD + "\r\n,山田太郎,15,265,,\r\n,佐藤花子,8,250,,\r\n", STAFF, null);
  const a = item(r, 2), b = item(r, 3);
  check("山田: 登録予定", a.action === "add", msgs(r, 2));
  check("山田: 前回（第11回 2025-10-01）と直近（第12回 2026-10-01）の2行", a.rec && a.rec.grants.length === 2 && a.rec.grants[0].grantDate === "2025-10-01" && a.rec.grants[1].grantDate === "2026-10-01" && a.rec.grants[1].grantNum === 12, JSON.stringify(a.rec));
  check("山田: 残15日は直近（付与20日）に全部、前回は残0", a.rec.grants[1].grantedDays === 20 && a.rec.grants[1].remainDays === 15 && a.rec.grants[0].remainDays === 0);
  check("山田: 期限は付与日の2年後の前日", a.rec.grants[1].expiresAt === "2028-09-30" && a.rec.grants[0].expiresAt === "2027-09-30");
  check("山田: 社員番号はスタッフ管理の値", a.rec.staffId === "1001");
  check("佐藤: 第1回（2026-03-15）だけ、付与10日・残8日", b.action === "add" && b.rec.grants.length === 1 && b.rec.grants[0].grantDate === "2026-03-15" && b.rec.grants[0].grantedDays === 10 && b.rec.grants[0].remainDays === 8, msgs(r, 3));
}
{
  const r = run(HEAD + "\r\n,山田太郎,37,265,,\r\n,山田太郎x,1,,,\r\n", STAFF, null);
  const a = item(r, 2);
  check("残37日: 直近20日＋前回17日に分ける（合計は37日のまま）", a.action === "add" && a.rec.grants[1].remainDays === 20 && a.rec.grants[0].remainDays === 17 && a.rec.grants[0].grantedDays === 20, msgs(r, 2));
  const r40 = run(HEAD + "\r\n,山田太郎,40,265,,\r\n", STAFF, null);
  check("残40日: 20＋20", item(r40, 2).action === "add" && item(r40, 2).rec.grants.every(g => g.remainDays === 20));
  const r41 = run(HEAD + "\r\n,山田太郎,41,265,,\r\n", STAFF, null);
  check("残41日はエラー（40日超）", item(r41, 2).action === "error");
  const rS = run(HEAD + "\r\n,佐藤花子,11,250,,\r\n", STAFF, null);
  check("期限内の付与が1回だけで残日数が付与日数を超えるとエラー", item(rS, 2).action === "error" && /超えています/.test(msgs(rS, 2)), msgs(rS, 2));
}
{
  // 週相当: 年間 150日 → 週3日相当。第12回 → 11日、第11回 → 11日
  const r = run(HEAD + "\r\n,山田太郎,15,150,,\r\n", STAFF, null);
  const a = item(r, 2);
  check("年間出勤日数150日→週3日相当: 直近11日・前回11日、残は11＋4", a.action === "add" && a.rec.grants[1].grantedDays === 11 && a.rec.grants[1].remainDays === 11 && a.rec.grants[0].remainDays === 4, msgs(r, 2));
  const r2 = run(HEAD + "\r\n,山田太郎,23,150,,\r\n", STAFF, null);
  check("週3日相当で直近11＋前回11を超える残23日はエラー", item(r2, 2).action === "error", msgs(r2, 2));
  const r3 = run(HEAD + "\r\n,山田太郎,30,40,18,16\r\n", STAFF, null);
  check("付与日数の列の入力を優先する（年間40日でも可）", item(r3, 2).action === "add" && item(r3, 2).rec.grants[1].grantedDays === 18 && item(r3, 2).rec.grants[0].grantedDays === 16 && item(r3, 2).rec.grants[0].remainDays === 12, msgs(r3, 2));
  const r4 = run(HEAD + "\r\n,山田太郎,0,40,,\r\n", STAFF, null);
  check("年間47日以下・週所定未設定で付与日数の列も空欄はエラー（推測しない）", item(r4, 2).action === "error" && /直近付与日数/.test(msgs(r4, 2)), msgs(r4, 2));
  const r5 = run(HEAD + "\r\n,加藤八子,5,,,\r\n", STAFF, null);
  check("年間出勤日数が空欄ならスタッフ管理の週所定労働日数（週3）で算出", item(r5, 2).action === "add" && item(r5, 2).rec.grants[1].grantedDays === 11, msgs(r5, 2));
  const r6 = run(HEAD + "\r\n,加藤八子,5,250,,\r\n", STAFF, null);
  check("年間出勤日数と週所定労働日数が食い違うと警告", item(r6, 2).action === "add" && /週所定労働日数/.test(msgs(r6, 2)) && r6.counts.warn === 1);
}

console.log("■ 登録しない人（理由を表示）");
{
  const csv = HEAD + "\r\n" + [",鈴木一郎,5,250,,", ",高橋次郎,5,250,,", ",伊藤四郎,5,250,,", ",渡辺五郎,5,250,,",
    ",小林七子,5,250,,", ",未登録太郎,5,250,,", "9999,山田太郎,5,250,,", ",田中三郎,0,40,,", ",田中三郎x,,,,", ",佐藤花子,abc,250,,"].join("\r\n") + "\r\n";
  const r = run(csv, STAFF, null);
  check("社員番号なし → エラー", item(r, 2).action === "error" && /社員番号が未設定/.test(msgs(r, 2)));
  check("入社日なし → エラー", item(r, 3).action === "error" && /入社日が未設定/.test(msgs(r, 3)));
  check("退職者 → エラー", item(r, 4).action === "error" && /退職/.test(msgs(r, 4)));
  check("社員番号の重複 → エラー", item(r, 5).action === "error" && /重複/.test(msgs(r, 5)));
  check("表記ゆれ（空白だけ違う）は紐付けない", item(r, 6).action === "error" && /小林 七子/.test(msgs(r, 6)));
  check("未登録の氏名 → エラー（従業員CSVを先に）", item(r, 7).action === "error" && /従業員CSV/.test(msgs(r, 7)));
  check("CSVの社員番号がスタッフ管理と違う → エラー", item(r, 8).action === "error" && /違います/.test(msgs(r, 8)));
  check("付与前で残0 → スキップ", item(r, 9).action === "skip", msgs(r, 9));
  check("有給残日数の空欄 → エラー", item(r, 10).action === "error" && /空欄/.test(msgs(r, 10)));
  check("有給残日数が数でない → エラー", item(r, 11).action === "error");
  const r2 = run(HEAD + "\r\n,田中三郎,3,250,,\r\n", STAFF, null);
  check("付与前なのに残日数がある → エラー", item(r2, 2).action === "error" && /付与日がまだ来ていない/.test(msgs(r2, 2)));
  const r3 = run(HEAD + "\r\n,山田太郎,5,250,,\r\n,山田太郎,6,250,,\r\n", STAFF, null);
  check("CSV内の同じ氏名は両方エラー", item(r3, 2).action === "error" && item(r3, 3).action === "error");
  const r4 = run(HEAD + "\r\n,=山田太郎,5,250,,\r\n", STAFF, null);
  check("先頭が = の値はエラー（CSV injection）", item(r4, 2).action === "error");
  const r5 = run(HEAD + "\r\n,山田太郎,2.3,250,,\r\n", STAFF, null);
  check("0.5日刻みでない残日数はエラー", item(r5, 2).action === "error");
  const r6 = run(HEAD + "\r\n,山田太郎,2.5,250,,\r\n", STAFF, null);
  check("0.5日刻みは受け付ける", item(r6, 2).action === "add" && item(r6, 2).rec.grants[1].remainDays === 2.5);
}

console.log("■ 二重登録の防止");
{
  const renamed = { y: { staffId: "旧氏名", staffName: "旧氏名", grantDate: "2025-10-01", remainDays: 3 } };
  const p = prep(HEAD + "\r\n,山田太郎,15,265,,\r\n", true);
  const deps = Object.assign({}, DEPS, { balanceStaffId: b => (b.staffId === "旧氏名" ? "1001" : b.staffId) });
  const r = C.validatePaidLeave(p.rows, STAFF, renamed, TODAY, deps, []);
  check("改名前の旧形式の付与行も正規化後の社員番号で検出してスキップ", item(r, 2).action === "skip");
  const r0 = run(HEAD + "\r\n,山田太郎,5,265,0,\r\n", STAFF, null);
  check("付与日数の列に0はエラー", item(r0, 2).action === "error");
  const dupName = STAFF.concat([{ name: "山田太郎", employeeId: "2001", hireDate: "2015/04/01", status: "在籍" }]);
  const rd = run(HEAD + "\r\n,山田太郎,5,265,,\r\n", dupName, null);
  check("同じ氏名のスタッフが複数いればエラー", item(rd, 2).action === "error" && /2人/.test(msgs(rd, 2)));
  const badId = STAFF.concat([{ name: "記号太郎", employeeId: "A.1", hireDate: "2015/04/01", status: "在籍" }]);
  const rk = run(HEAD + "\r\n,記号太郎,5,265,,\r\n", badId, null);
  check("社員番号に Firebase のキーに使えない文字があればエラー", item(rk, 2).action === "error");
  const rw = run(HEAD + "\r\n,佐藤花子,5,250,,10\r\n", STAFF, null);
  check("前回が期限切れ・付与前のとき前回付与日数は使わず警告", item(rw, 2).action === "add" && /前回付与日数は使いません/.test(msgs(rw, 2)));
}
{
  const bal = { "plb_1001_2024-10-01_1": { id: "plb_1001_2024-10-01_1", staffId: "1001", staffName: "山田太郎", grantDate: "2024-10-01", grantedDays: 20, usedDays: 0, remainDays: 3 } };
  const r = run(HEAD + "\r\n,山田太郎,15,265,,\r\n", STAFF, bal);
  check("付与行が1件でもある人はスキップ（期限切れの行でも）", item(r, 2).action === "skip" && /登録済み/.test(msgs(r, 2)));
  const old = { x: { staffId: "山田太郎", grantDate: "2025-10-01", grantedDays: 20, remainDays: 3 } };
  const r2 = run(HEAD + "\r\n,山田太郎,15,265,,\r\n", STAFF, old);
  check("旧形式（staffId=氏名）の付与行も検出してスキップ", item(r2, 2).action === "skip");
}

console.log("■ PATCH の中身（remainDays は CSV から決めた値・usedDays 0）");
{
  const r = run(HEAD + "\r\n,山田太郎,37,265,,\r\n,佐藤花子,8,250,,\r\n,鈴木一郎,5,250,,\r\n", STAFF, null);
  const patch = C.buildPaidLeavePatch(r, 1700000000000, "2026-10-12T00:00:00.000Z");
  const ks = Object.keys(patch);
  check("付与行は3件（山田2・佐藤1。エラーの人は書かない）", ks.length === 3, ks.join(","));
  check("キーは id と同じで plb_<社員番号>_<付与日>_<時刻>", ks.every(k => patch[k].id === k && /^plb_\d+_\d{4}-\d{2}-\d{2}_1700000000000$/.test(k)));
  check("usedDays は 0、remainDays は分けた値", patch["plb_1001_2026-10-01_1700000000000"].remainDays === 20 && patch["plb_1001_2025-10-01_1700000000000"].remainDays === 17 && ks.every(k => patch[k].usedDays === 0));
  check("Firebase のキーに使えない文字を含まない", ks.every(k => !/[.#$\[\]\/]/.test(k)));
  check("確認時の要約に時刻を含まない（再検証で一致する）", C.signature(r) === C.signature(run(HEAD + "\r\n,山田太郎,37,265,,\r\n,佐藤花子,8,250,,\r\n,鈴木一郎,5,250,,\r\n", STAFF, null)));
  check("★ grantedDays - usedDays で残日数を作っていない（残日数 < 付与日数のまま）", patch["plb_1002_2026-03-15_1700000000000"].remainDays === 8 && patch["plb_1002_2026-03-15_1700000000000"].grantedDays === 10);
}

console.log("■ 登録処理（模擬通信）");
function makeEnv(opts) {
  const db = { "/tc5_staff.json": opts.staff, "/tc5_paid_leave_balances.json": opts.balances == null ? null : opts.balances };
  const calls = [];
  const env = {
    isAdminAuthenticated: opts.admin !== false, demoMode: false, viewerMode: false, writePolicy: "full",
    facilitiesLoaded: true, _adminElevatePromise: null, FB_URL: "https://example.invalid",
    masterFacilities: [], staffList: [], masterDepts: [], staffPins: {}, paidLeaveBalances: [], DEF_DEPTS: [],
    alerts: [], renders: 0,
    showAlert(m) { env.alerts.push(m); }, render() { env.renders++; }, getTodayJSTStr() { return TODAY; },
    calculatePaidLeaveGrantDays: ctx.calculatePaidLeaveGrantDays, judgeWeeklyEquivByAnnualDays: ctx.judgeWeeklyEquivByAnnualDays,
    normalizePaidLeaveBalance: b => Object.assign({}, b), _lsSet() {},
    afterElevation() { return Promise.resolve(env._adminElevatePromise); }, applyFacilitiesLocal() {}, esc: s => String(s),
    authFetch: async (url, o) => {
      const p = url.replace("https://example.invalid", "");
      const m = (o && o.method) || "GET";
      calls.push(m + " " + p);
      if (opts.failGet && m === "GET") return { ok: false, status: 503, json: async () => null };
      if (m === "PATCH") {
        if (opts.failPatch) return { ok: false, status: opts.failPatch, json: async () => null };
        const body = JSON.parse(o.body);
        db[p] = Object.assign({}, db[p] || {}, body);
        return { ok: true, status: 200, json: async () => null };
      }
      if (opts.mutateBeforeGet && calls.filter(c => c.startsWith("GET")).length === 1) opts.mutateBeforeGet(db);
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(db[p] == null ? null : db[p])) };
    },
    Promise, Object, Array, JSON, String, Uint8Array, console, Date,
  };
  env.CSVIMP = C;
  const c = vm.createContext(env);
  vm.runInContext(UI + "\nthis.csvImp=csvImp;this.csvImpPlCommit=csvImpPlCommit;this.csvImpPick=csvImpPick;this.csvImpValidate=csvImpValidate;this.csvImpHtml=csvImpHtml;", c);
  return { c, db, calls };
}
async function runCommit(env, text, previewStaff, previewBal) {
  const p = prep(text, true);
  const st = { fileName: "x.csv", prep: p, result: env.c.csvImpValidate("pl", p, previewStaff, previewBal), error: "", failMsg: "", done: null };
  env.c.csvImp.pl = st;
  env.c.csvImpPlCommit();
  for (let i = 0; i < 50 && env.c.csvImp.busy; i++) await new Promise(r => setImmediate(r));
  return st;
}
const STAFF_OBJ = Object.assign({}, STAFF);
(async () => {
  const csv = HEAD + "\r\n,山田太郎,37,265,,\r\n,佐藤花子,8,250,,\r\n,鈴木一郎,5,250,,\r\n";
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: { keep: { id: "keep", staffId: "9999", staffName: "他人", grantDate: "2026-01-01", remainDays: 5 } } });
    const st = await runCommit(env, csv, STAFF, env.db["/tc5_paid_leave_balances.json"]);
    const patches = env.calls.filter(c => c.startsWith("PATCH"));
    check("正常登録: 登録直前に取り直してから1回の PATCH", patches.length === 1 && env.calls.indexOf("GET /tc5_staff.json") < env.calls.indexOf(patches[0]) && st.done && st.done.add === 2 && st.done.rows === 3, JSON.stringify(env.calls) + " " + st.failMsg);
    check("正常登録: 既存の付与行（他人）は残る", env.db["/tc5_paid_leave_balances.json"].keep.remainDays === 5);
    check("正常登録: 登録後を取り直して確認済み", st.done.verified === true);
    check("正常登録: 端末の付与行一覧も最新になる", env.c.paidLeaveBalances.length === 4);
    check("正常登録: エラーの人の理由は結果画面に出る", st.done.error === 1 && /社員番号が未設定/.test(env.c.csvImpHtml()));
    const st2 = await runCommit(env, csv, STAFF, env.db["/tc5_paid_leave_balances.json"]);
    check("同じCSVの2回目は全員スキップで書かない", st2.result.counts.add === 0 && env.calls.filter(c => c.startsWith("PATCH")).length === 1);
  }
  {
    // 確認後に別の端末で山田さんの付与行が登録された
    const env = makeEnv({ staff: STAFF_OBJ, balances: null, mutateBeforeGet: db => { db["/tc5_paid_leave_balances.json"] = { z: { staffId: "1001", grantDate: "2026-10-01", remainDays: 1 } }; } });
    const st = await runCommit(env, csv, STAFF, null);
    check("確認後にデータが変わったら書かずに確認し直させる", !st.done && env.calls.every(c => !c.startsWith("PATCH")) && /もう一度確認/.test(st.failMsg) && item(st.result, 2).action === "skip", st.failMsg);
  }
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: null, failGet: true });
    const st = await runCommit(env, csv, STAFF, null);
    check("最新を取得できなければ書かない（フェイルクローズ）", !st.done && env.calls.every(c => !c.startsWith("PATCH")) && /何も登録していません/.test(st.failMsg));
  }
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: null, failPatch: 403 });
    const st = await runCommit(env, csv, STAFF, null);
    check("権限エラーは「何も登録していません」", !st.done && /権限/.test(st.failMsg));
  }
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: null, admin: false });
    const st = await runCommit(env, csv, STAFF, null);
    check("管理者以外は登録しない（通信もしない）", !st.done && env.calls.length === 0 && env.c.alerts.length === 1);
  }
  {
    // ファイル選択時: 管理者トークンの確立を待ってから最新を取り、検証する。氏名は画面でエスケープする
    const xs = Object.assign({}, STAFF_OBJ, { 99: { name: "<b>悪</b>", employeeId: "1099", hireDate: "2015/04/01", status: "在籍" } });
    const env = makeEnv({ staff: xs, balances: null });
    let released = false, release;
    env.c._adminElevatePromise = new Promise(r => { release = () => { released = true; r(); }; });
    env.c.esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = HEAD + "\r\n,<b>悪</b>,5,265,,\r\n";
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, "utf8")]);
    env.c.csvImpPick("pl", { files: [{ name: "x.csv", size: buf.length, arrayBuffer: async () => buf }], value: "" });
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    check("選択時: 管理者トークンの確立前は読まない", env.calls.length === 0, JSON.stringify(env.calls));
    release();
    for (let i = 0; i < 50 && !(env.c.csvImp.pl && env.c.csvImp.pl.result); i++) await new Promise(r => setImmediate(r));
    check("選択時: 確立後に最新を取って検証する", released && env.calls.indexOf("GET /tc5_paid_leave_balances.json") >= 0 && env.c.csvImp.pl.result && env.c.csvImp.pl.result.counts.add === 1);
    const h = env.c.csvImpHtml();
    check("氏名は画面でエスケープされる（XSS）", h.indexOf("<b>悪</b>") < 0 && h.indexOf("&lt;b&gt;悪") >= 0);
  }
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: null, failGet: true });
    const buf = Buffer.from("\ufeff" + HEAD + "\r\n,山田太郎,5,265,,\r\n", "utf8");
    env.c.csvImpPick("pl", { files: [{ name: "x.csv", size: buf.length, arrayBuffer: async () => buf }], value: "" });
    for (let i = 0; i < 50 && !(env.c.csvImp.pl && env.c.csvImp.pl.error); i++) await new Promise(r => setImmediate(r));
    check("選択時: 最新を取得できなければエラー表示（検証しない）", env.c.csvImp.pl.error && !env.c.csvImp.pl.result);
  }
  {
    const env = makeEnv({ staff: STAFF_OBJ, balances: null });
    env.c.csvImp.pl = null;
    check("CSV一括登録画面に ③有給残日数CSV が出る", /③ 有給残日数CSV/.test(env.c.csvImpHtml()));
  }
  await bulkConsumeTests();
  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();

// ===== 期限切れの未登録をまとめて消化済みにする（PL-BULK-CONSUME） =====
async function bulkConsumeTests() {
  console.log("■ 期限切れの未登録をまとめて消化済みにする");
  const BULK = slice("// ===== PL-BULK-CONSUME-BEGIN =====", "// ===== PL-HISTORY-BEGIN =====");
  const T = "2026-10-12";
  const grants = [
    { staffId: "1001", staffName: "山田太郎", grantNum: 1, grantDate: "2015-10-01", expiresAt: "2017-09-30", grantDays: 10, auto: { autoGrantDays: null } },
    { staffId: "1001", staffName: "山田太郎", grantNum: 2, grantDate: "2016-10-01", expiresAt: "2018-09-30", grantDays: null, auto: { autoGrantDays: 11 } },
    { staffId: "1001", staffName: "山田太郎", grantNum: 3, grantDate: "2017-10-01", expiresAt: "2019-09-30", grantDays: null, auto: null },
    { staffId: "1002", staffName: "佐藤花子", grantNum: 1, grantDate: "2026-03-15", expiresAt: "2028-03-14", grantDays: 10, auto: null },  // 期限内
    { staffId: "1003", staffName: "退職次郎", grantNum: 1, grantDate: "2015-01-01", expiresAt: "2016-12-31", grantDays: 10, auto: null },
    { staffId: "1001", staffName: "山田太郎", grantNum: 4, grantDate: "2024-10-12", expiresAt: "2026-10-12", grantDays: 20, auto: null },  // 期限が今日（まだ有効）
  ];
  const freshStaff = [{ name: "山田太郎", employeeId: "1001", status: "在籍" }, { name: "佐藤花子", employeeId: "1002", status: "在籍" }, { name: "退職次郎", employeeId: "1003", status: "退職" }];
  const c2 = vm.createContext({ Object, Array, String, JSON, Math, Date, console });
  vm.runInContext(BULK.slice(0, BULK.indexOf("var plBulkConsumeBusy")) + "\nthis.T=plBulkConsumeTargets;this.P=plBulkConsumePatch;", c2);
  const t = c2.T(grants, T);
  check("対象は期限切れだけ（期限内・期限が今日の回は対象外）", t.length === 4 && t.every(x => x.expiresAt < T), JSON.stringify(t.map(x => x.grantDate)));
  check("付与日数は 自動算出 → 手動週所定 → 不明なら0", t[0].grantedDays === 10 && t[1].grantedDays === 11 && t[2].grantedDays === 0);
  const r = c2.P(t, freshStaff, [["1001", "2016-10-01"]], T, 1700000000000, "2026-10-12T00:00:00.000Z");
  const rows = Object.values(r.patch);
  check("登録済み（同じ社員番号・付与日）と退職者は書かない", r.count === 2 && r.skipped === 2 && rows.every(x => x.staffId === "1001") && !rows.some(x => x.grantDate === "2016-10-01"));
  check("1件ずつの「消化済み」と同じ形（usedDays=付与日数・残0）", rows.every(x => x.remainDays === 0 && x.usedDays === x.grantedDays && x.source === "bulkConsumed"));
  const tH = c2.T([Object.assign({}, grants[0], { hireDate: "2015/04/01" })], T);
  check("入社日が変わったスタッフの行は書かない", c2.P(tH, [{ name: "山田太郎", employeeId: "1001", status: "在籍", hireDate: "2015/05/01" }], [], T, 1, "x").count === 0 && c2.P(tH, [{ name: "山田太郎", employeeId: "1001", status: "在籍", hireDate: "2015/04/01" }], [], T, 1, "x").count === 1);
  check("社員番号が重複しているスタッフの行は書かない", c2.P(t, freshStaff.concat([{ name: "別人", employeeId: "1001", status: "在籍" }]), [], T, 1, "x").count === 0);
  {
    // 期限切れをまとめて消化済みにした後でも、期限内の残日数は有給残日数CSVで取り込める
    const consumed = { a: { staffId: "1001", staffName: "山田太郎", grantDate: "2016-04-01", expiresAt: "2018-03-31", grantedDays: 11, usedDays: 11, remainDays: 0, source: "bulkConsumed" } };
    const rc = run(HEAD + "\r\n,山田太郎,15,265,,\r\n", STAFF, consumed, T);
    check("期限切れ・残0の行だけの人はCSVで取り込める", item(rc, 2).action === "add", msgs(rc, 2));
    const left = { a: Object.assign({}, consumed.a, { remainDays: 2 }) };
    check("期限切れでも残がある行があればスキップ（安全側）", item(run(HEAD + "\r\n,山田太郎,15,265,,\r\n", STAFF, left, T), 2).action === "skip");
    const valid = { a: { staffId: "1001", grantDate: "2026-10-01", expiresAt: "2028-09-30", remainDays: 0 } };
    check("期限内の行があればスキップ（残0でも）", item(run(HEAD + "\r\n,山田太郎,15,265,,\r\n", STAFF, valid, T), 2).action === "skip");
  }
  check("社員番号が変わったスタッフの行は書かない", c2.P(t, [{ name: "山田太郎", employeeId: "9999", status: "在籍" }], [], T, 1, "x").count === 0);
  check("期限内の回が紛れ込んでも書かない（二重の防御）", c2.P([{ staffId: "1002", staffName: "佐藤花子", grantNum: 1, grantDate: "2026-03-15", expiresAt: "2028-03-14", grantedDays: 10 }], freshStaff, [], T, 1, "x").count === 0);

  // 画面の処理（模擬通信）
  function env(opts) {
    const db = { "/tc5_staff.json": opts.staff, "/tc5_paid_leave_balances.json": opts.balances };
    const calls = [], alerts = [];
    const e = {
      csvImpCanWrite: () => opts.admin !== false, getTodayJSTStr: () => T, getPaidLeaveUnregistered: () => ({ grants }),
      confirm: () => opts.confirm !== false, render() {}, recordsHistoryReady: () => opts.ready !== false, showAlert: m => alerts.push(m), afterElevation: () => Promise.resolve(),
      FB_URL: "https://x.invalid", CSVIMP: C, normalizePaidLeaveBalance: b => Object.assign({}, b), paidLeaveBalances: [],
      authFetch: async (url, o) => {
        const p = url.replace("https://x.invalid", ""), m = (o && o.method) || "GET";
        calls.push(m + " " + p);
        if (opts.failGet && m === "GET") return { ok: false, status: 503, json: async () => null };
        if (m === "PATCH") { db[p] = Object.assign({}, db[p] || {}, JSON.parse(o.body)); return { ok: true, status: 200, json: async () => null }; }
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(db[p] == null ? null : db[p])) };
      },
      Object, Array, String, JSON, Math, Date, Promise, console,
    };
    const c = vm.createContext(e);
    vm.runInContext(BULK + "\nthis.run=plBulkConsumeExpired;this.bar=plBulkConsumeBarHtml;this.busy=()=>plBulkConsumeBusy;", c);
    return { c, db, calls, alerts };
  }
  async function go(E) { E.c.run(); for (let i = 0; i < 50 && E.c.busy(); i++) await new Promise(r => setImmediate(r)); }
  {
    const E = env({ staff: Object.assign({}, freshStaff), balances: { keep: { staffId: "1002", grantDate: "2026-03-15", remainDays: 8 } } });
    await go(E);
    const patches = E.calls.filter(x => x.startsWith("PATCH"));
    check("登録直前に取り直してから1回の PATCH", patches.length === 1 && E.calls.indexOf("GET /tc5_paid_leave_balances.json") < E.calls.indexOf(patches[0]), JSON.stringify(E.calls));
    check("既存の行（期限内の佐藤さんの残8日）は変わらない", E.db["/tc5_paid_leave_balances.json"].keep.remainDays === 8);
    check("登録した件数を知らせる", /3件を消化済み/.test(E.alerts.join()), E.alerts.join());
    check("ボタンに期限内が対象外と出る", /期限内の2件は対象外/.test(E.c.bar(grants)), E.c.bar(grants));
  }
  {
    const E = env({ staff: Object.assign({}, freshStaff), balances: null, ready: false });
    check("打刻の過去分の読み込み中はボタンを押せない", /disabled/.test(E.c.bar(grants)) && /読み込み中/.test(E.c.bar(grants)));
  }
  {
    const E = env({ staff: Object.assign({}, freshStaff), balances: null, failGet: true });
    await go(E);
    check("最新を取得できなければ書かない", E.calls.every(x => !x.startsWith("PATCH")) && /何も登録していません/.test(E.alerts.join()));
  }
  {
    const E = env({ staff: Object.assign({}, freshStaff), balances: null, confirm: false });
    await go(E);
    check("確認でキャンセルすると通信しない", E.calls.length === 0);
  }
  {
    const E = env({ staff: Object.assign({}, freshStaff), balances: null, admin: false });
    await go(E);
    check("管理者以外は通信しない・ボタンも出ない", E.calls.length === 0 && E.c.bar(grants) === "");
  }
}
