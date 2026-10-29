/**
 * 承認済みの有給を管理者が取り消す（「取消」ボタン）の回帰テスト
 * 依存パッケージなし・送信なし・本番データ非アクセス
 *
 * 実行: node scripts/test-paid-leave-cancel.js
 *
 * 目的:
 *   承認済みの行に「取消」を出し、押すと残日数を戻して「取消済（canceled）」にし、
 *   スタッフへ通知することを固定する（2026-10-29 ユーザー指示）。
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
function block(start, end) {
  const s = html.indexOf(start);
  if (s < 0) return "";
  const e = html.indexOf(end, s + start.length);
  return e < 0 ? "" : html.slice(s, e);
}

console.log("\n[1] 一覧のボタン");
const row = block(":r.status===\"approved\"\n                  ?'<button class=\"btn-pl-withdraw\"", "+'</td></tr>';");
check("承認済みの行に「取消」を出す", row.includes('class="btn-pl-cancel"') && row.includes(">取消</button>"));
check("承認済みの行の「却下」は「取消」に置き換えた", !row.includes('class="btn-pl-reject"'));
check("申請中の行は従来どおり承認・却下", html.includes('?\'<button class="btn-pl-approve" data-plid="\'+esc(r.id)+\'"') && html.includes('+\'<button class="btn-pl-reject" data-plid="\'+esc(r.id)+\'" style="background:#dc2626;color:#fff;border:none;\'+_plBtn+\'">却下</button>\''));
check("書込みできない役割では押せない一覧に入れる", html.includes('".btn-pl-approve",".btn-pl-reject",".btn-pl-withdraw",".btn-pl-cancel",'));

console.log("\n[2] 取消の処理");
const h = block('document.querySelectorAll(".btn-pl-cancel").forEach(function(b){', "// 有給管理 — 引戻");
check("承認済み以外は扱わない", h.includes('if(!req||req.status!=="approved")return;'));
check("確認してから取り消す（確認の後に最新の申請で状態を見直す）", h.includes('showModal({title:"確認",okLabel:"取り消す",') && h.includes("req=paidLeaveRequests.find(function(r){return r.id===plId;});") && h.includes('if(paidLeaveBalanceSaving||!req||req.status!=="approved")return;'));
check("残日数を戻してから状態を変える", h.indexOf("reverseFifoConsumption(snapshot)") >= 0 && h.indexOf("reverseFifoConsumption(snapshot)") < h.indexOf('status:"canceled"'));
check("残日数を戻せなければ取消済にしない", h.includes('if(!rv||rv.ok!==true)throw new Error("balance restore failed");'));
check("申請を保存できなければ画面も通知も変えない", h.includes('if(saved!==true)throw new Error("request patch failed");') && h.indexOf("if(saved!==true)") < h.indexOf('req.status="canceled"'));
check("申請の保存は成否を返し、パスを変えうる id は書かない", html.includes("return true;\n  }).catch(function(e){console.error(\"[PaidLeave] patch network error\",e);return false;});") && html.includes('var url=FB_URL+"/tc5_paid_leave_requests/"+encodeURIComponent(id)+".json";'));
check("残日数の戻しは1件でも失敗したら ok:false", html.includes("return Promise.all(promises).then(function(rs){return {ok:rs.every(function(x){return x!==false;})};});"));
check("取消済（canceled）にして消化の記録を空にする", h.includes('patchPaidLeaveRequest(plId,{status:"canceled",canceledBy:"管理者",canceledAt:nowIso,consumedSnapshot:[]})'));
check("保存できてからスタッフへ通知する", h.indexOf("createPaidLeaveCancelNotification(req,getReqStaffId(req))") > h.indexOf("patchPaidLeaveRequest("));
check("途中で失敗した取消は読み込み直すまで押させない", h.includes("if(_plCancelFailed[plId]){") && h.includes("_plCancelFailed[plId]=true;"));
check("二重押しを防ぐ", h.includes("paidLeaveBalanceSaving=true;") && h.includes("b.disabled=true;"));
check("失敗したら知らせて押し直せる", h.includes('showAlert("取消に失敗しました。画面を読み込み直して、残日数と申請の状態を確かめてください。");') && h.includes("b.disabled=false;"));

console.log("\n[3] 通知・一覧の扱い");
check("取消の通知を作る", html.includes('type:"paid_leave_canceled"') && html.includes('plNotifId(req,"canceled")'));
check("通知は引戻と同じ注意の色", html.includes('var _snRev=(n.type==="paid_leave_reverted"||n.type==="paid_leave_canceled");'));
check("取消済は履歴に回る", html.includes('var PL_HIST_ST=["rejected","withdrawn","canceled"];'));
check("取消済の日は本人も代理も申請し直せる", html.includes('if(r.staffName===staffName&&r.status!=="rejected"&&r.status!=="canceled"){') && html.includes('getLeaveDates(r).indexOf(d)>=0&&r.status!=="rejected"&&r.status!=="canceled";') && html.includes('if(r.staffName===name&&r.status!=="rejected"&&r.status!=="canceled"){'));
check("取消済は「取消済」と表示する", html.includes('canceled:"取消済"'));

console.log("\n結果: " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
