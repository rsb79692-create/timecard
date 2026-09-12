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

  // ===== 結果 =====
  console.log("\n====================================");
  console.log("  PASS " + pass + " / FAIL " + fail);
  console.log("====================================");
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error("[ERROR]", e && e.message);
  process.exit(1);
});
