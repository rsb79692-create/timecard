/**
 * 管理者が「労務士画面の見え方を確認」する機能の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-viewer-preview.js
 *
 * 目的:
 *   管理画面から労務士と同じ描画を開けること、確認用では書き込まないこと
 *   （労務士画面の資料ダウンロードは資料を無効にする書込みを伴う）を固定する。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}

const S = html.indexOf("  if(viewerMode||viewerPreviewOn()){\n    var _vPrev=!viewerMode;");
const E = S < 0 ? -1 : html.indexOf("loadDocumentList(function(docs){", S);
if (S < 0 || E < 0) { console.error("ERROR: 労務士画面の描画ブロックが見つかりません。"); process.exit(1); }
const V = html.slice(S, E);

console.log("\n[1] 入口と描画");
check("確認用は管理者のログイン中・管理画面・労務士でないときだけ", html.includes('function viewerPreviewOn(){return !!(viewerPreview&&!viewerMode&&isAdminAuthenticated&&screen==="admin");}'));
check("精査ステータスのカードに入口がある（管理者デモでは出さない）", html.includes("+(!isAdminAuthenticated||demoMode?'':'<button class=\"btn-export\" id=\"btn-viewer-preview\"") && html.includes("viewerPreviewSet(true)"));
check("確認用には帯と「管理画面に戻る」を出す", V.includes("👀 労務士にはこう見えています") && V.includes('id="btn-viewer-preview-exit"') && V.includes("viewerPreviewSet(false)"));
const RR = html.slice(html.indexOf("function ensureAdminRecordRanges(){"), html.indexOf("}else if(screen===\"staffDetail\""));
check("確認用の打刻の取得は労務士と同じ分岐を通る", RR.includes("if(viewerMode||viewerPreviewOn()){"));
check("開閉で移動距離の読み込み中を残さない", html.includes("mileage.viewTried=false;mileage.viewLoading=false;mileage.viewClosedMonths=[];}"));
check("ログアウト・期限切れで確認用を戻す", html.includes("function _adminStateClear(){\n  viewerPreview=false;") && html.includes("function tenantSessionExpired(){\n  viewerPreview=false;"));

console.log("\n[2] 確認用では書き込まない");
check("資料の個別ダウンロードボタンを出さない", html.includes("ダウンロード（確認用のため押せません）") && html.includes("+(_vPrev?'':'<button onclick=\"viewerDownloadAndDelete("));
check("一括ダウンロードを出さない", html.includes("if(bulkBtn&&!_vPrev){"));
check("一括ダウンロードは労務士だけ", html.includes("bulkBtn.onclick=function(){\n          if(!viewerMode)return;"));
check("資料を無効にする処理は労務士だけ", html.includes("function viewerDownloadAndDelete(url,fileName,docId){\n  if(!viewerMode)return;"));

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
