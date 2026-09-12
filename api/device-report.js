/**
 * POST /api/device-report — 施設端末アプリからの登録・報告の唯一の窓口
 *
 * action:
 *   register : { code, platform, label, lat, lng, acc } → { deviceId, deviceToken, config }
 *   report   : { deviceId, deviceToken, event, lat, lng, acc, at, permission } → { state, config }
 *
 * ===== なぜ api/device.js と分けるか =====
 * こちらの呼び出し元はネイティブアプリで、Origin ヘッダを送らない。
 * api/_lib/http.js の guard は Origin 不在を拒否する（ブラウザ経由攻撃への多層防御）ため、
 * 同じ guard は使えない。代わりに次を守る。
 *
 *   ・Cookie を一切使わない（＝CSRF が原理的に成立しない）
 *   ・CORS 応答ヘッダを一切返さない → ブラウザからのクロスオリジン呼び出しは
 *     application/json のプリフライトが失敗して届かない
 *   ・認証は端末トークン（登録時に1度だけ発行し、以後ハッシュで突き合わせる）
 *   ・**IP単位のレート制限を最初に掛ける**（下記）
 *
 * ★★ 重い処理を認証の前に置いてはならない。★★
 *   このエンドポイントは Origin を見ない＝誰でも無認証で叩ける。
 *   RTDB は打刻（tc5_records）と honomi-board と同居しているため、ここで無認証の
 *   全件取得を許すと、打刻＝賃金側へ負荷が波及する。順序は必ず
 *   ①IP単位のレート制限 → ②端末1件の取得とトークン照合 → ③それ以外の取得
 *   とする。端末単位の上限は、既に読み込んだ lastSeenAt との差で見る（追加の往復を使わない）。
 *
 * ★ 判定（持ち出し確定・重複抑止・通知）はサーバ側にしかない。
 *   アプリは位置と権限状態を報告するだけで、通知の判断を持たない。
 */
"use strict";

const crypto = require("crypto");
const H = require("./_lib/http");
const G = require("./_lib/google");
const S = require("./_lib/secrets");
const D = require("./_lib/device");

const MIN_MS = 60;
const REGISTER_LIMIT_IP = 20;     // 10分窓。登録コードの総当たり抑止
const REPORT_LIMIT_IP = 120;      // 10分窓。無認証でも必ず通るゲート
// 同一端末の最短報告間隔（ms）。★ 追加の往復を使わず、既存の lastSeenAt との差で見る。
// 正常時の報告は15分間隔＋ジオフェンスのイベントなので、これで妨げられない。
const REPORT_MIN_INTERVAL_MS = 10 * 1000;

/** 基準位置として採用してよい測位精度（m）。これより粗い位置で基準を決めない。 */
const BASE_ACC_MAX_M = 100;

/**
 * スイープ（他端末の確定待ち・受信途絶・判定不能の評価）を走らせる最短間隔。
 * ★ 毎報告で走らせると、1端末の評価のために毎回 /devmon/facilities と /devmon/devices を
 *   全件読むことになる（端末50台で概算130MB/日）。RTDB は打刻と共有しているため無駄にできない。
 * ★ しきい値は確定=180秒・途絶=24時間なので、60秒間隔で取りこぼしは生じない。
 *   インスタンスをまたぐと多めに走るだけで、走らな過ぎる方向へは倒れない。
 */
// ★ 継続時間の最小値（MIN_DWELL_SEC=60秒）より必ず短く保つ。同値以上にすると、
//   dwell を最小へ下げたときに確定が最大2倍遅れる。
const SWEEP_MIN_INTERVAL_MS = Math.min(45 * 1000, D.MIN_DWELL_SEC * 1000 - 1000);
let _lastSweepAt = 0;

/**
 * 共通の前処理。戻り値 true ならこの時点で応答済み。
 * ★ CORS ヘッダは付けない（ブラウザから呼ばせない）。
 */
function guardApp(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(403).end(); return true; }
  if (req.method !== "POST") { H.fail(res, 405, "method_not_allowed"); return true; }
  const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") { H.fail(res, 415, "unsupported_media_type"); return true; }
  return false;
}

/** アプリへ返す設定。★ 他施設の情報・他端末の情報・トークンは返さない。 */
function viewConfig(fac, settings) {
  return {
    facilityName: fac ? String(fac.name || "") : "",
    lat: fac ? D.normLat(fac.lat) : null,
    lng: fac ? D.normLng(fac.lng) : null,
    radiusM: (fac && D.normRadius(fac.radiusM)) || D.DEFAULT_RADIUS_M,
    enabled: !!(fac && fac.enabled === true),
    dwellSec: settings.dwellSec,
    // アプリが定期報告する間隔の目安（秒）。サーバ側の受信途絶しきい値より十分短く。
    heartbeatSec: 900,
  };
}

/**
 * 監視の共通設定。
 * ★ 最も高頻度の経路（report）が毎回1往復払う必要はない。60秒だけウォームインスタンス内で
 *   使い回す。無期限にしてはならない（設定変更が反映されなくなる）。
 */
const SETTINGS_TTL_MS = 60 * 1000;
let _settingsCache = null, _settingsAt = 0;
async function loadSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsAt < SETTINGS_TTL_MS) return _settingsCache;
  const raw = await G.dbGet(D.ROOT + "/settings");
  const o = raw && typeof raw === "object" ? raw : {};
  _settingsCache = { dwellSec: D.normDwellSec(o.dwellSec), staleSec: D.normStaleSec(o.staleSec) };
  _settingsAt = now;
  return _settingsCache;
}

async function handleRegister(body) {
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!D.isEnrollCode(code)) return { status: 400, error: "bad_code" };

  // ★★ 登録コードの照合は register における唯一の資格情報である。
  //   これを他の取得と Promise.all で同時に開始してはならない（RULES.md「直列await」）。
  //   同時に始めると、不正なコードでも /devmon/devices の全件取得が必ず走る。
  const enroll = await G.dbGet(D.ROOT + "/enroll/" + code);
  if (!enroll || typeof enroll !== "object") return { status: 403, error: "bad_code" };
  if (!(Number(enroll.expiresAt) > Date.now())) return { status: 403, error: "code_expired" };
  if (!D.isFkey(enroll.fkey)) return { status: 500, error: "bad_enroll" };

  // 照合が通ってから、独立した取得だけを並列で行う。
  const [settings, devices] = await Promise.all([loadSettings(), D.loadDevices()]);

  let live = 0;
  for (const id of Object.keys(devices)) {
    const d = devices[id];
    if (d && typeof d === "object" && d.revoked !== true) live++;
  }
  if (live >= D.MAX_DEVICES) return { status: 409, error: "too_many_devices" };

  const deviceId = crypto.randomBytes(12).toString("base64url");
  const deviceToken = S.randomToken();
  const now = Date.now();
  const rec = {
    fkey: enroll.fkey,
    label: D.normText(body.label, 30) || "施設端末",
    platform: D.normText(body.platform, 20),
    tokenHash: S.tokenHash(deviceToken),
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    // ★ "inside" にしてはならない。位置を1度も判定していないので、
    //   管理画面が「範囲内（正常）」と表示すると事実と違う。
    state: "unknown",
    lastSeenAt: now,
    lastJudgedAt: 0,
  };

  // 基準位置を「登録する端末の現在地」にする指定があるときだけ、同じ原子的更新で書く。
  // ★ 指定が無ければ絶対に触らない（勝手に基準位置を動かさない）。
  const map = {};
  map[D.ROOT + "/enroll/" + code] = null;
  map[D.ROOT + "/devices/" + deviceId] = rec;

  const [fac0] = await Promise.all([D.loadFacility(enroll.fkey), D.ensureMeta()]);

  let baseSet = false, baseError = "";
  if (enroll.setBaseFromDevice === true) {
    const lat = D.normLat(body.lat), lng = D.normLng(body.lng);
    const acc = D.normAcc(body.acc);
    // ★ 既に基準位置が設定されている施設では上書きしない。
    //   setBaseFromDevice は発行時点の「未設定」を焼き込んだ値なので、
    //   発行後に管理者が手入力した基準位置を、古いコードでの登録が黙って動かしてしまう。
    const hasBase = !!(fac0 && D.normLat(fac0.lat) !== null && D.normLng(fac0.lng) !== null);
    if (hasBase) baseError = "base_already_set";
    else if (lat === null || lng === null) baseError = "no_position";
    else if (acc > BASE_ACC_MAX_M) baseError = "low_accuracy";
    else {
      map[D.ROOT + "/facilities/" + enroll.fkey + "/lat"] = lat;
      map[D.ROOT + "/facilities/" + enroll.fkey + "/lng"] = lng;
      map[D.ROOT + "/facilities/" + enroll.fkey + "/basedOn"] = "device";
      map[D.ROOT + "/facilities/" + enroll.fkey + "/updatedAt"] = new Date(now).toISOString();
      // 誰が動かしたかを残す（管理画面の updatedBy と同じ位置）
      map[D.ROOT + "/facilities/" + enroll.fkey + "/updatedBy"] = "device:" + deviceId;
      baseSet = true;
    }
  }

  // 施設設定が無い状態でも登録できるようにしておく（基準位置は後から管理画面で設定する）。
  // ★ enabled は true にしない。監視のON/OFFは必ず管理者の明示操作にする。
  if (!fac0) {
    map[D.ROOT + "/facilities/" + enroll.fkey + "/name"] = String(enroll.name || "");
    map[D.ROOT + "/facilities/" + enroll.fkey + "/radiusM"] = D.DEFAULT_RADIUS_M;
    map[D.ROOT + "/facilities/" + enroll.fkey + "/enabled"] = false;
    map[D.ROOT + "/facilities/" + enroll.fkey + "/createdAt"] = new Date(now).toISOString();
  }

  await G.dbPatchRoot(map);

  // 書込み後の値を返す（basedOn / lat / lng が反映されたもの）
  const fac = await D.loadFacility(enroll.fkey);
  return {
    status: 200, ok: true,
    deviceId: deviceId, deviceToken: deviceToken,
    baseSet: baseSet, baseError: baseError,
    config: viewConfig(fac || { name: enroll.name }, settings),
  };
}

async function handleReport(body) {
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const token = typeof body.deviceToken === "string" ? body.deviceToken : "";
  if (!D.isDeviceId(deviceId) || !token || token.length > 128) {
    return { status: 403, error: "forbidden" };
  }

  // ★ ①まず端末1件だけを取り、トークンを照合する。全件取得はこの後。
  const dev = await D.loadDevice(deviceId);
  if (!dev) return { status: 403, error: "forbidden" };
  if (!S.timingSafeEqualStr(S.tokenHash(token), String(dev.tokenHash || ""))) {
    return { status: 403, error: "forbidden" };
  }
  if (dev.revoked === true) return { status: 403, error: "revoked" };

  const nowMs = Date.now();
  // ★ ②同一端末の連打は、すでに読み込んだ lastSeenAt との差で弾く（往復を増やさない）。
  const seen = Number(dev.lastSeenAt) || 0;
  if (seen && nowMs - seen < REPORT_MIN_INTERVAL_MS) {
    return { status: 429, error: "too_frequent", retryAfter: 30 };
  }

  // ★ ③認証後に取得する。スイープを走らせる回だけ全件を読み、それ以外は自施設1件だけにする。
  const doSweep = (nowMs - _lastSweepAt) >= SWEEP_MIN_INTERVAL_MS;
  if (doSweep) _lastSweepAt = nowMs;
  let settings, facilities = null, fac = null, sweepDevices = null;
  if (doSweep) {
    [settings, facilities, sweepDevices] = await Promise.all([
      loadSettings(), D.loadFacilities(), D.loadDevices(),
    ]);
    fac = facilities[dev.fkey] && typeof facilities[dev.fkey] === "object" ? facilities[dev.fkey] : null;
  } else {
    [settings, fac] = await Promise.all([loadSettings(), D.loadFacility(dev.fkey)]);
  }

  const ev = D.evaluateReport(dev, {
    nowMs: nowMs,
    lat: body.lat, lng: body.lng, acc: body.acc,
    permission: body.permission,
  }, fac, settings);

  // ★★ 持ち出しの確定（state:"outside" / notifiedAt / pendingSince:null）は、
  //   LINE を**送れてから**書く。先に書くと、送信失敗の巻き戻しに失敗した時点で
  //   「通知済み・確定済み」が残り、evaluateReport も sweepPlan も二度と拾わないため
  //   **その持ち出しのアラートが完全に失われる**。
  //   先に書くのは観測値（lastSeenAt / lastDistM / lastJudgedAt / pendingSince）だけにする。
  const exitNt = ev.notify.find(function (x) { return x.kind === "exit"; }) || null;
  const firstPatch = D.splitPatchForSend(ev.patch, exitNt, nowMs);
  await D.patchDevice(deviceId, firstPatch);

  for (const nt of ev.notify) {
    // 通知の可否判定は evaluateReport が済ませている。ここでは送信だけ。
    const okSent = await D.sendLine(D.buildMessage(nt.kind, {
      facilityName: fac ? fac.name : "", atMs: nowMs, detail: nt.detail,
    }));
    if (okSent) {
      if (nt.kind === "exit") {
        // 送れたのでここで確定させる。★ 失敗しても未確定のままなので取り逃さない
        //   （次の報告かスイープが再送する。重複は出るが、取り逃しより軽い）。
        try {
          await D.patchDevice(deviceId, D.confirmPatch(nowMs));
          Object.assign(firstPatch, D.confirmPatch(nowMs));   // 応答を実際の保存内容へ合わせる
        } catch (e) { console.error("[device-report] confirm patch failed"); }
      }
      continue;
    }
    console.error("[device-report] notify failed kind=" + nt.kind);
    if (nt.kind === "permission") {
      // ★ permState は "lost"（事実）のまま残す。通知済みの印だけを消して再アームする。
      //   permState を戻すと管理画面が「権限は正常」と事実と逆の表示になる。
      try { await D.patchDevice(deviceId, { permNotifiedAt: null }); } catch (e) { /* 次の報告で再評価 */ }
    }
  }

  // 他の端末の確定待ち・受信途絶・判定不能も、この機会に評価する（定期実行を持たないため）。
  // ★ 全件を読んだ回だけ。読んでいない回に評価すると、対象が無いのに「正常」と誤認しうる。
  if (doSweep && facilities && sweepDevices) {
    try {
      const others = {};
      for (const id of Object.keys(sweepDevices)) if (id !== deviceId) others[id] = sweepDevices[id];
      await D.runSweep(facilities, others, nowMs, settings);
    } catch (e) { console.error("[device-report] sweep failed"); }
  }

  // ★ ev.patch ではなく firstPatch（＝実際に保存した内容）からを作る。
  //   ev.patch を使うと、LINE 送信に失敗して確定していないのに state:"outside" を返す。
  const merged = Object.assign({}, dev, firstPatch);
  // ★ judged（位置判定が成立したか）は返さない。アプリは使わないうえ、
  //   改造クライアントに「acc を粗く送れば判定を回避できた」ことを即座に教えるオラクルになる。
  return {
    status: 200, ok: true,
    state: String(merged.state || "unknown"),
    pending: Number(merged.pendingSince) > 0,
    distM: ev.distM === null ? null : Math.round(ev.distM),
    config: viewConfig(fac, settings),
  };
}

module.exports = async function handler(req, res) {
  if (guardApp(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const action = H.str(body.action, 32);
    if (action !== "register" && action !== "report") {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_action");
    }

    // ★ 認証より前に必ず通るゲート。Origin を見ないエンドポイントなので、
    //   これが唯一の「無認証の攻撃者に対する上限」である。
    const ipKey = S.sanitizeKey(H.clientIp(req));
    const n = await S.bumpAndCount(action === "register" ? "dvm_g" : "dvm_i", ipKey);
    if (n > (action === "register" ? REGISTER_LIMIT_IP : REPORT_LIMIT_IP)) {
      res.setHeader("Retry-After", "600");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }

    const r = action === "register" ? await handleRegister(body) : await handleReport(body);

    if (r.retryAfter) res.setHeader("Retry-After", String(r.retryAfter));
    await H.withMinDuration(startedAt, MIN_MS);
    const status = r.status || 200;
    const payload = Object.assign({}, r);
    delete payload.status;
    delete payload.retryAfter;
    return res.status(status).json(payload);
  } catch (e) {
    console.error("[device-report]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
