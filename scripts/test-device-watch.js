#!/usr/bin/env node
/**
 * test-device-watch.js — 施設端末の持ち出し検知の回帰テスト
 *
 * ★ 依存パッケージなし・**実送信なし・本番データ非アクセス**。
 *   ただし「I/O 関数を呼ばない」のではなく、**呼んでもスタブで止まる**ようにしてある。
 *   冒頭で `api/_lib/google.js`（RTDB・OAuth・外部HTTP）を require キャッシュで差し替えており、
 *   8g / 8h は `runSweep` と `/api/device-report` の handler を**実際に動かす**。
 *   実ネットワークへ出る経路はこのプロセスに存在しない。
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
 *  12. 定期実行（action:"sweep"）の入口。共有鍵の照合が RTDB より前にあること・
 *      鍵長32文字の強制・catch-all の不在・判定を runSweep へ委譲していること
 *  13. 管理画面を開かずに確定・通知されること（handler を実際に動かす）。
 *      確定の書き込みだけが失敗しても毎分送り直さないこと／送信失敗は必ず送り直すこと
 *  14. 送信済み記録（_exitSent）のメモリ上限（200件・TTL1時間）と追い出し順序
 *
 * 実行: node scripts/test-device-watch.js
 * 終了コード: 0=全PASS / 1=FAILあり
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

// ===== api/_lib/google.js（RTDB・OAuth・外部HTTP）を最初に差し替える =====
// ★★ 本ファイルの契約は「送信なし・本番データ非アクセス」である。実装が誤って I/O を
//   呼んだ場合に、**本番やLINEへ出る前にここで止める**（＝契約を仕組みで保証する）。
//   差し替えは api/_lib/*.js を require する**前**に行うこと（後では効かない）。
// ★ これにより `/api/device-report` の handler を実際に動かして結線を確認できる（8g 節）。
const GDB = Object.create(null);          // RTDB の中身（テストが直接組み立てる）
const GCALLS = { get: [], put: [], patch: [], patchRoot: [], http: [] };
// 書き込みだけを選んで失敗させるフック（「LINE は送れたが確定が書けない」状況の再現に使う）
const GFAIL = { patchIf: null, httpStatus: 0 };
require.cache[require.resolve(path.join(ROOT, "api", "_lib", "google.js"))] = {
  id: "google-stub", filename: "google-stub", loaded: true,
  exports: {
    async dbGet(p) { GCALLS.get.push(p); return Object.prototype.hasOwnProperty.call(GDB, p) ? GDB[p] : null; },
    async dbPut(p, v) { GCALLS.put.push(p); GDB[p] = v; return v; },
    async dbPatch(p, v) {
      GCALLS.patch.push([p, v]);
      if (GFAIL.patchIf && GFAIL.patchIf(String(p))) throw new Error("stub: patch failed");
      return v;
    },
    async dbPatchRoot(m) { GCALLS.patchRoot.push(Object.keys(m)); return m; },
    // ★ 外部HTTP（LINE送信）はここで必ず止まる。実送信の経路が無い。
    async httpRequest(url, o, body) {
      GCALLS.http.push([String(url), String(body)]);
      return { status: GFAIL.httpStatus || 200, body: "{}" };
    },
    async verifyIdToken() { throw new Error("stub: not used"); },
    async createCustomToken() { throw new Error("stub: not used"); },
    async getDbAccessToken() { throw new Error("stub: not used"); },
  },
};

const D = require(path.join(ROOT, "api", "_lib", "device.js"));
// ★ require だけ（I/O 関数は呼ばない）。secrets.js の資格情報の読み込みは遅延評価である。
const S = require(path.join(ROOT, "api", "_lib", "secrets.js"));

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
    dev0000000000001: { fkey: fk, state: "pending", pendingSince: now - 200000,
          lastSeenAt: now - 200000, lastJudgedAt: now - 200000 },
  };
  let plan = D.sweepPlan(devices, now, cfg, facs);
  check("継続が3分を超えていれば端末の追加報告なしで確定する", plan.confirms.length === 1);
  check("確定対象の端末IDを返す", !!plan.confirms[0] && plan.confirms[0].deviceId === "dev0000000000001");

  plan = D.sweepPlan({ dev0000000000001: { fkey: fk, state: "pending", pendingSince: now - 100000,
    lastSeenAt: now - 100000, lastJudgedAt: now - 100000 } }, now, cfg, facs);
  check("3分未満では確定しない", plan.confirms.length === 0);

  // ★ 形式が不正な端末IDを confirms へ入れてはならない。patchDevice が必ず throw するため
  //   「LINE は送れるが確定は永久に書けない」＝毎回のスイープで再送になる。
  //   markDevices（受信途絶・判定不能）は元から isDeviceId を検査しており、対称にする。
  const badId = D.sweepPlan({ "x": { fkey: fk, state: "pending", pendingSince: now - 200000,
    lastSeenAt: now - 200000, lastJudgedAt: now - 200000 } }, now, cfg, facs);
  check("形式が不正な端末IDは確定の対象にしない", badId.confirms.length === 0);
  check("形式が不正な端末IDは受信途絶・判定不能の対象にもしない",
    badId.stales.length === 0 && badId.unjudged.length === 0);
  check("実物と同じ形（8〜40文字）の端末IDは対象にする",
    D.sweepPlan({ "dev0000000000009": { fkey: fk, state: "pending", pendingSince: now - 200000,
      lastSeenAt: now - 200000, lastJudgedAt: now - 200000 } }, now, cfg, facs).confirms.length === 1);

  plan = D.sweepPlan({ dev0000000000001: { fkey: fk, state: "outside", pendingSince: 0,
    lastSeenAt: now - 200000, lastJudgedAt: now - 200000, notifiedAt: now - 100000 } }, now, cfg, facs);
  check("確定済みの端末を再確定しない", plan.confirms.length === 0);

  const offFacs = {}; offFacs[fk] = Object.assign({}, BASE, { enabled: false });
  plan = D.sweepPlan(devices, now, cfg, offFacs);
  check("監視OFFの施設は確定の対象外", plan.confirms.length === 0);

  plan = D.sweepPlan({ dev0000000000001: Object.assign({}, devices.dev0000000000001, { revoked: true }) }, now, cfg, facs);
  check("解除した端末は確定の対象外", plan.confirms.length === 0);

  // ★ 同じ継続について通知済みなら再送しない（確定の書き込みが失敗した場合の暴走を防ぐ）
  plan = D.sweepPlan({ dev0000000000001: Object.assign({}, devices.dev0000000000001, { notifiedAt: now - 100000 }) }, now, cfg, facs);
  check("同じ持ち出しについて通知済みなら再送しない", plan.confirms.length === 0);
  plan = D.sweepPlan({ dev0000000000001: Object.assign({}, devices.dev0000000000001, { notifiedAt: now - 300000 }) }, now, cfg, facs);
  check("前の持ち出しの通知済みは再アームを妨げない", plan.confirms.length === 1);

  // ★ 監視OFF・基準位置変更をまたいだ古い観測で確定しない
  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "pending", pendingSince: now - 300000,
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
    dev0000000000001: mk({ lastSeenAt: now - 7 * 3600 * 1000, lastJudgedAt: now - 7 * 3600 * 1000 }),
    dev0000000000002: mk({ lastSeenAt: now - 1 * 3600 * 1000, lastJudgedAt: now - 1 * 3600 * 1000 }),
    dev0000000000003: mk({ lastSeenAt: now - 9 * 3600 * 1000, revoked: true }),
    dev0000000000004: mk({ lastSeenAt: 0 }),
    dev0000000000005: mk({ fkey: "ffffffffffffffff", lastSeenAt: now - 9 * 3600 * 1000 }),
    // ★ 形式が不正なIDは、上の3条件へ到達する前に除外されること（下で個別に確認する）
    bad: mk({ lastSeenAt: now - 9 * 3600 * 1000 }),
  };
  let plan = D.sweepPlan(devices, now, cfg, facs);
  const ids = plan.stales.map(function (x) { return x.deviceId; });
  check("しきい値を超えた端末を選ぶ", ids.indexOf("dev0000000000001") >= 0);
  check("受信している端末は選ばない", ids.indexOf("dev0000000000002") < 0);
  check("解除した端末は選ばない", ids.indexOf("dev0000000000003") < 0);
  check("一度も報告が無い端末は選ばない", ids.indexOf("dev0000000000004") < 0);
  check("監視設定が無い施設の端末は選ばない", ids.indexOf("dev0000000000005") < 0);
  check("形式が不正な端末IDは選ばない", ids.indexOf("bad") < 0);
  // ★ 上の4本が「IDの形式で弾かれただけ」になっていないことを確かめる
  //   （形式を満たすIDなら選ばれる条件であることを対にして示す）。
  check("同条件で形式を満たすIDなら選ばれる（空振りでないことの担保）",
    ids.indexOf("dev0000000000001") >= 0 && plan.stales.length === 1);

  const after = Object.assign({}, devices.dev0000000000001, { staleNotifiedAt: now });
  plan = D.sweepPlan({ dev0000000000001: after }, now + 60000, cfg, facs);
  check("同じ途絶では1回だけ通知する", plan.stales.length === 0);

  const back = mk({ lastSeenAt: now + 120000, lastJudgedAt: now + 120000, staleNotifiedAt: now });
  plan = D.sweepPlan({ dev0000000000001: back }, now + 120000 + 7 * 3600 * 1000, cfg, facs);
  check("報告が戻った後の途絶は再び通知できる", plan.stales.length === 1);

  const offFacs = {}; offFacs[fk] = Object.assign({}, BASE, { enabled: false });
  plan = D.sweepPlan({ dev0000000000001: devices.dev0000000000001 }, now, cfg, offFacs);
  check("監視OFFの施設は途絶通知の対象外", plan.stales.length === 0);

  // ★ 再アームは「時刻差」で見る。印だけで抑止すると、印を戻せなかった時点で
  //   その事象について二度と通知されない（通知が恒久的に失われる）。
  const staleMs = cfg.staleSec * 1000;
  const sd = function (o) { return { dev0000000000001: Object.assign({ fkey: fk, state: "inside" }, o) }; };
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
    dev0000000000001: { fkey: fk, state: "inside", lastSeenAt: now - 60000, lastJudgedAt: now - 7 * 3600 * 1000 },
  }, now, cfg, facs);
  check("受信は新しくても判定が古ければ検知する", plan.unjudged.length === 1);
  check("受信途絶としては数えない", plan.stales.length === 0);

  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "unknown", lastSeenAt: now - 60000, lastJudgedAt: 0,
          createdAtMs: now - 7 * 3600 * 1000 },
  }, now, cfg, facs);
  check("1度も判定できていない端末を登録時刻から検知する", plan.unjudged.length === 1);

  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "inside", lastSeenAt: now - 60000, lastJudgedAt: now - 60000 },
  }, now, cfg, facs);
  check("直近に判定できている端末は対象外", plan.unjudged.length === 0);

  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "inside", lastSeenAt: now, lastJudgedAt: now - 7 * 3600 * 1000,
          unjudgedNotifiedAt: now },
  }, now, cfg, facs);
  check("同じ状態では1回だけ通知する", plan.unjudged.length === 0);

  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "inside", lastSeenAt: now - 9 * 3600 * 1000,
          lastJudgedAt: now - 9 * 3600 * 1000 },
  }, now, cfg, facs);
  check("受信途絶の端末を判定不能としても出さない",
    plan.stales.length === 1 && plan.unjudged.length === 0);

  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "unknown", lastSeenAt: now, lastJudgedAt: 0, createdAtMs: now },
  }, now, cfg, facs);
  check("登録直後は通知しない",
    plan.unjudged.length === 0 && plan.stales.length === 0 && plan.confirms.length === 0);

  // ★ 確定が抑止されたときに、受信途絶・判定できていない の検査を飛ばしてはならない
  //   （フェイルクローズ機構の中にフェイルオープンの穴を作らない）。
  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "pending", pendingSince: now - 300000,
          lastSeenAt: now - 9 * 3600 * 1000, lastJudgedAt: now - 400000 },
  }, now, cfg, facs);
  check("確定を抑止しても受信途絶は検査する", plan.confirms.length === 0 && plan.stales.length === 1);
  plan = D.sweepPlan({
    dev0000000000001: { fkey: fk, state: "pending", pendingSince: now - 300000,
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


// ===== 8e. 定期実行（管理画面を開かなくても確定・通知される）=====
section("8e. 定期実行：管理画面を開かなくても確定し、1回だけ通知する");
{
  // ★ 「サーバ」を純粋関数だけで模擬し、1分間隔の定期実行を回す。I/O は一切しない。
  //   RTDB の PATCH は null でキー削除になるので、それに合わせて適用する。
  function applyPatch(dev, patch) {
    for (const k of Object.keys(patch)) {
      if (patch[k] === null) delete dev[k]; else dev[k] = patch[k];
    }
  }
  const fk = D.fkeyOf(BASE.name);
  const facs = {}; facs[fk] = BASE;
  const cfg = { dwellSec: 180, staleSec: D.DEFAULT_STALE_SEC };
  const T0 = 1758000000000;

  // 1分ごとのスイープ（通知は数えるだけ）。runSweep の I/O を使わず sweepPlan で回す。
  let sent = 0;
  function cronMinutes(dev, fromMs, minutes) {
    for (let i = 1; i <= minutes; i++) {
      const now = fromMs + i * 60000;
      const plan = D.sweepPlan({ dev0000000000001: dev }, now, cfg, facs);
      for (let k = 0; k < plan.confirms.length; k++) {
        sent++;
        applyPatch(dev, D.confirmPatch(now));       // 送信成功 → 確定を書く
      }
      // 途絶・判定不能は本節の対象外（8b/8c で固定済み）。ここでは数だけ見る。
    }
  }

  const dev = { fkey: fk, state: "unknown", lastSeenAt: 0, lastJudgedAt: 0, createdAtMs: T0 };

  // ① 範囲内の報告
  let ev = D.evaluateReport(dev, { nowMs: T0, lat: BASE.lat, lng: BASE.lng, acc: 10 }, BASE, cfg);
  applyPatch(dev, D.splitPatchForSend(ev.patch, null, T0));
  check("範囲内なら通知しない", ev.notify.length === 0 && dev.state === "inside");

  // ② 範囲外を1回だけ報告して、そのまま沈黙する（電源を切る・機内モードにする）
  const far = northOf(BASE, 400);
  ev = D.evaluateReport(dev, { nowMs: T0 + 1000, lat: far.lat, lng: far.lng, acc: 10 }, BASE, cfg);
  const exit0 = ev.notify.filter(function (x) { return x.kind === "exit"; });
  applyPatch(dev, D.splitPatchForSend(ev.patch, exit0[0] || null, T0 + 1000));
  check("1回目の範囲外では確定しない（GPSの単発の飛びで通知しない）",
    exit0.length === 0 && dev.state === "pending" && dev.pendingSince === T0 + 1000);

  // ③ 端末が沈黙したまま定期実行が回る。3分未満では出さない。
  cronMinutes(dev, T0 + 1000, 2);
  check("3分未満は定期実行でも確定しない", sent === 0 && dev.state === "pending");

  // ④ 3分経過 → 定期実行が確定させる（★ これが「管理画面を開かなくても通知される」経路）
  cronMinutes(dev, T0 + 1000 + 120000, 1);
  check("端末が沈黙していても3分で定期実行が確定させる",
    sent === 1 && dev.state === "outside" && dev.notifiedAt > 0 && dev.pendingSince === undefined);

  // ⑤ 同一持ち出し中は、定期実行が1日回り続けても1回だけ
  cronMinutes(dev, T0 + 1000 + 180000, 1440);
  check("同一持ち出し中は定期実行を1440回回しても通知は1回だけ", sent === 1);

  // ⑥ 範囲内へ戻る（復帰そのものは通知しない）
  const tBack = T0 + 1000 + 180000 + 1440 * 60000;
  ev = D.evaluateReport(dev, { nowMs: tBack, lat: BASE.lat, lng: BASE.lng, acc: 10 }, BASE, cfg);
  applyPatch(dev, D.splitPatchForSend(ev.patch, null, tBack));
  check("範囲内へ戻っても復帰通知は出さない", ev.notify.length === 0 && dev.state === "inside");
  cronMinutes(dev, tBack, 10);
  check("復帰後の定期実行で余計な通知を出さない", sent === 1);

  // ⑦ 再度の持ち出しでは再通知する
  const tOut2 = tBack + 600000;
  ev = D.evaluateReport(dev, { nowMs: tOut2, lat: far.lat, lng: far.lng, acc: 10 }, BASE, cfg);
  applyPatch(dev, D.splitPatchForSend(ev.patch, null, tOut2));
  check("再度の持ち出しで継続計測が始まる", dev.state === "pending" && dev.pendingSince === tOut2);
  cronMinutes(dev, tOut2, 3);
  check("復帰後の再持ち出しでは定期実行が再通知する",
    sent === 2 && dev.state === "outside");

  // ⑧ 3分未満で範囲内へ戻った外出は、定期実行が回っても通知しない（誤検知対策）
  {
    const d = { fkey: fk, state: "inside", lastSeenAt: T0, lastJudgedAt: T0, createdAtMs: T0 };
    const t1 = T0 + 3600000;
    let e2 = D.evaluateReport(d, { nowMs: t1, lat: far.lat, lng: far.lng, acc: 10 }, BASE, cfg);
    applyPatch(d, D.splitPatchForSend(e2.patch, null, t1));
    const before = sent;
    cronMinutes(d, t1, 2);                       // まだ3分未満
    const t2 = t1 + 150000;                      // 2分30秒後に範囲内へ戻る
    e2 = D.evaluateReport(d, { nowMs: t2, lat: BASE.lat, lng: BASE.lng, acc: 10 }, BASE, cfg);
    applyPatch(d, D.splitPatchForSend(e2.patch, null, t2));
    check("3分未満で戻った外出では継続計測が消える",
      d.state === "inside" && d.pendingSince === undefined);
    cronMinutes(d, t2, 60);                      // 1時間ぶん回しても出さない
    check("3分未満で戻った外出は定期実行が回っても通知しない", sent === before);

    // ★ 再び出たときは、古い継続ではなく**今回の外出**から3分を測る。
    //   継続計測を消さない実装にすると、出た瞬間に確定して誤通知になる。
    const t3 = t2 + 3600000;
    e2 = D.evaluateReport(d, { nowMs: t3, lat: far.lat, lng: far.lng, acc: 10 }, BASE, cfg);
    applyPatch(d, D.splitPatchForSend(e2.patch, null, t3));
    check("再外出は今回の時刻から計測を始める", d.pendingSince === t3);
    cronMinutes(d, t3, 2);
    check("再外出でも3分未満なら通知しない", sent === before);
    cronMinutes(d, t3 + 120000, 1);
    check("再外出も3分で通知する", sent === before + 1);
  }

  // ⑨ 監視OFFの施設は定期実行でも通知しない（フェイルクローズを定期実行で破らない）
  const offFacs = {}; offFacs[fk] = Object.assign({}, BASE, { enabled: false });
  const dev2 = { fkey: fk, state: "pending", pendingSince: T0, lastJudgedAt: T0, lastSeenAt: T0 };
  const planOff = D.sweepPlan({ dev0000000000002: dev2 }, T0 + 600000, cfg, offFacs);
  check("監視OFFの施設は定期実行でも確定しない", planOff.confirms.length === 0);
  // 基準位置が未設定の施設も同じ
  const noBase = {}; noBase[fk] = { name: BASE.name, enabled: true, radiusM: 150 };
  check("基準位置が未設定の施設は定期実行でも確定しない",
    D.sweepPlan({ dev0000000000002: dev2 }, T0 + 600000, cfg, noBase).confirms.length === 0);
}

section("8f. 定期実行の入口（共有鍵・二重実装なし・認証前に往復しない）");
{
  const repRaw = fs.readFileSync(path.join(ROOT, "api", "device-report.js"), "utf8");
  const rep = repRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // ★ 判定の二重実装を作らない。sweep は既存の runSweep をそのまま呼ぶだけ。
  check("sweep は既存の runSweep へ委譲する", /D\.runSweep\(facilities, devices, nowMs, settings\)/.test(rep));
  check("sweep 独自の判定ロジックを持たない",
    rep.indexOf("function handleSweep") > 0
    && !/handleSweep[\s\S]{0,1200}?(sweepPlan|distanceM|evaluateReport|buildMessage|sendLine)/.test(rep));
  check("sweep は新しい通知基盤を作らない（LINE の直接呼び出しが無い）",
    rep.indexOf("api.line.me") < 0);

  // ★ 鍵の照合はレート制限（RTDB 2〜3往復）より前。鍵を知らない相手に RTDB を触らせない。
  const hIdx = rep.indexOf("module.exports = async function handler");
  const handler = hIdx > 0 ? rep.slice(hIdx) : "";
  const iKey = handler.indexOf("sweepKeyError(body)");
  const iBump = handler.indexOf("bumpAndCount(");
  check("鍵の照合はレート制限より前（無認証では RTDB へ1往復も起こさない）",
    iKey > 0 && iBump > 0 && iKey < iBump);
  check("鍵の照合より前に RTDB を読まない",
    handler.slice(0, iKey).indexOf("await D.") < 0 && handler.slice(0, iKey).indexOf("await G.") < 0
    && handler.slice(0, iKey).indexOf("loadSettings()") < 0);
  check("レート制限は sweep にも掛かる（鍵が漏れたときの上限）",
    /sweep: \{ kind: "dvm_s", limit: SWEEP_LIMIT_IP \}/.test(rep));
  // ★ 上限の**値**も固定する。1分間隔なら10分窓で10回なので、60 は再試行込みで妥当。
  //   ここを極端に緩めると、鍵が漏れたときの歯止めが無くなる。
  check("sweep のレート制限は 10分窓60回", /SWEEP_LIMIT_IP = 60;/.test(rep));
  // ★ 鍵の誤りにはレート制限が掛からない（照合を前へ置いているため）。総当たりに耐えるのは
  //   鍵の長さだけなので、文書が求める32文字以上をコード側でも強制する。下げてはならない。
  check("鍵は32文字以上を強制する", /SWEEP_KEY_MIN_LEN = 32;/.test(rep));
  // ★ 振り分けに catch-all の else を置いてはならない。else が handleSweep だと、
  //   将来 action を足したときにその action が鍵照合を通らずスイープを起動できる。
  check("action ごとに明示的に振り分ける（catch-all の else が無い）",
    /: action === "sweep" \? await handleSweep\(\)/.test(rep)
    && /: \{ status: 400, error: "bad_action" \}/.test(rep));
  check("鍵照合を通らずに handleSweep へ到達する枝が無い",
    handler.split("handleSweep()").length - 1 === 1);
  // ★ 定期実行はスイープの間引き（SWEEP_MIN_INTERVAL_MS）に掛からない。掛かると
  //   1分間隔という前提が黙って壊れ、AGENTS.md の表だけが残る。
  check("定期実行は間引きの対象にしない",
    !/async function handleSweep[\s\S]{0,400}?SWEEP_MIN_INTERVAL_MS/.test(rep));
  check("register / report の上限を変えていない",
    /REGISTER_LIMIT_IP = 20;/.test(rep) && /REPORT_LIMIT_IP = 120;/.test(rep));
  // ★ 定期実行の直後に、同じインスタンスへ来た報告が同じスイープをもう1回走らせない
  //   （/devmon/facilities と /devmon/devices の全件取得が二重になる）。
  check("定期実行はスイープの間引きタイマーを進める",
    /async function handleSweep[\s\S]{0,400}?_lastSweepAt = nowMs;/.test(rep));

  // ★ 鍵の値をログ・応答へ出さない
  check("鍵の値をログへ出さない", !/console\.[a-z]+\([^)]*DEVICE_SWEEP_KEY/.test(rep));
  check("鍵の値を応答へ返さない", !/key:\s*(got|want|body\.key)/.test(rep));
  check("鍵は環境変数から読む（コードへ埋め込まない）",
    /process\.env\.DEVICE_SWEEP_KEY/.test(rep)
    && !/DEVICE_SWEEP_KEY\s*=\s*["'][^"']+["']/.test(rep));

  // ★ 値で固定する（ソース一致だけだと、あとから条件を緩めても PASS してしまう）
  const i0 = repRaw.indexOf("const SWEEP_KEY_MIN_LEN");
  const i1 = repRaw.indexOf("\n}\n", repRaw.indexOf("function sweepKeyError"));
  const src = i0 > 0 && i1 > i0 ? repRaw.slice(i0, i1 + 3) : "";
  check("sweepKeyError を抽出できる", src.length > 100);
  const sandbox = { S: S, process: { env: {} }, module: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const f0 = sandbox.sweepKeyError;
  const GOOD = "0123456789abcdefghij0123456789abcdefghij";
  // ★ 通過時は null を返すため、そのまま .status を読むと FAIL ではなく TypeError で
  //   テスト全体が止まる（以降のアサーションが走らず、他の回帰まで隠れる）。
  function f(b) { const r = f0(b); return r && typeof r === "object" ? r : { status: 0, error: "" }; }

  sandbox.process.env.DEVICE_SWEEP_KEY = "";
  check("鍵が未設定なら 503（黙って何もしない状態を作らない）",
    f({ key: GOOD }).status === 503 && f({ key: GOOD }).error === "sweep_not_configured");
  sandbox.process.env.DEVICE_SWEEP_KEY = "short";
  check("鍵が短すぎるなら受け付けない", f({ key: "short" }).status === 503);

  sandbox.process.env.DEVICE_SWEEP_KEY = GOOD;
  check("正しい鍵は通る", f0({ key: GOOD }) === null);
  check("鍵なしは 403", f({}).status === 403 && f({}).error === "forbidden");
  check("空文字の鍵は 403", f({ key: "" }).status === 403);
  check("違う鍵は 403", f({ key: GOOD + "x" }).status === 403);
  check("前方一致では通らない", f({ key: GOOD.slice(0, 10) }).status === 403);
  check("文字列以外の鍵は 403",
    f({ key: 12345 }).status === 403 && f({ key: true }).status === 403
    && f({ key: { toString: function () { return GOOD; } } }).status === 403);
  check("極端に長い鍵は照合前に弾く", f({ key: GOOD.repeat(100) }).status === 403);
  // ★ 環境変数・Body に混ざった前後の空白で恒久的に 403 になる事故を防ぐ。
  //   403 は 503 と違って「未設定」と区別できないため、切り分け不能な状態になる。
  check("Body の鍵の前後の空白を無視する",
    f0({ key: " " + GOOD + " " }) === null && f0({ key: GOOD + "\n" }) === null);
  sandbox.process.env.DEVICE_SWEEP_KEY = GOOD + "\n";
  check("環境変数の鍵の末尾の改行を無視する", f0({ key: GOOD }) === null);
  sandbox.process.env.DEVICE_SWEEP_KEY = "  " + GOOD + "  ";
  check("環境変数の鍵の前後の空白を無視する", f0({ key: GOOD }) === null);
  sandbox.process.env.DEVICE_SWEEP_KEY = "   ";       // 空白だけ＝実質未設定
  check("空白だけの鍵は未設定として 503", f({ key: GOOD }).status === 503);
  sandbox.process.env.DEVICE_SWEEP_KEY = GOOD;        // 後続のために戻す
  check("空白を除いても違う鍵は通さない", f({ key: " " + GOOD + "x " }).status === 403);
  check("鍵の照合は定数時間比較を使う", src.indexOf("S.timingSafeEqualStr") > 0);
  check("鍵をそのまま比較しない（ハッシュへ通してから比較する）",
    src.indexOf("S.tokenHash(got)") > 0 && src.indexOf("S.tokenHash(want)") > 0);
  check("鍵をエラー本文へ含めない",
    JSON.stringify(f({ key: GOOD + "x" })).indexOf(GOOD) < 0);

  // ★ 保険の経路（報告時・管理画面）を外していないこと
  check("報告の機会のスイープを残している（スケジューラ停止時の保険）",
    /doSweep && facilities && sweepDevices/.test(rep));
  const adm = fs.readFileSync(path.join(ROOT, "api", "device.js"), "utf8");
  check("管理画面の取得時のスイープを残している", adm.indexOf("D.runSweep(") > 0);
}

// ===== 9. LINE 本文 =====

/**
 * 8h. 送信済み記録（_exitSent）のメモリ上限。
 * ★ 上限・TTL は内部実装なので、外からは runSweep の挙動で確かめる。
 *   「際限なく増やさない（上限を超えたら最古から落ちる）」と
 *   「直近に通知した継続の抑止は残る」を両方見ることで、
 *   上限を極端に小さくする変異（抑止が実質無効になる）も検出できる。
 */
async function exitMemSection() {
  section("8h. 送信済み記録のメモリ上限（際限なく増やさない／抑止中の継続を落とさない）");
  // LINE の資格情報はスタブ側で止まるのでダミーで足りる（実値は使わない・送信されない）。
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "stub-token";
  process.env.LINE_TO_ID = "stub-to";

  const fk = D.fkeyOf("ミュゲの泉");
  const facs = {}; facs[fk] = Object.assign({}, BASE);
  const cfg = { dwellSec: 180, staleSec: D.DEFAULT_STALE_SEC };
  const now = 1760000000000;
  // ★ 他の節と ID を重複させてはならない。`_exitSent` はモジュール変数で節をまたいで残るため、
  //   継続キー（deviceId + "@" + pendingSince）が他節と一致すると、
  //   その節が黙って sent===0 になり原因の分かりにくい FAIL になる。
  //   ここは "devMEM…"、8g は "devTESTid…"、8a〜8e は "dev00000…" で衝突しない。
  const idOf = function (i) { return "devMEM" + String(1000000000 + i); };
  const mk = function (offset) {
    return { fkey: fk, state: "pending", pendingSince: now - 200000 - offset,
             lastSeenAt: now - 200000 - offset, lastJudgedAt: now - 200000 - offset,
             createdAtMs: now - 900000 };
  };

  const first = {}; first[idOf(0)] = mk(0);
  let r = await D.runSweep(facs, first, now, cfg);
  check("1件目の持ち出しで通知する", r.sent === 1);
  r = await D.runSweep(facs, first, now + 1000, cfg);
  check("同じ継続は送り直さない", r.sent === 0);

  // ★ 上限を超える数の**別の継続**を流し込んで記録を押し出す（SWEEP_CONFIRM_MAX=5 なので5件ずつ）。
  for (let b = 0; b < 50; b++) {
    const batch = {};
    for (let k = 0; k < 5; k++) {
      const i = 1 + b * 5 + k;
      batch[idOf(i)] = mk(i);
    }
    await D.runSweep(facs, batch, now + 2000 + b, cfg);
  }
  // ★ 251継続を通したので、先頭（idOf(0)）は EXIT_SENT_MAX=200 の追い出しで落ちている。
  //   「落ちたら再送される」＝上限が効いている証拠。**Map を全消去する実装でもここは通るため、
  //   直後の「直近の抑止は残っている」と対にして初めて『最古から落ちる』を固定できる。**
  r = await D.runSweep(facs, first, now + 3000, cfg);
  check("上限を超えると最古の記録は落ちる（メモリを際限なく増やさない）", r.sent === 1);

  const lastId = idOf(250);
  const recent = {}; recent[lastId] = mk(250);
  r = await D.runSweep(facs, recent, now + 4000, cfg);
  check("直近に通知した継続の抑止は残っている", r.sent === 0);
}

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
  check("端末APIは register / report / sweep 以外を受け付けない",
    /Object\.prototype\.hasOwnProperty\.call\(RATE, action\)/.test(rep)
    && /register: \{ kind: "dvm_g"/.test(rep)
    && /report: \{ kind: "dvm_i"/.test(rep)
    && /sweep: \{ kind: "dvm_s"/.test(rep)
    && rep.indexOf('"bootstrap"') < 0 && rep.indexOf("setFacility") < 0);
  check("端末APIは CORS 応答ヘッダを付けない（ブラウザから呼ばせない）",
    rep.indexOf("Access-Control-Allow-Origin") < 0);
  check("全 action にIP単位のレート制限を掛けている（kind と上限を取り違えない）",
    /bumpAndCount\(RATE\[action\]\.kind, ipKey\)/.test(rep)
    && /n > RATE\[action\]\.limit/.test(rep));
  check("端末トークンは定数時間比較する", /timingSafeEqualStr/.test(rep));
  // ★ 重い取得を認証の前に置いてはならない（誰でも無認証で叩けるため）。
  //   ★★ 位置の比較は**必ず対象の関数本体へスコープする**。ファイル全体の indexOf で
  //   比べると、同じ字句を使う別の関数（sweepKeyError / handleSweep）の位置を拾い、
  //   handleReport の順序が崩れても PASS してしまう（2026-09-13 のレビューで実際に発覚）。
  const hIdx = rep.indexOf("module.exports = async function handler");
  const handler = hIdx > 0 ? rep.slice(hIdx) : "";
  check("レート制限は action の振り分けより前（handler 内の順序）",
    handler.indexOf("bumpAndCount(") > 0
    && handler.indexOf("bumpAndCount(") < handler.indexOf("handleReport(body)"));
  {
    const rIdx = rep.indexOf("async function handleReport");
    const rBody = rIdx > 0 ? rep.slice(rIdx, rep.indexOf("module.exports")) : "";
    const rAuth = rBody.indexOf("timingSafeEqualStr");
    const rOne = rBody.indexOf("D.loadDevice(deviceId)");
    const rAll = rBody.indexOf("D.loadFacilities(), D.loadDevices()");
    check("handleReport の本体を切り出せる", rBody.length > 500);
    check("handleReport は端末1件の取得でトークンを照合する",
      rOne > 0 && rAuth > rOne);
    check("handleReport の全件取得はトークン照合より後",
      rAll > 0 && rAll > rAuth);
    // ★ handleReport の中に「照合より前の全件取得」が1つも無いこと
    check("handleReport はトークン照合より前に全件取得しない",
      rBody.slice(0, rAuth).indexOf("D.loadFacilities()") < 0
      && rBody.slice(0, rAuth).indexOf("D.loadDevices()") < 0);
  }
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
    // ★ 定期実行（60秒）の直下に置く。短すぎると cron の直後に端末報告が冗長な
    //   全件スイープを重ねる。60秒以上にすると継続時間の最小値（60秒）を超える。
    check("報告時スイープの間引きは定期実行の間隔の直下（59秒）",
      /Math\.min\(59 \* 1000, D\.MIN_DWELL_SEC \* 1000 - 1000\)/.test(repSrc));
    // ★ 設定キャッシュの TTL は呼び出し間隔より長くする（短いと一度も効かない）。
    check("設定キャッシュの TTL は呼び出し間隔より長い",
      /SETTINGS_TTL_MS = 5 \* 60 \* 1000;/.test(repSrc));

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


/**
 * 8g. `/api/device-report` の handler を**実際に動かす**。
 *
 * ★ ソース走査と純粋関数だけでは、結線の壊れ（action の振り分け・guardApp・応答の形・
 *   鍵照合の位置）を検出できない。RTDB と外部HTTP は冒頭のスタブで止まっているので、
 *   本番データへもLINEへも到達しない。
 */
async function devReportHandlerSection() {
  section("8g. 端末API の handler を実際に動かす（管理画面を開かずに通知されること）");

  const handler = require(path.join(ROOT, "api", "device-report.js"));
  const KEY = "k".repeat(40);
  const DEV = "devTESTid0000001";           // isDeviceId を満たす形
  const fk = D.fkeyOf("ミュゲの泉");

  function reset() {
    for (const k of Object.keys(GDB)) delete GDB[k];
    GCALLS.get.length = 0; GCALLS.put.length = 0;
    GCALLS.patch.length = 0; GCALLS.patchRoot.length = 0; GCALLS.http.length = 0;
    GDB["devmon/settings"] = { dwellSec: 180, staleSec: D.DEFAULT_STALE_SEC };
  }
  async function call(body, opts) {
    const o = opts || {};
    const res = { code: 0, body: null, headers: {} };
    res.setHeader = function (k, v) { res.headers[String(k).toLowerCase()] = v; };
    res.status = function (c) { res.code = c; return res; };
    res.json = function (b) { res.body = b; return res; };
    res.end = function () { return res; };
    await handler({
      method: o.method || "POST",
      headers: { "content-type": o.ct || "application/json", "x-real-ip": "203.0.113.9" },
      body: body,
    }, res);
    return res;
  }
  // LINE の資格情報はスタブ側で止まるので、ダミーで足りる（実値は使わない）。
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "stub-token";
  process.env.LINE_TO_ID = "stub-to";

  // --- guardApp（ブラウザから呼ばせない）---
  reset();
  process.env.DEVICE_SWEEP_KEY = KEY;
  let r = await call({ action: "sweep", key: KEY }, { method: "GET" });
  check("GET は 405", r.code === 405 && r.body.error === "method_not_allowed");
  r = await call({ action: "sweep", key: KEY }, { ct: "text/plain" });
  check("JSON 以外は 415", r.code === 415);
  r = await call({ action: "sweep", key: KEY }, { method: "OPTIONS" });
  check("OPTIONS は 403（プリフライトを通さない）", r.code === 403);
  check("CORS 応答ヘッダを付けない", !r.headers["access-control-allow-origin"]);
  check("no-store を付ける", String(r.headers["cache-control"]) === "no-store");

  // --- 鍵（★ 無認証で RTDB へ1往復も起こさないこと）---
  reset();
  delete process.env.DEVICE_SWEEP_KEY;
  r = await call({ action: "sweep", key: KEY });
  check("鍵が未設定なら 503 sweep_not_configured",
    r.code === 503 && r.body.error === "sweep_not_configured");
  check("★ 鍵が未設定なら RTDB へ1往復も起こさない（レート制限すら走らせない）",
    GCALLS.get.length === 0 && GCALLS.patch.length === 0 && GCALLS.put.length === 0);

  reset();
  process.env.DEVICE_SWEEP_KEY = KEY;
  r = await call({ action: "sweep", key: "x".repeat(40) });
  check("鍵が違えば 403", r.code === 403 && r.body.error === "forbidden");
  check("★ 鍵が違えば RTDB へ1往復も起こさない",
    GCALLS.get.length === 0 && GCALLS.patch.length === 0);
  check("鍵が違えば LINE も送らない", GCALLS.http.length === 0);
  r = await call({ action: "sweep" });
  check("鍵なしも 403", r.code === 403);
  check("応答に鍵の値を含めない", JSON.stringify(r.body).indexOf(KEY) < 0);

  // --- 端末0台（設定直後の確認に使う応答）---
  reset();
  r = await call({ action: "sweep", key: KEY });
  check("正しい鍵なら 200", r.code === 200 && r.body.ok === true);
  check("応答は件数だけ（端末トークン・座標・施設名を返さない）",
    r.body.devices === 0 && r.body.sent === 0 && r.body.confirmed === 0
    && JSON.stringify(r.body).indexOf("token") < 0
    && JSON.stringify(r.body).indexOf("lat") < 0);
  check("端末0台なら LINE を送らない", GCALLS.http.length === 0);
  check("鍵が通ったあとにレート制限を数える", GCALLS.patch.length >= 1);

  // --- ★ 本題: 沈黙した端末を、管理画面を開かずに確定させて LINE を送る ---
  reset();
  const now = Date.now();
  GDB["devmon/facilities"] = {};
  GDB["devmon/facilities"][fk] =
    { name: "ミュゲの泉", lat: 34.46, lng: 135.37, radiusM: 150, enabled: true };
  GDB["devmon/devices"] = {};
  GDB["devmon/devices"][DEV] = {
    fkey: fk, state: "pending", pendingSince: now - 200000,
    lastSeenAt: now - 200000, lastJudgedAt: now - 200000, createdAtMs: now - 900000,
  };
  r = await call({ action: "sweep", key: KEY });
  check("★ 管理画面を開かずに持ち出しを確定した",
    r.code === 200 && r.body.confirms === 1 && r.body.confirmed === 1);
  check("LINE を1通だけ送った", GCALLS.http.length === 1);
  const sentTo = GCALLS.http[0] ? GCALLS.http[0][0] : "";
  const sentBody = GCALLS.http[0] ? GCALLS.http[0][1] : "";
  check("送信先は既存の LINE Messaging API push",
    sentTo === "https://api.line.me/v2/bot/message/push");
  check("本文が持ち出し検知で、施設名が入る",
    sentBody.indexOf("持ち出し検知") > 0 && sentBody.indexOf("ミュゲの泉") > 0);
  const wrote = GCALLS.patch.filter(function (x) { return String(x[0]).indexOf("devices/" + DEV) >= 0; });
  // ★ 書き込みが無かったとき（＝期待が崩れたとき）に TypeError で落ちないようにする。
  //   落ちると以降のアサーションが走らず、他の回帰まで隠れる。
  const w0 = (wrote[0] && wrote[0][1]) || {};
  check("確定を書き込んだ（state / pendingSince / notifiedAt）",
    wrote.length === 1 && w0.state === "outside"
    && w0.pendingSince === null && Number(w0.notifiedAt) > 0);
  // ★ 送信成功のあとに書く（先に書くと、巻き戻し失敗でアラートが完全に失われる）
  check("送信より後に確定を書く（取り逃しを作らない）", Object.keys(w0).length === 3);

  // --- 同一持ち出し中は、毎分叩いても2通目を出さない ---
  // ★ 実装が**実際に書いた差分だけ**を適用する（期待値を上から流し込まない）。
  //   確定を書けていなければ、次のスイープが再送して下の check が FAIL する＝それが正しい信号。
  Object.assign(GDB["devmon/devices"][DEV], w0);
  GCALLS.http.length = 0;
  for (let i = 0; i < 5; i++) await call({ action: "sweep", key: KEY });
  check("★ 同一持ち出し中は何回叩いても LINE を送らない", GCALLS.http.length === 0);

  // --- 範囲内へ戻ったあとの再持ち出しでは再通知する ---
  GDB["devmon/devices"][DEV] = {
    fkey: fk, state: "pending", pendingSince: now + 600000,
    lastSeenAt: now + 600000, lastJudgedAt: now + 600000, createdAtMs: now - 900000,
    notifiedAt: now,                        // 前回の持ち出しの通知（これより継続が新しい）
  };
  GCALLS.http.length = 0;
  r = await call({ action: "sweep", key: KEY }, {});
  // ★ pendingSince が未来なので、この時点ではまだ確定しない
  check("再持ち出しの直後は確定しない", GCALLS.http.length === 0 && r.body.confirms === 0);
  GDB["devmon/devices"][DEV].pendingSince = now - 300000;
  GDB["devmon/devices"][DEV].lastSeenAt = now - 300000;
  GDB["devmon/devices"][DEV].lastJudgedAt = now - 300000;
  GDB["devmon/devices"][DEV].notifiedAt = now - 900000;   // 前回通知は今の継続より古い
  r = await call({ action: "sweep", key: KEY });
  check("★ 復帰後の再持ち出しでは再通知する",
    GCALLS.http.length === 1 && r.body.confirmed === 1);

  // --- 監視OFF・基準位置未設定では通知しない（フェイルクローズ）---
  GDB["devmon/facilities"][fk].enabled = false;
  GDB["devmon/devices"][DEV] = {
    fkey: fk, state: "pending", pendingSince: now - 400000,
    lastSeenAt: now - 400000, lastJudgedAt: now - 400000, createdAtMs: now - 900000,
  };
  GCALLS.http.length = 0;
  r = await call({ action: "sweep", key: KEY });
  check("監視OFFの施設は確定しない", GCALLS.http.length === 0 && r.body.confirms === 0);
  GDB["devmon/facilities"][fk] = { name: "ミュゲの泉", enabled: true, radiusM: 150 };
  r = await call({ action: "sweep", key: KEY });
  check("基準位置が未設定の施設は確定しない", GCALLS.http.length === 0 && r.body.confirms === 0);

  // --- ★ LINE は送れたが確定の書き込みだけが失敗したときに、毎分再送しないこと ---
  //   持ち出し検知は「送信できてから確定を書く」＝取り逃しより重複を選ぶ設計なので、
  //   書き込みだけが失敗すると sweepPlan の抑止条件が変わらず、次のスイープが送り直す。
  //   定期実行が1分間隔なので、放置すると1端末あたり1,440通/日になりうる。
  //   LINE の push 枠は朝の未打刻通知と同じなので、枠を食い潰すと業務通知まで沈黙する。
  {
    reset();
    const t = Date.now();
    GDB["devmon/facilities"] = {};
    GDB["devmon/facilities"][fk] =
      { name: "ミュゲの泉", lat: 34.46, lng: 135.37, radiusM: 150, enabled: true };
    GDB["devmon/devices"] = {};
    GDB["devmon/devices"][DEV] = {
      fkey: fk, state: "pending", pendingSince: t - 200000,
      lastSeenAt: t - 200000, lastJudgedAt: t - 200000, createdAtMs: t - 900000,
    };
    // 端末レコードへの書き込みだけを失敗させる（レート制限のカウンタは成功させる）
    GFAIL.patchIf = function (p) { return p.indexOf("devmon/devices/") >= 0; };
    // ★ 意図的に失敗させるので、実装の console.error でテスト出力が埋まらないよう一時的に黙らせる。
    //   （実装のログ出力そのものは変えていない。この区間を抜けたら必ず戻す。）
    const _err = console.error;
    console.error = function () {};
    try {
    let rr = await call({ action: "sweep", key: KEY });
    check("確定が書けなくても LINE は送る（取り逃しを作らない）",
      rr.code === 200 && GCALLS.http.length === 1);
    check("確定が書けていないので state は pending のまま",
      String(GDB["devmon/devices"][DEV].state) === "pending");

    // ★ 次のスイープ（1分後に相当）。同じ継続なので LINE を送り直してはならない。
    GCALLS.http.length = 0;
    rr = await call({ action: "sweep", key: KEY });
    check("★ 同じ継続の持ち出しを毎分送り直さない", GCALLS.http.length === 0);
    check("送らないだけで、確定の書き込みはやり直す",
      GCALLS.patch.filter(function (x) { return String(x[0]).indexOf("devmon/devices/") >= 0; }).length >= 2);
    for (let i = 0; i < 20; i++) await call({ action: "sweep", key: KEY });
    check("★ 20回叩いても送り直さない（LINE の枠を食い潰さない）", GCALLS.http.length === 0);

    // ★ ただし**別の持ち出し**（pendingSince が違う）は必ず通す。
    //   抑止のキーを deviceId だけにすると、復帰後の再持ち出しを取りこぼす。
    GDB["devmon/devices"][DEV].pendingSince = t - 600000;
    GDB["devmon/devices"][DEV].lastJudgedAt = t - 600000;
    GDB["devmon/devices"][DEV].lastSeenAt = t - 600000;
    GCALLS.http.length = 0;
    rr = await call({ action: "sweep", key: KEY });
    check("★ 別の持ち出し（継続が違う）は抑止しない", GCALLS.http.length === 1);

    // 書き込みが復活したら確定できる
    GFAIL.patchIf = null;
    GDB["devmon/devices"][DEV].pendingSince = t - 900000;
    GDB["devmon/devices"][DEV].lastJudgedAt = t - 900000;
    GDB["devmon/devices"][DEV].lastSeenAt = t - 900000;
    GCALLS.http.length = 0;
    rr = await call({ action: "sweep", key: KEY });
    check("書き込みが復活すれば確定できる",
      GCALLS.http.length === 1 && rr.body.confirmed === 1);

    // ★★ LINE の**送信が失敗した**ときは抑止してはならない。抑止すると、
    //   そのインスタンスが生きているあいだ通知が出ず＝取り逃しになる。
    //   （抑止して良いのは「既に届いた同一内容」だけ。）
    GFAIL.httpStatus = 500;
    GDB["devmon/devices"][DEV] = {
      fkey: fk, state: "pending", pendingSince: t - 1200000,
      lastSeenAt: t - 1200000, lastJudgedAt: t - 1200000, createdAtMs: t - 1800000,
    };
    GCALLS.http.length = 0;
    rr = await call({ action: "sweep", key: KEY });
    check("送信が失敗したら確定しない", GCALLS.http.length === 1 && rr.body.confirmed === 0);
    check("送信が失敗したら state は pending のまま",
      String(GDB["devmon/devices"][DEV].state) === "pending");
    GFAIL.httpStatus = 200;
    GCALLS.http.length = 0;
    rr = await call({ action: "sweep", key: KEY });
    check("★ 送信が失敗した持ち出しは、次のスイープで必ず送り直す（取り逃さない）",
      GCALLS.http.length === 1 && rr.body.confirmed === 1);

    } finally {
      // ★ ここを straight-line にしてはならない。区間内で例外が出たときに console.error が
      //   差し替わったまま残り、末尾の .catch のエラー表示まで飲まれて原因が見えなくなる。
      GFAIL.patchIf = null;
      GFAIL.httpStatus = 0;
      console.error = _err;
    }
  }

  // --- 他 action への影響（鍵で端末認証を迂回できない）---
  reset();
  r = await call({ action: "nope", key: KEY });
  check("未知の action は 400 bad_action", r.code === 400 && r.body.error === "bad_action");
  r = await call({ action: "report", deviceId: DEV, deviceToken: KEY });
  check("★ sweep の鍵で report は通らない（端末トークンが必要）", r.code === 403);
  r = await call({ action: "register", code: "AAAAAAAA", key: KEY });
  check("★ sweep の鍵で register も通らない", r.code === 403);
  check("register / report で LINE は送られない", GCALLS.http.length === 0);
}

// ===== 結果 =====
exitMemSection()
  .then(function () { return devwatchUiSection(); })
  .then(function () { return devReportHandlerSection(); }).then(function () {
  console.log("\n====================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("====================================");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error("[ERROR]", e && e.message);
  process.exit(1);
});
