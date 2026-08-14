/**
 * api/_lib/mileage-auto.js — 応援（施設変更）打刻から施設間移動を自動集計する共通ロジック
 *
 * ===== なぜ打刻を正本にするのか =====
 * 移動距離の対象は「勤務中の施設間移動」だけである（自宅→最初の勤務施設、最後の勤務施設→自宅、
 * 通常の通勤は対象外）。その移動は既に打刻として記録されている:
 *   clockIn.workFacility        … その日の起点施設（応援先へ直行した場合は応援先が起点）
 *   facilityChange.workFacility … 移動先（時系列順）
 * したがって職員が毎日「どこからどこへ動いたか」を入力し直す必要はない。
 *
 * ===== このファイルは「純粋な計算」しか持たない =====
 * ネットワーク・DB・環境変数に一切触れない。入力は打刻レコードの配列と地点マスタだけ。
 * ★ 下記 SHARED-AUTO ブロックは index.html にも**同一内容**で存在する。
 *   表示（クライアント）と確定（サーバ）が食い違うと支給額が画面と合わなくなるため、
 *   scripts/test-mileage.js が「両者のソースが1文字も違わないこと」を検証している。
 *   変更するときは必ず両方を同じ内容にすること。
 *
 * ===== 打刻忘れ・不整合は推測で埋めない =====
 *   起点施設が確定できない        → status "no_origin"（距離も金額も確定しない）
 *   応援打刻だけがある（出勤なし）→ status "no_origin"
 *   地点／区間距離が未登録        → status "missing_leg"（0km にしない）
 * これらは「要確認」として管理者へ出し、月次確定を止める。
 */
"use strict";

// ==== SHARED-AUTO-BEGIN ====
// ★★ このブロックは api/_lib/mileage-auto.js（サーバ）と index.html（クライアント）の
//    両方に同一内容で存在する。表示と確定が食い違わないよう、片方だけ変更してはならない。★★
//    （scripts/test-mileage.js の「共有ブロックのソース一致」テストが FAIL する）

/** 距離は 0.1km 刻み。浮動小数の誤差（6.2+4.4=10.600000000000001）を持ち回らない。 */
function mileageAutoRound1(v){var n=Number(v);return isFinite(n)?Math.round(n*10)/10:0;}

/**
 * キーが外部データ（氏名・日付・施設名）由来の索引を作るときは、必ずこれを使う。
 * ★ 素の {} を使うと、キーが "__proto__" のデータを1件書かれるだけで Object.prototype を
 *   汚染できる。/honomi は匿名認証で書けるため、打刻や修正申請に "__proto__" という
 *   氏名を1件混ぜるだけで、管理画面の集計が全職員分おかしくなる（月次確定の妨害になる）。
 */
function mileageAutoDict(){return Object.create(null);}
/** 索引に安全に使えるキーか（プロトタイプを触りにいく特殊キーを弾く）。 */
function mileageAutoSafeKey(k){
  return typeof k==="string"&&k!==""&&k!=="__proto__"&&k!=="prototype"&&k!=="constructor";
}
function mileageAutoHas(o,k){return !!o&&Object.prototype.hasOwnProperty.call(o,k);}

/**
 * 出勤打刻が示す「その日の起点施設」。
 * workFacility（応援先を選んで出勤した場合は応援先）を正とし、
 * 未記録の旧データだけ facilityName（打刻した端末の施設）で補う。
 */
function mileageAutoFacilityOf(r){
  return String((r&&(r.workFacility||r.facilityName))||"");
}

/**
 * 施設変更打刻が示す「移動先」。
 * ★ facilityName へフォールバックしてはならない。facilityName は打刻した端末の施設＝
 *   移動元であり、移動先ではない。補うと実際と逆の経路を作ってしまう。
 *   移動先が記録されていない打刻は、経路を推測せずその打刻だけ使わない。
 */
function mileageAutoDestOf(r){
  return String((r&&r.workFacility)||"");
}

/** 移動距離の判定に使う打刻種別だけを残す（休憩は経路に影響しない）。 */
function mileageAutoIsRouteType(t){
  return t==="clockIn"||t==="clockOut"||t==="facilityChange";
}

/**
 * 同一スタッフ・同一日の打刻から、施設の移動経路（施設名の並び）を組み立てる。
 *
 * ・出勤(clockIn)で区間を開始し、その施設をその日の「起点」とする
 * ・施設変更(facilityChange)ごとに移動先を追加する
 * ・退勤(clockOut)で区間を閉じる
 * ・★ 最後は必ず起点施設へ戻す。実際の退勤打刻が応援先であっても、
 *   帰りの移動は必ず発生しているため（業務ルール）。
 *
 * 戻り値 { routes:[[施設名,...],...], hasMove, noOrigin, notes:[...] }
 */
function mileageAutoBuildNodes(dayRecords){
  var rs=[],i;
  for(i=0;i<dayRecords.length;i++){
    var r0=dayRecords[i];
    if(!r0||r0.deleted)continue;
    if(!mileageAutoIsRouteType(String(r0.type||"")))continue;
    var t=Date.parse(r0.timestamp);
    if(!isFinite(t))continue;   // 時刻が壊れているレコードは順序を決められないので使わない
    rs.push({t:t,i:i,r:r0});
  }
  // ★ 同時刻（管理者の手動追加は秒が 0 になる）でも順序が決まるようにする。
  //   配列順だけに頼ると、サーバとクライアントで並びが変わり結果が食い違う。
  rs.sort(function(a,b){
    if(a.t!==b.t)return a.t-b.t;
    var ai=String(a.r.id||""),bi=String(b.r.id||"");
    if(ai!==bi)return ai<bi?-1:1;
    return a.i-b.i;
  });

  var segs=[],noteMap={},cur=null;
  function note(k){noteMap[k]=true;}
  for(i=0;i<rs.length;i++){
    var rec=rs[i].r,ty=String(rec.type||"");
    if(ty==="clockIn"){
      // 退勤が無いまま次の出勤が来た場合も、前の勤務は前の勤務として閉じる
      if(cur){segs.push(cur);note("multi_shift");}
      cur={origin:mileageAutoFacilityOf(rec),nodes:[mileageAutoFacilityOf(rec)]};
    }else if(ty==="facilityChange"){
      // ★ 出勤打刻が無い状態の施設変更から起点を推測してはならない（打刻忘れの可能性）
      if(!cur){note("orphan_change");continue;}
      var to=mileageAutoDestOf(rec);
      if(!to){note("empty_facility");continue;}
      var from=String(rec.fromFacility||"");
      var last=cur.nodes[cur.nodes.length-1];
      if(from&&last&&from!==last)note("route_mismatch");
      if(to!==last)cur.nodes.push(to);
    }else if(ty==="clockOut"){
      if(cur){segs.push(cur);cur=null;}
    }
  }
  if(cur){note("no_clockout");segs.push(cur);}

  var routes=[],hasMove=false,noOrigin=false;
  // ★ 移動先が記録されていない施設変更があった日は、経路が1区間欠けたまま「正常」に見えてしまう。
  //   欠けた区間を推測せず、確定できない日として扱う（管理者が打刻を直す／削除する）。
  var brokenPunch=!!noteMap.empty_facility;
  for(i=0;i<segs.length;i++){
    var s=segs[i];
    if(s.nodes.length<2)continue;            // 施設間の移動が無い日
    hasMove=true;
    if(!s.origin){noOrigin=true;continue;}   // 起点施設が記録されていない
    var nodes=s.nodes.slice();
    if(nodes[nodes.length-1]!==s.origin)nodes.push(s.origin);   // 最後は必ず起点へ戻す
    routes.push(nodes);
  }
  if(noteMap.orphan_change){hasMove=true;noOrigin=true;}
  if(brokenPunch)hasMove=true;

  var notes=[];
  for(var k in noteMap)if(Object.prototype.hasOwnProperty.call(noteMap,k))notes.push(k);
  notes.sort();
  return {routes:routes,hasMove:hasMove,noOrigin:noOrigin,brokenPunch:brokenPunch,notes:notes};
}

/**
 * 地点マスタから「施設名 → 地点ID」の対応表を作る。
 * ・places[].facility（管理画面で明示的に対応づけた施設名）を優先する
 * ・未設定の地点は、地点名と施設名が完全一致する場合だけ対応づける
 * ★ 同じ施設名に複数の地点が対応する場合は、どちらか一方を推測せず「未対応」とする。
 */
function mileageAutoPlaceMap(places){
  var exp=mileageAutoDict(),imp=mileageAutoDict(),i,p,key;
  for(i=0;i<(places||[]).length;i++){
    p=places[i];
    if(!p||!p.id||p.active===false)continue;
    key=String(p.facility||"").trim();
    if(key){(exp[key]=exp[key]||[]).push(p.id);continue;}
    key=String(p.name||"").trim();
    if(key)(imp[key]=imp[key]||[]).push(p.id);
  }
  var map=mileageAutoDict();
  for(key in exp)if(exp[key].length===1)map[key]=exp[key][0];
  for(key in imp){
    if(mileageAutoHas(exp,key))continue;   // 明示指定が優先
    if(imp[key].length===1)map[key]=imp[key][0];
  }
  return map;
}

/**
 * 1日分の打刻 → 経路・区間距離・合計距離。
 * ctx = { placeByFacility:{施設名:地点ID}, legs:{"fromId__toId":km} }
 *
 * ★ 未登録区間・未対応施設を 0km として扱ってはならない。status で区別し、
 *   どの区間・どの施設が未登録かを返す。
 */
function mileageAutoDayRoute(dayRecords,ctx){
  var b=mileageAutoBuildNodes(dayRecords);
  var out={status:"none",totalKm:0,legs:[],routes:b.routes,notes:b.notes,
           sig:"",missingPlaces:[],missingLegs:[],
           // attention＝確定は止めないが管理者に見せる不審点（打刻の後編集・複数出勤・退勤漏れ）
           attention:(b.notes.indexOf("route_mismatch")>=0||b.notes.indexOf("multi_shift")>=0
                      ||b.notes.indexOf("no_clockout")>=0)};
  if(!b.hasMove)return out;
  var i,j;
  var sigParts=[];
  for(i=0;i<b.routes.length;i++)sigParts.push(b.routes[i].join(">"));
  out.sig=sigParts.join("|");
  if(b.brokenPunch){out.status="broken_punch";return out;}
  if(b.noOrigin){out.status="no_origin";return out;}

  var total=0,legs=[],missP=[],missPSeen=mileageAutoDict(),missL=[];
  var legMap=(ctx&&ctx.legs)||{},pmap=(ctx&&ctx.placeByFacility)||{};
  for(i=0;i<b.routes.length;i++){
    var nodes=b.routes[i];
    for(j=0;j+1<nodes.length;j++){
      var fN=nodes[j],tN=nodes[j+1];
      var fId=mileageAutoHas(pmap,fN)?pmap[fN]:"";
      var tId=mileageAutoHas(pmap,tN)?pmap[tN]:"";
      if(!fId&&!missPSeen[fN]){missPSeen[fN]=true;missP.push(fN);}
      if(!tId&&!missPSeen[tN]){missPSeen[tN]=true;missP.push(tN);}
      var km=null;
      if(fId&&tId){
        var key=fId+"__"+tId;
        km=mileageAutoHas(legMap,key)?legMap[key]:null;
        if(km==null)missL.push({fromName:fN,toName:tN});
      }
      legs.push({fromName:fN,toName:tN,km:km});
      if(km!=null)total=mileageAutoRound1(total+km);
    }
  }
  out.legs=legs;
  out.missingPlaces=missP;
  out.missingLegs=missL;
  out.totalKm=mileageAutoRound1(total);
  out.status=(missP.length||missL.length)?"missing_leg":"auto";
  return out;
}

/** 経路の表示文字列（"ナナイロ → ハルイロ → ナナイロ"）。複数勤務の日は「／」で区切る。 */
function mileageAutoRouteText(routes){
  var out=[];
  for(var i=0;i<(routes||[]).length;i++)out.push(routes[i].join(" → "));
  return out.join(" ／ ");
}

/**
 * 1人・1か月分の自動集計。recs は対象スタッフの打刻レコード（他スタッフを含んでいてもよいが、
 * 呼び出し側で staff 一致を必ず絞ること）。
 * 戻り値 { days:{ "YYYY-MM-DD": dayRoute }, dates:[...] }
 */
function mileageAutoMonth(recs,ym,ctx){
  var byDate=mileageAutoDict(),i;
  for(i=0;i<(recs||[]).length;i++){
    var r=recs[i];
    if(!r||r.deleted)continue;
    var d=String(r.date||"");
    if(d.slice(0,7)!==ym)continue;
    if(!mileageAutoSafeKey(d))continue;
    if(!mileageAutoIsRouteType(String(r.type||"")))continue;
    (byDate[d]=byDate[d]||[]).push(r);
  }
  var dates=[];
  for(var k in byDate)dates.push(k);
  dates.sort();
  var days=mileageAutoDict(),keep=[];
  for(i=0;i<dates.length;i++){
    var res=mileageAutoDayRoute(byDate[dates[i]],ctx);
    if(res.status==="none")continue;
    days[dates[i]]=res;keep.push(dates[i]);
  }
  return {days:days,dates:keep};
}

/**
 * 自動集計と、例外の手入力申請・打刻修正申請の状態を突き合わせて、月の確定対象行を作る。
 *
 * ・承認済みの手入力申請がある日は、その日の自動集計より手入力を優先する（例外運用の趣旨）
 * ・未処理の手入力申請がある日は確定できない（pending_request）
 * ・移動がある日に未処理の打刻修正申請があると確定できない（pending_correction）
 * ・却下された手入力申請は無効。自動集計の値へ戻す
 *
 * 戻り値 { rows:[...], totalKm, blockers:[{date,status}] }
 *   rows[].status: "auto"|"manual"|"no_origin"|"missing_leg"|"pending_correction"|"pending_request"
 */
function mileageAutoMerge(autoDays,manualByDate,pendingCorrectionDates){
  var seen=mileageAutoDict(),list=[],k;
  for(k in autoDays)if(!seen[k]){seen[k]=1;list.push(k);}
  for(k in manualByDate)if(mileageAutoSafeKey(k)&&!seen[k]){seen[k]=1;list.push(k);}
  list.sort();
  var rows=[],totalKm=0,blockers=[];
  for(var i=0;i<list.length;i++){
    var d=list[i];
    var a=mileageAutoHas(autoDays,d)?autoDays[d]:null;
    var m=mileageAutoHas(manualByDate,d)?manualByDate[d]:null;
    var mSt=m?String(m.status||""):"";
    var row={date:d,source:"auto",status:"none",km:0,sig:a?a.sig:"",
             autoKm:a?a.totalKm:0,autoStatus:a?a.status:"none",
             routeText:a?mileageAutoRouteText(a.routes):"",
             notes:a?a.notes:[],missingPlaces:a?a.missingPlaces:[],missingLegs:a?a.missingLegs:[],
             attention:!!(a&&a.attention)};
    if(m&&mSt==="pending"){
      row.source="manual";row.status="pending_request";row.km=mileageAutoRound1(m.totalKm);
      row.routeText=String(m.routeText||row.routeText);
    }else if(m&&mSt==="approved"){
      row.source="manual";row.status="manual";row.km=mileageAutoRound1(m.totalKm);
      row.routeText=String(m.routeText||row.routeText);
    }else{
      if(m&&mSt==="rejected")row.manualRejected=true;
      if(!a||a.status==="none")continue;
      row.status=(pendingCorrectionDates&&mileageAutoHas(pendingCorrectionDates,d))?"pending_correction":a.status;
      row.km=(row.status==="auto")?a.totalKm:0;
    }
    if(row.status==="auto"||row.status==="manual")totalKm=mileageAutoRound1(totalKm+row.km);
    else blockers.push({date:d,status:row.status});
    rows.push(row);
  }
  return {rows:rows,totalKm:mileageAutoRound1(totalKm),blockers:blockers};
}

/**
 * 確定済みスナップショットと現在の集計を突き合わせ、確定後に生じた差異を返す。
 * ★ 自動で書き換えない。管理者へ「確定後差異あり」として提示するためだけに使う。
 *   経路（施設の並び）と距離が同じなら差異としない（時刻だけの打刻修正は支給額に影響しないため）。
 */
function mileageAutoDiff(snapDays,curRows){
  var snap=mileageAutoDict(),cur=mileageAutoDict(),i,k,d;
  for(i=0;i<(snapDays||[]).length;i++){
    d=String(snapDays[i].date||"");
    if(mileageAutoSafeKey(d))snap[d]={km:mileageAutoRound1(snapDays[i].km),sig:String(snapDays[i].sig||""),source:String(snapDays[i].source||"")};
  }
  for(i=0;i<(curRows||[]).length;i++){
    d=String(curRows[i].date||"");
    if(mileageAutoSafeKey(d))cur[d]={km:mileageAutoRound1(curRows[i].km),sig:String(curRows[i].sig||""),
                 source:String(curRows[i].source||""),status:String(curRows[i].status||"")};
  }
  var seen=mileageAutoDict(),dates=[];
  for(k in snap)if(!seen[k]){seen[k]=1;dates.push(k);}
  for(k in cur)if(!seen[k]){seen[k]=1;dates.push(k);}
  dates.sort();
  var diffs=[];
  for(i=0;i<dates.length;i++){
    d=dates[i];
    var s=snap[d]||null,c=cur[d]||null;
    if(s&&c&&s.km===c.km&&s.sig===c.sig)continue;
    // ★ 確定時は要確認が0件でなければ確定できないので、スナップショットに無い日が
    //   要確認として現れたなら「確定後に新しく発生した」ということ。必ず報告する。
    //   除外してよいのは、そもそも集計対象にならない日（移動なし）だけ。
    if(!s&&c&&c.status==="none")continue;
    diffs.push({date:d,
      beforeKm:s?s.km:0,afterKm:c?c.km:0,
      beforeSig:s?s.sig:"",afterSig:c?c.sig:"",
      status:c?c.status:"removed"});
  }
  return diffs;
}
// ==== SHARED-AUTO-END ====

module.exports = {
  round1: mileageAutoRound1,
  dict: mileageAutoDict,
  safeKey: mileageAutoSafeKey,
  has: mileageAutoHas,
  facilityOf: mileageAutoFacilityOf,
  destOf: mileageAutoDestOf,
  isRouteType: mileageAutoIsRouteType,
  buildNodes: mileageAutoBuildNodes,
  placeMap: mileageAutoPlaceMap,
  dayRoute: mileageAutoDayRoute,
  routeText: mileageAutoRouteText,
  month: mileageAutoMonth,
  merge: mileageAutoMerge,
  diff: mileageAutoDiff,
};
