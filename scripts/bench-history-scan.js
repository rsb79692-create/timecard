#!/usr/bin/env node
/**
 * bench-history-scan.js — 承認漏れ集計（全期間スキャン）の所要時間を測る
 *
 * ★ 依存パッケージなし・送信なし・本番データ非アクセス。
 *   `index.html` の RECORDS-RANGE ブロックを実タイマーで動かし、
 *   ネットワークは「RTT ＋ 共有帯域」で模擬する（並列にしても総帯域は増えない）。
 *   件数・転送量は AGENTS.md に記録した本番実測値を使う。
 *
 * これは回帰テストではない（合否を判定しない）。
 * AGENTS.md に載せている「集計完了までの時間」を追試するための計測スクリプト。
 *
 * 実行:
 *   node scripts/bench-history-scan.js
 *   node scripts/bench-history-scan.js <比較したい index.html のパス>
 *
 * 出力:
 *   集計完了       … 管理画面へ入ってから recordsHistoryReady() が真になるまで
 *   表示月確保     … 表示中の月が使えるようになるまで（初期画面が操作可能になるまで）
 *   月切替の表示待ち … スキャン中に別の月へ切り替えたとき、その月が出るまで
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const htmlPath = process.argv[2] || path.join(ROOT, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const BEGIN = "// ===== RECORDS-RANGE-BEGIN =====";
const END = "// ===== RECORDS-RANGE-END =====";
const bi = html.indexOf(BEGIN), ei = html.indexOf(END);
if (bi < 0 || ei < 0 || ei < bi) {
  console.error("[ERROR] RECORDS-RANGE ブロックを抽出できません: " + htmlPath);
  process.exit(1);
}
const CODE = html.slice(bi + BEGIN.length, ei);

// 本番実測（2026-08-28）: 全件 4,267件 / 1,038,792B（2026-04〜2026-08）。2026-08 = 783件 / 230,104B。
// 当月は月初からの日数ぶんしか無いので少なめに置く。
const MONTHS = 6;                       // 運用開始月〜当月
const BYTES_PER_FULL_MONTH = 215000;
const RECS_PER_FULL_MONTH = 730;
const PROFILES = {
  fast: { rtt: 80, bps: 10e6, label: "RTT 80ms / 10Mbps" },
  slow: { rtt: 250, bps: 1.5e6, label: "RTT 250ms / 1.5Mbps" }
};

function ym(base, n) {
  const t = parseInt(base.slice(0, 4), 10) * 12 + (parseInt(base.slice(5, 7), 10) - 1) + n;
  const m = (t % 12) + 1;
  return Math.floor(t / 12) + "-" + (m < 10 ? "0" : "") + m;
}

function run(profKey, opts) {
  return new Promise((resolve) => {
    const P = PROFILES[profKey];
    const inflight = [];
    const pipe = setInterval(() => {
      if (!inflight.length) return;
      const share = (P.bps / 8) * 0.02 / inflight.length;   // 20ms 分を均等配分
      for (let i = inflight.length - 1; i >= 0; i--) {
        const r = inflight[i];
        if (r.rtt > 0) { r.rtt -= 20; continue; }
        r.left -= share;
        if (r.left <= 0) { inflight.splice(i, 1); r.res(); }
      }
    }, 20);
    const st = { t0: Date.now(), reqs: 0, bytes: 0, recs: 0, ls: 0, maxPar: 0, par: 0,
                 paint: 0, full: 0, switchAt: 0, switchDone: 0 };
    const sb = {
      console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array,
      String, Number, RegExp, isNaN, parseInt, parseFloat,
      FB_URL: "https://example.invalid/honomi",
      records: [], recordsReady: false, recordsStale: false, monthRecordsReady: false, _recLoadedDay: "",
      _LAZY_RETRY_MS: 5000, screen: "admin", viewerMode: false, writePolicy: "full", adminTab: "records",
      selMonth: "", selDate: "", reviewMonth: "", mealAdminMonth: "", adjLogMonth: "",
      monthlyDaysYear: 0, mileage: { adminYm: "", myMonth: "" },
      showPaidLeaveForm: false, _paidLeaveRenderGuard: false, monthlyDaysEditing: false,
      mileageBlocksRerender: () => false, punchOutboxMergeInto: () => {},
      render: () => {}, document: { querySelector: () => null },
      pad: (n) => (n < 10 ? "0" + n : "" + n),
      fmtDateKey: (d) => d.getFullYear() + "-" + sb.pad(d.getMonth() + 1) + "-" + sb.pad(d.getDate()),
      monthKey: (iso) => (iso ? iso.substring(0, 7) : ""),
      addYm: (m, n) => ym(m + "-01", n),
      getJSTMonthRange: () => ({ first: "" }),
      loadData: (k, d) => d,
      localStorage: { getItem: (k) => (k === "tc5_records_oldest" ? JSON.stringify(opts.oldest) : null), setItem: () => {} },
      _lsSet: () => { st.ls++; },
      fetchJson: () => Promise.resolve(null),
      authFetch: (url) => {
        const a = /startAt=%22([\d-]+)%22/.exec(url), b = /endAt=%22([\d-]+)%22/.exec(url);
        const days = a && b ? Math.max(1, Math.round((Date.parse(b[1].replace(/-31$/, "-28")) - Date.parse(a[1])) / 86400000) + 1) : 1;
        const bytes = Math.round(BYTES_PER_FULL_MONTH * Math.min(1, days / 30));
        const recs = Math.round(RECS_PER_FULL_MONTH * Math.min(1, days / 30));
        st.reqs++; st.bytes += bytes; st.recs += recs;
        st.par++; if (st.par > st.maxPar) st.maxPar = st.par;
        return new Promise((res) => inflight.push({ left: bytes, rtt: P.rtt, res })).then(() => {
          st.par--;
          const obj = {};
          for (let i = 0; i < recs; i++) obj["k_" + a[1] + "_" + i] = { date: a[1], staff: "s" + (i % 26), type: "clockIn" };
          return { ok: true, status: 200, json: () => Promise.resolve(obj) };
        });
      }
    };
    vm.createContext(sb); vm.runInContext(CODE, sb);
    const today = sb.recToday();
    const curYm = today.substring(0, 7);
    sb.selMonth = curYm;
    sb.getJSTMonthRange = () => ({ first: curYm + "-01" });
    const otherYm = ym(today, -(MONTHS - 2));

    const drive = setInterval(() => {
      sb.ensureAdminRecordRanges();
      if (!st.paint && sb.recordsRangeCovers(curYm + "-01", today)) st.paint = Date.now() - st.t0;
      if (opts.switchMonth && !st.switchAt && Date.now() - st.t0 >= 1000) { st.switchAt = Date.now(); sb.selMonth = otherYm; }
      if (st.switchAt && !st.switchDone && sb.recordsRangeCovers(otherYm + "-01", otherYm + "-28")) st.switchDone = Date.now() - st.switchAt;
      if (!st.full && sb.recordsHistoryReady()) st.full = Date.now() - st.t0;
      const done = st.full && (!opts.switchMonth || st.switchDone);
      if (done || Date.now() - st.t0 > 120000) {
        clearInterval(drive); clearInterval(pipe);
        resolve(st);
      }
    }, 100);
  });
}

(async function () {
  const d = new Date();
  const today = d.getFullYear() + "-" + (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1)
    + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate();
  const oldest = ym(today, -(MONTHS - 1)) + "-01";
  console.log("対象: " + htmlPath);
  console.log("条件: 運用開始月 " + oldest.slice(0, 7) + " 〜 当月（" + MONTHS + "か月）/ 1か月あたり "
    + Math.round(BYTES_PER_FULL_MONTH / 1024) + "KB・" + RECS_PER_FULL_MONTH + "件\n");
  for (const k of ["fast", "slow"]) {
    const a = await run(k, { oldest: oldest });
    console.log("[" + PROFILES[k].label + "]");
    console.log("  集計完了       " + (a.full / 1000).toFixed(2) + "s"
      + "   通信 " + a.reqs + "回 / " + (a.bytes / 1024).toFixed(0) + "KB / " + a.recs + "件"
      + " / 最大並列 " + a.maxPar);
    console.log("  表示月確保     " + (a.paint / 1000).toFixed(2) + "s（初期画面が操作可能になるまで）");
    const b = await run(k, { oldest: oldest, switchMonth: true });
    console.log("  月切替の表示待ち " + (b.switchDone / 1000).toFixed(2) + "s（スキャン中に別の月へ切り替えた場合）\n");
  }
  process.exit(0);
})();
