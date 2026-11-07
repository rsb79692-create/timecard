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
for (const k of ["admin", "viewer", "demo", "staffDemo"]) {
  check(k + " は置かない", manifestFor("?c=mantel&" + k + "=x", UA.android) === null);
  check("token と " + k + " が両方あれば置かない", manifestFor("?c=mantel&token=t&" + k + "=x", UA.android) === null);
}
check("sys と token が両方あれば置かない", manifestFor("?c=mantel&token=t&sys", UA.android) === null);
check("クエリに sys と token・ハッシュに会社の URL は sys 用を置かない", manifestFor("?sys&token=X", UA.android, "#c=mantel") !== "manifest-mantel-sys.json");
for (const k of ["admin", "viewer", "demo", "staffDemo"]) check("sys と " + k + " が両方あれば置かない", manifestFor("?c=mantel&" + k + "=a&sys", UA.android) === null);

console.log("■ マンテール: システム管理者URL（?c=mantel&sys だけ）");
check("Android は &sys 付きで起動する専用の manifest", manifestFor("?c=mantel&sys", UA.android) === "manifest-mantel-sys.json");
check("Android で sys に値があっても同じ", manifestFor("?c=mantel&sys=1", UA.android) === "manifest-mantel-sys.json");
check("ハッシュの URL は置かない（アプリ本体はクエリの sys しか見ない）", manifestFor("", UA.android, "#c=mantel&sys") === null);
check("iPhone は従来どおり置かない", manifestFor("?c=mantel&sys", UA.iphone) === null);
check("iPad（Mac 表記）は従来どおり置かない", manifestFor("?c=mantel&sys", UA.ipad) === null);
check("PC は従来どおり置かない", manifestFor("?c=mantel&sys", UA.pc) === null);
check("専用ファイルの無い会社は置かない", manifestFor("?c=other&sys", UA.android) === null);
check("穂乃味の ?sys は従来どおり manifest.json", manifestFor("?sys", UA.android) === "manifest.json");
{
  const sm2 = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest-mantel-sys.json"), "utf8"));
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest-mantel.json"), "utf8"));
  check("専用 manifest の起動URLは ?c=mantel&sys", sm2.start_url === "./?c=mantel&sys");
  check("専用 manifest の id は打刻アプリと別", sm2.id === "./?c=mantel&sys" && sm2.id !== base.id);
  check("専用 manifest に資格情報を含めない", !/token=|admin=|viewer=|demo=/.test(JSON.stringify(sm2)));
  check("アイコンは実在する", sm2.icons.every(function (i) { return fs.existsSync(path.join(__dirname, "..", i.src)); }));
}
check("不正な会社IDは Android の施設URLでも置かない", manifestFor("?c=Mantel!&token=abc", UA.android) === null);

console.log("■ 読み込み後の差し替え（会社に応じて manifest を差し替える処理）が sys 用を上書きしない");
{
  const lm = /    var m=document\.querySelector\('link\[rel="manifest"\]'\);if\(m\)\{[^\r\n]*/.exec(html);
  check("差し替え処理を抽出できる", !!lm);
  function afterSwap(href, invalid) {
    const link = { h: href, removed: false, getAttribute: function () { return this.h; }, setAttribute: function (k, v) { this.h = v; },
      parentNode: { removeChild: function () { link.removed = true; } } };
    const ctx = vm.createContext({ document: { querySelector: function () { return link; } }, TENANT: { manifest: "manifest-mantel.json" }, TENANT_INVALID: !!invalid });
    vm.runInContext(lm[0], ctx);
    return link.removed ? null : link.h;
  }
  if (lm) {
    check("sys 用の manifest は上書きしない", afterSwap("manifest-mantel-sys.json") === "manifest-mantel-sys.json");
    check("会社の manifest はそのまま", afterSwap("manifest-mantel.json") === "manifest-mantel.json");
    check("存在しない会社では外す", afterSwap("manifest.json", true) === null);
  }
}

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
