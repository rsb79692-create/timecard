/**
 * 管理者URLトークンの「設定状態」判定のテスト（依存パッケージなし・送信なし）
 *
 * 実行: node scripts/test-admin-token-state.js
 *
 * 目的:
 *   取得失敗（通信断・401/403・5xx）や取得前の状態を「未設定」と表示しないこと、
 *   および取得成功時にだけ configured / unconfigured を断定することを固定する。
 *   2026-08 の認証移行前の実装は取得失敗の null をそのまま「未設定です」と表示しており、
 *   起動直後の一時的な失敗が「管理者PINが未設定です」の誤表示になっていた。
 *
 * 方式:
 *   index.html はビルドを持たない単一ファイルのため、該当ブロックだけを抜き出して
 *   vm コンテキストで評価し、authFetch をモックする。本番データへは一切アクセスしない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.html");
const START = "// ===== 管理者URLトークンの「設定状態」（表示専用。認証には一切使わない）=====";
const END = "var demoParam=new URLSearchParams";

const html = fs.readFileSync(SRC, "utf8");
const s = html.indexOf(START);
const e = html.indexOf(END, s);
if (s < 0 || e < 0) {
  console.error("ERROR: index.html から管理者トークン状態の判定ブロックを抽出できませんでした。");
  console.error("       index.html 側のマーカーコメントを変更した場合は、本テストの START/END も合わせてください。");
  process.exit(1);
}
const CODE = html.slice(s, e);

const PATHS = {
  set: "/config/adminTokenSet.json",
  hash: "/config/adminTokenHash.json",
  legacy: "/config/adminToken.json"
};

/** routes: {set|hash|legacy: {ok:true,value} | {ok:false,status} | {network:true}} */
function makeCtx(routes) {
  const timers = [];
  const ctx = {
    FB_URL: "https://example.invalid/honomi",
    ADMIN_TOKEN: "",
    ADMIN_TOKEN_SET: false,
    showPaidLeaveForm: false,
    _paidLeaveRenderGuard: false,
    monthlyDaysEditing: false,
    console: console,
    renderCount: 0,
    fetchCalls: 0,
    _timers: timers,
    render: function () { ctx.renderCount++; },
    esc: function (v) { return String(v); },
    maskToken: function (t) { return String(t).slice(0, 2) + "***"; },
    // 「再取得」ボタンだけ実体を返す（押下中の disabled 復元を検証するため）
    btn: { disabled: false, textContent: "再取得" },
    document: {
      querySelector: function () { return null; },
      getElementById: function (id) { return id === "btn-reload-admin-token-state" ? ctx.btn : null; }
    },
    setTimeout: function (fn) { const id = timers.length + 1; timers.push({ id: id, fn: fn }); return id; },
    clearTimeout: function (id) {
      const i = timers.findIndex(function (t) { return t.id === id; });
      if (i >= 0) timers.splice(i, 1);
    },
    authFetch: function (url) {
      ctx.fetchCalls++;
      const key = Object.keys(PATHS).find(function (k) { return url.endsWith(PATHS[k]); });
      const r = key ? routes[key] : null;
      if (!r || r.network) return Promise.reject(new Error("network error"));
      if (r.ok === false) {
        return Promise.resolve({ ok: false, status: r.status || 500, json: function () { return Promise.resolve(null); } });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(r.value); } });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return ctx;
}

/** 保留中の setTimeout を順に実行する（自動リトライの回数を数えるため） */
async function drainTimers(ctx, maxRounds) {
  let rounds = 0;
  while (ctx._timers.length && rounds < (maxRounds || 20)) {
    const t = ctx._timers.shift();
    rounds++;
    await t.fn();
    await new Promise(function (r) { setImmediate(r); });
  }
  return rounds;
}

const OK_NONE = { ok: true, value: null };   // 取得成功・ノード不在（＝本当に未設定）
const NET_FAIL = { network: true };          // 通信失敗
const HTTP_403 = { ok: false, status: 403 }; // 権限拒否
const HTTP_500 = { ok: false, status: 500 };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
}

async function main() {
  console.log("=== 管理者URLトークン設定状態: loading / configured / unconfigured / error ===\n");

  // 1. 正常時（設定済み）— 誤って「未設定」にしない
  {
    const ctx = makeCtx({ set: { ok: true, value: true }, hash: OK_NONE, legacy: OK_NONE });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("1. 設定済み → configured", ctx.adminTokenStatus === "configured", ctx.adminTokenStatus);
    check("1. ラベルが「設定済み（サーバ保管）」", ctx._adminTokenStateLabel() === "設定済み（サーバ保管）", ctx._adminTokenStateLabel());
  }

  // 2. 判定前（初期値）は loading であり「未設定」ではない
  {
    const ctx = makeCtx({ set: OK_NONE, hash: OK_NONE, legacy: OK_NONE });
    check("2. 初期状態は loading", ctx.adminTokenStatus === "loading", ctx.adminTokenStatus);
    check("2. loading のラベルに「未設定」を含まない", ctx._adminTokenStateLabel().indexOf("未設定") < 0, ctx._adminTokenStateLabel());
  }

  // 3. 取得が全件失敗（通信断）→ error。未設定と表示しない
  {
    const ctx = makeCtx({ set: NET_FAIL, hash: NET_FAIL, legacy: NET_FAIL });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("3. 通信失敗 → error", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
    check("3. ラベルに「未設定」を含まない", ctx._adminTokenStateLabel().indexOf("未設定") < 0, ctx._adminTokenStateLabel());
    check("3. 補足文で「未設定とは限りません」と伝える", ctx._adminTokenStateNote().indexOf("未設定とは限りません") >= 0);
    check("3. ADMIN_TOKEN_SET を勝手に false 断定しない（保持）", ctx.ADMIN_TOKEN_SET === false);
  }

  // 4. 401/403/5xx も error 扱い（HTTP 応答はあるが判定材料にならない）
  {
    const ctx = makeCtx({ set: HTTP_403, hash: HTTP_403, legacy: HTTP_403 });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("4. 403 → error", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
  }

  // 5. 一部だけ失敗 → 未設定と断定しない（判定材料が欠けている）
  {
    const ctx = makeCtx({ set: HTTP_500, hash: OK_NONE, legacy: OK_NONE });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("5. 一部失敗 → error（unconfigured にしない）", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
  }

  // 6. 全件が「取得成功・不在」のときだけ unconfigured と断定する
  {
    const ctx = makeCtx({ set: OK_NONE, hash: OK_NONE, legacy: OK_NONE });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("6. 本当に未設定 → unconfigured", ctx.adminTokenStatus === "unconfigured", ctx.adminTokenStatus);
    check("6. 従来どおり「未設定（URLログイン不可）」を表示", ctx._adminTokenStateLabel() === "未設定（URLログイン不可）", ctx._adminTokenStateLabel());
  }

  // 7. 旧形式（平文トークン）だけ残っている → configured（旧形式）
  {
    const ctx = makeCtx({ set: OK_NONE, hash: OK_NONE, legacy: { ok: true, value: "legacyToken123" } });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("7. 旧形式のみ → configured", ctx.adminTokenStatus === "configured", ctx.adminTokenStatus);
    check("7. ラベルが「旧形式（要再設定）」", ctx._adminTokenStateLabel() === "旧形式（要再設定）", ctx._adminTokenStateLabel());
  }

  // 8. 自動リトライは有限（無限リトライしない）
  {
    const ctx = makeCtx({ set: NET_FAIL, hash: NET_FAIL, legacy: NET_FAIL });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState()); // 1回目の失敗 → リトライ予約
    const rounds = await drainTimers(ctx);
    check("8. 自動リトライは最大 " + ctx.ADMIN_TOKEN_STATE_MAX_RETRY + " 回で停止",
      rounds === ctx.ADMIN_TOKEN_STATE_MAX_RETRY, "実行回数=" + rounds);
    check("8. 打ち切り後も error のまま（未設定にしない）", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
    check("8. 追加の予約が残っていない", ctx._timers.length === 0, "残り=" + ctx._timers.length);
  }

  // 9. 一時失敗のあと再取得が成功すれば、リロードなしで正しい状態へ復帰する
  {
    let firstRound = true;
    const ctx = makeCtx({});
    ctx.authFetch = function (url) {
      ctx.fetchCalls++;
      if (firstRound) return Promise.reject(new Error("network error"));
      const value = url.endsWith(PATHS.set) ? true : null;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(value); } });
    };
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("9. 一時失敗直後は error", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
    firstRound = false;
    await drainTimers(ctx); // 自動リトライが回復を拾う
    check("9. 自動リトライ成功でリロード不要のまま configured へ復帰",
      ctx.adminTokenStatus === "configured", ctx.adminTokenStatus);
    check("9. 復帰時に再描画している", ctx.renderCount > 0, "renderCount=" + ctx.renderCount);
  }

  // 10. 手動「再取得」はリトライ枠を戻して再試行できる
  {
    let failing = true;
    const ctx = makeCtx({});
    ctx.authFetch = function () {
      ctx.fetchCalls++;
      if (failing) return Promise.reject(new Error("network error"));
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(null); } });
    };
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    await drainTimers(ctx); // 自動リトライを使い切る
    check("10. 自動リトライ枠を使い切った状態", ctx.adminTokenStatus === "error", ctx.adminTokenStatus);
    failing = false;
    await ctx.retryAdminTokenState();
    await new Promise(function (r) { setImmediate(r); });
    check("10. 手動再取得で unconfigured を確定できる", ctx.adminTokenStatus === "unconfigured", ctx.adminTokenStatus);
  }

  // 11. トークン保存成功後は予約済みの自動リトライを取り消す
  //     （後から発火した再取得が失敗して「確認できません」へ戻るのを防ぐ）
  {
    const ctx = makeCtx({ set: NET_FAIL, hash: NET_FAIL, legacy: NET_FAIL });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    check("11. 失敗後にリトライが予約されている", ctx._timers.length === 1, "予約数=" + ctx._timers.length);
    // 画面側の保存成功処理と同じことをする
    ctx.ADMIN_TOKEN_SET = true;
    ctx.adminTokenStatus = "configured";
    ctx.cancelAdminTokenStateRetry();
    check("11. 保存成功で予約が取り消される", ctx._timers.length === 0, "残り=" + ctx._timers.length);
    await drainTimers(ctx);
    check("11. 保存成功後に error へ戻らない", ctx.adminTokenStatus === "configured", ctx.adminTokenStatus);
  }

  // 12. 「再取得」ボタンは失敗しても押せる状態へ必ず戻る
  //     （描画が抑止される状況で戻さないと、再取得の手段そのものが失われる）
  {
    const ctx = makeCtx({ set: NET_FAIL, hash: NET_FAIL, legacy: NET_FAIL });
    ctx.applyAdminTokenState(await ctx.loadAdminTokenState());
    await ctx.retryAdminTokenState();
    await new Promise(function (r) { setImmediate(r); });
    check("12. 再取得失敗後もボタンが有効に戻る", ctx.btn.disabled === false, "disabled=" + ctx.btn.disabled);
    check("12. ボタン文言が「再取得」に戻る", ctx.btn.textContent === "再取得", ctx.btn.textContent);
  }

  console.log("\n=== 結果: " + pass + " PASS / " + fail + " FAIL ===");
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error("テスト実行エラー:", e);
  process.exit(1);
});
