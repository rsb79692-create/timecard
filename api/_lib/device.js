/**
 * api/_lib/device.js — 施設端末の持ち出し監視（共通ロジック）
 *
 * 目的は1つだけ。「施設に置いてある打刻用スマホが施設の設定範囲外へ持ち出されたら、
 * 管理者へ LINE を1回送る」。それ以外の機能は持たない。
 *
 * ===== 置き場所 =====
 * データは RTDB のルート直下 /devmon。`database.rules.json` に未定義＝デフォルト拒否で、
 * クライアント（打刻端末・職員・労務士）からは直接読み書きできない。
 *
 * ★ /honomi 配下へ置いてはならない。/honomi は打刻のために
 *   tc5_records / tc5_pins / master/locations を匿名または一般スタッフへ開けてある。
 *   そこへ監視設定を置くと、監視対象の端末自身が
 *   「監視OFF」「基準位置＝自宅」「範囲内」と書けてしまい、検知を無効化できる。
 *   （`master/locations` に判定時刻を持たせないのと同じ理由。AGENTS.md 参照）
 *
 * ===== 判定はすべてサーバ側で行う =====
 * 端末アプリは「いまの位置と権限状態」を報告するだけで、持ち出し確定・重複抑止・
 * 通知の判断を一切持たない。アプリを書き換えても判定を変えられないようにするため。
 *
 * ★ ただし**位置そのものは端末の自己申告**である。サーバへ判定を置いた目的は
 *   「重複通知の抑止」と「端末時刻の偽装対策」であって、位置の真正性の保証ではない。
 *   改造クライアント・エミュレータ・OSの位置偽装で「範囲内」を偽ることはできる。
 *   その代わり、偽っても**必ず痕跡が残る**ようにしてある（下記「判定できていない検知」）。
 *
 * ★ 経過時間は必ず「サーバ受信時刻」で測る。端末が申告した時刻（at）は参考情報として
 *   しか使わない。端末時刻を進めるだけで「3分継続した」と偽れてしまうため。
 *
 * ===== 判定できていない検知（フェイルクローズ）=====
 * 「報告は届くが位置を判定できない」状態（位置を送らない・測位が粗すぎる）を
 * 放置すると、管理画面が「監視中・範囲内」と緑表示のまま検知が死ぬ。
 * そのため judged した時刻（lastJudgedAt）を残し、一定時間判定できていない端末は
 * 受信途絶と同じ扱いで管理者へ通知する。**この仕組みを外してはならない。**
 */
"use strict";

const crypto = require("crypto");
const G = require("./google");
const S = require("./secrets");

const ROOT = "devmon";

// 許容半径（m）。初期値150m。
const DEFAULT_RADIUS_M = 150;
const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 2000;

// 範囲外がこれだけ継続したら持ち出し確定（秒）。初期値3分。
const DEFAULT_DWELL_SEC = 180;
const MIN_DWELL_SEC = 60;
const MAX_DWELL_SEC = 1800;

/**
 * GPS誤差の扱い。
 * ★ acc（測位誤差）を差し引いてから半径と比べる。差し引かないと、誤差だけで
 *   範囲外と判定して誤通知になる。
 * ★ ただし差し引く量には上限を置く（ACC_CAP_M）。上限が無いと、端末が
 *   acc を大きく申告するだけで永久に「範囲内」にできる。
 * ★ ACC_MAX_M より粗い測位は状態判定に使わない（lastSeenAt だけ更新する）。
 *   このとき pendingSince を消してはならない。消すと、粗い測位を挟むだけで
 *   3分の計測をリセットできてしまう。
 * ★ acc の申告が無い／不正なときは「判定に使えない」ではなく ACC_CAP_M として扱う。
 *   判定スキップへ落とすと、**acc を省略するだけで永久に判定されない**抜け道になる。
 */
const ACC_CAP_M = 100;
const ACC_MAX_M = 300;

/**
 * これだけ受信（または位置の判定）が無ければ管理者へ通知する（秒）。
 * ★ 24時間。短くしてはならない。iOS は静止している端末からの定期報告を保証しない
 *   （移動が無いと OS が背景実行を起こさない）ため、数時間のしきい値では毎日誤警報になる。
 *   受信途絶の検知は補助であって、確実な検知手段ではない。
 */
const DEFAULT_STALE_SEC = 24 * 3600;

// 登録コードの有効期間と上限。
const ENROLL_TTL_MS = 24 * 3600 * 1000;
const MAX_ENROLL_OPEN = 20;

// 上限。RTDB に TTL は無いため、無制限に増やさせない。
const MAX_FACILITIES = 50;
const MAX_DEVICES = 50;

// 1回のスイープで確定・通知する件数の上限（1リクエストの所要時間を縛る）。
const SWEEP_CONFIRM_MAX = 5;
// 集約通知に並べる行数の上限。超えた分は「他N件」にまとめる。
const DIGEST_LINES_MAX = 10;

// 端末が申告できる権限状態。ここに無い値は「不明」として判定に使わない。
const PERM_VALUES = { always: 1, whenInUse: 1, denied: 1, off: 1, restricted: 1 };

// ===== 純粋関数（テストはここを直接呼ぶ。I/O を持たせてはならない）=====

/**
 * 施設名の正規化。fkey の導出にだけ使う。
 * NFKC ＋ 空白除去。`scripts/morning-check.js` の normalizeFacility と同じ考え方で、
 * 表記ゆれ（全角空白・半角空白）を同じ施設として扱う。
 * ★ 表示名は利用者が入力したままを保存する（正規化した名前を表示に使わない）。
 */
function normFacilityName(s) {
  let v = typeof s === "string" ? s : "";
  try { v = v.normalize("NFKC"); } catch (e) { /* 環境差で失敗しても素の値で続ける */ }
  return v.replace(/\s+/g, "");
}

/**
 * 施設のキー。施設名から決まる16桁の16進。
 * ★ 施設名をそのまま RTDB のキーにしてはならない（`. $ # [ ] /` が使えない）。
 *   sanitize で置換すると別名が同じキーへ衝突し、2施設が同じ設定を共有しうる。
 * ★ 正規化の結果が同じ名前（例「ハルイロ」と「ハル イロ」）は同じ施設として扱う。
 *   管理画面はこの衝突を検出して警告を出す（`index.html` の DEVWATCH）。
 */
function fkeyOf(name) {
  const n = normFacilityName(name);
  if (!n) return "";
  return crypto.createHash("sha256").update(n, "utf8").digest("hex").slice(0, 16);
}

function isFkey(v) {
  return typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
}

function isDeviceId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(v);
}

/** 登録コード。人が読み上げて入力する前提なので、紛らわしい文字を外した8桁。 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newEnrollCode() {
  const b = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}
function isEnrollCode(v) {
  return typeof v === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(v);
}

/** 緯度・経度。未設定は null を返す（0 と混同しないため、数値以外は必ず null）。 */
function normLat(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!isFinite(n) || n < -90 || n > 90) return null;
  return Math.round(n * 1e6) / 1e6;
}
function normLng(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!isFinite(n) || n < -180 || n > 180) return null;
  return Math.round(n * 1e6) / 1e6;
}
/**
 * 「値が送られてきたが緯度（経度）として使えない」かどうか。
 * ★ 未設定（null / undefined / 空文字）と、不正値（NaN・範囲外）を区別するために使う。
 *   区別しないと、`Number("abc")` が NaN → JSON で null になるため、
 *   入力ミスが「未設定」として黙って既存値へフォールバックしてしまう。
 * ★★ 緯度と経度を**別々に**検査する。「どちらとしても不正」だけを弾くと、
 *   日本の座標（緯度≈34 / 経度≈135）では**入れ違いを検出できない**。
 *   緯度欄へ 135.5 を入れても素通りし、既存値へフォールバックして
 *   「保存しました」と出るのに基準位置が変わらない、という無言の失敗になる。
 */
function isBadLat(v) {
  if (v === null || v === undefined || v === "") return false;   // 未設定
  return normLat(v) === null;
}
function isBadLng(v) {
  if (v === null || v === undefined || v === "") return false;   // 未設定
  return normLng(v) === null;
}
/** 許容半径。範囲外の値は既定へ丸めず null を返す（黙って別の半径で監視しない）。 */
function normRadius(v) {
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  if (!isFinite(n)) return null;
  const i = Math.round(n);
  if (i < MIN_RADIUS_M || i > MAX_RADIUS_M) return null;
  return i;
}
function normDwellSec(v) {
  const n = Number(v);
  if (!isFinite(n)) return DEFAULT_DWELL_SEC;
  const i = Math.round(n);
  if (i < MIN_DWELL_SEC || i > MAX_DWELL_SEC) return DEFAULT_DWELL_SEC;
  return i;
}
/**
 * 受信途絶・判定不能のしきい値（秒）。
 * ★ 上限を設ける。桁を1つ間違えて入れたときに、検知が**無言で無効化**されないため
 *   （normDwellSec と同じ扱いで、範囲外は既定へ倒す）。
 */
const MIN_STALE_SEC = 3600;              // 1時間
const MAX_STALE_SEC = 7 * 24 * 3600;     // 7日
function normStaleSec(v) {
  const n = Number(v);
  if (!isFinite(n)) return DEFAULT_STALE_SEC;
  const i = Math.round(n);
  if (i < MIN_STALE_SEC || i > MAX_STALE_SEC) return DEFAULT_STALE_SEC;
  return i;
}
/**
 * 測位誤差（m）。
 * ★ 申告が無い・不正なら ACC_CAP_M（差し引ける上限）として扱い、判定は行う。
 *   ACC_MAX_M を返して判定スキップにすると「acc を省略すれば検知されない」抜け道になる。
 */
function normAcc(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return ACC_CAP_M;
  return n;
}

/**
 * 表示・LINE本文へ出す文字列の正規化。
 * ★ 制御文字・双方向制御・ゼロ幅を落とす。落とさないと、施設名や端末名に改行を混ぜて
 *   LINE本文へ偽の行（例「範囲内へ戻りました」）を差し込める。
 * ★ 正規表現の \u エスケープを使わず、コードポイントで判定する
 *   （エスケープが実体文字へ変換されると正規表現が壊れるため）。
 */
function normText(v, max) {
  let s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue;                  // C0 制御文字・DEL
    if (c >= 0x80 && c <= 0x9f) continue;                  // C1 制御文字
    if (c >= 0x200b && c <= 0x200f) continue;              // ゼロ幅・方向マーク
    if (c === 0x2028 || c === 0x2029) continue;            // 行区切り・段落区切り
    if (c >= 0x202a && c <= 0x202e) continue;              // 双方向制御
    if (c >= 0x2066 && c <= 0x2069) continue;              // 双方向分離
    out += ch;
  }
  s = out.trim();
  const lim = max || 60;
  return Array.from(s).slice(0, lim).join("");
}

/** 2点間の距離（m）。Haversine。 */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad, p2 = lat2 * toRad;
  const dp = (lat2 - lat1) * toRad;
  const dl = (lng2 - lng1) * toRad;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2)
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 施設設定が監視可能な状態か（ONかつ基準位置と半径が揃っている）。 */
function facilityReady(fac) {
  if (!fac || typeof fac !== "object") return false;
  if (fac.enabled !== true) return false;
  return normLat(fac.lat) !== null && normLng(fac.lng) !== null && normRadius(fac.radiusM) !== null;
}

/**
 * 1回の報告を評価する。純粋関数。
 *
 * prev : { state, pendingSince, notifiedAt, permState, permNotifiedAt, lastSeenAt, lastJudgedAt }
 * rep  : { nowMs, lat, lng, acc, permission }   ← nowMs はサーバ受信時刻
 * fac  : { enabled, lat, lng, radiusM }
 * cfg  : { dwellSec }
 *
 * 戻り値 { patch, notify, distM, judged }
 *   patch  … デバイスレコードへ適用する差分
 *   notify … [{kind:"exit"|"permission"}]（0〜2件）
 *   judged … 位置の判定を行ったか（false なら受信記録だけ）
 */
function evaluateReport(prev, rep, fac, cfg) {
  const p = prev && typeof prev === "object" ? prev : {};
  const nowMs = Number(rep && rep.nowMs) || 0;
  const dwellMs = normDwellSec(cfg && cfg.dwellSec) * 1000;
  const patch = { lastSeenAt: nowMs };
  const notify = [];

  // --- 権限状態（位置の判定とは独立に評価する）---
  // ★ 記録は監視ON/OFFに関係なく行う（管理画面の表示を正確に保つため）。
  //   ただし**通知は監視ONの施設だけ**。OFF の施設で LINE だけ飛ぶと、
  //   管理画面が「OFF」と表示しているのに通知が来る食い違いになる。
  const monitored = !!(fac && typeof fac === "object" && fac.enabled === true);
  const perm = rep && typeof rep.permission === "string" ? rep.permission : "";
  if (perm && Object.prototype.hasOwnProperty.call(PERM_VALUES, perm)) {
    if (perm === "always") {
      // 復帰。次に失われたときへ向けて通知権を戻す（復帰そのものは通知しない）。
      if (p.permState !== "ok") patch.permState = "ok";
      // ★ permDetail も消す。消さないと管理画面（permState==="lost"||permDetail）が
      //   「権限に問題あり」を永久に赤で出し続け、赤の意味が失われる。
      if (p.permDetail) patch.permDetail = null;
    } else {
      patch.permState = "lost";
      patch.permDetail = perm;
      // ★ 1度失われたら、戻るまで再通知しない。
      // ★★ 再通知の判定に permState を使ってはならない。通知の送信に失敗したときへ
      //   「permState を ok へ戻して再アームする」しか手が無くなり、管理画面が
      //   「権限は正常（緑）」と事実と逆の表示になる。通知済みの印（permNotifiedAt）で判定する。
      const notified = Number(p.permNotifiedAt) > 0 && p.permState === "lost";
      if (!notified && monitored) {
        patch.permNotifiedAt = nowMs;
        notify.push({ kind: "permission", detail: perm });
      }
    }
  }

  // --- 位置 ---
  const lat = normLat(rep && rep.lat), lng = normLng(rep && rep.lng);
  if (!facilityReady(fac) || lat === null || lng === null) {
    // 監視OFF・基準位置未設定・座標なしのときは状態を触らない（推測で範囲内にしない）。
    // ★ lastJudgedAt を進めないので、この状態が続けば「判定できていない」として通知される。
    return { patch: patch, notify: notify, distM: null, judged: false };
  }

  const distM = distanceM(Number(fac.lat), Number(fac.lng), lat, lng);
  patch.lastDistM = Math.round(distM);
  const acc = normAcc(rep && rep.acc);
  patch.lastAccM = Math.round(acc);

  // 粗すぎる測位は判定に使わない。★ pendingSince は消さない。
  if (acc >= ACC_MAX_M) {
    return { patch: patch, notify: notify, distM: distM, judged: false };
  }

  patch.lastJudgedAt = nowMs;     // ここまで来たら位置判定が成立している
  const radius = normRadius(fac.radiusM);
  const outside = (distM - Math.min(acc, ACC_CAP_M)) > radius;

  if (outside) {
    if (p.state === "outside") {
      // 持ち出し中。範囲内へ戻るまで再通知しない。
      return { patch: patch, notify: notify, distM: distM, judged: true };
    }
    const since = Number(p.pendingSince) > 0 ? Number(p.pendingSince) : nowMs;
    patch.pendingSince = since;
    // ★ 確定には「最初の範囲外」から dwell 以上経った別の報告が必要。
    //   1回の報告だけでは確定しない（GPSの単発の飛びで通知しない）。
    //   端末がこのあと沈黙しても、スイープ（sweepPlan）が同じ基準で確定させる。
    if (nowMs - since >= dwellMs) {
      patch.state = "outside";
      patch.pendingSince = null;
      patch.notifiedAt = nowMs;
      // since を返すのは、LINE送信が失敗したときに「確定前の状態」へ戻して
      // 次の報告で送り直せるようにするため（通知を1回分黙って捨てない）。
      notify.push({ kind: "exit", distM: Math.round(distM), since: since });
    } else if (p.state !== "pending") {
      // ★ "inside" と書かない。実際は範囲外なので、管理画面が「範囲内」と表示すると事実と違う。
      patch.state = "pending";
    }
    return { patch: patch, notify: notify, distM: distM, judged: true };
  }

  // 範囲内。継続計測を解除し、次の持ち出しへ向けて通知権を戻す。
  if (Number(p.pendingSince) > 0) patch.pendingSince = null;
  if (p.state !== "inside") patch.state = "inside";
  return { patch: patch, notify: notify, distM: distM, judged: true };
}

/**
 * 「LINE を送る前に書いてよい差分」を作る。純粋関数。
 *
 * ★ 持ち出しの確定（state / notifiedAt）は送信できてから書く。先に書くと、
 *   巻き戻しに失敗した時点で evaluateReport も sweepPlan も拾わなくなり、
 *   その持ち出しのアラートが完全に失われる。
 * ★ 観測値（lastSeenAt / lastDistM / lastAccM / lastJudgedAt）と継続開始時刻は先に書く。
 *   継続開始時刻を落とすと、次の報告で計測がやり直しになる。
 */
function splitPatchForSend(evPatch, exitNotify, nowMs) {
  const out = Object.assign({}, evPatch || {});
  if (!exitNotify) return out;
  delete out.state;
  delete out.notifiedAt;
  out.pendingSince = Number(exitNotify.since) > 0 ? Number(exitNotify.since) : Number(nowMs) || 0;
  return out;
}

/**
 * 確定（持ち出し検知を送れたあとに書く差分）。純粋関数。
 */
function confirmPatch(nowMs) {
  return { state: "outside", pendingSince: null, notifiedAt: Number(nowMs) || 0 };
}

/**
 * 端末の一覧から「いま通知すべきもの」を選ぶ。純粋関数。
 *
 * confirms … 範囲外の継続が dwell を超えているのに確定していない端末。
 *   ★ これが無いと、ジオフェンスの Exit を1回送った直後に端末が沈黙した場合
 *     （電源を切る・機内モードにする・OSが起こさない）に**通知が永久に出ない**。
 *     経過はサーバ受信時刻で測っているので、端末の追加報告は本来不要である。
 * stales … 受信そのものが途絶えた端末（1つの途絶につき1回だけ）。
 * unjudged … 報告は届くが位置判定が成立していない端末（1つの状態につき1回だけ）。
 */
function sweepPlan(devices, nowMs, cfg, facilities) {
  const dwellMs = normDwellSec(cfg && cfg.dwellSec) * 1000;
  const staleMs = normStaleSec(cfg && cfg.staleSec) * 1000;
  const map = devices && typeof devices === "object" ? devices : {};
  const facs = facilities && typeof facilities === "object" ? facilities : {};
  const confirms = [], stales = [], unjudged = [];

  for (const id of Object.keys(map)) {
    // ★ 形式が不正なキーは対象にしない（markDevices と対称にする）。
    //   patchDevice は不正な ID で必ず throw するため、confirms へ入れると
    //   「LINE は送れるが確定は永久に書けない」＝**毎回のスイープで再送**になる。
    //   定期実行が1分間隔なので、1件混ざるだけで1日1,440通の通知になりうる。
    if (!isDeviceId(id)) continue;
    const d = map[id];
    if (!d || typeof d !== "object") continue;
    if (d.revoked === true) continue;
    if (!facilityReady(facs[d.fkey])) continue;     // 監視OFFの施設は対象外

    // ① 確定待ちが dwell を超えている（端末が沈黙していても確定させる）
    const since = Number(d.pendingSince) || 0;
    if (d.state !== "outside" && since > 0 && nowMs - since >= dwellMs) {
      // ★ 前の持ち出しの通知（notifiedAt）が今の継続より新しい場合は出さない。
      // ★ 判定が成立した時刻が継続開始より古い（＝監視OFF・基準位置変更をまたいで
      //   古い観測が残っている）ものは確定させない。現在位置を見ずに通知しないため。
      const judged = Number(d.lastJudgedAt) || 0;
      const notified = Number(d.notifiedAt) || 0;
      if (notified <= since && judged >= since) {
        confirms.push({ deviceId: id, dev: d, since: since });
        continue;
      }
      // ★ 抑止したときに continue してはならない。②受信途絶・③判定できていない の
      //   検査まで飛ばすと、フェイルクローズ機構の中にフェイルオープンの穴を作る。
    }

    // ② 受信途絶
    const seen = Number(d.lastSeenAt) || 0;
    if (seen && nowMs - seen >= staleMs) {
      // ★ 再アームは「時刻差」で見る。staleNotifiedAt > lastSeenAt だけで抑止すると、
      //   沈黙中は lastSeenAt が進まないため、印を戻せなかった時点で**その途絶について
      //   二度と通知されない**（送信失敗と巻き戻し失敗が重なると通知が恒久的に消える）。
      //   しきい値ぶん経てば必ず再通知する。24時間窓の重複抑止はそのまま効く。
      const sn = Number(d.staleNotifiedAt) || 0;
      if (!(sn > seen) || nowMs - sn >= staleMs) {
        stales.push({ deviceId: id, dev: d, quietMs: nowMs - seen });
      }
      continue;                                     // 途絶と「判定できていない」を二重に出さない
    }

    // ③ 報告は届くが位置の判定が成立していない
    const judged = Number(d.lastJudgedAt) || 0;
    const base = judged || Number(d.createdAtMs) || 0;
    // ★ 時刻をまったく持たない端末（想定外のデータ）は「判定できていない」として扱う。
    //   どこにも入れないと、正常として黙って見過ごす側へ倒れる（フェイルクローズ）。
    const un = Number(d.unjudgedNotifiedAt) || 0;
    if (!base) {
      // 時刻をまったく持たない端末。★ ここも時刻差で再アームする（M-A と同じ理由）。
      if (!un || nowMs - un >= staleMs) {
        unjudged.push({ deviceId: id, dev: d, quietMs: 0 });
      }
      continue;
    }
    if (nowMs - base >= staleMs) {
      // ★ 再アームは時刻差で見る。判定できない状態が続くかぎり base は進まないため、
      //   印だけで抑止すると**フェイルクローズ機構そのものが恒久的に黙る**。
      if (!(un > base) || nowMs - un >= staleMs) {
        unjudged.push({ deviceId: id, dev: d, quietMs: nowMs - base });
      }
    }
  }
  return { confirms: confirms, stales: stales, unjudged: unjudged };
}

// ===== LINE 本文（純粋関数）=====

/** JST の "M/D H:MM"。 */
function jstStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  return p.month + "/" + p.day + " " + p.hour + ":" + p.minute;
}

const PERM_LABEL = {
  whenInUse: "「このAppの使用中のみ許可」へ変更されました",
  denied: "位置情報の利用が拒否されています",
  off: "端末の位置情報サービスがOFFです",
  restricted: "位置情報の利用が制限されています",
};

function hoursLabel(ms) {
  const h = Math.floor((Number(ms) || 0) / 3600000);
  return h > 0 ? h + "時間以上" : "長時間";
}

function buildMessage(kind, o) {
  const name = normText(o && o.facilityName, 40) || "（施設名なし）";
  const at = jstStamp(o && o.atMs);
  if (kind === "exit") {
    return ["【施設端末 持ち出し検知】", name, at, "施設の設定範囲外へ移動しました。"].join("\n");
  }
  if (kind === "permission") {
    const detail = PERM_LABEL[o && o.detail] || "位置情報の「常に許可」が外れました";
    return ["【施設端末 位置情報の警告】", name, at, detail + "。",
      "この状態では持ち出しを検知できません。"].join("\n");
  }
  if (kind === "stale") {
    return ["【施設端末 受信途絶】", name, at,
      hoursLabel(o && o.quietMs) + "、端末から位置情報が届いていません。",
      "電源・アプリの状態を確認してください。"].join("\n");
  }
  if (kind === "unjudged") {
    return ["【施設端末 位置を判定できません】", name, at,
      hoursLabel(o && o.quietMs) + "、端末の位置を判定できていません。",
      "この状態では持ち出しを検知できません。アプリと位置情報の設定を確認してください。"].join("\n");
  }
  return "";
}

/**
 * 複数端末ぶんを1通へまとめる。
 * ★ 端末ごとに LINE を送ると、端末数に比例して外部通信が増える（N+1）。
 *   受信途絶・判定不能は同時に複数出やすいのでまとめる。
 *   持ち出し検知（exit）はまとめない（どの施設かを即座に伝える必要があるため）。
 */
function buildDigest(kind, items, atMs) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "";
  if (list.length === 1) {
    return buildMessage(kind, {
      facilityName: list[0].facilityName, atMs: atMs, quietMs: list[0].quietMs,
    });
  }
  const head = kind === "stale" ? "【施設端末 受信途絶】" : "【施設端末 位置を判定できません】";
  const lead = kind === "stale"
    ? "以下の端末から位置情報が届いていません。"
    : "以下の端末の位置を判定できていません。";
  const lines = list.slice(0, DIGEST_LINES_MAX).map(function (it) {
    return "・" + (normText(it.facilityName, 40) || "（施設名なし）")
      + "（" + hoursLabel(it.quietMs) + "）";
  });
  if (list.length > DIGEST_LINES_MAX) lines.push("・他 " + (list.length - DIGEST_LINES_MAX) + " 件");
  const tail = kind === "stale"
    ? "電源・アプリの状態を確認してください。"
    : "アプリと位置情報の設定を確認してください。";
  return [head, jstStamp(atMs), lead].concat(lines).concat([tail]).join("\n");
}

// ===== I/O =====

/**
 * 既存の LINE 通知基盤（Messaging API push）をそのまま使う。
 * ★ 通知基盤を新設しない。環境変数も既存と同じ
 *   （LINE_CHANNEL_ACCESS_TOKEN / LINE_TO_ID。api/line-notify.js と共通）。
 * ★ 値はログへ出さない（存在の真偽だけ）。
 */
async function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  const to = process.env.LINE_TO_ID || "";
  if (!token || !to) {
    console.error("[device] LINE credentials not configured");
    return false;
  }
  const bodyStr = JSON.stringify({ to: to, messages: [{ type: "text", text: String(text) }] });
  try {
    const res = await G.httpRequest(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      bodyStr
    );
    if (res.status !== 200) {
      console.error("[device] LINE API error: HTTP " + res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[device] LINE send failed:", e && e.message);
    return false;
  }
}

async function loadFacilities() {
  const raw = await G.dbGet(ROOT + "/facilities");
  return raw && typeof raw === "object" ? raw : {};
}

async function loadDevices() {
  const raw = await G.dbGet(ROOT + "/devices");
  return raw && typeof raw === "object" ? raw : {};
}

/**
 * /devmon/_meta を1度だけ作る。
 * ★ ウォームインスタンス内では2回目以降を省く。`_meta` を読む処理はどこにも無く、
 *   書込 action ごとに GET を1往復払う意味が無い。
 */
let _metaChecked = false;
async function ensureMeta() {
  if (_metaChecked) return;
  _metaChecked = true;
  try {
    const meta = await G.dbGet(ROOT + "/_meta");
    if (meta && typeof meta === "object") return;
    await G.dbPut(ROOT + "/_meta", { createdAt: new Date().toISOString(), version: 1 });
  } catch (e) {
    _metaChecked = false;                 // 次回やり直せるようにする
    throw e;
  }
}

/** 施設設定の取得（1件）。 */
async function loadFacility(fkey) {
  if (!isFkey(fkey)) return null;
  const raw = await G.dbGet(ROOT + "/facilities/" + fkey);
  return raw && typeof raw === "object" ? raw : null;
}

async function loadDevice(deviceId) {
  if (!isDeviceId(deviceId)) return null;
  const raw = await G.dbGet(ROOT + "/devices/" + deviceId);
  return raw && typeof raw === "object" ? raw : null;
}

async function patchDevice(deviceId, patch) {
  if (!isDeviceId(deviceId)) throw new Error("bad device id");
  await G.dbPatch(ROOT + "/devices/" + deviceId, patch);
}

/** 複数端末へ同じ印を1回の原子的更新で付ける（端末ごとに書き込まない）。 */
async function markDevices(items, field, value) {
  const map = {};
  let n = 0;
  for (const it of items || []) {
    if (!isDeviceId(it.deviceId)) continue;
    map[ROOT + "/devices/" + it.deviceId + "/" + field] = value;
    n++;
  }
  if (!n) return 0;
  await G.dbPatchRoot(map);
  return n;
}

/**
 * 「この継続についての持ち出し通知は、このインスタンスから既に送れている」記録。
 *
 * ★★ なぜ要るか。持ち出し検知は「送信できてから確定（`state`/`notifiedAt`）を書く」
 *   ＝取り逃しより重複を選ぶ設計である。そのため **LINE は送れたのに確定の書き込みだけが
 *   失敗した**場合、`sweepPlan` の抑止条件（`notified <= since`）が変わらないので
 *   次のスイープが同じ通知を送り直す。定期実行が1分間隔になったことで、これが
 *   最悪 1端末あたり 1,440通/日になりうる。LINE の push 枠は朝の未打刻通知
 *   （`scripts/morning-check.js`）と**同じ資格情報・同じ枠**なので、枠を食い潰すと
 *   業務上より重い通知まで沈黙する。
 *
 * ★ キーは `deviceId + "@" + pendingSince`（＝継続の同一性）にする。
 *   **別の持ち出しは必ず `pendingSince` が違う**ので、復帰後の再持ち出しを取りこぼさない。
 *   「すでに管理者へ届いた同一内容」だけを抑止するので、通知の喪失にはならない。
 * ★ これは保険であって正本ではない（インスタンスが入れ替われば失われる）。
 *   正本は RTDB の `notifiedAt` のままにする。
 */
const EXIT_SENT_TTL_MS = 60 * 60 * 1000;
const EXIT_SENT_MAX = 200;
const _exitSent = new Map();
function exitSentRecently(key, nowMs) {
  const at = _exitSent.get(key);
  return typeof at === "number" && nowMs - at < EXIT_SENT_TTL_MS;
}
function markExitSent(key, nowMs) {
  // 古い記録を捨ててから足す（無制限に増やさない）。
  for (const [k, at] of _exitSent) {
    if (nowMs - at >= EXIT_SENT_TTL_MS) _exitSent.delete(k);
  }
  while (_exitSent.size >= EXIT_SENT_MAX) {
    const oldest = _exitSent.keys().next();
    if (oldest.done) break;
    _exitSent.delete(oldest.value);
  }
  _exitSent.set(key, nowMs);
}

/**
 * スイープ。次の3つの機会に呼ぶ。**判定の実装はここだけ**（二重実装を作らない）。
 *
 *   ① 外部スケジューラからの定期実行（1分間隔・`POST /api/device-report` の action:"sweep"）
 *      ← これが主経路。管理画面を誰も開かなくても確定・通知されるのはこれによる。
 *   ② 端末の報告時（`SWEEP_MIN_INTERVAL_MS` で間引く）  ← 保険
 *   ③ 管理画面の取得時（`/api/device` の bootstrap）      ← 保険
 *
 * ★ ②③ を外してはならない。①のスケジューラはリポジトリ外にあり、止まっても
 *   Actions のように失敗が見えない。二重化しておく（朝の未打刻通知と同じ考え方）。
 * ★ 通知の送信に失敗したときは印を付けない（次の機会にやり直す）。
 */
async function runSweep(facilities, devices, nowMs, settings) {
  const plan = sweepPlan(devices, nowMs, settings, facilities);
  const facOf = function (d) { return (facilities && facilities[d.fkey]) || {}; };
  const results = [];

  // ★ 件ごとの「送信 → 成功したときだけ印を付ける」は直列のまま（順序に意味がある）。
  //   件をまたいだ処理は互いに独立なので並列にする。直列にすると最悪12段が応答時間に乗る。
  const jobs = [];
  let confirmed = 0;

  // 持ち出しの確定は1件ずつ通知する（どの施設かを即座に伝えるため）。件数は上限で縛る。
  for (const it of plan.confirms.slice(0, SWEEP_CONFIRM_MAX)) {
    jobs.push((async function () {
      const key = it.deviceId + "@" + it.since;
      if (exitSentRecently(key, nowMs)) {
        // ★ この継続の LINE は既に届いている（確定の書き込みだけが失敗した）。
        //   送信は繰り返さず、書き込みのやり直しだけを行う。
        try {
          await patchDevice(it.deviceId, confirmPatch(nowMs));
          confirmed++;
        } catch (e) { console.error("[device] confirm patch retry failed"); }
        return 0;
      }
      const ok = await sendLine(buildMessage("exit", {
        facilityName: facOf(it.dev).name, atMs: nowMs,
      }));
      if (!ok) return 0;                    // 印を付けない＝次の機会に再送
      markExitSent(key, nowMs);
      confirmed++;
      try {
        await patchDevice(it.deviceId, confirmPatch(nowMs));
      } catch (e) { console.error("[device] confirm patch failed"); }
      return 1;
    })());
  }

  // 受信途絶・判定できていない は1通へまとめ、印も1回の更新で付ける。
  for (const kind of ["stale", "unjudged"]) {
    const list = plan[kind === "stale" ? "stales" : "unjudged"];
    if (!list.length) continue;
    jobs.push((async function () {
      const field = kind === "stale" ? "staleNotifiedAt" : "unjudgedNotifiedAt";
      const text = buildDigest(kind, list.map(function (it) {
        return { facilityName: facOf(it.dev).name, quietMs: it.quietMs };
      }), nowMs);
      // ★ 受信途絶・判定不能は「印を先に付けてから送る」。
      //   Vercel は同時実行でスケールするため、送ってから印を付けると
      //   同時に走ったスイープが同じ集約通知を何通も出す（集約した意味が消える）。
      //   この2種は「取り逃しても24時間後に再評価される」ので、重複を避ける側へ倒す。
      //   （持ち出し検知＝exit は逆で、取り逃しが致命なので送信成功後に印を付ける。）
      try { await markDevices(list, field, nowMs); } catch (e) {
        console.error("[device] mark failed");
        return 0;                              // 印を付けられないなら送らない（重複を作らない）
      }
      const ok = await sendLine(text);
      if (!ok) {
        // 送れなかったので印を戻す（次の機会にやり直す）。戻せなくても次のしきい値で再評価される。
        try { await markDevices(list, field, null); } catch (e) { /* 記録のみ */ }
        return 0;
      }
      return 1;
    })());
  }

  const done = await Promise.all(jobs);
  done.forEach(function (v) { results.push(v); });
  const sent = results.reduce(function (a, v) { return a + v; }, 0);
  return {
    sent: sent, confirmed: confirmed,
    confirms: plan.confirms.length, stales: plan.stales.length, unjudged: plan.unjudged.length,
  };
}

// ===== 認証（管理者）=====

/**
 * ID トークンからロールを解決する。
 * ★ api/_lib/mileage.js の resolveIdentity と同一の取り決め。
 *   移動距離の業務モジュール全体をここへ持ち込まないため、同じ6行を置いている。
 */
async function resolveIdentity(idToken) {
  let claims = null;
  try { claims = await G.verifyIdToken(idToken); } catch (e) { return null; }
  if (!claims || typeof claims.sub !== "string") return null;
  return { role: typeof claims.r === "string" ? claims.r : "", claims: claims };
}

/**
 * 管理者として有効か。
 * ★ r:"a" を特権として扱うので、/authz/adminMinAt による失効判定を必ず通す
 *   （管理者PIN・管理者URLの変更で旧セッションを締め出す既存の取り決め）。
 */
async function isValidAdmin(ident) {
  if (!ident || ident.role !== "a") return false;
  return await S.adminSessionValid(ident.claims);
}

module.exports = {
  ROOT,
  DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M,
  DEFAULT_DWELL_SEC, MIN_DWELL_SEC, MAX_DWELL_SEC,
  ACC_CAP_M, ACC_MAX_M,
  DEFAULT_STALE_SEC,
  ENROLL_TTL_MS, MAX_ENROLL_OPEN, MAX_FACILITIES, MAX_DEVICES,
  SWEEP_CONFIRM_MAX, DIGEST_LINES_MAX,
  PERM_VALUES,
  // 純粋関数
  normFacilityName, fkeyOf, isFkey, isDeviceId,
  newEnrollCode, isEnrollCode,
  normLat, normLng, isBadLat, isBadLng, normRadius, normDwellSec, normStaleSec, normAcc, normText,
  distanceM, facilityReady, evaluateReport, sweepPlan, splitPatchForSend, confirmPatch,
  jstStamp, buildMessage, buildDigest, hoursLabel,
  // I/O
  sendLine, loadFacilities, loadDevices, loadFacility, loadDevice,
  patchDevice, markDevices, ensureMeta, runSweep,
  resolveIdentity, isValidAdmin,
};
