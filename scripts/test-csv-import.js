/**
 * CSV一括登録（施設・従業員）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス（合成データのみ）
 *
 * 実行: node scripts/test-csv-import.js
 *
 * 方式:
 *   index.html の「CSV一括登録（施設・従業員）: 純粋関数 BEGIN〜END」を抜き出して vm で評価する。
 *   登録処理（csvImpCommit）は通信・権限の判定を含むため、抜き出して模擬の authFetch で動かす。
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
  const s = html.indexOf(a), e = s < 0 ? -1 : html.indexOf(b, s);
  if (s < 0 || e < 0) { console.error("ERROR: index.html から抽出できませんでした: " + a); process.exit(1); }
  return html.slice(s, e);
}
const PURE = slice("// ===== CSV一括登録（施設・従業員）: 純粋関数 BEGIN =====", "// ===== CSV一括登録（施設・従業員）: 純粋関数 END =====");
const UI = slice("// ===== CSV一括登録: 画面と登録処理 =====", "// ===== 資料管理 =====");

const ctx = vm.createContext({ TextDecoder, Uint8Array, Date, JSON, Object, Array, String, Math, console });
vm.runInContext(PURE + "\nthis.CSVIMP=CSVIMP;", ctx);
const C = ctx.CSVIMP;
const enc = (s, bom) => { const b = Buffer.from(s, "utf8"); return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), b]) : b); };
const TODAY = "2026-09-29";
// 部門の既定値は index.html の定義をそのまま使う（テスト側で値を複製しない）
const DEF_DEPTS_FROM_HTML = (() => { const m = /var DEF_DEPTS=(\[[^\]]*\]);/.exec(html); if (!m) { console.error("ERROR: index.html から DEF_DEPTS を抽出できませんでした"); process.exit(1); } return JSON.parse(m[1]); })();

const FAC_HEAD = "施設コード,施設名,正式名称,郵便番号,住所,電話番号,状態";
const STAFF_HEAD = "社員コード,姓,名,ふりがな,在籍状態,所属部署,役職,施設名,雇用区分,入社日,退職日";
function prep(kind, text, bom) {
  const d = C.decode(enc(text, bom));
  if (!d.ok) return d;
  return C.prepare(kind, d.text);
}
function msgs(res, line) { const it = res.items.find(x => x.line === line); return it ? it.msgs.map(m => m.lv + ":" + m.t).join(" | ") : ""; }

console.log("■ 文字コード・BOM・日本語");
{
  const t = FAC_HEAD + "\r\nF001,テスト苑,社会福祉法人 テスト会 テスト苑,123-4567,東京都千代田区１－２－３,03-0000-0000,有効\r\n";
  const a = prep("fac", t, true), b = prep("fac", t, false);
  check("BOM付きUTF-8を読める", a.ok && a.rows.length === 1, JSON.stringify(a.error));
  check("BOM無しUTF-8を読める", b.ok && b.rows.length === 1);
  check("日本語（施設名・住所）が文字化けしない", a.ok && a.rows[0].v["施設名"] === "テスト苑" && a.rows[0].v["住所"] === "東京都千代田区１－２－３");
  check("BOM付きでも見出しの1列目を認識する", a.ok && a.rows[0].v["施設コード"] === "F001");
  const sjis = new Uint8Array([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x2C, 0x0D, 0x0A]); // 「テスト,」の Shift_JIS
  const d = C.decode(sjis);
  check("Shift_JIS は文字化けさせずに拒否する", !d.ok && /UTF-8/.test(d.error));
}

console.log("■ CSV解析（引用符・改行）");
{
  const p = C.parse('a,"b,c","d""e"\n"x\ny",z\n');
  check("引用符内のコンマ・\"\" のエスケープ", p.ok && p.rows[0].cells[1] === "b,c" && p.rows[0].cells[2] === 'd"e');
  check("引用符内の改行と行番号", p.ok && p.rows[1].cells[0] === "x\ny" && p.rows[1].line === 2);
  check("閉じていない引用符はエラー", !C.parse('a,"b\n').ok);
}

console.log("■ 空行・0件・列不足・余分な列");
{
  const many = FAC_HEAD + "\r\n" + ",,,,,,\r\n".repeat(50) + "F001,テスト苑,,,,,有効\r\n" + ",,,,,,\r\n".repeat(900);
  const p = prep("fac", many);
  check("全項目が空の行は無視（エラーにしない）", p.ok && p.rows.length === 1, JSON.stringify(p.error));
  check("行番号は元のCSVの行", p.ok && p.rows[0].line === 52);
  const z = prep("fac", FAC_HEAD + "\r\n" + ",,,,,,\r\n".repeat(5));
  check("0件CSVは「登録するデータがありません」", !z.ok && /登録するデータがありません/.test(z.error));
  const e = prep("fac", "");
  check("空ファイルは見出しなしエラー", !e.ok && /見出し/.test(e.error));
  const miss = prep("staff", "社員コード,姓,名\r\n1,山田,太郎\r\n");
  check("列不足はエラーで列名を示す", !miss.ok && /列が不足しています：ふりがな/.test(miss.error));
  const extra = prep("fac", FAC_HEAD + ",備考\r\nF001,テスト苑,,,,,有効,メモ\r\n");
  check("余分な列は取り込まず警告", extra.ok && extra.fileWarnings.some(w => /備考/.test(w)) && !("備考" in extra.rows[0].v));
  const dupHead = prep("fac", FAC_HEAD + ",施設名\r\nF001,テスト苑,,,,,有効,x\r\n");
  check("見出しの重複はエラー", !dupHead.ok && /重複/.test(dupHead.error));
  const short = prep("fac", FAC_HEAD + "\r\nF001,テスト苑\r\n");
  const rs = C.validateFacilities(short.rows, [], short.fileWarnings);
  check("列の足りない行はエラー", rs.counts.error === 1 && /列の数/.test(msgs(rs, 2)));
}

console.log("■ 施設CSV");
{
  const t = FAC_HEAD + "\r\n"
    + "F001,あんず苑,正式あんず苑,123-4567,住所1,03-1111-1111,有効\r\n"
    + "F002,既存苑,,,新住所,,有効\r\n"
    + "F003,同じ苑,,,,,有効\r\n"
    + "F004,無効苑,,,,,無効\r\n"
    + "F005,あんず苑,,,,,有効\r\n"
    + "F006,=HYPERLINK(\"x\"),,,,,有効\r\n"
    + "F007,変な.名前,,,,,有効\r\n"
    + "F008,きよみ苑,,,,,休止\r\n"
    + "F009,既存 苑,,,,,有効\r\n";
  const existing = [{ name: "既存苑", token: "TOKEN_A", code: "F002", address: "旧住所" }, { name: "同じ苑", token: "TOKEN_B", code: "F003" }];
  const p = prep("fac", t);
  const r = C.validateFacilities(p.rows, existing, p.fileWarnings);
  check("新規は登録予定", r.items[0].action === "add" && r.items[0].rec.code === "F001" && r.items[0].rec.formalName === "正式あんず苑");
  check("既存は空欄以外だけ更新予定（名前・トークンは変えない）", r.items[1].action === "update" && r.items[1].changes.address.to === "新住所" && !("name" in r.items[1].changes) && !("token" in r.items[1].changes));
  check("既存と同じ内容はスキップ", r.items[2].action === "skip");
  check("状態=無効はスキップ", r.items[3].action === "skip");
  check("CSV内の施設名重複はエラー", r.items[4].action === "error" && /2行目と施設名が重複/.test(msgs(r, 6)));
  check("数式の先頭文字（CSV injection）はエラー", r.items[5].action === "error" && /数式/.test(msgs(r, 7)));
  check("キーに使えない文字はエラー", r.items[6].action === "error");
  check("状態の不正値はエラー", r.items[7].action === "error" && /有効」か「無効/.test(msgs(r, 9)));
  check("既存と表記だけ違う施設は自動で紐付けずエラー", r.items[8].action === "error" && /空白・全角半角/.test(msgs(r, 10)));
  {
    const q = prep("fac", FAC_HEAD + "\r\nF1,全角苑,,６４９－６２７３,,０７３－０００－００００,有効\r\n");
    const rq = C.validateFacilities(q.rows, [], q.fileWarnings);
    check("全角数字の郵便番号・電話番号は警告しない（保存値は変えない）", rq.counts.warn === 0 && rq.items[0].rec.postalCode === "６４９－６２７３", msgs(rq, 2));
  }
  check("件数の集計", r.counts.add === 1 && r.counts.update === 1 && r.counts.skip === 2 && r.counts.error === 5, JSON.stringify(r.counts));
  const cur = C.normalizeList(existing);
  let n = 0;
  const patch = C.buildFacilityPatch(r, cur, () => "T" + (++n));
  check("PATCH は新規を末尾に追加し、既存は補足項目だけ", JSON.stringify(patch) === JSON.stringify({ "2": { name: "あんず苑", code: "F001", formalName: "正式あんず苑", postalCode: "123-4567", address: "住所1", tel: "03-1111-1111", token: "T1" }, "0/address": "新住所" }), JSON.stringify(patch));
  // 同じCSVを2回目: 登録後の状態で検証すると追加・更新が0件
  const after = [{ name: "既存苑", token: "TOKEN_A", code: "F002", address: "新住所" }, { name: "同じ苑", token: "TOKEN_B", code: "F003" }, patch["2"]];
  const r2 = C.validateFacilities(p.rows, after, p.fileWarnings);
  check("同じ施設CSVを2回読み込んでも二重登録しない", r2.counts.add === 0 && r2.counts.update === 0, JSON.stringify(r2.counts));
}

console.log("■ 従業員CSV");
const FACS = [{ name: "あんず苑", token: "A" }, { name: "Kiyomi`s郷あゆむ", token: "B" }];
const DEPTS = ["調理"];
{
  const t = STAFF_HEAD + "\r\n"
    + "100001,山田,太郎,やまだ たろう,在籍,,,あんず苑,パート,2020-04-01,\r\n"   // 2 正常
    + ",佐藤,花子,さとう　はなこ,在籍,,,あんず苑,社員,,\r\n"                        // 3 社員コード空欄・日付空欄・社員→正社員
    + "100003,鈴木,一郎,すずき いちろう,在籍,,,あんず苑,パート,2021-01-01,\r\n"     // 4 社員コード重複（5行目）
    + "100003,高橋,二郎,たかはし じろう,休職,,,Kiyomi`s郷あゆむ,社員,2022/5/3,\r\n" // 5 社員コード重複（4行目）
    + "100005,田中,三郎,たなか さぶろう,在籍,,,どこか苑,パート,2020-01-01,\r\n"      // 6 施設なし
    + ",野口,四郎,のぐち しろう,在籍,,,あんず苑,社員,1900-01-20,\r\n"               // 7 不自然な日付（警告）
    + "100007,伊藤,五郎,いとう ごろう,在籍,,代表,,,2013-09-26,\r\n"                  // 8 施設空欄・役職
    + "100008,渡辺,六郎,わたなべ ろくろう,在籍,,,あんず苑,パート,2020-02-30,\r\n"    // 9 実在しない日付
    + "100009,既存,太郎,きそん たろう,在籍,,,あんず苑,パート,2020-01-01,\r\n"       // 10 既存と同名 → スキップ
    + "100010,中村,七子,なかむら ななこ,退職,,,あんず苑,パート,2020-01-01,\r\n"     // 11 退職で退職日なし
    + "100011,小林,八子,こばやし はちこ,在籍,経理,,あんず苑,パート,2020-01-01,\r\n"  // 12 部門なし
    + "100012,山田,太郎,やまだ たろう,在籍,,,あんず苑,パート,2020-01-01,\r\n"       // 13 CSV内で同名（2行目）
    + "100013,加藤,九子,かとう きゅうこ,在籍,,,あんず 苑,パート,2020-01-01,\r\n"     // 14 施設の表記ゆれ
    + "100014,吉田,十子,よしだ とおこ,退職,,,あんず苑,パート,2020-01-01,2025-03-31\r\n" // 15 退職（正常）
    + "100015,既存,花子,きそん はなこ,在籍,,,あんず苑,パート,2020-01-01,\r\n"       // 16 既存と表記だけ違う
    + "100016,+山本,,やまもと,在籍,,,あんず苑,パート,,\r\n"                          // 17 CSV injection
    + "100017,松本,,まつもと,在籍,,,あんず苑,嘱託,,\r\n";                             // 18 雇用区分不正
  const existing = [{ name: "既存太郎", employeeId: "900", status: "在籍" }, { name: "既存 花子", employeeId: "100001" }];
  const p = prep("staff", t, true);
  const r = C.validateStaff(p.rows, existing, FACS, DEPTS, TODAY, p.fileWarnings);
  const at = line => r.items.find(x => x.line === line);
  check("正常な行は登録予定・入社日は YYYY/MM/DD", at(4).action === "add" && at(4).rec.hireDate === "2021/01/01" && at(4).rec.name === "鈴木一郎" && at(4).rec.location === "あんず苑");
  check("CSV内の同名は両方エラー（氏名が本人の識別子のため）", at(2).action === "error" && at(13).action === "error" && /同じ氏名/.test(msgs(r, 13)));
  check("社員コード空欄は警告のみで登録予定", at(3).action === "add" && at(3).rec.employeeId === "" && /社員コードが空欄/.test(msgs(r, 3)));
  check("日付空欄を許容", at(3).rec.hireDate === "");
  check("「社員」は「正社員」として登録（明示）", at(3).rec.employmentType === "正社員" && /正社員」として/.test(msgs(r, 3)));
  check("全角空白のふりがなを姓よみ・名よみへ分割", at(3).rec.yomiLast === "さとう" && at(3).rec.yomiFirst === "はなこ" && at(3).rec.yomi === "さとうはなこ");
  check("社員コード重複は警告のみで両方登録予定", at(4).action === "add" && at(5).action === "add" && /5行目と重複/.test(msgs(r, 4)) && /4行目と重複/.test(msgs(r, 5)));
  check("施設名は完全一致で施設名（施設マスタのキー）へ変換", at(5).rec.location === "Kiyomi`s郷あゆむ" && at(5).rec.hireDate === "2022/05/03" && at(5).rec.status === "休職");
  check("施設が見つからない行はエラー", at(6).action === "error" && /施設「どこか苑」が見つかりません/.test(msgs(r, 6)));
  check("不自然な日付は補正せず警告して登録予定", at(7).action === "add" && at(7).rec.hireDate === "1900/01/20" && /不自然な日付/.test(msgs(r, 7)));
  check("施設空欄は警告・役職は取り込まない旨を警告", at(8).action === "add" && at(8).rec.location === "" && /役職/.test(msgs(r, 8)) && !("position" in at(8).rec));
  check("実在しない日付はエラー", at(9).action === "error" && /形式が正しくありません/.test(msgs(r, 9)));
  check("既存と同名は上書きせずスキップ", at(10).action === "skip" && at(10).rec === null);
  check("退職で退職日なしはエラー", at(11).action === "error");
  check("未登録の部門はエラー", at(12).action === "error" && /部門/.test(msgs(r, 12)));
  check("施設の表記ゆれは自動で紐付けない", at(14).action === "error" && /自動では紐付けません/.test(msgs(r, 14)));
  check("退職（退職日あり）は retireDate を持つ", at(15).action === "add" && at(15).rec.retireDate === "2025/03/31");
  check("既存と表記だけ違う氏名は自動登録しない", at(16).action === "error" && /既存 花子/.test(msgs(r, 16)));
  check("CSV injection の先頭文字はエラー", at(17).action === "error" && /数式/.test(msgs(r, 17)));
  check("雇用区分の不正値はエラー", at(18).action === "error");
  {
    const q = prep("staff", STAFF_HEAD + "\r\n900,新人,太郎,しんじん たろう,在籍,,,あんず苑,パート,,\r\n");
    const rr = C.validateStaff(q.rows, existing, FACS, DEPTS, TODAY, q.fileWarnings);
    check("既存の社員コードと重複する新規は警告のみで登録予定", rr.items[0].action === "add" && /登録済みのスタッフ（既存太郎）と重複/.test(msgs(rr, 2)));
  }
  check("PINを含まない（新規レコードに pin 系の項目が無い）", r.items.filter(i => i.rec).every(i => !Object.keys(i.rec).some(k => /pin/i.test(k))));
  const c = r.counts;
  check("件数の集計（登録/スキップ/警告/エラー）", c.add === 6 && c.skip === 1 && c.error === 10 && c.update === 0 && c.warn === 5, JSON.stringify(c));

  // 登録内容: 新規だけを既存の末尾へ（既存行は上書きしない）
  const curRaw = { "0": existing[0], "1": existing[1] };
  const cur = C.normalizeList(curRaw);
  const patch = C.buildStaffPatch(r, cur);
  const keys = Object.keys(patch);
  check("PATCH は既存の添字を含まない（既存従業員を誤更新しない）", keys.every(k => +k >= 2) && keys.length === 6, keys.join(","));
  // 同じCSVを2回: 登録後の一覧で検証すると新規0件
  const after = existing.concat(keys.map(k => patch[k]));
  const r2 = C.validateStaff(p.rows, after, FACS, DEPTS, TODAY, p.fileWarnings);
  check("同じ従業員CSVを2回読み込んでも二重登録しない", r2.counts.add === 0 && r2.counts.skip === 7, JSON.stringify(r2.counts));
  check("確認時と登録直前の内容が変われば signature が変わる", C.signature(r) !== C.signature(r2));
}

{
  const rowsTxt = Array.from({ length: 3000 }, (_, i) => "100001,同名," + (i % 2 ? "太郎" : "太郎") + ",どうめい たろう,在籍,,,あんず苑,パート,,").join("\r\n");
  const q = prep("staff", STAFF_HEAD + "\r\n" + rowsTxt + "\r\n");
  const t0 = Date.now();
  const rr = C.validateStaff(q.rows, [], FACS, DEPTS, TODAY, q.fileWarnings);
  const total = rr.items.reduce((s, it) => s + it.msgs.reduce((a, m) => a + m.t.length, 0), 0);
  check("同じ氏名・社員コードが3000行でも文言が膨らまない（行番号は先頭5件＋ほかN）", total < 3000 * 400 && /3・4・5・6・7行目（ほか2994行）と同じ氏名/.test(msgs(rr, 2)), "total=" + total + " ms=" + (Date.now() - t0));
}

{
  const q = prep("staff", STAFF_HEAD + "\r\nconstructor,constructor,,こんす,在籍,constructor,,toString,パート,,\r\n1,proto,,ぷろと,在籍,,,あんず苑,パート,,\r\n");
  const rr = C.validateStaff(q.rows, [{ name: "hasOwnProperty" }], FACS, DEPTS, TODAY, q.fileWarnings);
  check("組み込み名（constructor 等）の部門・施設をマスタに在ると誤認しない", rr.items[0].action === "error" && /部門/.test(msgs(rr, 2)) && /施設「toString」/.test(msgs(rr, 2)));
  check("組み込み名でも例外にならず通常どおり判定", rr.items[1].action === "add");
}

console.log("■ 取得データの形");
{
  check("null は空", C.normalizeList(null).ok && C.normalizeList(null).next === 0);
  check("穴のある配列は末尾の次から追加", C.normalizeList([{ name: "a" }, null, { name: "c" }]).next === 3);
  check("数値以外のキーは中止（フェイルクローズ）", !C.normalizeList({ a: { name: "x" } }).ok);
  check("数値キーのオブジェクトは最大+1", C.normalizeList({ "0": { name: "a" }, "5": { name: "b" } }).next === 6);
  check("日付の変換", C.parseDate("2024-4-1").store === "2024/04/01" && C.parseDate("2024-02-29") && !C.parseDate("2023-02-29") && !C.parseDate("20240401"));
}

console.log("■ 社員コードを後から変えても打刻・有給は同一人物のまま");
{
  // 打刻・承認・PINは氏名（name）で紐付く。社員番号の変更は name を変えない。
  const idx = html.indexOf('var modalSaveBtn=document.getElementById("btn-modal-save");');
  const blk = html.slice(idx, html.indexOf("// モーダル内IME", idx));
  check("スタッフ編集の保存で、社員番号の変更は打刻の付け替えを伴わない（改名時だけ付け替える）",
    /if\(newN!==orig\)\{[\s\S]*r\.staff===orig[\s\S]*\}\s*s\.lastName=ln;[\s\S]*s\.employeeId=empId;/.test(blk));
  check("打刻レコードは氏名（staff）で本人を持つ", /\{id:generateRecordId\(\),staff:staff,type:type/.test(html));
}

console.log("■ 登録処理（模擬通信）");
function makeEnv(opts) {
  const db = { "/master/locations.json": opts.facilities, "/tc5_staff.json": opts.staff };
  const calls = [];
  const env = {
    csvImp: null, isAdminAuthenticated: opts.admin !== false, demoMode: !!opts.demo, viewerMode: false,
    writePolicy: opts.demo ? "readonlyWithAllowList" : "full", facilitiesLoaded: true, _adminElevatePromise: null,
    FB_URL: "https://example.invalid", masterFacilities: [], DEF_DEPTS: DEF_DEPTS_FROM_HTML, staffList: [], masterDepts: DEPTS, staffPins: opts.pins || {},
    alerts: [], renders: 0,
    showAlert(m) { env.alerts.push(m); }, render() { env.renders++; }, getTodayJSTStr() { return TODAY; },
    _lsSet() {}, applyFacilitiesLocal() { env.appliedFac = true; }, esc: s => String(s),
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
    authFetch: async (url, o) => {
      const p = url.replace("https://example.invalid", "");
      const m = (o && o.method) || "GET";
      calls.push(m + " " + p);
      if (opts.failGet && m === "GET") return { ok: false, status: 503, json: async () => null };
      if (m === "PATCH") {
        if (opts.failPatch) return { ok: false, status: opts.failPatch, json: async () => null };
        const body = JSON.parse(o.body);
        const cur = db[p] == null ? {} : Object.assign({}, db[p]);
        Object.keys(body).forEach(k => {
          const [a, b] = k.split("/");
          if (b) cur[a] = Object.assign({}, cur[a], { [b]: body[k] }); else cur[a] = body[k];
        });
        db[p] = cur;
        return { ok: true, status: 200, json: async () => null };
      }
      if (opts.mutateBeforeGet && calls.filter(c => c.startsWith("GET")).length === 1) opts.mutateBeforeGet(db);
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(db[p] == null ? null : db[p])) };
    },
    Promise, Object, Array, JSON, String, Uint8Array, console,
  };
  env.CSVIMP = C;
  const c = vm.createContext(env);
  vm.runInContext(UI + "\nthis.csvImp=csvImp;this.csvImpCommit=csvImpCommit;this.csvImpValidate=csvImpValidate;this.csvImpCanWrite=csvImpCanWrite;this.csvImpHtml=csvImpHtml;", c);
  c.masterFacilities = opts.facilities ? Object.values(opts.facilities) : [];
  c.staffList = opts.staff ? Object.values(opts.staff) : [];
  return { c, db, calls };
}
async function runCommit(env, kind, text) {
  const p = prep(kind, text);
  const st = { fileName: "x.csv", prep: p, result: env.c.csvImpValidate(kind, p), error: "", failMsg: "", done: null };
  env.c.csvImp[kind] = st;
  env.c.csvImpCommit(kind);
  for (let i = 0; i < 50 && env.c.csvImp.busy; i++) await new Promise(r => setImmediate(r));
  return st;
}
(async () => {
  const staffCsv = STAFF_HEAD + "\r\n100001,山田,太郎,やまだ たろう,在籍,,,あんず苑,パート,2020-04-01,\r\n,佐藤,花子,さとう はなこ,在籍,,,あんず苑,社員,,\r\n";
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: { "0": { name: "既存太郎" } } });
    const st = await runCommit(env, "staff", staffCsv);
    check("正常登録: 1回の PATCH で書く", env.calls.filter(c => c.startsWith("PATCH")).length === 1 && st.done && st.done.add === 2, JSON.stringify(env.calls) + " " + st.failMsg);
    check("正常登録: 既存行は変わらない", env.db["/tc5_staff.json"]["0"].name === "既存太郎" && env.db["/tc5_staff.json"]["2"].name === "佐藤花子");
    check("正常登録: 登録後を取り直して確認済み", st.done.verified === true);
    check("正常登録: PIN未設定の人を示す", st.done.pinUnset.length === 2);
    // 同じCSVをもう一度
    const st2 = await runCommit(env, "staff", staffCsv);
    check("2回目は登録予定0件のため書かない", st2.result.counts.add === 0 && env.calls.filter(c => c.startsWith("PATCH")).length === 1);
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {}, admin: false });
    const st = await runCommit(env, "staff", staffCsv);
    check("管理者以外は登録しない（通信もしない）", !st.done && env.calls.length === 0 && env.c.alerts.length === 1);
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {}, demo: true });
    check("デモ画面では使えない表示", !env.c.csvImpCanWrite() && /使えません/.test(env.c.csvImpHtml()));
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {}, failPatch: 403 });
    const st = await runCommit(env, "staff", staffCsv);
    check("権限拒否（Rules の 403）は失敗表示で何も登録しない", !st.done && /権限/.test(st.failMsg) && /何も登録していません/.test(st.failMsg) && Object.keys(env.db["/tc5_staff.json"]).length === 0);
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {}, failGet: true });
    const st = await runCommit(env, "staff", staffCsv);
    check("最新の取得に失敗したら書かない（途中失敗）", !st.done && env.calls.every(c => !c.startsWith("PATCH")) && /取得できません/.test(st.failMsg));
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {}, mutateBeforeGet: db => { db["/tc5_staff.json"] = { "0": { name: "山田太郎" } }; } });
    const st = await runCommit(env, "staff", staffCsv);
    check("確認後に他の操作で同名が登録されたら書かずに確認し直し", !st.done && env.calls.every(c => !c.startsWith("PATCH")) && st.result.counts.add === 1 && /もう一度確認/.test(st.failMsg));
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {} });
    const origFetch = env.c.authFetch;
    env.c.authFetch = async (url, o) => (o && o.method === "PATCH") ? null : origFetch(url, o);
    const st = await runCommit(env, "staff", staffCsv);
    check("PATCH の通信エラーは「登録されたか分からない」と伝え、成功扱いにしない", !st.done && /登録されたか分からない/.test(st.failMsg) && !/何も登録していません/.test(st.failMsg));
  }
  {
    // 端末の施設一覧（キャッシュ）にだけ在って本番に無い施設は、登録直前の取り直しで弾く
    const env = makeEnv({ facilities: {}, staff: {} });
    const p = prep("staff", staffCsv);
    env.c.masterFacilities = [FACS[0]];
    const st = { fileName: "x.csv", prep: p, result: env.c.csvImpValidate("staff", p), error: "", failMsg: "", done: null };
    env.c.csvImp.staff = st; env.c.csvImpCommit("staff");
    for (let i = 0; i < 50 && env.c.csvImp.busy; i++) await new Promise(r => setImmediate(r));
    check("従業員の登録直前に施設マスタも取り直し、端末のキャッシュだけの施設では登録しない", !st.done && env.calls.every(c => !c.startsWith("PATCH")) && env.calls.includes("GET /master/locations.json") && env.calls.includes("GET /tc_master_depts.json") && st.result.counts.error === 2, JSON.stringify(env.calls));
  }
  {
    // 部門マスタを一度も保存していない会社（RTDB は null）は、アプリ全体と同じ既定の部門で照合する
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {} });
    env.c.masterDepts = env.c.DEF_DEPTS.slice();
    const st = await runCommit(env, "staff", STAFF_HEAD + "\r\n1,部門,太郎,ぶもん たろう,在籍,調理補助,,あんず苑,パート,,\r\n");
    check("部門マスタ未保存でも既定の部門なら登録できる（誤って「他の操作で変わった」にしない）", st.done && st.done.add === 1 && !st.failMsg, st.failMsg);
  }
  {
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: {} });
    env.c.facilitiesLoaded = false;
    const st = await runCommit(env, "fac", FAC_HEAD + "\r\nF001,新苑,,,,,有効\r\n");
    check("施設マスタを取得できていないときは施設を登録しない（通信もしない）", !st.done && env.calls.length === 0 && env.c.alerts.length === 1);
  }
  {
    // PATCH の直前に別端末が同じ添字へ追加し、それを上書きしてしまった場合は検出して知らせる
    const env = makeEnv({ facilities: { "0": FACS[0] }, staff: { "0": { name: "既存太郎" } } });
    const origFetch = env.c.authFetch;
    let n = 0;
    env.c.authFetch = async (url, o) => {
      if (o && o.method === "PATCH") { env.db["/tc5_staff.json"] = {}; } // 別端末が古い一覧で全体保存した想定
      n++; return origFetch(url, o);
    };
    const st = await runCommit(env, "staff", staffCsv);
    check("登録後に既存の行が消えていたら利用者へ知らせる", st.done && st.done.lost.join() === "既存太郎", JSON.stringify(st.done) + st.failMsg);
  }
  {
    const env = makeEnv({ facilities: { "0": { name: "既存苑", token: "KEEP" } }, staff: {} });
    const st = await runCommit(env, "fac", FAC_HEAD + "\r\nF001,新苑,,,,,有効\r\nF002,既存苑,,,新住所,,有効\r\n");
    const f = env.db["/master/locations.json"];
    check("施設登録: 新規にはトークン（英数字32文字）を付ける", st.done && /^[A-Za-z0-9]{32}$/.test(f["1"].token), JSON.stringify(f) + st.failMsg);
    check("施設登録: 既存のトークン・名前は変えない", f["0"].token === "KEEP" && f["0"].name === "既存苑" && f["0"].address === "新住所");
    check("施設登録: 端末側の派生値を更新", env.c.appliedFac === true);
  }
  console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})();
