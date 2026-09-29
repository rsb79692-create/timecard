#!/usr/bin/env node
/**
 * test-face-photo.js — 打刻時の顔撮影（スタッフ別ON/OFF）の回帰テスト
 *
 * ★ 依存パッケージなし・送信なし・本番データ非アクセス・カメラも使わない。
 *
 * 固定する仕様:
 *   1. 既定は OFF。`facePhoto === true` のときだけ ON（未設定・null・"false"・"true"・0・1 は OFF）
 *   2. 撮影するのは出勤・退勤だけ（休憩・施設変更では撮影しない）
 *   3. スタッフテスト画面（sandbox）・管理者デモ・閲覧用URLでは撮影しない
 *   4. 撮影した画像を保存も送信もしない
 *      （fetch / localStorage / IndexedDB / Cache / Blob / dataURL を一切使わない）
 *   5. 撮影後にキャンバスを消し、カメラのトラックを停止する
 *   6. カメラが使えない・拒否された場合も例外を投げず、打刻を止めない
 *   7. 打刻処理の結線: 端末保存の成功後・送信前に非同期で呼ばれ、await していない
 *   8. 勝手に ON へ移行する処理が無い（true を書くのはチェックONの分岐だけ）
 *
 * 実行: node scripts/test-face-photo.js
 * 終了コード: 0=全PASS / 1=FAILあり
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}
function section(t) { console.log("\n── " + t + " ──"); }

// ===== 対象ブロックの抽出 =====
const BEGIN = "// ===== FACECAM-BEGIN =====";
const END = "// ===== FACECAM-END =====";
const bi = html.indexOf(BEGIN), ei = html.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error("[ERROR] FACECAM ブロックを index.html から抽出できません");
  process.exit(1);
}
const CODE = html.slice(bi + BEGIN.length, ei);

/**
 * コメントを落としたコード本体。ソース走査はこちらに対して行う。
 * ★ 説明文に禁止APIの名前が出てくるのは当然なので、コメントまで含めて走査すると
 *   「説明を書いたら FAIL する」テストになってしまう。見るのは実際のコードだけ。
 * ★ 単純な除去（ブロックコメントと // 以降）。この区間の文字列に "//" は含まれない。
 */
const CODE_NC = CODE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===== スタブ =====

function mkTrack() { return { stopped: false, stop() { this.stopped = true; } }; }

function mkCanvas(rec) {
  const ctx = {
    drawn: 0, cleared: 0,
    drawImage() { this.drawn++; rec.drawn++; },
    clearRect() { this.cleared++; rec.cleared++; },
  };
  return {
    width: 0, height: 0,
    getContext() { return ctx; },
    // ★ 呼ばれたら即 FAIL にする（画像を残せる形へ変換していないことの証明）
    toDataURL() { rec.forbidden.push("toDataURL"); throw new Error("toDataURL must not be used"); },
    toBlob() { rec.forbidden.push("toBlob"); throw new Error("toBlob must not be used"); },
    _ctx: ctx,
  };
}

function mkVideo(rec) {
  return {
    videoWidth: 640, videoHeight: 480, readyState: 4,
    srcObject: "unset", removed: false,
    setAttribute() {}, addEventListener() {},
    play() { return Promise.resolve(); },
    remove() { this.removed = true; rec.videoRemoved = true; },
  };
}

function mkElement() {
  const el = {
    id: "", textContent: "", children: [], parentNode: null,
    style: { cssText: "" },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    setAttribute() {}, addEventListener() {}, remove() {},
  };
  return el;
}

function throwingProxy(label, rec) {
  return new Proxy({}, {
    get() { rec.forbidden.push(label); throw new Error(label + " must not be used"); },
    set() { rec.forbidden.push(label); throw new Error(label + " must not be used"); },
  });
}

function makeCtx(opts) {
  opts = opts || {};
  const rec = { drawn: 0, cleared: 0, forbidden: [], videoRemoved: false };
  const body = mkElement();
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Error,
    setTimeout, clearTimeout,
    document: { createElement: () => mkElement(), body: body },
    navigator: opts.navigator !== undefined ? opts.navigator
      : { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
    // ★ 使われたら例外になる。撮影経路がこれらへ触れないことを機械的に固定する。
    fetch: () => { rec.forbidden.push("fetch"); throw new Error("fetch must not be used"); },
    authFetch: () => { rec.forbidden.push("authFetch"); throw new Error("authFetch must not be used"); },
    localStorage: throwingProxy("localStorage", rec),
    indexedDB: throwingProxy("indexedDB", rec),
    caches: throwingProxy("caches", rec),
    Blob: function () { rec.forbidden.push("Blob"); throw new Error("Blob must not be used"); },
    FormData: function () { rec.forbidden.push("FormData"); throw new Error("FormData must not be used"); },
    XMLHttpRequest: function () { rec.forbidden.push("XHR"); throw new Error("XHR must not be used"); },
    URL: { createObjectURL: () => { rec.forbidden.push("createObjectURL"); throw new Error("no"); } },
  };
  if (opts.globals) Object.assign(sandbox, opts.globals);
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  sandbox.__rec = rec;
  sandbox.__body = body;
  return sandbox;
}

// ===== 1. 既定 OFF =====
section("1. 既定は OFF（facePhoto === true だけが ON）");
{
  const c = makeCtx();
  const F = c.faceCamStaffEnabled;
  check("undefined は OFF", F({ name: "a" }) === false);
  check("null は OFF", F({ name: "a", facePhoto: null }) === false);
  check("false は OFF", F({ name: "a", facePhoto: false }) === false);
  check('文字列 "false" は OFF', F({ name: "a", facePhoto: "false" }) === false);
  check('文字列 "true" は OFF（真偽値以外を ON にしない）', F({ name: "a", facePhoto: "true" }) === false);
  check("数値 1 は OFF", F({ name: "a", facePhoto: 1 }) === false);
  check("数値 0 は OFF", F({ name: "a", facePhoto: 0 }) === false);
  check("スタッフ自体が null なら OFF", F(null) === false);
  check("true だけが ON", F({ name: "a", facePhoto: true }) === true);
}

// ===== 2/3. 撮影条件 =====
section("2/3. 撮影する打刻種別と画面の条件");
{
  const c = makeCtx();
  const S = c.faceCamShouldCapture;
  const on = { name: "a", facePhoto: true };
  const env = {
    writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false, hasCamera: true,
  };
  check("出勤は撮影する", S("clockIn", on, env) === true);
  check("退勤は撮影する", S("clockOut", on, env) === true);
  check("休憩開始は撮影しない", S("breakStart", on, env) === false);
  check("休憩終了は撮影しない", S("breakEnd", on, env) === false);
  check("施設変更は撮影しない", S("facilityChange", on, env) === false);
  check("OFFのスタッフは撮影しない", S("clockIn", { name: "a" }, env) === false);
  check("sandbox では撮影しない",
    S("clockIn", on, Object.assign({}, env, { writePolicy: "sandbox" })) === false);
  check("閲覧用URLでは撮影しない",
    S("clockIn", on, Object.assign({}, env, { viewerMode: true })) === false);
  check("管理者デモでは撮影しない",
    S("clockIn", on, Object.assign({}, env, { demoMode: true })) === false);
  check("スタッフデモでは撮影しない",
    S("clockIn", on, Object.assign({}, env, { staffDemoMode: true })) === false);
  check("カメラが無い端末では撮影しない",
    S("clockIn", on, Object.assign({}, env, { hasCamera: false })) === false);
}

// ===== 4/5/6. 撮影と破棄 =====
section("4/5/6. 1枚撮影 → 即破棄（保存・送信をしない）");
(async function () {
  {
    const c = makeCtx();
    const rec = c.__rec;
    const track = mkTrack();
    let canvas = null, video = null;
    const r = await c.faceCamCaptureOnce({
      getUserMedia: () => Promise.resolve({ getTracks: () => [track] }),
      makeVideo: () => (video = mkVideo(rec)),
      makeCanvas: () => (canvas = mkCanvas(rec)),
      waitFrame: () => Promise.resolve(),
    });
    check("撮影に成功する", r && r.ok === true);
    check("描画は1回だけ（1枚）", rec.drawn === 1);
    check("撮影後にキャンバスを消している", rec.cleared >= 1);
    check("キャンバスの大きさを 0 にしている", canvas.width === 0 && canvas.height === 0);
    check("カメラのトラックを停止している", track.stopped === true);
    check("video の srcObject を外している", video.srcObject === null);
    check("video を DOM から外している", video.removed === true);
    check("禁止APIへ触れていない（保存・送信なし）", rec.forbidden.length === 0);
  }

  // 権限拒否
  {
    const c = makeCtx();
    const rec = c.__rec;
    let threw = false, r = null;
    try {
      r = await c.faceCamCaptureOnce({
        getUserMedia: () => Promise.reject(new Error("NotAllowedError")),
        makeVideo: () => mkVideo(rec), makeCanvas: () => mkCanvas(rec),
        waitFrame: () => Promise.resolve(),
      });
    } catch (e) { threw = true; }
    check("カメラ拒否で例外を投げない", threw === false);
    check("カメラ拒否は ok:false を返す", r && r.ok === false);
  }

  // getUserMedia が無い環境
  {
    const c = makeCtx();
    const r = await c.faceCamCaptureOnce({});
    check("getUserMedia が無い環境は ok:false", r && r.ok === false && r.reason === "unsupported");
  }

  // 途中で例外が出てもトラックは止める
  {
    const c = makeCtx();
    const rec = c.__rec;
    const track = mkTrack();
    const r = await c.faceCamCaptureOnce({
      getUserMedia: () => Promise.resolve({ getTracks: () => [track] }),
      makeVideo: () => mkVideo(rec),
      makeCanvas: () => { throw new Error("boom"); },
      waitFrame: () => Promise.resolve(),
    });
    check("描画前に失敗しても ok:false", r && r.ok === false);
    check("失敗時もカメラのトラックを停止する", track.stopped === true);
  }

  // OFF のスタッフでは撮影処理そのものが始まらない（オーバーレイも出ない）
  {
    const c = makeCtx({
      globals: {
        staffList: [{ name: "山田 太郎" }],   // facePhoto 未設定 = OFF
        staffName: "山田 太郎",
        writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false,
      },
    });
    c.faceCamAfterPunch("clockIn");
    check("OFFのスタッフでは撮影表示を出さない", c.__body.children.length === 0);
  }
  {
    const c = makeCtx({
      globals: {
        staffList: [{ name: "山田 太郎", facePhoto: true }],
        staffName: "山田 太郎",
        writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false,
      },
    });
    c.faceCamAfterPunch("clockIn");
    // ★ 上端の開示ストリップ＋下端のプレビュー箱の2つ（プレビューは収まらないとき 1x1 になる）
    check("ONのスタッフでは撮影表示を出す", c.__body.children.length === 2);
    c.faceCamClose();
    check("閉じると表示を取り除く", c.__body.children.length === 0);
  }
  {
    const c = makeCtx({
      globals: {
        staffList: [{ name: "山田 太郎", facePhoto: true }],
        staffName: "山田 太郎",
        writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false,
      },
    });
    c.faceCamAfterPunch("breakStart");
    check("休憩では撮影表示を出さない", c.__body.children.length === 0);
  }

  // ===== 4c. 連続打刻での再入 =====
  section("4c. 連続打刻でカメラを二重に起こさない");
  {
    let opened = 0;
    const track = mkTrack();
    const c = makeCtx({
      globals: {
        staffList: [{ name: "山田 太郎", facePhoto: true }],
        staffName: "山田 太郎",
        writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false,
      },
      navigator: {
        mediaDevices: {
          getUserMedia: function () {
            opened++;
            // 応答しないカメラ（権限ダイアログが出たまま）を模す
            return new Promise(function () {});
          },
        },
      },
    });
    c.faceCamAfterPunch("clockIn");
    c.faceCamAfterPunch("clockOut");   // 続けて押す
    check("連続して押してもカメラは1回だけ起こす", opened === 1);
    check("表示も1組だけ（開示＋プレビュー）", c.__body.children.length === 2);

    // 表示を閉じても、撮影が飛行中なら次の撮影を始めない
    c.faceCamClose();
    c.faceCamAfterPunch("clockIn");
    check("撮影が飛行中のあいだは次の撮影を始めない", opened === 1);
  }
  {
    // 表示を閉じるとき、飛行中のカメラも止める
    const track = mkTrack();
    let resolveGum = null;
    const c = makeCtx({
      globals: {
        staffList: [{ name: "山田 太郎", facePhoto: true }],
        staffName: "山田 太郎",
        writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false,
      },
      navigator: {
        mediaDevices: {
          getUserMedia: function () {
            return new Promise(function (r) { resolveGum = r; });
          },
        },
      },
    });
    c.faceCamAfterPunch("clockIn");
    resolveGum({ getTracks: function () { return [track]; } });
    await new Promise(function (r) { setTimeout(r, 5); });
    c.faceCamClose();
    check("表示を閉じたらカメラを止める", track.stopped === true);
  }

  // ===== 4d. 表示の位置と寿命 =====
  section("4d. 表示の位置と寿命");
  {
    check("画面中央に置かない（打刻完了と打刻時刻を覆わない）",
      CODE.indexOf("top:50%") < 0 && CODE.indexOf("faceCamBottomPx()") > 0);
    // ★ 幅を明示しないと、left:50% で利用可能幅がビューポートの50%に制限され、
    //   文言が折り返して背が高くなり、下端へ置いても打刻時刻へ届いてしまう。
    check("幅を明示して背を低く保つ",
      CODE.indexOf("width:264px") > 0 && CODE.indexOf("max-width:calc(100vw - 24px)") > 0);
    check("更新バナーの高さぶん持ち上げる（開示文が隠れない）",
      CODE.indexOf("app-update-banner") > 0 && CODE.indexOf("offsetHeight") > 0);
    // ★★ 開示は画面**上端**の固定ストリップで出す。
    //   下端は更新バナーと打刻時刻に挟まれて安全な位置が無く、本文（流し込み）は
    //   打刻完了ブロック自体が 320px の可視高を超えるため画面外へ押し出される。
    //   上端なら覆うのは「← もどる」だけである。
    check("開示は上端の固定ストリップで出す",
      CODE.indexOf("facecam-strip") > 0 && CODE.indexOf("top:0") > 0
      && CODE.indexOf("FACECAM_STRIP_BEFORE") > 0);
    check("開示文に撮影理由（管理者設定）が入る",
      CODE.indexOf("管理者設定により撮影") > 0);
    check("撮影の成否を開示文へ反映する（render を待たない）",
      CODE.indexOf("FACECAM_STRIP_OK") > 0 && CODE.indexOf("FACECAM_STRIP_NG") > 0
      && CODE.indexOf("_faceCam.strip.textContent") > 0);
    check("ストリップは操作をふさがない", CODE.indexOf("pointer-events:none") > 0);
    check("閉じるときにストリップも取り除く",
      CODE.indexOf("_faceCam.strip.parentNode.removeChild") > 0);
    // ★ プレビューは打刻時刻の行より下に収まるときだけ
    check("プレビューの基準は打刻時刻の行",
      CODE.indexOf("punch-time-line") > 0 && CODE.indexOf("function faceCamHasRoom") > 0);
    check("打刻時刻の行に基準の id を付けている", html.indexOf('id="punch-time-line"') > 0);
    check("基準が取れないならプレビューを出さない（安全側）",
      CODE.indexOf("if(!a||!a.getBoundingClientRect)return false;") > 0);
    check("本文へ開示文を流し込む方式はやめた（画面外へ押し出されるため）",
      html.indexOf("facecam-notice") < 0);
    check("固まった撮影は一定時間で解除する（以後撮影されないままにしない）",
      CODE.indexOf("FACECAM_BUSY_MAX_MS") > 0 && CODE.indexOf("_faceCam.busyAt") > 0);
    check("ホームへ戻る操作でも表示を閉じる",
      /function goHome\(\)\{\s*\n\s*faceCamClose\(\);/.test(html));
    const showMs = Number((CODE.match(/FACECAM_SHOW_MS=(\d+)/) || [])[1] || 0);
    const maxMs = Number((CODE.match(/FACECAM_MAX_MS=(\d+)/) || [])[1] || 0);
    check("表示は打刻後の画面遷移（1500ms）より短い", showMs > 0 && showMs < 1500);
    check("固まっても必ず閉じる上限がある", maxMs > showMs && maxMs <= 3000);
    check("画面がホームへ戻る時点で表示を閉じる",
      /faceCamClose\(\);\s*\n\s*punchMsg=null;staffName=null;/.test(html));
  }

  // ===== 4b. ソース走査 =====
  section("4b. 撮影ブロックが保存・送信の手段を持たない");
  const forbidden = [
    "authFetch", "localStorage", "sessionStorage", "indexedDB", "caches",
    "toDataURL", "toBlob", "new Blob", "FormData", "XMLHttpRequest",
    "createObjectURL", "captureStream", "MediaRecorder",
  ];
  forbidden.forEach(function (w) {
    check("FACECAM に " + w + " が無い", CODE_NC.indexOf(w) < 0);
  });
  check("FACECAM に fetch( が無い", !/[^a-zA-Z]fetch\s*\(/.test(CODE_NC));
  check("FACECAM に saveRecord / punchOutbox への書き込みが無い",
    CODE_NC.indexOf("saveRecord") < 0 && CODE_NC.indexOf("punchOutboxCommit") < 0);

  // ===== 7. 打刻処理の結線 =====
  section("7. 打刻処理の結線");
  const execIdx = html.indexOf("async function _execPunch");
  const execEnd = html.indexOf("function doPunch(", execIdx);
  const exec = html.slice(execIdx, execEnd);
  check("_execPunch から faceCamAfterPunch を呼んでいる", /faceCamAfterPunch\(type\)/.test(exec));
  check("faceCamAfterPunch を await していない（打刻を待たせない）",
    !/await\s+faceCamAfterPunch/.test(exec));
  const iPush = exec.indexOf("records.push(nr)");
  const iFace = exec.indexOf("faceCamAfterPunch(type)");
  const iFlush = exec.indexOf('punchOutboxFlush("punch")');
  check("端末保存の成功後に呼んでいる", iPush > 0 && iFace > iPush);
  check("送信より前に呼んでいる（送信をブロックしない位置）", iFlush > iFace);
  check("端末保存の失敗時は撮影へ進まない（return が先にある）",
    exec.indexOf("if(!_saved)") > 0 && exec.indexOf("if(!_saved)") < iFace);

  // ===== 8. 管理画面の結線と既定OFF =====
  section("8. スタッフ管理の結線（既定OFF・自動ONなし）");
  check("モーダルに打刻時の顔撮影のチェックボックスがある",
    html.indexOf('id="modal-face-photo"') > 0);
  check("モーダルの表示は faceCamStaffEnabled で判定している",
    /fpEl\.checked=faceCamStaffEnabled\(s\)/.test(html));
  check("既存スタッフの保存はチェックON時だけ true を書く",
    /if\(fpEl2&&fpEl2\.checked\)s\.facePhoto=true; else delete s\.facePhoto;/.test(html));
  check("新規スタッフの保存もチェックON時だけ true を書く",
    /if\(fpEl3&&fpEl3\.checked\)newStaff\.facePhoto=true;/.test(html));
  const trueWrites = (html.match(/facePhoto=true/g) || []).length;
  check("facePhoto=true を書くのはその2か所だけ（勝手にONへ移行しない）", trueWrites === 2);
  check("新規スタッフのオブジェクト初期値に facePhoto を入れていない",
    !/var newStaff=\{[^}]*facePhoto/.test(html));

  // ===== 9. 撮影の瞬間の演出（シャッター音・フラッシュ） =====
  section("9. 撮影の瞬間の演出（音・フラッシュ）");
  {
    // onShot は描画の直後に1回だけ呼ばれる（撮影の実タイミングと演出を一致させる）
    const c = makeCtx();
    const rec = c.__rec;
    let drawnAtShot = -1, shots = 0;
    const r = await c.faceCamCaptureOnce({
      getUserMedia: () => Promise.resolve({ getTracks: () => [mkTrack()] }),
      makeVideo: () => mkVideo(rec),
      makeCanvas: () => mkCanvas(rec),
      waitFrame: () => Promise.resolve(),
      onShot: (...a) => { shots++; drawnAtShot = rec.drawn; check("onShot へ何も渡さない（画像を渡さない）", a.length === 0); },
    });
    check("onShot は1回だけ呼ばれる", shots === 1);
    check("onShot は描画の直後に呼ばれる", drawnAtShot === 1);
    check("演出ありでも撮影は成功する", r && r.ok === true);
  }
  {
    // 演出が例外を投げても撮影結果と破棄は変わらない
    const c = makeCtx();
    const rec = c.__rec;
    const track = mkTrack();
    let canvas = null;
    const r = await c.faceCamCaptureOnce({
      getUserMedia: () => Promise.resolve({ getTracks: () => [track] }),
      makeVideo: () => mkVideo(rec),
      makeCanvas: () => (canvas = mkCanvas(rec)),
      waitFrame: () => Promise.resolve(),
      onShot: () => { throw new Error("fx failed"); },
    });
    check("演出の失敗で撮影結果を変えない", r && r.ok === true);
    check("演出の失敗でも破棄は行う", canvas.width === 0 && track.stopped === true);
  }
  {
    // 撮影に失敗したら演出しない（撮っていないのに音を鳴らさない）
    const c = makeCtx();
    let shots = 0;
    const r = await c.faceCamCaptureOnce({
      getUserMedia: () => Promise.reject(new Error("NotAllowedError")),
      makeVideo: () => mkVideo(c.__rec),
      makeCanvas: () => mkCanvas(c.__rec),
      onShot: () => { shots++; },
    });
    check("撮影失敗時は演出しない", r && r.ok === false && shots === 0);
  }
  {
    // 画面が戻った後（自分の表示が無い）には鳴らさない・光らせない
    const c = makeCtx({ globals: { window: {}, requestAnimationFrame: () => 0 } });
    c.faceCamShutterFx({ box: {} });
    check("表示中でないときは演出しない", c.__body.children.length === 0);
    // 表示中なら全画面フラッシュを出し、操作をふさがない。閉じるときに消す
    const ui = c.faceCamOpenOverlay();
    c.faceCamShutterFx(ui);
    const fl = c.__body.children.find((x) => x.id === "facecam-flash");
    check("表示中は全画面フラッシュを出す", !!fl);
    check("フラッシュは操作をふさがない", !!fl && /pointer-events:none/.test(fl.style.cssText));
    let threw = false;
    try { check("AudioContext が無い端末では音の準備を行わない", c.faceCamAudioPrime() === null); c.faceCamShutterSound(); }
    catch (e) { threw = true; }
    check("AudioContext が無い端末でも例外にならない", threw === false);
    c.faceCamClose();
    check("閉じるときにフラッシュも消す", !c.__body.children.some((x) => x.id === "facecam-flash"));
  }
  check("マイクは使わない（audio:false）", /audio:false/.test(CODE_NC) && !/audio:true/.test(CODE_NC));

  // ===== 10. 打刻画面のインカメラプレビュー（2026-09-30） =====
  section("10. 打刻画面のプレビュー（表示時に起動・打刻/離脱で停止・失敗でも打刻可）");
  // 打刻画面の枠（#facecam-slot）を持つ document の模擬。getUserMedia は呼ばれた回数とトラックを記録する。
  function makePv(opts) {
    opts = opts || {};
    const rec = { drawn: 0, cleared: 0, forbidden: [], videoRemoved: false, gum: 0, tracks: [] };
    const body = mkElement();
    const slot = mkElement(); slot.id = "facecam-slot";
    const docL = {}, winL = {};
    const doc = {
      body: body, visibilityState: "visible",
      createElement: (t) => t === "video" ? Object.assign(mkVideo(rec), mkElement(), { videoWidth: 640, videoHeight: 480, readyState: 4, srcObject: "unset", remove() { rec.videoRemoved = true; } })
        : t === "canvas" ? mkCanvas(rec) : mkElement(),
      getElementById: (id) => (id === "facecam-slot" && c.__slotOn) ? slot : null,
      addEventListener: (t, f) => { docL[t] = f; }
    };
    const gum = () => {
      rec.gum++;
      if (opts.deny) return Promise.reject(new Error("NotAllowedError"));
      const t = mkTrack(); rec.tracks.push(t);
      return Promise.resolve({ getTracks: () => [t] });
    };
    const c = makeCtx({ globals: {
      document: doc,
      window: { addEventListener: (t, f) => { winL[t] = f; } },
      navigator: { mediaDevices: { getUserMedia: gum } },
      staffList: [{ name: "a", facePhoto: true }, { name: "b" }], staffName: "a",
      screen: "punch", punchMsg: null,
      writePolicy: "full", viewerMode: false, demoMode: false, staffDemoMode: false
    } });
    c.__rec2 = rec; c.__slot = slot; c.__slotOn = true; c.__docL = docL; c.__winL = winL;
    return c;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  {
    const c = makePv();
    check("顔撮影ONのスタッフの打刻画面にだけ枠を出す", /id="facecam-slot"/.test(c.faceCamPreviewSlotHtml(true)));
    check("出勤・退勤を押せないときは枠を出さない", c.faceCamPreviewSlotHtml(false) === "");
    c.staffName = "b";
    check("顔撮影OFFのスタッフには枠を出さない", c.faceCamPreviewSlotHtml(true) === "");
    c.staffName = "a"; c.writePolicy = "sandbox";
    check("スタッフテスト画面では枠を出さない", c.faceCamPreviewSlotHtml(true) === "");
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    check("打刻画面を表示した時点でカメラを起動する", rec.gum === 1 && c._faceCam.pv && c._faceCam.pv.state === "live");
    check("プレビューを打刻ボタンの上の枠へ入れる", c.__slot.children.length === 1 && c.__slot.children[0].id === "facecam-preview");
    c.faceCamSyncPreview(); c.faceCamSyncPreview(); await flush();
    check("再描画してもカメラを起動し直さない", rec.gum === 1);
    // 打刻（出勤）→ プレビューの映像で撮り、カメラを止める
    c.punchMsg = "出勤 07:00:00"; c.__slotOn = false;
    c.faceCamSyncPreview();
    check("打刻完了の表示へ移った瞬間はまだ止めない（この直後に撮影する）", rec.tracks[0].stopped === false);
    c.faceCamAfterPunch("clockIn");
    await flush(); await flush(); await flush();
    check("打刻したらプレビューの映像で1枚撮る（カメラを起動し直さない）", rec.gum === 1 && rec.drawn === 1);
    check("撮影後にキャンバスを消している", rec.cleared >= 1);
    check("打刻完了時にカメラのトラックを停止する", rec.tracks[0].stopped === true);
    check("撮影後に映像の要素を外す", rec.videoRemoved === true && c._faceCam.pv === null);
    check("プレビュー経由でも禁止APIへ触れていない（保存・送信なし）", rec.forbidden.length === 0);
    c.faceCamClose();
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c.screen = "home"; c.__slotOn = false; c.faceCamSyncPreview();
    check("打刻画面を離れたらカメラを停止する", rec.tracks[0].stopped === true && c._faceCam.pv === null);
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c.faceCamClose();
    check("ホームへ戻る（faceCamClose）でカメラを停止する", rec.tracks[0].stopped === true && c._faceCam.pv === null);
    c.faceCamSyncPreview(); await flush();
    c.faceCamClose(true);
    check("撮影直前の表示の作り直し（faceCamClose(true)）ではプレビューを残す", rec.tracks[1].stopped === false && !!c._faceCam.pv);
    c.faceCamClose();
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c.document.visibilityState = "hidden"; c.__docL.visibilitychange();
    check("タブが裏へ回ったらカメラを停止する", rec.tracks[0].stopped === true && c._faceCam.pv === null);
    c.document.visibilityState = "visible"; c.__docL.visibilitychange(); await flush();
    check("表示に戻ったらプレビューを再開する", rec.gum === 2 && c._faceCam.pv && c._faceCam.pv.state === "live");
    c.__winL.pagehide();
    check("ページを離れたらカメラを停止する", rec.tracks[1].stopped === true && c._faceCam.pv === null);
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c.punchMsg = "休憩開始"; c.__slotOn = false; c.faceCamSyncPreview();
    c.faceCamAfterPunch("breakStart");
    check("撮影しない打刻（休憩）でもカメラを停止する", rec.tracks[0].stopped === true && rec.drawn === 0 && c._faceCam.pv === null);
  }
  {
    const c = makePv({ deny: true }); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    check("カメラを拒否されたらプレビューは失敗表示にする", c._faceCam.pv && c._faceCam.pv.state === "failed");
    const m = c._faceCam.pv && c._faceCam.pv.msg;
    check("失敗時は枠の中に「使用できません／打刻はそのまま行えます」を見える状態で出す",
      !!m && m.style.display === "flex" && /使用できません/.test(m.textContent) && /打刻はそのまま行えます/.test(m.textContent));
    let threw = false;
    try { c.punchMsg = "出勤"; c.__slotOn = false; c.faceCamSyncPreview(); c.faceCamAfterPunch("clockIn"); } catch (e) { threw = true; }
    await flush(); await flush();
    check("カメラ取得に失敗しても打刻処理へ例外を返さない（打刻は成立する）", threw === false && rec.drawn === 0);
    c.faceCamClose();
  }
  // ── 指摘で足したもの（遅れて届いたカメラ・再入ガード・起動中の打刻・放置・映像の途切れ・撮影時の DOM）──
  {
    // 許可ダイアログを待つ間に画面を離れた → 後から届いたカメラはその場で止める
    let resolveGum = null; const t = mkTrack();
    const c = makePv(); c.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { resolveGum = r; });
    c.faceCamSyncPreview();
    c.screen = "home"; c.__slotOn = false; c.faceCamSyncPreview();
    resolveGum({ getTracks: () => [t] }); await flush(); await flush();
    check("許可を待つ間に画面を離れたら、後から届いたカメラをその場で止める", t.stopped === true && c._faceCam.pv === null);
  }
  {
    // 撮影中（running）に次の打刻 → 撮らずに抜けるときもプレビューのカメラを止める
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c._faceCam.running = true;
    c.punchMsg = "退勤"; c.__slotOn = false; c.faceCamSyncPreview();
    c.faceCamAfterPunch("clockOut");
    check("撮影中の再入で撮らないときもプレビューのカメラを止める", rec.tracks[0].stopped === true && rec.drawn === 0);
    c._faceCam.running = false; c.faceCamClose();
  }
  {
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c._faceCam.busy = true; c._faceCam.busyAt = Date.now();
    c.punchMsg = "退勤"; c.__slotOn = false; c.faceCamSyncPreview();
    c.faceCamAfterPunch("clockOut");
    check("撮影が飛行中（busy）で撮らないときもプレビューのカメラを止める", rec.tracks[0].stopped === true && rec.drawn === 0);
    c._faceCam.busy = false; c.faceCamClose();
  }
  {
    // プレビューの起動中に打刻 → プレビューを止め、従来どおりその場でカメラを起動して1回だけ撮る
    let resolveGum = null; const t = mkTrack();
    const c = makePv(); const rec = c.__rec2; const gum0 = c.navigator.mediaDevices.getUserMedia;
    c.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { resolveGum = r; });
    c.faceCamSyncPreview();
    c.navigator.mediaDevices.getUserMedia = gum0;
    c.punchMsg = "出勤"; c.__slotOn = false; c.faceCamSyncPreview();
    c.faceCamAfterPunch("clockIn");
    resolveGum({ getTracks: () => [t] });
    await flush(); await flush(); await flush();
    check("プレビュー起動中の打刻は従来どおりその場で1回撮り、遅れて届いたプレビューのカメラは止める",
      rec.drawn === 1 && rec.gum === 1 && rec.tracks[0].stopped === true && t.stopped === true);
    c.faceCamClose();
  }
  {
    // 放置したら一時停止し、画面に触れたら再開する
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    c._faceCamLastInput = Date.now() - c.FACECAM_PV_IDLE_MS - 1;
    c.faceCamPreviewIdleCheck();
    check("操作が無いまま一定時間たったらカメラを一時停止する", rec.tracks[0].stopped === true && c._faceCam.pv === null && c._faceCam.pvIdle === true);
    check("一時停止中は枠に一時停止の表示を出す", c.__slot.children.some((x) => x.id === "facecam-idle"));
    // ボタン（打刻・もどる）を押したときは再開しない（その操作で画面が変わる。カメラを二重に取りにいかない）
    c.__docL.pointerdown({ target: { closest: (sel) => /button/.test(sel) ? {} : null } }); await flush();
    check("一時停止中に打刻ボタン等を押しても、その操作ではカメラを再開しない", rec.gum === 1 && c._faceCam.pvIdle === true);
    c.__docL.pointerdown({ target: { closest: () => null } }); await flush();
    check("画面に触れたらカメラを再開する", rec.gum === 2 && c._faceCam.pv && c._faceCam.pv.state === "live" && c._faceCam.pvIdle === false);
    check("再開したら一時停止の表示を取り除く（枠が伸びて打刻ボタンがずれない）",
      c.__slot.children.length === 1 && c.__slot.children[0].id === "facecam-preview");
    c.faceCamClose();
  }
  {
    // 映像が途中で止まった（他のアプリに取られた等）→ 「使用できません」にする
    const c = makePv(); const rec = c.__rec2;
    let endedCb = null;
    c.navigator.mediaDevices.getUserMedia = () => { rec.gum++; const t = mkTrack(); t.addEventListener = (ev, f) => { if (ev === "ended") endedCb = f; }; rec.tracks.push(t); return Promise.resolve({ getTracks: () => [t] }); };
    c.faceCamSyncPreview(); await flush();
    endedCb && endedCb();
    check("映像が途中で止まったら「使用できません」に切り替える（撮れたことにしない）", c._faceCam.pv && c._faceCam.pv.state === "failed");
    c.faceCamClose();
  }
  {
    // 撮影するときは映像要素が画面上（非表示の枠）にある
    const c = makePv(); const rec = c.__rec2;
    c.faceCamSyncPreview(); await flush();
    const v = c._faceCam.pv.video;
    let attached = null;
    c.document.createElement = ((orig) => (t) => { const el = orig(t); if (t === "canvas") { const g = el.getContext(); const d0 = g.drawImage; g.drawImage = function (x) { attached = !!(x && x.parentNode); return d0.apply(this, arguments); }; } return el; })(c.document.createElement);
    c.punchMsg = "出勤"; c.__slotOn = false; c.faceCamSyncPreview();
    c.faceCamAfterPunch("clockIn"); await flush(); await flush(); await flush();
    check("撮影するとき映像要素を画面から外したままにしない（非表示の枠へ移す）", attached === true && rec.drawn === 1);
    c.faceCamClose();
  }
  {
    const iRender = html.indexOf("function render(){");
    const rsrc = html.slice(iRender, html.indexOf("}", iRender));
    check("render() のたびにプレビューを同期する（画面を離れたら止める）", /faceCamSyncPreview\(\)/.test(rsrc));
    const iSlot = html.indexOf("+faceCamPreviewSlotHtml(ci||co)");
    const iGrid = html.indexOf("+'<div class=\"grid2\">'", iSlot);
    check("プレビューの枠は打刻ボタン（grid2）の直前＝上に置く（ボタンへ重ねない）", iSlot > 0 && iGrid > iSlot && iGrid - iSlot < 200);
    // ── 大きなプレビュー（2026-09-30 変更。横幅いっぱい・高さ＝幅×3/4・説明文なし）──
    check("描画のたびにプレビューの大きさを決め直す", /faceCamFitPreview\(\);/.test(CODE_NC));
    check("プレビューは横幅いっぱい・4:3（小さなサムネイルの大きさを持たない）",
      /id="facecam-slot" style="width:100%;aspect-ratio:4\/3;/.test(html)
      && /FACECAM_PV_RATIO=0\.75/.test(CODE_NC) && !/96px;height:72px|64,48|48,36/.test(CODE_NC));
    check("ボタンが入らないときだけ高さを詰め、幅×0.56 より低くしない",
      /FACECAM_PV_MIN_RATIO=0\.56/.test(CODE_NC) && /Math\.max\(min,h-Math\.ceil\(over\)\)/.test(CODE_NC));
    const iEl = CODE_NC.indexOf("function faceCamPreviewEl(");
    const elSrc = CODE_NC.slice(iEl, CODE_NC.indexOf("\nfunction ", iEl + 10));
    check("プレビューの枠には説明文を出さない（映像だけ。カメラを使えないときの案内を除く）",
      // 画面に出る文字だけを見る（読み上げ用の aria-label は画面に出ないので除く）
      iEl > 0 && !/管理者設定|保存・送信|撮影しています/.test(elSrc.replace(/el\.setAttribute\("aria-label","[^"]*"\)/, ""))
      && /object-fit:cover/.test(elSrc));
    check("画面に出す説明文は無くても、読み上げ用の名前でカメラと理由を伝える（role=img・aria-label）",
      /setAttribute\("role","img"\)/.test(elSrc) && /aria-label","インカメラ映像（管理者設定により撮影/.test(elSrc));
    check("撮影時の開示（画面上端「管理者設定により撮影」）は残す",
      /FACECAM_STRIP_BEFORE="📷 管理者設定により撮影します/.test(CODE_NC) && /strip\.textContent=FACECAM_STRIP_BEFORE/.test(CODE_NC));
  }
  {
    // 大きさの決め方を実際に動かす（幅 317px＝360px 幅の画面の内側）
    const mk = (btnBottom, vh) => {
      const slot = { id: "facecam-slot", clientWidth: 317, style: {}, getBoundingClientRect: () => ({ width: 317 }) };
      const grid = { getBoundingClientRect: () => ({ bottom: btnBottom(slot) }) };
      const c = makeCtx({ globals: {
        document: { createElement: () => mkElement(), body: mkElement(), getElementById: (id) => id === "facecam-slot" ? slot : null, querySelector: (s) => s === ".grid2" ? grid : null, addEventListener() {} },
        window: { innerHeight: vh, scrollY: 0, addEventListener() {} }
      } });
      c.faceCamFitPreview();
      return parseInt(slot.style.height, 10);
    };
    // 余裕がある: 幅×3/4
    check("余裕があれば高さ＝幅×3/4（317→238px）", mk((s) => 214 + parseInt(s.style.height || 0, 10) + 206, 740) === 238);
    // 少し足りない: 足りない分だけ詰める
    const h2 = mk((s) => 214 + parseInt(s.style.height || 0, 10) + 206, 650);
    check("4つのボタンが入らないときは足りない分だけ詰める（650px の画面で 230px）", h2 === 230, "h=" + h2);
    // 大きく足りない（バナー等）: 幅×0.56 で止め、それ以上は小さくしない
    const h3 = mk((s) => 414 + parseInt(s.style.height || 0, 10) + 206, 650);
    check("大きく足りなくても幅×0.56（178px）より小さくしない（打刻履歴等は下へ出てよい）", h3 === 178, "h=" + h3);
  }

  // ===== 結果 =====
  console.log("\n====================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("====================================");
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error("[ERROR]", e && e.message);
  process.exit(1);
});
