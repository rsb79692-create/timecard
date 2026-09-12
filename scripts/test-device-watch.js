#!/usr/bin/env node
/**
 * test-device-watch.js — 施設端末の持ち出し検知の回帰テスト
 *
 * ★ 依存パッケージなし・送信なし・本番データ非アクセス（I/O 関数は呼ばない）。
 *
 * 固定する仕様:
 *   1. 距離計算と入力値の正規化（緯度・経度・半径・継続時間・測位誤差）
 *   2. 半径を超えただけでは通知しない。一定時間（既定3分）継続して初めて持ち出し確定
 *   3. 同じ持ち出し中は再通知しない。範囲内へ戻ったら内部状態が戻り、再び検知できる
 *   4. GPS誤差を差し引いて判定する。誤差の差し引きには上限があり、
 *      粗すぎる測位は判定に使わない（かつ継続計測をリセットしない）
 *   5. 経過時間はサーバ受信時刻で測る（端末申告の時刻を使わない）
 *   6. 監視OFF・基準位置未設定では通知しない（推測で範囲内にもしない）
 *   7. 位置情報権限の喪失は1回だけ通知し、「常に許可」へ戻ると再び通知できる
 *   8. 受信途絶は1つの途絶につき1回だけ通知する
 *   9. LINE 本文の書式。施設名に改行を混ぜても行を増やせない
 *  10. 権限マトリクス（管理APIは管理者だけ。職員・労務士・デモを絶対に通さない）
 *  11. 設定の置き場所（/devmon はクライアントから到達不能・端末APIは業務データを読まない）
 *
 * 実行: node scripts/test-device-watch.js
 * 終了コード: 0=全PASS / 1=FAILあり
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const D = require(path.join(ROOT, "api", "_lib", "device.js"));

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}
function section(t) { console.log("\n── " + t + " ──"); }
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

const CFG = { dwellSec: 180 };
// 大阪府岸和田市あたりの座標を基準に使う（実在の施設座標ではない）
const BASE = { name: "ミュゲの泉", lat: 34.46, lng: 135.37, radiusM: 150, enabled: true };

/** 基準点から北へ m メートルの地点。 */
function northOf(fac, m) {
  return { lat: fac.lat + (m / 111195), lng: fac.lng };
}

// ===== 1. 距離と正規化 =====
section("1. 距離計算と入力値の正規化");
{
  check("同一地点は 0m", D.distanceM(34.46, 135.37, 34.46, 135.37) === 0);
  check("緯度1度は約111km", near(D.distanceM(34, 135, 35, 135), 111195, 400));
  const p = northOf(BASE, 200);
  check("北へ200mは約200m", near(D.distanceM(BASE.lat, BASE.lng, p.lat, p.lng), 200, 3));
  check("経度差も距離になる", D.distanceM(34.46, 135.37, 34.46, 135.38) > 800);

  check("緯度の範囲外は null", D.normLat(91) === null && D.normLat(-91) === null);
  check("緯度の数値文字列は受け付ける", D.normLat("34.46") === 34.46);
  check("空文字は null", D.normLat("") === null && D.normLng("") === null);
  check("null / undefined は null", D.normLat(null) === null && D.normLat(undefined) === null);
  check("緯度 0 は有効な値（null にしない）", D.normLat(0) === 0);
  check("経度の範囲外は null", D.normLng(181) === null && D.normLng(-181) === null);
  check("半径は 50〜2000 のみ",
    D.normRadius(150) === 150 && D.normRadius(49) === null && D.normRadius(2001) === null);
  check("半径の不正値は既定へ丸めず null", D.normRadius("abc") === null);
  check("継続時間の不正値は既定180へ",
    D.normDwellSec("x") === 180 && D.normDwellSec(10) === 180 && D.normDwellSec(99999) === 180);
  check("継続時間は範囲内ならそのまま", D.normDwellSec(300) === 300);
  // ★ 申告が無い・不正な測位誤差は「判定に使えない値」にしてはならない。
  //   判定スキップへ落とすと「acc を省略すれば検知されない」抜け道になる。
  check("測位誤差の申告が無いときは差し引き上限として扱う（判定は行う）",
    D.normAcc(undefined) === D.ACC_CAP_M && D.ACC_CAP_M < D.ACC_MAX_M);
  check("測位誤差の負値も差し引き上限として扱う", D.normAcc(-5) === D.ACC_CAP_M);
  check("測位誤差の正常値はそのまま使う", D.normAcc(12) === 12);
  check("受信途絶のしきい値は既定24時間（短くしない）", D.DEFAULT_STALE_SEC === 24 * 3600);
  check("しきい値の不正値は既定へ倒す", D.normStaleSec(0) === D.DEFAULT_STALE_SEC
    && D.normStaleSec("x") === D.DEFAULT_STALE_SEC);
  check("不正な座標の入力を「未設定」と区別する",
    D.isBadLat("abc") === true && D.isBadLat(NaN) === true
    && D.isBadLat(null) === false && D.isBadLat("") === false
    && D.isBadLat(34.46) === false);
  // ★ 緯度と経度を別々に検査する。日本の座標（緯度≈34 / 経度≈135）では、
  //   まとめて判定すると入れ違いを検出できず「保存成功なのに基準位置が変わらない」になる。
  check("緯度欄に経度の値（135.5）を入れたら弾く", D.isBadLat(135.5) === true);
  check("経度欄の 135.5 は正しい値として通す", D.isBadLng(135.5) === false);
  check("緯度欄の 34.4 は正しい値として通す", D.isBadLat(34.4) === false);
  check("経度欄に 200 を入れたら弾く", D.isBadLng(200) === true);
  check("しきい値の上下限外は既定へ倒す",
    D.normStaleSec(60) === D.DEFAULT_STALE_SEC && D.normStaleSec(99999999) === D.DEFAULT_STALE_SEC);
}

// ===== 施設キー =====
section("1b. 施設キー（表記ゆれを同じ施設として扱う）");
{
  check("同じ名前は同じキー", D.fkeyOf("ミュゲの泉") === D.fkeyOf("ミュゲの泉"));
  check("前後の空白は同じキー", D.fkeyOf(" ミュゲの泉 ") === D.fkeyOf("ミュゲの泉"));
  check("全角空白も同じキー", D.fkeyOf("ミュゲ　の泉") === D.fkeyOf("ミュゲの泉"));
  check("別の名前は別のキー", D.fkeyOf("ハルイロ") !== D.fkeyOf("ミュゲの泉"));
  check("空名はキーを作らない", D.fkeyOf("") === "" && D.fkeyOf("   ") === "");
  check("キーは16桁の16進", D.isFkey(D.fkeyOf("ハーベスト")) === true);
  check("RTDBで使えない文字を含む名前でもキーは安全",
    D.isFkey(D.fkeyOf("A/B.C$D#E[F]")) === true);
}

// ===== 2/3. 継続判定と重複抑止 =====
section("2/3. 3分継続で確定・持ち出し中は再通知しない");
{
  const t0 = 1757000000000;
  const inside = { lat: BASE.lat, lng: BASE.lng, acc: 10 };
  const out = Object.assign({ acc: 10 }, northOf(BASE, 400));

  let dev = { state: "inside" };
  let r = D.evaluateReport(dev, Object.assign({ nowMs: t0 }, inside), BASE, CFG);
  check("範囲内では通知しない", r.notify.length === 0);
  check("範囲内では state=inside", r.patch.state === undefined || r.patch.state === "inside");
  check("範囲内では継続計測を持たない", !r.patch.pendingSince);

  // 1回目の範囲外
  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 }, out), BASE, CFG);
  check("1回目の範囲外では通知しない（単発の飛びで通知しない）", r.notify.length === 0);
  check("1回目の範囲外で継続計測を開始する", r.patch.pendingSince === t0);
  check("1回目の範囲外では state=outside にしない", r.patch.state !== "outside");
  dev = Object.assign({}, dev, r.patch);

  // 179秒後 → まだ確定しない
  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 179000 }, out), BASE, CFG);
  check("179秒では確定しない", r.notify.length === 0);
  check("179秒でも継続開始時刻を保つ", (r.patch.pendingSince || dev.pendingSince) === t0);
  dev = Object.assign({}, dev, r.patch);

  // 180秒後 → 確定して1回通知
  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 180000 }, out), BASE, CFG);
  check("180秒で持ち出し確定", r.notify.length === 1 && r.notify[0].kind === "exit");
  check("確定で state=outside", r.patch.state === "outside");
  check("確定で継続計測を消す", r.patch.pendingSince === null);
  check("確定時刻を残す", r.patch.notifiedAt === t0 + 180000);
  check("やり直し用に継続開始時刻を返す", r.notify[0].since === t0);
  dev = Object.assign({}, dev, r.patch);

  // 持ち出し中は何度報告しても通知しない
  let again = 0;
  for (let i = 1; i <= 5; i++) {
    const rr = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 180000 + i * 60000 }, out), BASE, CFG);
    again += rr.notify.length;
    dev = Object.assign({}, dev, rr.patch);
  }
  check("持ち出し中は再通知しない", again === 0);
  check("持ち出し中も最終受信は更新する", dev.lastSeenAt === t0 + 180000 + 5 * 60000);

  // 範囲内へ戻る
  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 600000 }, inside), BASE, CFG);
  check("範囲内へ戻っても通知しない（復帰通知は出さない）", r.notify.length === 0);
  check("範囲内へ戻ると state=inside", r.patch.state === "inside");
  dev = Object.assign({}, dev, r.patch);

  // 再アーム: もう一度持ち出すと通知される
  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 700000 }, out), BASE, CFG);
  dev = Object.assign({}, dev, r.patch);
  const r2 = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 700000 + 180000 }, out), BASE, CFG);
  check("範囲内へ戻った後は再び検知できる（再アーム）",
    r.notify.length === 0 && r2.notify.length === 1 && r2.notify[0].kind === "exit");
}

// ===== 4. GPS誤差 =====
section("4. GPS誤差の扱い");
{
  const t0 = 1757000000000;
  // 半径150m。200m地点で誤差100m → 200-100=100 ≦ 150 なので範囲内扱い（誤通知しない）
  let r = D.evaluateReport({ state: "inside" },
    Object.assign({ nowMs: t0, acc: 100 }, northOf(BASE, 200)), BASE, CFG);
  check("誤差を差し引いて範囲内なら継続計測を始めない", !r.patch.pendingSince);

  // 誤差を大きく申告すれば判定されない、という抜け道を作らない
  r = D.evaluateReport({ state: "inside" },
    Object.assign({ nowMs: t0, acc: 1000 }, northOf(BASE, 300)), BASE, CFG);
  check("粗すぎる測位は判定に使わない", r.judged === false);
  check("粗すぎる測位でも最終受信は更新する", r.patch.lastSeenAt === t0);
  check("粗すぎる測位では判定時刻を進めない", r.patch.lastJudgedAt === undefined);
  check("粗すぎる測位でも距離と誤差は記録する",
    r.patch.lastDistM > 0 && r.patch.lastAccM === 1000);

  // ★ acc を省略しても判定される（省略すれば検知されない、という抜け道を残さない）
  const noAcc = D.evaluateReport({ state: "inside" },
    { nowMs: t0, lat: northOf(BASE, 400).lat, lng: BASE.lng }, BASE, CFG);
  check("測位誤差の申告が無くても判定する", noAcc.judged === true);
  check("測位誤差の申告が無いときは差し引き上限として扱う", D.normAcc(undefined) === D.ACC_CAP_M);
  check("測位誤差の申告が無くても範囲外なら継続計測を始める", noAcc.patch.pendingSince === t0);

  // 粗い測位を挟んでも継続計測はリセットされない
  const out = Object.assign({ acc: 10 }, northOf(BASE, 400));
  let dev = { state: "inside" };
  dev = Object.assign({}, dev, D.evaluateReport(dev, Object.assign({ nowMs: t0 }, out), BASE, CFG).patch);
  const coarse = D.evaluateReport(dev,
    Object.assign({ nowMs: t0 + 60000, acc: 900 }, northOf(BASE, 10)), BASE, CFG);
  check("粗い測位で継続計測を消さない", coarse.patch.pendingSince === undefined);
  dev = Object.assign({}, dev, coarse.patch);
  const fin = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 180000 }, out), BASE, CFG);
  check("粗い測位を挟んでも3分で確定する", fin.notify.length === 1);

  // 差し引き上限を超える誤差は上限までしか効かない
  const capped = D.evaluateReport({ state: "inside" },
    Object.assign({ nowMs: t0, acc: D.ACC_MAX_M - 1 }, northOf(BASE, 400)), BASE, CFG);
  check("誤差の差し引きには上限がある（400m地点は範囲外のまま）",
    capped.patch.pendingSince === t0);

  // 判定できたときは lastJudgedAt が進む（「判定できていない」検知の土台）
  const okj = D.evaluateReport({ state: "inside" },
    Object.assign({ nowMs: t0, acc: 10 }, northOf(BASE, 10)), BASE, CFG);
  check("判定できたら判定時刻を残す", okj.patch.lastJudgedAt === t0);
}

// ===== 4b. 確定前の状態 =====
section("4b. 確定前は「範囲内」と記録しない");
{
  const t0 = 1757000000000;
  const out = Object.assign({ acc: 10 }, northOf(BASE, 400));
  const r = D.evaluateReport({ state: "inside" }, Object.assign({ nowMs: t0 }, out), BASE, CFG);
  check("確定前は state=pending（範囲内と書かない）", r.patch.state === "pending");
  const r2 = D.evaluateReport({ state: "pending", pendingSince: t0 },
    Object.assign({ nowMs: t0 + 60000 }, out), BASE, CFG);
  check("確定前の再報告で state を書き換えない", r2.patch.state === undefined);
  const back = D.evaluateReport({ state: "pending", pendingSince: t0 },
    { nowMs: t0 + 70000, lat: BASE.lat, lng: BASE.lng, acc: 10 }, BASE, CFG);
  check("範囲内へ戻れば state=inside", back.patch.state === "inside");
  check("範囲内へ戻れば継続計測を消す", back.patch.pendingSince === null);
}


// ===== 5. 時刻の扱い =====
section("5. 経過時間はサーバ受信時刻で測る");
{
  const t0 = 1757000000000;
  const out = Object.assign({ acc: 10 }, northOf(BASE, 400));
  let dev = { state: "inside" };
  dev = Object.assign({}, dev, D.evaluateReport(dev, Object.assign({ nowMs: t0 }, out), BASE, CFG).patch);
  // 端末が「3分後」を申告してもサーバ受信時刻が進んでいなければ確定しない
  const spoof = D.evaluateReport(dev,
    Object.assign({ nowMs: t0 + 1000, at: new Date(t0 + 999999).toISOString() }, out), BASE, CFG);
  check("端末申告の時刻では確定できない", spoof.notify.length === 0);
  const srcNC = fs.readFileSync(path.join(ROOT, "api", "_lib", "device.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("evaluateReport が rep.at を読んでいない", srcNC.indexOf("rep.at") < 0);
}

// ===== 6. 監視OFF・未設定 =====
section("6. 監視OFF・基準位置未設定では判定しない");
{
  const t0 = 1757000000000;
  const out = Object.assign({ acc: 10 }, northOf(BASE, 400));
  const off = Object.assign({}, BASE, { enabled: false });
  let r = D.evaluateReport({ state: "inside" }, Object.assign({ nowMs: t0 }, out), off, CFG);
  check("監視OFFでは通知しない", r.notify.length === 0);
  check("監視OFFでは判定しない", r.judged === false);
  check("監視OFFでも最終受信だけは残す", r.patch.lastSeenAt === t0);

  const noBase = Object.assign({}, BASE, { lat: null, lng: null });
  r = D.evaluateReport({ state: "inside" }, Object.assign({ nowMs: t0 }, out), noBase, CFG);
  check("基準位置が無ければ判定しない", r.judged === false && r.notify.length === 0);

  r = D.evaluateReport({ state: "inside" }, { nowMs: t0, acc: 10 }, BASE, CFG);
  check("端末が位置を送ってこなければ判定しない", r.judged === false);
  check("位置が無いとき state を範囲内へ倒さない", r.patch.state === undefined);

  const badRadius = Object.assign({}, BASE, { radiusM: 10 });
  check("半径が不正な施設は監視可能とみなさない", D.facilityReady(badRadius) === false);
  check("施設設定が無ければ監視可能とみなさない", D.facilityReady(null) === false);
}

// ===== 7. 権限の喪失 =====
section("7. 位置情報権限の喪失");
{
  const t0 = 1757000000000;
  const at = { lat: BASE.lat, lng: BASE.lng, acc: 10 };
  let dev = { state: "inside", permState: "ok" };
  let r = D.evaluateReport(dev, Object.assign({ nowMs: t0, permission: "whenInUse" }, at), BASE, CFG);
  check("常に許可が外れたら1回通知する",
    r.notify.filter(function (n) { return n.kind === "permission"; }).length === 1);
  check("権限の状態を lost にする", r.patch.permState === "lost");
  dev = Object.assign({}, dev, r.patch);

  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 60000, permission: "whenInUse" }, at), BASE, CFG);
  check("失われ続けているあいだは再通知しない", r.notify.length === 0);
  dev = Object.assign({}, dev, r.patch);

  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 120000, permission: "always" }, at), BASE, CFG);
  check("常に許可へ戻っても通知しない", r.notify.length === 0);
  check("常に許可へ戻ると ok に戻す", r.patch.permState === "ok");
  dev = Object.assign({}, dev, r.patch);

  r = D.evaluateReport(dev, Object.assign({ nowMs: t0 + 180000, permission: "denied" }, at), BASE, CFG);
  check("もう一度失われたら再び通知する", r.notify.length === 1);
  dev = Object.assign({}, dev, r.patch);

  r = D.evaluateReport({ state: "inside" }, Object.assign({ nowMs: t0, permission: "nonsense" }, at), BASE, CFG);
  check("知らない権限文字列では状態を触らない",
    r.notify.length === 0 && r.patch.permState === undefined);
  r = D.evaluateReport({ state: "inside" }, Object.assign({ nowMs: t0 }, at), BASE, CFG);
  check("権限の申告が無ければ状態を触らない", r.patch.permState === undefined);

  // 位置の判定と権限の判定は独立（範囲外かつ権限喪失なら2件）
  const outp = Object.assign({ acc: 10 }, northOf(BASE, 400));
  let d2 = { state: "inside", permState: "ok", pendingSince: t0 - 200000 };
  const both = D.evaluateReport(d2,
    Object.assign({ nowMs: t0, permission: "off" }, outp), BASE, CFG);
  check("範囲外の確定と権限喪失は同時に通知しうる", both.notify.length === 2);
}

// ===== 8. スイープ（確定・受信途絶・判定できていない）=====
section("8. スイープ：端末が沈黙しても確定する");
{
  const now = 1757000000000;
  const fk = D.fkeyOf("ミュゲの泉");
  const facs = {}; facs[fk] = Object.assign({}, BASE);
  const cfg = { dwellSec: 180, staleSec: 6 * 3600 };

  // ★ Exit を1回報告した直後に端末が沈黙した場合（電源を切る・機内モード）
  const devices = {
    d1: { fkey: fk, state: "pending", pendingSince: now - 200000,
          lastSeenAt: now - 200000, lastJudgedAt: now - 200000 },
  };
  let plan = D.sweepPlan(devices, now, cfg, facs);
  check("継続が3分を超えていれば端末の追加報告なしで確定する", plan.confirms.length === 1);
  check("確定対象の端末IDを返す", plan.confirms[0].deviceId === "d1");

  plan = D.sweepPlan({ d1: { fkey: fk, state: "pending", pendingSince: now - 100000,
    lastSeenAt: now - 100000, lastJudgedAt: now - 100000 } }, now, cfg, facs);
  check("3分未満では確定しない", plan.confirms.length === 0);

  plan = D.sweepPlan({ d1: { fkey: fk, state: "outside", pendingSince: 0,
    lastSeenAt: now - 200000, lastJudgedAt: now - 200000, notifiedAt: now - 100000 } }, now, cfg, facs);
  check("確定済みの端末を再確定しない", plan.confirms.length === 0);

  const offFacs = {}; offFacs[fk] = Object.assign({}, BASE, { enabled: false });
  plan = D.sweepPlan(devices, now, cfg, offFacs);
  check("監視OFFの施設は確定の対象外", plan.confirms.length === 0);

  plan = D.sweepPlan({ d1: Object.assign({}, devices.d1, { revoked: true }) }, now, cfg, facs);
  check("解除した端末は確定の対象外", plan.confirms.length === 0);

  // ★ 同じ継続について通知済みなら再送しない（確定の書き込みが失敗した場合の暴走を防ぐ）
  plan = D.sweepPlan({ d1: Object.assign({}, devices.d1, { notifiedAt: now - 100000 }) }, now, cfg, facs);
  check("同じ持ち出しについて通知済みなら再送しない", plan.confirms.length === 0);
  plan = D.sweepPlan({ d1: Object.assign({}, devices.d1, { notifiedAt: now - 300000 }) }, now, cfg, facs);
  check("前の持ち出しの通知済みは再アームを妨げない", plan.confirms.length === 1);

  // ★ 監視OFF・基準位置変更をまたいだ古い観測で確定しない
  plan = D.sweepPlan({
    d1: { fkey: fk, state: "pending", pendingSince: now - 300000,
          lastSeenAt: now - 300000, lastJudgedAt: now - 400000 },
  }, now, cfg, facs);
  check("継続開始より古い判定しか無ければ確定しない（現在位置を見ずに通知しない）",
    plan.confirms.length === 0);
}

section("8b. スイープ：受信途絶");
{
  const now = 1757000000000;
  const fk = D.fkeyOf("ミュゲの泉");
  const facs = {}; facs[fk] = Object.assign({}, BASE);
  const cfg = { dwellSec: 180, staleSec: 6 * 3600 };
  const mk = function (o) { return Object.assign({ fkey: fk, state: "inside" }, o); };
  const devices = {
    d1: mk({ lastSeenAt: now - 7 * 3600 * 1000, lastJudgedAt: now - 7 * 3600 * 1000 }),
    d2: mk({ lastSeenAt: now - 1 * 3600 * 1000, lastJudgedAt: now - 1 * 3600 * 1000 }),
    d3: mk({ lastSeenAt: now - 9 * 3600 * 1000, revoked: true }),
    d4: mk({ lastSeenAt: 0 }),
    d5: mk({ fkey: "ffffffffffffffff", lastSeenAt: now - 9 * 3600 * 1000 }),
  };
  let plan = D.sweepPlan(devices, now, cfg, facs);
  const ids = plan.stales.map(function (x) { return x.deviceId; });
  check("しきい値を超えた端末を選ぶ", ids.indexOf("d1") >= 0);
  check("受信している端末は選ばない", ids.indexOf("d2") < 0);
  check("解除した端末は選ばない", ids.indexOf("d3") < 0);
  check("一度も報告が無い端末は選ばない", ids.indexOf("d4") < 0);
  check("監視設定が無い施設の端末は選ばない", ids.indexOf("d5") < 0);

  const after = Object.assign({}, devices.d1, { staleNotifiedAt: now });
  plan = D.sweepPlan({ d1: after }, now + 60000, cfg, facs);
  check("同じ途絶では1回だけ通知する", plan.stales.length === 0);

  const back = mk({ lastSeenAt: now + 120000, lastJudgedAt: now + 120000, staleNotifiedAt: now });
  plan = D.sweepPlan({ d1: back }, now + 120000 + 7 * 3600 * 1000, cfg, facs);
  check("報告が戻った後の途絶は再び通知できる", plan.stales.length === 1);

  const offFacs = {}; offFacs[fk] = Object.assign({}, BASE, { enabled: false });
  plan = D.sweepPlan({ d1: devices.d1 }, now, cfg, offFacs);
  check("監視OFFの施設は途絶通知の対象外", plan.stales.length === 0);

  // ★ 再アームは「時刻差」で見る。印だけで抑止すると、印を戻せなかった時点で
  //   その事象について二度と通知されない（通知が恒久的に失われる）。
  const staleMs = cfg.staleSec * 1000;
  const sd = function (o) { return { d1: Object.assign({ fkey: fk, state: "inside" }, o) }; };
  plan = D.sweepPlan(sd({ lastSeenAt: now - 9 * 3600 * 1000, staleNotifiedAt: now - 60000 }), now, cfg, facs);
  check("印を付けた直後は再通知しない", plan.stales.length === 0);
  plan = D.sweepPlan(sd({ lastSeenAt: now - 9 * 3600 * 1000, staleNotifiedAt: now - staleMs + 1000 }), now, cfg, facs);
  check("しきい値の直前までは再通知しない", plan.stales.length === 0);
  plan = D.sweepPlan(sd({ lastSeenAt: now - 20 * 3600 * 1000, staleNotifiedAt: now - staleMs }), now, cfg, facs);
  check("しきい値ぶん経てば必ず再通知する（通知を恒久的に失わない）", plan.stales.length === 1);
  plan = D.sweepPlan(sd({ lastSeenAt: now - 60000, lastJudgedAt: now - 9 * 3600 * 1000,
    unjudgedNotifiedAt: now - staleMs }), now, cfg, facs);
  check("判定できていない側もしきい値ぶんで再通知する", plan.unjudged.length === 1);
}

section("8c. スイープ：報告は届くが位置を判定できていない（フェイルクローズ）");
{
  const now = 1757000000000;
  const fk = D.fkeyOf("ミュゲの泉");
  const facs = {}; facs[fk] = Object.assign({}, BASE);
  const cfg = { dwellSec: 180, staleSec: 6 * 3600 };

  // ★ 本命。位置を送らない／粗い測位だけを送り続ける端末は lastSeenAt が新しいので
  //   「受信途絶」にはならない。判定時刻で検知する。
  let plan = D.sweepPlan({
    d1: { fkey: fk, state: "inside", lastSeenAt: now - 60000, lastJudgedAt: now - 7 * 3600 * 1000 },
  }, now, cfg, facs);
  check("受信は新しくても判定が古ければ検知する", plan.unjudged.length === 1);
  check("受信途絶としては数えない", plan.stales.length === 0);

  plan = D.sweepPlan({
    d1: { fkey: fk, state: "unknown", lastSeenAt: now - 60000, lastJudgedAt: 0,
          createdAtMs: now - 7 * 3600 * 1000 },
  }, now, cfg, facs);
  check("1度も判定できていない端末を登録時刻から検知する", plan.unjudged.length === 1);

  plan = D.sweepPlan({
    d1: { fkey: fk, state: "inside", lastSeenAt: now - 60000, lastJudgedAt: now - 60000 },
  }, now, cfg, facs);
  check("直近に判定できている端末は対象外", plan.unjudged.length === 0);

  plan = D.sweepPlan({
    d1: { fkey: fk, state: "inside", lastSeenAt: now, lastJudgedAt: now - 7 * 3600 * 1000,
          unjudgedNotifiedAt: now },
  }, now, cfg, facs);
  check("同じ状態では1回だけ通知する", plan.unjudged.length === 0);

  plan = D.sweepPlan({
    d1: { fkey: fk, state: "inside", lastSeenAt: now - 9 * 3600 * 1000,
          lastJudgedAt: now - 9 * 3600 * 1000 },
  }, now, cfg, facs);
  check("受信途絶の端末を判定不能としても出さない",
    plan.stales.length === 1 && plan.unjudged.length === 0);

  plan = D.sweepPlan({
    d1: { fkey: fk, state: "unknown", lastSeenAt: now, lastJudgedAt: 0, createdAtMs: now },
  }, now, cfg, facs);
  check("登録直後は通知しない",
    plan.unjudged.length === 0 && plan.stales.length === 0 && plan.confirms.length === 0);

  // ★ 確定が抑止されたときに、受信途絶・判定できていない の検査を飛ばしてはならない
  //   （フェイルクローズ機構の中にフェイルオープンの穴を作らない）。
  plan = D.sweepPlan({
    d1: { fkey: fk, state: "pending", pendingSince: now - 300000,
          lastSeenAt: now - 9 * 3600 * 1000, lastJudgedAt: now - 400000 },
  }, now, cfg, facs);
  check("確定を抑止しても受信途絶は検査する", plan.confirms.length === 0 && plan.stales.length === 1);
  plan = D.sweepPlan({
    d1: { fkey: fk, state: "pending", pendingSince: now - 300000,
          lastSeenAt: now - 60000, lastJudgedAt: now - 9 * 3600 * 1000 },
  }, now, cfg, facs);
  check("確定を抑止しても判定できていないかを検査する",
    plan.confirms.length === 0 && plan.unjudged.length === 1);
}

section("8d. 権限の通知は監視ONの施設だけ");
{
  const t0 = 1757000000000;
  const at = { nowMs: t0, lat: BASE.lat, lng: BASE.lng, acc: 10, permission: "denied" };
  const off = Object.assign({}, BASE, { enabled: false });
  const rOn = D.evaluateReport({ state: "inside", permState: "ok" }, at, BASE, CFG);
  const rOff = D.evaluateReport({ state: "inside", permState: "ok" }, at, off, CFG);
  check("監視ONなら権限の異常を通知する",
    rOn.notify.filter(function (x) { return x.kind === "permission"; }).length === 1);
  // ★ 管理画面が「OFF」と出しているのに LINE だけ来る食い違いを作らない
  check("監視OFFでは権限の通知を出さない",
    rOff.notify.filter(function (x) { return x.kind === "permission"; }).length === 0);
  check("監視OFFでも権限の状態は記録する（管理画面の表示を正確に保つ）",
    rOff.patch.permState === "lost" && rOff.patch.permDetail === "denied");
  // 復帰で permDetail も消す（恒久的な赤表示を作らない）
  const back = D.evaluateReport({ state: "inside", permState: "lost", permDetail: "denied" },
    { nowMs: t0, lat: BASE.lat, lng: BASE.lng, acc: 10, permission: "always" }, BASE, CFG);
  check("常に許可へ戻ると permState と permDetail の両方を消す",
    back.patch.permState === "ok" && back.patch.permDetail === null);
}


// ===== 9. LINE 本文 =====
section("9. LINE 本文");
{
  const at = Date.UTC(2026, 8, 12, 11, 15);  // 2026-09-12 20:15 JST
  const msg = D.buildMessage("exit", { facilityName: "ミュゲの泉", atMs: at });
  const lines = msg.split("\n");
  check("1行目は見出し", lines[0] === "【施設端末 持ち出し検知】");
  check("2行目は施設名", lines[1] === "ミュゲの泉");
  check("3行目はJSTの日時", lines[2] === "9/12 20:15");
  check("4行目は本文", lines[3] === "施設の設定範囲外へ移動しました。");
  check("4行で終わる", lines.length === 4);

  const inj = D.buildMessage("exit", {
    facilityName: "ミュゲの泉\n【施設端末 復帰】\n範囲内へ戻りました", atMs: at,
  });
  check("施設名に改行を混ぜても行を増やせない", inj.split("\n").length === 4);

  const permMsg = D.buildMessage("permission", { facilityName: "ハルイロ", atMs: at, detail: "whenInUse" });
  check("権限の通知は見出しが違う", permMsg.split("\n")[0] === "【施設端末 位置情報の警告】");
  check("権限の通知に施設名と日時が入る",
    permMsg.indexOf("ハルイロ") > 0 && permMsg.indexOf("9/12 20:15") > 0);
  const staleMsg = D.buildMessage("stale", { facilityName: "ハーベスト", atMs: at, quietMs: 7 * 3600 * 1000 });
  check("途絶の通知は見出しが違う", staleMsg.split("\n")[0] === "【施設端末 受信途絶】");
  check("途絶の通知に時間が入る", staleMsg.indexOf("7時間以上") > 0);
  check("施設名が空でも空行にしない",
    D.buildMessage("exit", { facilityName: "", atMs: at }).split("\n")[1] === "（施設名なし）");
  check("知らない種別では本文を作らない", D.buildMessage("unknown", { atMs: at }) === "");

  check("制御文字とゼロ幅を落とす", D.normText("ミュゲ​の泉") === "ミュゲの泉");
  check("長すぎる名前は切り詰める", D.normText("あ".repeat(100), 40).length === 40);
}

// ===== 10. 権限マトリクス =====
section("10. 権限マトリクス");
{
  const api = require(path.join(ROOT, "api", "device.js"));
  const A = api.ACTIONS;
  const names = Object.keys(A);
  check("管理APIの action が定義されている", names.length >= 5);
  check("bootstrap / setFacility / issueEnroll / revokeDevice / deleteFacility が揃っている",
    ["bootstrap", "setFacility", "deleteFacility", "issueEnroll", "revokeDevice"]
      .every(function (n) { return names.indexOf(n) >= 0; }));
  check("すべての action が管理者だけ",
    names.every(function (n) { return A[n].length === 1 && A[n][0] === "a"; }));
  ["s", "v", "d", "x", ""].forEach(function (role) {
    check("role " + (role || "(空)") + " を通す action が無い",
      names.every(function (n) { return A[n].indexOf(role) < 0; }));
  });
  check("書込系 action が WRITE_ACTIONS に登録されている",
    ["setFacility", "deleteFacility", "issueEnroll", "revokeDevice"]
      .every(function (n) { return api.WRITE_ACTIONS[n] === 1; })
    && api.WRITE_ACTIONS.bootstrap === undefined);

  const adminSrc = fs.readFileSync(path.join(ROOT, "api", "device.js"), "utf8");
  check("管理APIは adminSessionValid 相当の失効判定を通している",
    /isValidAdmin\(ident\)/.test(adminSrc));
  check("管理APIはブラウザ用の guard を使っている", /H\.guard\(req, res\)/.test(adminSrc));
  check("管理APIは端末トークンを返さない",
    adminSrc.indexOf("tokenHash: ") < 0 && !/deviceToken/.test(adminSrc));
}

// ===== 11. 設定の置き場所 =====
section("11. 設定の置き場所（クライアントから触れない）");
{
  const rules = fs.readFileSync(path.join(ROOT, "database.rules.json"), "utf8");
  const parsed = JSON.parse(rules);
  check("database.rules.json は正しいJSON", !!parsed.rules);
  check("/devmon は Rules に定義されていない（＝デフォルト拒否）",
    parsed.rules.devmon === undefined);
  check("/honomi の下に監視設定を置いていない",
    JSON.stringify(parsed.rules.honomi || {}).indexOf("devmon") < 0);

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  check("index.html は RTDB の devmon を直接読み書きしない",
    html.indexOf("/devmon.json") < 0 && html.indexOf('"/devmon') < 0);
  check("index.html は /api/device 経由で設定を扱う",
    html.indexOf('DEVICE_API="https://timecard-rho.vercel.app/api/device"') > 0);
  check("基準位置・監視ON/OFFを master/locations へ保存していない",
    !/masterFacilities\.[a-zA-Z]*\s*[\s\S]{0,80}(radiusM|devWatch)/.test(html));

  const repRaw = fs.readFileSync(path.join(ROOT, "api", "device-report.js"), "utf8");
  // ★ コメントを除いたコード本体を走査する。説明文に tc5_records と書いただけで
  //   FAIL するテストにしない（見るのは実際のコードだけ）。
  const rep = repRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("端末APIは業務データ（tc5_*）を読まない", rep.indexOf("tc5_") < 0);
  check("端末APIは施設マスタ（master/locations）を読まない", rep.indexOf("master/locations") < 0);
  check("端末APIは管理者ロールを扱わない", rep.indexOf("isValidAdmin") < 0);
  check("端末APIは register / report 以外を受け付けない",
    /action !== "register" && action !== "report"/.test(rep));
  check("端末APIは CORS 応答ヘッダを付けない（ブラウザから呼ばせない）",
    rep.indexOf("Access-Control-Allow-Origin") < 0);
  check("端末APIは登録・報告の両方にIP単位のレート制限を掛けている",
    /bumpAndCount\(action === "register" \? "dvm_g" : "dvm_i", ipKey\)/.test(rep));
  check("端末トークンは定数時間比較する", /timingSafeEqualStr/.test(rep));
  // ★ 重い取得を認証の前に置いてはならない（誰でも無認証で叩けるため）
  const iLimit = rep.indexOf("bumpAndCount(action ===");
  const iAuth = rep.indexOf("timingSafeEqualStr");
  const iLoadAll = rep.indexOf("D.loadFacilities(), D.loadDevices()");
  const iLoadOne = rep.indexOf("D.loadDevice(deviceId)");
  // ★ 源ファイル上の位置ではなく、handler の中での順序で見る
  //   （handleReport は handler より前に定義されているため、単純な indexOf 比較では逆転する）。
  const hIdx = rep.indexOf("module.exports = async function handler");
  const handler = hIdx > 0 ? rep.slice(hIdx) : "";
  check("レート制限は action の振り分けより前（handler 内の順序）",
    handler.indexOf("bumpAndCount(") > 0
    && handler.indexOf("bumpAndCount(") < handler.indexOf("handleReport(body)"));
  check("端末1件の取得でトークンを照合する", iLoadOne > 0 && iAuth > iLoadOne);
  check("全件取得はトークン照合より後",
    iLoadAll > 0 && iLoadAll > iAuth);
  check("報告の連打は保存済みの最終受信時刻で弾く（往復を増やさない）",
    /REPORT_MIN_INTERVAL_MS/.test(rep) && /nowMs - seen < REPORT_MIN_INTERVAL_MS/.test(rep));
  check("登録直後の state を範囲内にしない", /state: "unknown"/.test(rep));
  // ★ 持ち出しの確定は「LINE を送れてから」書く。先に書くと、巻き戻しに失敗した時点で
  //   evaluateReport も sweepPlan も拾わなくなり、その持ち出しのアラートが完全に失われる。
  // ★ 値で固定する。ソース文字列の一致だけだと、あとから
  //   「送信前に ev.patch を丸ごと書く」1行を足しても PASS してしまう。
  {
    const evPatch = { lastSeenAt: 100, lastDistM: 400, lastAccM: 10, lastJudgedAt: 100,
                      state: "outside", pendingSince: null, notifiedAt: 100 };
    const first = D.splitPatchForSend(evPatch, { kind: "exit", since: 40 }, 100);
    check("送信前に確定（state）を書かない", first.state === undefined);
    check("送信前に通知済み（notifiedAt）を書かない", first.notifiedAt === undefined);
    check("送信前も観測値は書く",
      first.lastSeenAt === 100 && first.lastDistM === 400 && first.lastJudgedAt === 100);
    check("送信前も継続開始時刻は保つ（次の報告で計測がやり直しにならない）",
      first.pendingSince === 40);
    const none = D.splitPatchForSend(evPatch, null, 100);
    check("持ち出し通知が無いときは差分をそのまま書く",
      none.state === "outside" && none.notifiedAt === 100);
    const conf = D.confirmPatch(123);
    check("確定の差分は state/pendingSince/notifiedAt の3つだけ",
      conf.state === "outside" && conf.pendingSince === null && conf.notifiedAt === 123
      && Object.keys(conf).length === 3);
    check("確定を書くのは送信成功の枝の中だけ（ソース上の位置）",
      rep.indexOf("D.confirmPatch(nowMs)") > rep.indexOf("if (okSent)"));
    check("送信前の書き込みは純関数を通す", rep.indexOf("D.splitPatchForSend(ev.patch") > 0);
  }
  check("権限通知の失敗で permState を書き換えない（事実のまま赤で残す）",
    rep.indexOf("permNotifiedAt: null") > 0 && rep.indexOf("permState: null") < 0
    && rep.indexOf("permState: " + JSON.stringify("ok")) < 0);
  check("権限の再通知ゲートは permNotifiedAt で判定する",
    fs.readFileSync(path.join(ROOT, "api", "_lib", "device.js"), "utf8")
      .indexOf("Number(p.permNotifiedAt) > 0") > 0);
  check("基準位置が既にある施設では端末登録で上書きしない",
    rep.indexOf("base_already_set") > 0);
  check("判定の成否（judged）を端末へ返さない", rep.indexOf("judged: !!ev.judged") < 0);

  const lib = fs.readFileSync(path.join(ROOT, "api", "_lib", "device.js"), "utf8");
  check("通知は既存のLINE基盤（Messaging API push）を使う",
    lib.indexOf("https://api.line.me/v2/bot/message/push") > 0);
  check("通知の資格情報は既存の環境変数名を使う",
    lib.indexOf("LINE_CHANNEL_ACCESS_TOKEN") > 0 && lib.indexOf("LINE_TO_ID") > 0);
  check("LINEトークンの値をログへ出さない", !/console\.[a-z]+\([^)]*LINE_CHANNEL_ACCESS_TOKEN/.test(lib));

  const g = fs.readFileSync(path.join(ROOT, "api", "_lib", "google.js"), "utf8");
  check("devmon はルート直下へルーティングされる", /authz\|ratelimit\|mileage\|devmon/.test(g));
  check("devmon はマルチパス更新の許可トップに入っている",
    /"authz", "ratelimit", "mileage", "devmon"/.test(g));
}

// ===== 12. 管理画面の監視UI（index.html の DEVWATCH ブロック）=====
//
// ★ ここを実際に動かして固定する。ソース走査だけにすると、
//   「失敗時に再取得を撃ち続ける」ような回帰を検出できない（実際に作り込んだ）。
const vm = require("vm");
const htmlSrc = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const DW_BEGIN = "// ===== DEVWATCH-BEGIN =====";
const DW_END = "// ===== DEVWATCH-END =====";
const dwi = htmlSrc.indexOf(DW_BEGIN), dwe = htmlSrc.indexOf(DW_END);
if (dwi < 0 || dwe < 0 || dwe < dwi) {
  console.error("[ERROR] DEVWATCH ブロックを index.html から抽出できません");
  process.exit(1);
}
const DW = htmlSrc.slice(dwi + DW_BEGIN.length, dwe);
const DW_NC = DW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function dwCtx(opts) {
  opts = opts || {};
  const rec = { fetches: 0, renders: 0, alerts: [] };
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Error, isFinite,
    setTimeout, clearTimeout, AbortController: undefined,
    document: {
      activeElement: opts.activeElement || null,
      querySelectorAll: function () { return []; },
      createElement: function () { return { style: {}, appendChild: function () {} }; },
      body: { appendChild: function () {} },
    },
    navigator: {},
    writePolicy: "full", viewerMode: false, demoMode: false,
    masterFacilities: opts.masterFacilities || [],
    _LAZY_RETRY_MS: 5000,
    _adminElevatePromise: null,
    mileageAutoDict: function () { return Object.create(null); },
    mileageAutoSafeKey: function (k) {
      return typeof k === "string" && k !== "" && k !== "__proto__" && k !== "prototype" && k !== "constructor";
    },
    esc: function (v) { return String(v); },
    render: function () { rec.renders++; if (opts.renderCallsEnsure) sandbox.devWatchEnsure(); },
    showAlert: function (m) { rec.alerts.push(String(m)); },
    showConfirm: function (m, ok) { rec.alerts.push(String(m)); if (ok) ok(); },
    showModal: function (o) { if (o && o.onOK) o.onOK(); },
    getAuthToken: function () { return Promise.resolve("tok"); },
    fetch: function () {
      rec.fetches++;
      const resp = opts.response || {
        ok: false, status: 0, json: function () { return Promise.reject(new Error("no")); },
      };
      // ★ 即解決（マイクロタスク）にしてはならない。再試行ゲートが壊れたとき、
      //   失敗→render→再取得の連鎖がマイクロタスクだけで回り続けて
      //   setTimeout（tick）へ到達せず、テストが FAIL ではなくハングする。
      return new Promise(function (r) { setTimeout(function () { r(resp); }, 0); });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(DW, sandbox);
  sandbox.__rec = rec;
  return sandbox;
}

function tick(n) {
  let pr = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) pr = pr.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return pr;
}

async function devwatchUiSection() {
  section("12. 管理画面の監視UI：失敗しても再取得を撃ち続けない");
  {
    // render() が devWatchEnsure() を呼び戻す状況（実際の _renderInner と同じ）を再現する
    const c = dwCtx({ renderCallsEnsure: true });
    c.devWatchEnsure();
    await tick(20);
    const f1 = c.__rec.fetches;
    check("取得失敗のあと無制限に再取得しない（1.5秒で数回に収まる）", f1 > 0 && f1 <= 3);
    check("失敗を記録して画面へ出す", c.devWatch.failed === true && !!c.devWatch.failMsg);
    // 上限に達したあとは、何度 render されても通信しない
    for (let i = 0; i < 30; i++) c.devWatchEnsure();
    await tick(10);
    check("上限に達したら自動では再取得しない", c.__rec.fetches === f1);
    // 手動の再取得はゲートを戻す
    c.devWatchReload();
    await tick(10);
    check("手動の再取得はやり直せる", c.__rec.fetches > f1);
  }

  {
    // 回復しない失敗（セッション失効）は自動再試行しない
    const c = dwCtx({
      response: {
        ok: false, status: 403,
        json: function () { return Promise.resolve({ error: "session_revoked" }); },
      },
    });
    c.devWatchEnsure();
    await tick(10);
    const f = c.__rec.fetches;
    // ★ 5秒の汎用ゲートを跨いで確かめる。跨がないと、汎用ゲートだけで PASS してしまい
    //   「回復しない失敗では自動再試行しない」という特例を固定できない（変異試験で判明）。
    for (let i = 0; i < 10; i++) { c._devWatchLastTry = 0; c.devWatchEnsure(); await tick(2); }
    check("セッション失効では自動再試行しない（時間ゲートを跨いでも）",
      c.__rec.fetches === f && f === 1);
    check("セッション失効の文言を出す", /セッション/.test(c.devWatch.failMsg));
  }

  section("12b. 管理画面の監視UI：索引・孤立設定・表記ゆれ");
  {
    // ★ 施設名は master/locations 由来（一般スタッフでも書ける）。"__proto__" で壊れない。
    const c = dwCtx({
      masterFacilities: [{ name: "ミュゲの泉" }, { name: "ハルイロ" }, { name: "ハル イロ" }],
      response: {
        ok: true, status: 200,
        json: function () {
          return Promise.resolve({
            ok: true, role: "a",
            settings: { dwellSec: 180, staleSec: 86400, defaultRadiusM: 150 },
            facilities: [
              { fkey: "a".repeat(16), name: "ミュゲの泉", lat: 34.46, lng: 135.37, radiusM: 150, enabled: true },
              { fkey: "b".repeat(16), name: "__proto__", lat: 34.4, lng: 135.3, radiusM: 150, enabled: true },
              { fkey: "c".repeat(16), name: "消えた施設", lat: 34.4, lng: 135.3, radiusM: 150, enabled: true },
            ],
            devices: [
              { deviceId: "dev1", fkey: "a".repeat(16), label: "iPhone", state: "inside",
                lastSeenAt: Date.now(), lastJudgedAt: Date.now() },
            ],
          });
        },
      },
    });
    c.devWatchEnsure();
    await tick(10);
    // ★ 本体では描画のたびに呼ばれる（拠点の追加・削除へ即座に追従させるため）。
    c.devWatchRefreshMasterIndex();
    check("取得に成功する", c.devWatch.booted === true && c.devWatch.failed === false);
    check("プロトタイプを触る名前の施設で壊れない（索引が汚染されない）",
      typeof c.devWatch.facs.lat === "undefined" && c.devWatch.facs["__proto__"] === undefined);
    check("正常な施設は索引に入る", !!c.devWatch.facs["ミュゲの泉"]);
    check("端末を施設へ紐づける", (c.devWatch.devs["ミュゲの泉"] || []).length === 1);
    check("施設マスタに無い監視設定を孤立として拾う",
      c.devWatch.orphans.some(function (f) { return f.name === "消えた施設"; }));
    check("表記ゆれで同じキーへ寄る拠点を衝突として拾う",
      (c.devWatch.dupes["ハルイロ"] || []).length === 2);
    check("孤立設定の解除導線を描画する", /btn-dw-orphan/.test(c.devWatchOrphanHtml()));
    check("表記ゆれの警告を描画する",
      (function () { c.devWatch.open["ハルイロ"] = true; return /同じ施設として扱われます/.test(c.devWatchFacilityHtml("ハルイロ")); })());
  }

  section("12c. 管理画面の監視UI：判定できていない端末を正常として出さない");
  {
    const c = dwCtx({});
    const now = Date.now();
    const staleMs = 86400 * 1000;
    check("判定が古い端末を検知する",
      c.devWatchUnjudged({ lastJudgedAt: now - 2 * staleMs, lastSeenAt: now }, staleMs) === true);
    check("直近に判定できている端末は検知しない",
      c.devWatchUnjudged({ lastJudgedAt: now - 1000, lastSeenAt: now }, staleMs) === false);
    check("1度も判定していない端末は登録時刻から見る",
      c.devWatchUnjudged({ lastJudgedAt: 0, createdAt: new Date(now - 2 * staleMs).toISOString() }, staleMs) === true);
    check("登録直後は検知しない",
      c.devWatchUnjudged({ lastJudgedAt: 0, createdAt: new Date(now).toISOString() }, staleMs) === false);

    // 状態ラベル: 判定できていない端末があるなら緑（監視中）にしない
    c.devWatch.booted = true;
    c.devWatch.settings = { dwellSec: 180, staleSec: 86400, defaultRadiusM: 150 };
    c.devWatch.facs["X"] = { fkey: "f".repeat(16), name: "X", lat: 34, lng: 135, radiusM: 150, enabled: true };
    c.devWatch.devs["X"] = [{ deviceId: "d", state: "inside", lastSeenAt: now, lastJudgedAt: now - 2 * staleMs }];
    const lab = c.devWatchStatusLabel("X");
    check("判定できていない端末があれば「監視中」と表示しない", lab.t !== "監視中");
    check("判定できていない状態は赤で出す", lab.c === "#b91c1c");
    c.devWatch.devs["X"] = [{ deviceId: "d", state: "inside", lastSeenAt: now, lastJudgedAt: now }];
    check("正常なら監視中", c.devWatchStatusLabel("X").t === "監視中");
    c.devWatch.devs["X"] = [{ deviceId: "d", state: "pending", pendingSince: now, lastSeenAt: now, lastJudgedAt: now }];
    check("確定前は「範囲外を確認中」と出す", c.devWatchStatusLabel("X").t === "範囲外を確認中");
  }

  section("12d. 管理画面の監視UI：入力の保護と検証");
  {
    const c = dwCtx({ activeElement: { classList: { contains: function (k) { return k === "dw-lat"; } } } });
    check("緯度の入力中は再描画を止める（フォーカスを守る）", c.devWatchEditing() === true);
    const c2 = dwCtx({});
    check("入力していないときは再描画を止めない", c2.devWatchEditing() === false);
    // ★ 保存中を理由に再描画を止めてはならない。保存の通信が settle しない状況で
    //   管理画面全体の10秒ポーリング再描画が止まる。保存中の表示は状態から導出する。
    c2.devWatch.saving = "X";
    check("保存中は再描画を止めない（状態から表示を導く）", c2.devWatchEditing() === false);
    check("API呼び出しは必ず settle する（トークン取得の滞留で固まらない）",
      DW_NC.indexOf("Promise.race") > 0);
  }
  {
    check("10秒ポーリングの再描画条件に監視UIのガードが入っている",
      (htmlSrc.match(/!mileageBlocksRerender\(\)&&!devWatchEditing\(\)/g) || []).length >= 10);
    check("保存中の状態を DOM ではなく devWatch で持つ",
      /devWatch\.saving=k;render\(\)/.test(DW_NC) && !/b\.textContent="保存中…"/.test(DW_NC));
    check("数値でない座標を送らない", /!isFinite\(nLat\)/.test(DW_NC) && /!isFinite\(nRad\)/.test(DW_NC));
    check("索引は Object.create(null) 相当を使う",
      (DW_NC.match(/mileageAutoDict\(\)/g) || []).length >= 5);
    check("索引へ入れるキーを検査する", /mileageAutoSafeKey\(/.test(DW_NC));
    check("再試行の間隔と回数の上限を持つ",
      /DEVWATCH_MAX_TRY/.test(DW_NC) && /_devWatchLastTry/.test(DW_NC) && /_LAZY_RETRY_MS/.test(DW_NC));
    check("取得できたら入力中でない下書きを捨てる",
      /if\(!devWatchEditing\(\)\)\{devWatch\.draft=mileageAutoDict\(\);\}/.test(DW_NC));
    check("設定は /api/device 経由だけ（RTDB を直接触らない）",
      DW_NC.indexOf("authFetch") < 0 && DW_NC.indexOf("FB_URL") < 0);
    // ★ locItems（devWatchFacilityHtml を呼ぶ）より前で再計算すること。
    //   後ろだと、表記ゆれの警告が1描画ぶん遅れる（拠点を追加した直後に出ない）。
    check("孤立設定と表記ゆれ衝突は描画のたびに作り直す（拠点の追加・削除へ追従する）",
      DW_NC.indexOf("function devWatchRefreshMasterIndex()") > 0
      && htmlSrc.indexOf("devWatchRefreshMasterIndex();") > 0
      && htmlSrc.indexOf("devWatchRefreshMasterIndex();") < htmlSrc.indexOf("var locItems=masterFacilities.map"));
    check("1度も判定していない端末があれば監視中と表示しない",
      DW_NC.indexOf("監視ON（判定待ち）") > 0);
    // ★ 判定をやり直す状態（unknown）も緑にしない（基準位置を直した直後の窓）
    {
      const c3 = dwCtx({});
      const now3 = Date.now();
      c3.devWatch.booted = true;
      c3.devWatch.settings = { dwellSec: 180, staleSec: 86400, defaultRadiusM: 150 };
      c3.devWatch.facs["Y"] = { fkey: "e".repeat(16), name: "Y", lat: 34, lng: 135, radiusM: 150, enabled: true };
      c3.devWatch.devs["Y"] = [{ deviceId: "d", state: "unknown", lastSeenAt: now3, lastJudgedAt: now3 - 1000 }];
      check("判定をやり直す状態（unknown）を「監視中」と表示しない",
        c3.devWatchStatusLabel("Y").t !== "監視中");
    }
  }

  section("12e. 端末アプリとサーバの取り決め");
  {
    const watch = fs.readFileSync(path.join(ROOT, "devicewatch", "src", "watch.js"), "utf8");
    const watchNC = watch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // ★ 監視OFFで端末を止めてはならない。止めると報告の契機が消え、
    //   ONに戻しても人がアプリを開くまで再開しない。
    check("監視OFFでも端末側の監視を止めない", watchNC.indexOf("enabled === false") < 0);
    check("落ちていたら張り直す（自己復旧）", watchNC.indexOf("function ensureWatching") > 0
      || watchNC.indexOf("ensureWatching") > 0);
    check("最終報告時刻を端末へ永続化する（背景タスクで間引きが効くように）",
      watchNC.indexOf("dw_last_report_at") > 0 && watchNC.indexOf("markReported") > 0);
    check("位置更新きっかけの報告に最短間隔がある", watchNC.indexOf("REPORT_THROTTLE_MS") > 0);
    check("ジオフェンスのイベントは間引かない（報告が落ちない）",
      watchNC.indexOf("too_frequent") > 0);
    check("起床距離は許容半径と同程度（検知の確実性を落とさない）",
      /distanceInterval:\s*200/.test(watchNC));

    const repSrc = fs.readFileSync(path.join(ROOT, "api", "device-report.js"), "utf8");
    check("登録コードの照合は単独で await する（他の取得と同時に始めない）",
      /const enroll = await G\.dbGet/.test(repSrc)
      && repSrc.indexOf("const enroll = await G.dbGet") < repSrc.indexOf("Promise.all([loadSettings(), D.loadDevices()])"));
    check("スイープは間隔で間引く（毎報告で全件取得しない）",
      repSrc.indexOf("SWEEP_MIN_INTERVAL_MS") > 0 && repSrc.indexOf("const doSweep") > 0);
    check("間引いた回は自施設1件だけ読む",
      repSrc.indexOf("D.loadFacility(dev.fkey)") > 0);
    check("スイープの間隔は継続時間の最小値より短い",
      repSrc.indexOf("D.MIN_DWELL_SEC * 1000 - 1000") > 0);

    const admSrc = fs.readFileSync(path.join(ROOT, "api", "device.js"), "utf8");
    // ★ 判定の前提が変わったら、その施設の**全端末**を判定やり直しにする。
    //   pendingSince を持つ端末だけでは、旧基準で inside だった端末が緑のまま残る。
    check("前提変更時は確定済み以外の全端末を unknown へ戻す",
      admSrc.indexOf('if (d.state !== "outside") {') > 0
      && admSrc.indexOf('map[D.ROOT + "/devices/" + id + "/state"] = "unknown";') > 0);
    check("確定済み（範囲外）は消さない", admSrc.indexOf('d.state !== "outside"') > 0);
    // ★ ONへ戻した直後に誤アラートを出さないための猶予
    check("前提変更時はしきい値ぶんの猶予を与える",
      admSrc.indexOf('"/unjudgedNotifiedAt"] = now2') > 0
      && admSrc.indexOf('"/staleNotifiedAt"] = now2') > 0);
    // ★ 受信途絶の猶予は「まだ沈黙していない端末」だけ。すでに沈黙している端末は本物の異常なので、
    //   猶予を与えると通知が最大しきい値ぶん遅れる（lastSeenAt は監視OFFでも進む）。
    check("すでに沈黙している端末には受信途絶の猶予を与えない",
      admSrc.indexOf("now2 - (Number(d.lastSeenAt) || 0) < staleMs2") > 0);
    check("多重パスのキーは deviceId の形式を検査する", admSrc.indexOf("D.isDeviceId(id)") > 0);
  }
}

// ===== 結果 =====
devwatchUiSection().then(function () {
  console.log("\n====================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("====================================");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error("[ERROR]", e && e.message);
  process.exit(1);
});
