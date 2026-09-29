/**
 * 従業員・施設マスタの保存（古い一覧での全体上書きを起こさないこと）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス（合成データ・模擬 RTDB のみ）
 *
 * 実行: node scripts/test-staff-save.js
 *
 * 目的:
 *   以前は管理画面が起動時に読んだスタッフ一覧（staffList）・施設一覧（masterFacilities）を取り直さないまま、
 *   1人を編集・削除しただけでも配列全体を PUT していた。そのため、開いたままの古い画面から保存すると、
 *   他の端末や CSV一括登録が後から追加したスタッフ・施設、他の人への編集を黙って消していた。
 *   本テストは、端末A・端末B・CSV一括登録を別々の実行環境（vm）として、同じ模擬 RTDB を共有させて再現する。
 *
 * 方式:
 *   index.html から次のブロックを抜き出して評価する（DOM は模擬）。
 *   ・「従業員・施設マスタの1件単位の保存」（mstFetch / mstWrite / mstAppend / staffDeleteOne / facilityAddOne / facilityDeleteOne）
 *   ・CSV一括登録の純粋関数と登録処理（CSVIMP / csvImpCommit）
 *   ・スタッフ編集モーダルの保存（btn-modal-save の onclick と staffModalSave）
 *   模擬 RTDB は REST の規則（ノードの GET、添字への PUT・DELETE、if-match: null_etag の 412、複数パス PATCH）で動く。
 */
"use strict";

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
  const s = html.indexOf(a), e = s < 0 ? -1 : html.indexOf(b, s + a.length);
  if (s < 0 || e < 0) { console.error("ERROR: index.html から抽出できませんでした: " + a); process.exit(1); }
  return html.slice(s, e);
}
const MST = slice("// ===== 従業員・施設マスタの1件単位の保存 =====", "// ===== CSV一括登録（施設・従業員）: 純粋関数 BEGIN =====");
const PURE = slice("// ===== CSV一括登録（施設・従業員）: 純粋関数 BEGIN =====", "// ===== CSV一括登録（施設・従業員）: 純粋関数 END =====");
const CSVUI = slice("// ===== CSV一括登録: 画面と登録処理 =====", "// ===== 資料管理 =====");
const MODAL = slice('    var modalSaveBtn=document.getElementById("btn-modal-save");', "    // モーダル内IME");
const DEF_DEPTS = JSON.parse(/var DEF_DEPTS=(\[[^\]]*\]);/.exec(html)[1]);

// ---- 模擬 RTDB（REST の規則）----
function makeServer(init) {
  const db = {};
  for (const node of Object.keys(init)) { db[node] = {}; init[node].forEach((v, i) => { db[node][String(i)] = JSON.parse(JSON.stringify(v)); }); }
  const log = [];
  function nodeView(node) {
    const o = db[node] || {};
    const keys = Object.keys(o);
    if (!keys.length) return null;
    // Firebase の REST と同じ規則: キーがすべて数値で、最大添字+1 の半分より多く埋まっていれば
    // 配列で返す（空いた添字は null）。そうでなければオブジェクトで返す。
    const max = Math.max(...keys.map(Number));
    if (keys.every((k) => /^\d+$/.test(k)) && keys.length * 2 > max + 1) {
      const arr = []; for (let i = 0; i <= max; i++) arr.push(o[String(i)] === undefined ? null : o[String(i)]);
      return JSON.parse(JSON.stringify(arr));
    }
    return JSON.parse(JSON.stringify(o));
  }
  async function handle(url, opts) {
    const m = (opts && opts.method) || "GET";
    const p = url.replace("https://example.invalid/", "").replace(/\.json$/, "");
    const node = ["tc5_staff", "master/locations", "tc_master_depts"].find((n) => p === n || p.startsWith(n + "/"));
    log.push(m + " " + p);
    const res = (st, body) => ({ ok: st >= 200 && st < 300, status: st, json: async () => JSON.parse(JSON.stringify(body === undefined ? null : body)) });
    if (!node) return res(404, null);
    db[node] = db[node] || {};
    if (p === node) {
      if (m === "GET") return res(200, nodeView(node));
      if (m === "PUT") { log.push("FULL-PUT " + node); db[node] = {}; const v = JSON.parse(opts.body); (Array.isArray(v) ? v : Object.values(v || {})).forEach((x, i) => { db[node][String(i)] = x; }); return res(200, v); }
      if (m === "PATCH") {
        const body = JSON.parse(opts.body);
        // RTDB と同じく null を書いたキーは削除される
        Object.keys(body).forEach((k) => {
          const [a, b] = k.split("/");
          if (b) db[node][a] = Object.assign({}, db[node][a], { [b]: body[k] });
          else if (body[k] === null) delete db[node][a];
          else db[node][a] = body[k];
        });
        return res(200, body);
      }
    }
    const key = decodeURIComponent(p.slice(node.length + 1));
    if (m === "GET") return res(200, db[node][key] === undefined ? null : db[node][key]);
    if (m === "PUT") {
      const h = (opts && opts.headers) || {};
      if (h["if-match"] === "null_etag" && db[node][key] != null) return res(412, null);
      db[node][key] = JSON.parse(opts.body); return res(200, db[node][key]);
    }
    if (m === "DELETE") { delete db[node][key]; return res(200, null); }
    return res(405, null);
  }
  return { db, log, handle, view: nodeView };
}

// ---- 端末（管理画面）1台ぶんの実行環境 ----
function makeTerminal(server, name) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: "", checked: false, disabled: false, style: {}, onclick: null });
  const env = {
    name, alerts: [], closed: 0, renders: 0,
    writePolicy: "full", FB_URL: "https://example.invalid", DEF_DEPTS,
    staffList: [], masterFacilities: [], masterDepts: DEF_DEPTS.slice(), staffPins: {}, records: [], approvals: {},
    facilitiesLoaded: true, isAdminAuthenticated: true, demoMode: false, viewerMode: false, _adminElevatePromise: null,
    _apvBusyCount: 0, TENANT: { legacy: true },
    document: { getElementById: (id) => el(id) },
    showAlert(m) { env.alerts.push(m); }, closeHrmModal() { env.closed++; }, render() { env.renders++; },
    mileageSaveStaffModal() {}, prompt() { return null; }, getTodayJSTStr() { return "2026-09-30"; },
    apvApprovalBlocked() { return false; }, recordsHistoryReady() { return true; }, ensureRecordsHistory() {},
    renamePinInAuthz() {}, _lsSet() {}, TLS: { setItem() {} }, esc: (s) => String(s),
    saveData(k) { env.fullSave = (env.fullSave || 0) + 1; }, saveFacilities() { env.fullSave = (env.fullSave || 0) + 1; },
    applyFacilitiesLocal() {}, devWatchOnFacilityDeleted(n) { env.devDeleted = n; },
    authFetch: (url, opts) => server.handle(url, opts),
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (i * 53 + 7) % 256; return a; } },
    console, Promise, Object, Array, JSON, String, Math, Uint8Array, TextDecoder, Date,
    els,
  };
  const c = vm.createContext(env);
  vm.runInContext(PURE + "\n" + MST + "\n" + CSVUI + "\n(function(){\n" + MODAL + "\n})();\n"
    + "this.CSVIMP=CSVIMP;this.staffDeleteOne=staffDeleteOne;this.facilityAddOne=facilityAddOne;this.facilityDeleteOne=facilityDeleteOne;"
    + "this.csvImp=csvImp;this.csvImpCommit=csvImpCommit;this.csvImpValidate=csvImpValidate;this.mstToList=mstToList;", c);
  // 起動時の読み込み（initFirebase と同じ: 空いた添字は読み飛ばす）
  c.load = () => {
    c.staffList = c.mstToList(server.view("tc5_staff"));
    c.masterFacilities = c.mstToList(server.view("master/locations"));
  };
  // スタッフ編集モーダルに値を入れて「保存」を押す
  c.saveModal = async (orig, f) => {
    const v = Object.assign({ lname: "", fname: "", ly: "", fy: "", empid: "", hire: "", loc: "", dept: "", et: "", wd: "", role: "", status: "在籍" }, f);
    const set = (id, x) => { el(id).value = x; };
    set("hrm-modal-orig", orig || ""); set("modal-lname", v.lname); set("modal-fname", v.fname);
    set("modal-lname-yomi", v.ly); set("modal-fname-yomi", v.fy); set("modal-empid", v.empid);
    set("modal-hiredate", v.hire); set("modal-location", v.loc); set("modal-dept", v.dept);
    set("modal-emptype", v.et); set("modal-weekdays", v.wd); set("modal-role", v.role); set("modal-status", v.status);
    el("btn-modal-save").onclick();
    await settle(c);
  };
  return c;
}
async function settle(c) { for (let i = 0; i < 80; i++) { await new Promise((r) => setImmediate(r)); } }
const S = (ln, fn, ly, fy, extra) => Object.assign({ name: ln + fn, lastName: ln, firstName: fn, yomiLast: ly, yomiFirst: fy, yomi: ly + fy, employeeId: "", hireDate: "", location: "本店", dept: "", employmentType: "パート", role: "", status: "在籍", canSupportWork: false, mealRequired: false }, extra || {});
const names = (srv) => Object.values(srv.db.tc5_staff).filter(Boolean).map((x) => x.name).sort();
const staffOf = (srv, n) => Object.values(srv.db.tc5_staff).find((x) => x && x.name === n);
const FORM = (s, over) => Object.assign({ lname: s.lastName, fname: s.firstName, ly: s.yomiLast, fy: s.yomiFirst, empid: s.employeeId, loc: s.location, et: s.employmentType, status: s.status }, over || {});
const INIT_STAFF = [S("山田", "太郎", "やまだ", "たろう", { employeeId: "E1" }), S("佐藤", "花子", "さとう", "はなこ", { employeeId: "E2" }), S("鈴木", "一郎", "すずき", "いちろう", { employeeId: "E3" })];
const INIT_FAC = [{ name: "本店", token: "TOK_HONTEN_0000000000000000000000" }, { name: "二号店", token: "TOK_NIGO_000000000000000000000000" }];

(async () => {
  console.log("■ 端末Aが古い一覧のまま既存スタッフを編集しても、端末Bの追加を消さない");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();                                        // 端末A: スタッフ一覧を開く
    await B.saveModal("", { lname: "新人", fname: "次郎", ly: "しんじん", fy: "じろう", loc: "本店", et: "パート" }); // 端末B: 追加
    check("端末Bの追加が保存される", names(srv).includes("新人次郎"), JSON.stringify(B.alerts));
    await A.saveModal("佐藤花子", FORM(INIT_STAFF[1], { empid: "E2-new" })); // 端末A: 古い一覧から既存1名を編集
    check("端末Aの編集が保存される", staffOf(srv, "佐藤花子").employeeId === "E2-new", JSON.stringify(A.alerts));
    check("端末Bで追加したスタッフが消えない", names(srv).includes("新人次郎"), names(srv).join(","));
    check("全体 PUT（FULL-PUT）を一度も行わない", !srv.log.includes("FULL-PUT tc5_staff") && !A.fullSave && !B.fullSave, srv.log.join(" "));
    check("端末Aの画面の一覧も最新になる（Bの追加が見える）", A.staffList.some((x) => x.name === "新人次郎"));
    check("保存後にモーダルを閉じる", A.closed === 1 && B.closed === 1);
  }

  console.log("■ 端末A・Bが別々の既存スタッフを編集しても、互いの変更を巻き戻さない");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    await B.saveModal("山田太郎", FORM(INIT_STAFF[0], { et: "正社員" }));
    await A.saveModal("鈴木一郎", FORM(INIT_STAFF[2], { loc: "二号店" }));
    check("端末Bの変更（山田太郎の雇用形態）が残る", staffOf(srv, "山田太郎").employmentType === "正社員", JSON.stringify(staffOf(srv, "山田太郎")));
    check("端末Aの変更（鈴木一郎の拠点）が残る", staffOf(srv, "鈴木一郎").location === "二号店");
    check("関係のない佐藤花子は変わらない", JSON.stringify(staffOf(srv, "佐藤花子")) === JSON.stringify(INIT_STAFF[1]));
    // フォームに無い項目（他端末で付いた値）も保つ
    srv.db.tc5_staff["1"].paidLeaveNote = "他端末で付けた値";
    await A.saveModal("佐藤花子", FORM(INIT_STAFF[1], { empid: "E2b" }));
    check("編集フォームに無い項目は最新の値を保つ（古い一覧の値で戻さない）", staffOf(srv, "佐藤花子").paidLeaveNote === "他端末で付けた値" && staffOf(srv, "佐藤花子").employeeId === "E2b");
  }

  console.log("■ CSV一括登録の後に、古い一覧の端末Aが既存スタッフを編集しても CSV 登録分が消えない");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), M = makeTerminal(srv, "管理者");
    A.load(); M.load();                                        // 端末A: 古い一覧を開いたまま
    const csv = "社員コード,姓,名,ふりがな,在籍状態,所属部署,役職,施設名,雇用区分,入社日,退職日\r\n"
      + "100001,新井,一郎,あらい いちろう,在籍,,,本店,パート,2024-04-01,\r\n,野中,三子,のなか みつこ,在籍,,,二号店,社員,,\r\n";
    const d = M.CSVIMP.decode(new Uint8Array(Buffer.from(csv, "utf8"))); const p = M.CSVIMP.prepare("staff", d.text);
    const st = { fileName: "x.csv", prep: p, result: M.csvImpValidate("staff", p), error: "", failMsg: "", done: null };
    M.csvImp.staff = st; M.csvImpCommit("staff"); await settle(M);
    check("CSVで2名登録される", st.done && st.done.add === 2 && names(srv).includes("新井一郎") && names(srv).includes("野中三子"), st.failMsg);
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "E1-x" }));
    check("端末Aの編集が保存される", staffOf(srv, "山田太郎").employeeId === "E1-x");
    check("CSVで登録したスタッフが消えない", names(srv).includes("新井一郎") && names(srv).includes("野中三子"), names(srv).join(","));
    await A.saveModal("", { lname: "追加", fname: "花子", ly: "ついか", fy: "はなこ", loc: "本店" });
    check("続けて端末Aで新規追加しても CSV 登録分は消えず、末尾に足される", names(srv).length === 6 && names(srv).includes("野中三子"), names(srv).join(","));
  }

  console.log("■ 削除しても配列に空きを作らない（更新前の版の画面が null を読んで止まらない）");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    A.staffDeleteOne("山田太郎"); await settle(A);
    check("削除できる", !names(srv).includes("山田太郎") && names(srv).length === 2);
    check("末尾の1件（鈴木一郎）を空いた位置へ移し、他の行（佐藤花子）の添字は変えない", srv.db.tc5_staff["0"].name === "鈴木一郎" && srv.db.tc5_staff["1"].name === "佐藤花子" && !("2" in srv.db.tc5_staff));
    check("削除は1回の PATCH（全部成功か全部失敗）", srv.log.filter((l) => l === "PATCH tc5_staff").length === 1 && !srv.log.some((l) => /^DELETE/.test(l)));
    // 更新前の版の読み方（Array.isArray ? そのまま : Object.values）でも null が無い
    const raw = srv.view("tc5_staff"); const oldRead = Array.isArray(raw) ? raw : Object.values(raw);
    check("更新前の版の読み方でも null の行が無い", oldRead.length === 2 && oldRead.every((x) => x && x.name));
    await B.saveModal("鈴木一郎", FORM(INIT_STAFF[2], { empid: "E3-b" }));
    check("古い一覧の端末Bが鈴木一郎を編集しても、削除された山田太郎は復活しない", !names(srv).includes("山田太郎") && staffOf(srv, "鈴木一郎").employeeId === "E3-b", names(srv).join(","));
    // 他の経路で空きができた配列（null 入り）を読んでも一覧へ null を入れない
    srv.db.tc5_staff["3"] = S("遠方", "五郎", "えんぽう", "ごろう");
    check("null 入りの配列を読み込んでも null を一覧へ入れない", Array.isArray(srv.view("tc5_staff")) && srv.view("tc5_staff").includes(null) && (() => { const C = makeTerminal(srv, "C"); C.load(); return C.staffList.length === 3 && C.staffList.every((x) => x && x.name); })());
    const C = makeTerminal(srv, "C"); C.load();
    await C.saveModal("", { lname: "穴", fname: "埋", ly: "あな", fy: "うめ", loc: "本店" });
    check("空きがあっても新規は最大添字の次へ（既存の行を上書きしない）", srv.db.tc5_staff["4"] && srv.db.tc5_staff["4"].name === "穴埋" && srv.db.tc5_staff["3"].name === "遠方五郎");
    const nPatch = srv.log.filter((l) => l === "PATCH tc5_staff").length;
    B.staffDeleteOne("存在しない人"); await settle(B);
    check("既に無い人の削除は何も書かない", srv.log.filter((l) => l === "PATCH tc5_staff").length === nPatch);
    // 起動時の端末保存（localStorage）の控えに null が混ざっていても落ちない
    check("起動時の端末保存の読み込みも null を読み飛ばす", html.includes('var masterFacilities=mstToList(loadData("tc_master_facilities",[]));') && html.includes('var staffList=mstToList(loadData("tc5_staff",DEF_STAFF));') && html.includes("if(f&&f.token)"));
  }

  console.log("■ 2端末が同時に新規追加しても、どちらも消えない（同じ添字は条件付き書き込みで防ぐ）");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    const pa = A.saveModal("", { lname: "同時", fname: "A", ly: "どうじ", fy: "えー", loc: "本店" });
    const pb = B.saveModal("", { lname: "同時", fname: "B", ly: "どうじ", fy: "びー", loc: "本店" });
    await Promise.all([pa, pb]);
    check("両方とも保存される", names(srv).includes("同時A") && names(srv).includes("同時B") && names(srv).length === 5, names(srv).join(","));
    check("412（先に使われた添字）を受けて取り直した", srv.log.filter((l) => l === "PUT tc5_staff/3").length >= 2);
    // 同時に同じ氏名を追加 → 片方は「同名」で止まる
    const pc = A.saveModal("", { lname: "重複", fname: "君", ly: "ちょうふく", fy: "くん", loc: "本店" });
    const pd = B.saveModal("", { lname: "重複", fname: "君", ly: "ちょうふく", fy: "くん", loc: "本店" });
    await Promise.all([pc, pd]);
    check("同じ氏名の同時追加は1件だけになる", names(srv).filter((n) => n === "重複君").length === 1, names(srv).join(","));
    check("止まった側には同名の理由を表示し、モーダルは開いたまま", (A.alerts.concat(B.alerts)).some((m) => /同名/.test(m)));
  }

  console.log("■ 取得・書き込みに失敗したら書かない／成功扱いにしない");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"); A.load();
    const orig = A.authFetch;
    A.authFetch = async (u, o) => ((o && o.method) ? orig(u, o) : { ok: false, status: 503, json: async () => null });
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "X" }));
    check("最新の一覧を取得できないときは保存しない", staffOf(srv, "山田太郎").employeeId === "E1" && A.alerts.some((m) => /取得できない/.test(m)) && A.closed === 0);
    A.authFetch = async (u, o) => ((o && o.method === "PUT") ? { ok: false, status: 403, json: async () => null } : orig(u, o));
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "X" }));
    check("権限拒否（403）は失敗と表示し、モーダルを閉じない", staffOf(srv, "山田太郎").employeeId === "E1" && A.alerts.some((m) => /権限/.test(m)) && A.closed === 0);
    // 書く直前の確認（1件の GET）が通信失敗なら、書かずに通信失敗として知らせる（「同時に変更」と取り違えない）
    A.alerts.length = 0;
    A.authFetch = async (u, o) => ((!(o && o.method) && /\/tc5_staff\/\d+\.json$/.test(u)) ? null : orig(u, o));
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "Y" }));
    check("書く直前の確認が通信失敗なら書かず、通信失敗として知らせる", staffOf(srv, "山田太郎").employeeId === "E1" && A.alerts.some((m) => /通信状態/.test(m)) && !A.alerts.some((m) => /同時に変更/.test(m)) && A.closed === 0, JSON.stringify(A.alerts));
    A.authFetch = orig;
    // 追加で 412 が5回続いても、同じ全件取得を重複させない（最初の1回＋再試行4回＝GET 5回）
    const gets0 = srv.log.filter((l) => l === "GET tc5_staff").length;
    A.authFetch = async (u, o) => ((o && o.method === "PUT") ? { ok: false, status: 412, json: async () => null } : orig(u, o));
    await A.saveModal("", { lname: "競合", fname: "続き", ly: "きょうごう", fy: "つづき", loc: "本店" });
    const gets = srv.log.filter((l) => l === "GET tc5_staff").length - gets0;
    check("412 が続いても全件取得は5回まで（失敗後に同じ取得を重ねない）", gets === 5 && !names(srv).includes("競合続き") && A.closed === 0, "GET=" + gets);
    A.authFetch = orig;
    srv.db.tc5_staff["0"] = null; delete srv.db.tc5_staff["0"];
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "X" }));
    check("他端末で削除済みの人を編集しても復活させない", !names(srv).includes("山田太郎") && A.alerts.some((m) => /削除された/.test(m)));
  }

  console.log("■ 取り直した直後に他の端末が削除しても、別人の行へ書かない（書く直前に確かめる）");
  {
    // 端末Bが佐藤花子の保存で一覧を取り直した直後に、端末Aが佐藤花子を削除（末尾の鈴木一郎が添字1へ移る）
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    const origB = B.authFetch; let hooked = false;
    B.authFetch = async (u, o) => {
      const r = await origB(u, o);
      if (!hooked && !(o && o.method) && /\/tc5_staff\.json$/.test(u)) { hooked = true; A.staffDeleteOne("佐藤花子"); await settle(A); }
      return r;
    };
    await B.saveModal("佐藤花子", FORM(INIT_STAFF[1], { empid: "E2-B" }));
    await settle(B); await settle(B);
    check("端末Aの削除で添字1へ移った鈴木一郎の行を、端末Bの編集で上書きしない", staffOf(srv, "鈴木一郎") && staffOf(srv, "鈴木一郎").employeeId === "E3" && !names(srv).includes("佐藤花子"), JSON.stringify(srv.db.tc5_staff));
    check("端末Bには同時に変更された旨を表示し、モーダルは閉じない", B.alerts.some((m) => /同時に変更/.test(m)) && B.closed === 0);
    check("端末Bの画面の一覧は最新（佐藤花子なし）になる", !B.staffList.some((x) => x.name === "佐藤花子"));
  }
  {
    // 端末Aが山田太郎の削除で一覧を取り直した直後に、端末Bが末尾の鈴木一郎を削除 → Aは移す前に食い違いに気づいて中止
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    const origA = A.authFetch; let hooked = false;
    A.authFetch = async (u, o) => {
      const r = await origA(u, o);
      if (!hooked && !(o && o.method) && /\/tc5_staff\.json$/.test(u)) { hooked = true; B.staffDeleteOne("鈴木一郎"); await settle(B); }
      return r;
    };
    A.staffDeleteOne("山田太郎"); await settle(A); await settle(A); await settle(A);
    check("削除の直前に末尾の行が変わっていたら移さない（削除済みの人を復活させない）", !names(srv).includes("鈴木一郎") && names(srv).includes("山田太郎") && names(srv).includes("佐藤花子"), names(srv).join(","));
    check("削除側にも同時に変更された旨を表示する", A.alerts.some((m) => /同時に変更/.test(m)));
  }

  console.log("■ 改名時の打刻の付け替えはスタッフ行の保存が成功してから");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"); A.load();
    A.records = [{ id: "r1", staff: "山田太郎", date: "2026-09-01" }];
    const orig = A.authFetch;
    A.authFetch = async (u, o) => ((o && o.method === "PUT" && /tc5_staff\//.test(u)) ? { ok: false, status: 403, json: async () => null } : orig(u, o));
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { fname: "太朗" }));
    check("保存に失敗したら打刻の氏名を付け替えない", A.records[0].staff === "山田太郎" && !srv.log.some((l) => /^PATCH tc5_records/.test(l)) && names(srv).includes("山田太郎"));
    A.authFetch = orig;
    await A.saveModal("山田太郎", FORM(INIT_STAFF[0], { fname: "太朗" }));
    const iPut = srv.log.indexOf("PUT tc5_staff/0"), iRec = srv.log.indexOf("PATCH tc5_records/r1");
    check("保存に成功したら、その後で打刻の氏名を付け替える", iPut >= 0 && iRec > iPut && A.records[0].staff === "山田太朗" && names(srv).includes("山田太朗"), srv.log.join(" "));
  }

  console.log("■ 施設マスタも古い一覧で全体上書きしない");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const A = makeTerminal(srv, "A"), B = makeTerminal(srv, "B");
    A.load(); B.load();
    B.facilityAddOne("三号店", "TOK_SAN_00000000000000000000000000"); await settle(B);
    check("端末Bの施設追加が保存される", Object.values(srv.db["master/locations"]).some((f) => f && f.name === "三号店"));
    // 画面の削除ボタンと同じく、削除成功後に持ち出し監視を止める処理を渡す
    check("画面の削除ボタンは削除成功後に持ち出し監視を止める", html.includes("facilityDeleteOne(_dn,function(){devWatchOnFacilityDeleted(_dn);})"));
    A.facilityDeleteOne("二号店", () => A.devWatchOnFacilityDeleted("二号店")); await settle(A);
    const facNames = () => Object.values(srv.db["master/locations"]).filter(Boolean).map((f) => f.name).sort();
    check("古い一覧の端末Aが別の施設を削除しても、端末Bの追加が消えない", facNames().join(",") === "三号店,本店", facNames().join(","));
    check("施設の削除後に持ち出し監視の停止を呼ぶ", A.devDeleted === "二号店");
    A.facilityAddOne("四号店", "TOK_YON_00000000000000000000000000"); await settle(A);
    check("端末Aの追加も末尾に足され、既存は残る", facNames().join(",") === "三号店,四号店,本店", facNames().join(","));
    B.facilityAddOne("本店", "X"); await settle(B);
    check("最新の一覧に同名がある施設は追加しない", facNames().filter((n) => n === "本店").length === 1 && B.alerts.some((m) => /既に存在/.test(m)));
    check("施設でも全体 PUT を行わない", !srv.log.includes("FULL-PUT master/locations") && !A.fullSave && !B.fullSave);
    const T = makeTerminal(srv, "T"); T.facilitiesLoaded = false;
    T.facilityAddOne("五号店", "x"); await settle(T);
    check("施設マスタを取得できていない端末は施設を保存しない", !facNames().includes("五号店") && T.alerts.length === 1);
    check("打刻URLトークンは書き換えない（本店）", Object.values(srv.db["master/locations"]).find((f) => f && f.name === "本店").token === INIT_FAC[0].token);
  }

  console.log("■ デモ・テスト画面（writePolicy≠full）は従来の保存経路のまま");
  {
    const srv = makeServer({ tc5_staff: INIT_STAFF, "master/locations": INIT_FAC });
    const D = makeTerminal(srv, "D"); D.load(); D.writePolicy = "sandbox";
    await D.saveModal("山田太郎", FORM(INIT_STAFF[0], { empid: "SB" }));
    check("サンドボックスでは本番ノードへ書かない（従来の saveData 経由）", D.fullSave === 1 && staffOf(srv, "山田太郎").employeeId === "E1" && !srv.log.some((l) => /^(PUT|DELETE|PATCH)/.test(l)));
  }

  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
