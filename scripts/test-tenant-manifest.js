/**
 * 会社ごとの manifest の選び方（index.html の <head> 先頭のスクリプト）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-tenant-manifest.js
 *
 * 方式: index.html の最初の <script> のうち manifest を決める即時関数を抜き出し、
 *       location・navigator・document.write を模擬して、書き出す <link rel="manifest"> を確かめる。
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
const sm = /\(function\(\)\{\r?\n  var q=null,c="";/.exec(html);
const s = sm ? sm.index : -1;
const e = s < 0 ? -1 : html.indexOf("})();", s);
if (s < 0 || e < 0) { console.error("ERROR: index.html から manifest を決めるスクリプトを抽出できませんでした"); process.exit(1); }
const SRC = html.slice(s, e + 5);

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; SH-M26) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
function manifestFor(search, ua, hash) {
  const out = [];
  const ctx = vm.createContext({
    URLSearchParams,
    location: { search: search, hash: hash || "" },
    navigator: { userAgent: ua },
    document: { write: (t) => out.push(t) },
  });
  vm.runInContext(SRC, ctx);
  const m = /href="([^"]*)"/.exec(out.join(""));
  return m ? m[1] : null;
}

console.log("■ 穂乃味（従来どおり）");
check("?c 無しは manifest.json", manifestFor("", UA.android) === "manifest.json");
check("穂乃味の施設URLも manifest.json", manifestFor("?token=all", UA.iphone) === "manifest.json");
check("?c=honomi は manifest.json", manifestFor("?c=honomi&admin=x", UA.android) === "manifest.json");

console.log("■ マンテール: 資格情報なし");
for (const k of Object.keys(UA)) check("?c=mantel（" + k + "）は会社の manifest", manifestFor("?c=mantel", UA[k]) === "manifest-mantel.json");

console.log("■ マンテール: 施設URL（token だけ）");
check("Android は会社の manifest を置く（インストールできる）", manifestFor("?c=mantel&token=abc", UA.android) === "manifest-mantel.json");
check("Android でハッシュの施設URLも同じ", manifestFor("", UA.android, "#c=mantel&token=abc") === "manifest-mantel.json");
check("iPhone は置かない（ホーム画面アプリへ施設トークンが引き継がれないため）", manifestFor("?c=mantel&token=abc", UA.iphone) === null);
check("iPad（Mac 表記）は置かない", manifestFor("?c=mantel&token=abc", UA.ipad) === null);
check("PC は従来どおり置かない", manifestFor("?c=mantel&token=abc", UA.pc) === null);

console.log("■ マンテール: 施設以外の資格情報つきURLは Android でも置かない");
for (const k of ["admin", "viewer", "demo", "staffDemo", "sys"]) {
  check(k + " は置かない", manifestFor("?c=mantel&" + k + "=x", UA.android) === null);
  check("token と " + k + " が両方あれば置かない", manifestFor("?c=mantel&token=t&" + k + "=x", UA.android) === null);
}
check("不正な会社IDは Android の施設URLでも置かない", manifestFor("?c=Mantel!&token=abc", UA.android) === null);

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
