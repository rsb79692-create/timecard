/**
 * 労務士（閲覧用URL）画面の精査ゲートの回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-viewer-review-gate.js
 *
 * 目的:
 *   管理者が勤怠精査を完了していない月は、労務士画面で CSV だけでなく
 *   日次の打刻表・有給申請・賄い回数も出さないことを固定する（2026-10-29 ユーザー指摘）。
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

console.log("\n[1] 日次の打刻表");
check("表示日の月が精査完了か判定する", V.includes("vDayReviewed=monthReviewed(vDayYm)"));
check("未精査の月は打刻を表に使わない", /var dRecsV=records\.filter\(function\(r\)\{return vDayReviewed&&/.test(V));
check("未精査の月は表の代わりに案内を出す", V.includes("+(!vDayReviewed?vNotReviewedRow(colCount,vDayYm):"));

console.log("\n[2] 対象月の打刻・有給・賄い");
check("未精査の月は対象月の打刻を空にする", V.includes("var vMRecs=vReviewed?records.filter("));
check("精査判定は打刻の抽出より前", V.indexOf("var vReviewed=monthReviewed(reviewMonth);") >= 0 && V.indexOf("var vReviewed=monthReviewed(reviewMonth);") < V.indexOf("var vMRecs="));
check("未精査の月は有給申請を出さない", V.includes("var vPlRowsHtml=!vReviewed?vNotReviewedRow(3,reviewMonth):"));
check("未精査の月は賄い回数を出さない", V.includes("var vMealRowsHtml=!vReviewed?vNotReviewedRow(3,reviewMonth):"));

console.log("\n[3] CSV（既存のゲートを保つ）");
check("CSVボタンは精査完了のときだけ出す", V.includes("+(vReviewed\n        ?'<button id=\"btn-viewer-csv-daily\""));
const gates = (V.match(/if\(!monthReviewed\(reviewMonth\)\)\{showAlert\(/g) || []).length;
check("日次・月次・人別明細CSVは押したときも精査を確かめる（3か所）", gates === 3);

console.log("\n[4] 取得");
const R = html.slice(html.indexOf("function ensureAdminRecordRanges(){"), html.indexOf("}else if(screen===\"staffDetail\""));
check("労務士は精査完了の月だけ取得する", R.includes("if(monthReviewed(reviewMonth))addMonth(reviewMonth);") && R.includes("if(selDate&&monthReviewed(monthKey(selDate)))"));
check("10秒ごとの当日取得も、労務士は未精査の月なら取らない", html.includes("var _pd=recToday();\n      if(viewerMode&&!monthReviewed(monthKey(_pd)))return;"));
check("精査状態のノードが無くても読み終えた扱いにし、精査済みの表示を消す",
  html.includes("if(val===null||(val && typeof val===\"object\"))reviewStatusLoaded=true;\n        if(val===null)val={};"));
check("精査状態の取得失敗（HTTPエラー）は精査状態に使わない",
  html.includes("/tc5_monthly_review_status.json\")\n      .then(function(r){if(!r.ok)throw new Error("));

console.log("\n[5] 労務士の端末に打刻・承認を残さない");
check("端末保存（打刻・承認）は労務士URLでは行わない", html.includes('if((k==="tc5_records"||k==="tc5_approvals")&&_isViewerUrl())return;'));
check("起動時・日付変更時の当日取得は労務士URLでは行わない", html.includes("function loadPunchRecords(){if(_isViewerUrl())return Promise.resolve(null);"));
check("労務士URLでは当日取得の再試行もしない", html.includes("if(_isViewerUrl()){recordsReady=true;recordsStale=false;return true;}"));
check("労務士URLでは端末キャッシュを読まず、残っていた分を消す", html.includes('var records=_isViewerUrl()?[]:loadData("tc5_records",[]);') && html.includes('TLS.removeItem("tc5_records");TLS.removeItem("tc5_approvals");') && html.includes('var approvals=_isViewerUrl()?{}:loadData("tc5_approvals",{});'));

console.log("\n[6] 管理者の確認用（労務士画面の見え方）");
check("確認用は管理者のログイン中・管理画面・労務士でないときだけ", html.includes('function viewerPreviewOn(){return !!(viewerPreview&&!viewerMode&&isAdminAuthenticated&&screen==="admin");}'));
check("確認用は労務士と同じ描画を使う", V.length > 0);
check("確認用には帯と「管理画面に戻る」を出す", V.includes("👀 労務士にはこう見えています") && V.includes('id="btn-viewer-preview-exit"') && V.includes("viewerPreviewSet(false)"));
check("精査ステータスのカードに入口がある（管理者デモでは出さない）", html.includes(`+(!isAdminAuthenticated||demoMode?'':'<button class="btn-export" id="btn-viewer-preview"`) && html.includes("viewerPreviewSet(true)"));
check("確認用の打刻の取得は労務士と同じ分岐を通る", R.includes("if(viewerMode||viewerPreviewOn()){"));
check("確認用の移動距離は労務士と同じ月だけを返してもらう", html.includes('mileageApi("monthlyReport",{ym:ym||"",withDetail:true,asViewer:viewerPreviewOn()})'));
check("確認用の応答を管理者の表示に残さない", html.includes("mileage.viewLoading=false;\n  if(res.ok&&res.data&&!viewerMode&&viewerPreview!==!!res.data.asViewer)return;"));

console.log("\n[7] 確認用では書き込まない（資料のダウンロードは資料を無効にするため）");
check("確認用では資料の個別ダウンロードボタンを出さない", html.includes("ダウンロード（確認用のため押せません）") && html.includes("+(_vPrev?'':'<button onclick=\"viewerDownloadAndDelete("));
check("確認用では一括ダウンロードを出さない", html.includes("if(bulkBtn&&!_vPrev){"));
check("一括ダウンロードは労務士だけ", html.includes("bulkBtn.onclick=function(){\n          if(!viewerMode)return;"));
check("資料を無効にする処理は労務士だけ", html.includes("function viewerDownloadAndDelete(url,fileName,docId){\n  if(!viewerMode)return;"));
check("開閉で移動距離の読み込み中を残さない", html.includes("mileage.viewTried=false;mileage.viewLoading=false;mileage.viewClosedMonths=[];}"));
check("ログアウト・期限切れで確認用を戻す", html.includes("function _adminStateClear(){\n  viewerPreview=false;") && html.includes("function tenantSessionExpired(){\n  viewerPreview=false;"));

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
