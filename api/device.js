/**
 * POST /api/device — 施設端末の持ち出し監視「管理者側」の唯一の窓口
 *
 * 入力 : { idToken, action, ...params }
 * 出力 : { ok:true, ... } / 失敗は { error: <code> }
 *
 * ===== 権限 =====
 *   role "a"（管理者）だけ。adminSessionValid 必須。
 *   職員・労務士・デモ・サンドボックス・匿名は全 action 拒否。
 *   ★ 監視設定を職員が触れる場所に置かないための API である。ロールを緩めてはならない。
 *
 * 端末アプリからの登録・報告は別エンドポイント（api/device-report.js）。
 * こちらは Origin 許可リスト（ブラウザ経由）を必須にする。
 */
"use strict";

const H = require("./_lib/http");
const G = require("./_lib/google");
const S = require("./_lib/secrets");
const D = require("./_lib/device");

const MIN_MS = 60;
const WRITE_LIMIT_ADMIN = 120;
const READ_LIMIT_ADMIN = 120;

const ACTIONS = {
  bootstrap: ["a"],
  setFacility: ["a"],
  deleteFacility: ["a"],
  issueEnroll: ["a"],
  revokeDevice: ["a"],
};

const WRITE_ACTIONS = { setFacility: 1, deleteFacility: 1, issueEnroll: 1, revokeDevice: 1 };

/** 監視の共通設定。UI は持たない（設定画面を増やさない）。未設定なら既定値。 */
async function loadSettings() {
  const raw = await G.dbGet(D.ROOT + "/settings");
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    dwellSec: D.normDwellSec(o.dwellSec),
    staleSec: D.normStaleSec(o.staleSec),
    defaultRadiusM: D.normRadius(o.defaultRadiusM) || D.DEFAULT_RADIUS_M,
  };
}

/** 画面へ返す施設設定（内部キーを増やさない）。 */
function viewFacility(fkey, f) {
  return {
    fkey: fkey,
    name: String(f.name || ""),
    lat: D.normLat(f.lat),
    lng: D.normLng(f.lng),
    radiusM: D.normRadius(f.radiusM),
    enabled: f.enabled === true,
    updatedAt: String(f.updatedAt || ""),
  };
}

/** 画面へ返す端末情報。★ 端末トークンとそのハッシュは絶対に返さない。 */
function viewDevice(id, d) {
  return {
    deviceId: id,
    fkey: String(d.fkey || ""),
    label: String(d.label || ""),
    platform: String(d.platform || ""),
    state: String(d.state || ""),
    // ★ 判定が成立しているかを必ず返す。返さないと管理画面が
    //   「報告は来ているが位置を判定できていない」端末を正常として表示してしまう。
    lastJudgedAt: Number(d.lastJudgedAt) || 0,
    lastAccM: Number(d.lastAccM) || 0,
    pendingSince: Number(d.pendingSince) || 0,
    permState: String(d.permState || ""),
    permDetail: String(d.permDetail || ""),
    lastSeenAt: Number(d.lastSeenAt) || 0,
    lastDistM: Number(d.lastDistM) || 0,
    createdAt: String(d.createdAt || ""),
    revoked: d.revoked === true,
  };
}

async function handleBootstrap() {
  const [settings, facilities, devices] = await Promise.all([
    loadSettings(), D.loadFacilities(), D.loadDevices(),
  ]);
  // ★ 定期実行（action:"sweep"）が止まったときの保険として、管理画面を開いた時点でも評価する。
  //   確定待ちの持ち出し・受信途絶・判定できていない端末をここで拾う。
  //   ＝この読み取りは LINE 送信と書き込みを伴う（bootstrap を純粋な読取として扱わない）。
  //   失敗しても画面表示は妨げない（通知できなかっただけで設定は正しく返す）。
  let devList0 = devices;
  try {
    const r = await D.runSweep(facilities, devices, Date.now(), settings);
    // ★ スイープが持ち出しを確定させた場合だけ、端末一覧を取り直して返す。
    //   取り直さないと「LINE では持ち出し検知なのに、画面は範囲外を確認中」という
    //   食い違いが、このセッションのあいだ（booted=true）ずっと残る。
    //   受信途絶・判定不能の印（*NotifiedAt）は画面へ返さないので取り直す必要はない。
    if (r && r.confirmed > 0) devList0 = await D.loadDevices();
  } catch (e) {
    console.error("[device] sweep failed");
  }
  const facList = [];
  for (const k of Object.keys(facilities)) {
    const f = facilities[k];
    if (f && typeof f === "object") facList.push(viewFacility(k, f));
  }
  const devList = [];
  for (const id of Object.keys(devList0)) {
    const d = devList0[id];
    if (d && typeof d === "object") devList.push(viewDevice(id, d));
  }
  devList.sort(function (a, b) { return (b.lastSeenAt || 0) - (a.lastSeenAt || 0); });
  return {
    status: 200, ok: true,
    settings: settings,
    facilities: facList,
    devices: devList,
  };
}

async function handleSetFacility(body, actor) {
  const name = D.normText(body.name, 40);
  if (!name) return { status: 400, error: "bad_name" };
  const fkey = D.fkeyOf(name);
  if (!D.isFkey(fkey)) return { status: 400, error: "bad_name" };

  const facilities = await D.loadFacilities();
  const cur = facilities[fkey] && typeof facilities[fkey] === "object" ? facilities[fkey] : null;
  if (!cur && Object.keys(facilities).length >= D.MAX_FACILITIES) {
    return { status: 409, error: "too_many_facilities" };
  }

  // ★ 「送られていない」と「不正な値」を区別する。区別しないと、入力ミス（NaN → JSON で null）が
  //   「未設定」として既存値へ黙ってフォールバックし、保存に成功したように見える。
  if (D.isBadLat(body.lat) || D.isBadLng(body.lng)) {
    return { status: 400, error: "bad_position" };
  }
  // ★ 座標が送られていないときは既存値を保つ。監視OFFへ切り替えるだけで
  //   基準位置が消えると、再度ONにしたときに設定をやり直すことになる。
  let lat = D.normLat(body.lat);
  let lng = D.normLng(body.lng);
  if (lat === null || lng === null) {
    lat = cur ? D.normLat(cur.lat) : null;
    lng = cur ? D.normLng(cur.lng) : null;
  }
  let radiusM = D.normRadius(body.radiusM);
  if (radiusM === null) radiusM = cur ? D.normRadius(cur.radiusM) : null;

  const enabled = body.enabled === true;
  if (enabled && (lat === null || lng === null)) return { status: 400, error: "base_position_required" };
  if (enabled && radiusM === null) return { status: 400, error: "bad_radius" };
  // 明示的に不正な半径が送られた場合は、既定へ丸めず拒否する
  if (body.radiusM !== undefined && body.radiusM !== null && body.radiusM !== ""
      && D.normRadius(body.radiusM) === null) {
    return { status: 400, error: "bad_radius" };
  }

  const rec = {
    name: name,
    lat: lat, lng: lng,
    // ★ 施設ノードは全置換で書くので、register が書いた basedOn を引き継ぐ。
    //   引き継がないと「基準位置をどこから取ったか」が保存のたびに消える。
    basedOn: cur && cur.basedOn ? String(cur.basedOn) : (lat === null ? "" : "manual"),
    radiusM: radiusM === null ? D.DEFAULT_RADIUS_M : radiusM,
    enabled: enabled,
    createdAt: cur && cur.createdAt ? String(cur.createdAt) : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: String(actor || ""),
  };
  await D.ensureMeta();

  // ★ 判定の前提（基準位置・半径・ON/OFF）が変わったら、その施設の端末の
  //   「範囲外の継続観測」を捨てる。捨てないと、古い前提で付いた pendingSince が残り、
  //   現在位置を1度も判定しないまま「範囲外へ移動しました」を送ってしまう
  //   （監視OFF→後日ON、基準位置の訂正の直後に起きる）。
  const changed = !cur || D.normLat(cur.lat) !== lat || D.normLng(cur.lng) !== lng
    || D.normRadius(cur.radiusM) !== rec.radiusM || (cur.enabled === true) !== enabled;
  const map = {};
  map[D.ROOT + "/facilities/" + fkey] = rec;
  if (changed) {
    const now2 = Date.now();
    const [devices, st2] = await Promise.all([D.loadDevices(), loadSettings()]);
    const staleMs2 = st2.staleSec * 1000;
    for (const id of Object.keys(devices)) {
      // ★ 形式が不正なキーを多重パスへ連結してはならない。1つ混じると dbPatchRoot が
      //   例外になり、その施設の設定保存が以後すべて失敗する。
      if (!D.isDeviceId(id)) continue;
      const d = devices[id];
      if (!d || typeof d !== "object" || d.fkey !== fkey || d.revoked === true) continue;
      // ★ 「その施設の全端末」を判定やり直しにする（pendingSince を持つ端末だけでは足りない）。
      //   基準位置を直した直後、旧基準で "inside" だった端末は
      //   「古い判定のまま緑（監視中）」に見える。新しい基準で1度も判定していないので、
      //   管理画面は「監視ON（判定待ち）」でなければならない。
      // ★ 確定済み（state:"outside"）は消さない。持ち出し中の事実が管理画面から消えてしまう。
      if (d.state !== "outside") {
        map[D.ROOT + "/devices/" + id + "/pendingSince"] = null;
        map[D.ROOT + "/devices/" + id + "/state"] = "unknown";
      }
      // ★ しきい値ぶんの猶予を与える。監視OFFのあいだ lastJudgedAt は進まないため、
      //   OFF が長引いたあと ON へ戻すと、その場のスイープが即座に
      //   「位置を判定できていません」を送ってしまう（ONにした本人が誤アラートを受ける）。
      //   端末が次の報告をするまでの猶予として、通知済みの印を now にする。
      map[D.ROOT + "/devices/" + id + "/unjudgedNotifiedAt"] = now2;
      // ★ 受信途絶の猶予は「保存時点でまだ沈黙していない端末」だけに与える。
      //   lastSeenAt は監視OFFでも進むので、すでに沈黙している端末＝**本物の異常**である。
      //   無条件に猶予すると、その通知を最大しきい値ぶん（計48時間）遅らせてしまう。
      if (now2 - (Number(d.lastSeenAt) || 0) < staleMs2) {
        map[D.ROOT + "/devices/" + id + "/staleNotifiedAt"] = now2;
      }
    }
  }
  await G.dbPatchRoot(map);
  return { status: 200, ok: true, facility: viewFacility(fkey, rec) };
}

/**
 * 施設の監視を止める（拠点マスタから施設を削除したときに呼ぶ）。
 * ★ 設定を消すだけにしてはならない。その施設に紐づいた端末が残っていると、
 *   存在しない施設の名前で通知が出続ける。端末も同時に無効化する。
 */
async function handleDeleteFacility(body, actor) {
  const fkey = D.isFkey(body.fkey) ? body.fkey : D.fkeyOf(D.normText(body.name, 40));
  if (!D.isFkey(fkey)) return { status: 400, error: "bad_name" };
  const [facilities, devices] = await Promise.all([D.loadFacilities(), D.loadDevices()]);
  if (!facilities[fkey]) return { status: 200, ok: true, removed: 0 };

  const map = {};
  map[D.ROOT + "/facilities/" + fkey] = null;
  let n = 0;
  for (const id of Object.keys(devices)) {
    const d = devices[id];
    if (!d || typeof d !== "object" || d.fkey !== fkey) continue;
    map[D.ROOT + "/devices/" + id + "/revoked"] = true;
    map[D.ROOT + "/devices/" + id + "/revokedAt"] = new Date().toISOString();
    map[D.ROOT + "/devices/" + id + "/revokedBy"] = String(actor || "");
    n++;
  }
  await G.dbPatchRoot(map);
  return { status: 200, ok: true, removed: n };
}

/**
 * 端末登録コードの発行。
 * ★ 端末側はこのコードでしか登録できない（勝手に端末を増やせない）。
 */
async function handleIssueEnroll(body, actor) {
  const name = D.normText(body.name, 40);
  if (!name) return { status: 400, error: "bad_name" };
  const fkey = D.fkeyOf(name);
  if (!D.isFkey(fkey)) return { status: 400, error: "bad_name" };

  const raw = await G.dbGet(D.ROOT + "/enroll");
  const now = Date.now();
  const open = {};
  const expired = [];
  if (raw && typeof raw === "object") {
    for (const c of Object.keys(raw)) {
      const r = raw[c];
      if (r && typeof r === "object" && Number(r.expiresAt) > now) open[c] = r;
      else if (D.isEnrollCode(c)) expired.push(c);
    }
  }
  if (Object.keys(open).length >= D.MAX_ENROLL_OPEN) return { status: 429, error: "too_many_codes" };

  let code = D.newEnrollCode();
  // 衝突は事実上起きないが、既存コードを上書きして他施設の登録を奪わないようにする
  for (let i = 0; i < 5 && Object.prototype.hasOwnProperty.call(open, code); i++) code = D.newEnrollCode();
  if (Object.prototype.hasOwnProperty.call(open, code)) return { status: 500, error: "code_conflict" };

  const rec = {
    fkey: fkey, name: name,
    setBaseFromDevice: body.setBaseFromDevice === true,
    expiresAt: now + D.ENROLL_TTL_MS,
    createdAt: new Date().toISOString(),
    createdBy: String(actor || ""),
  };
  await D.ensureMeta();
  // ★ 期限切れのコードは同じ更新で片付ける。RTDB に TTL は無いので、
  //   放置すると /devmon/enroll が伸び続け、発行のたびに全件を読むことになる。
  const map = {};
  map[D.ROOT + "/enroll/" + code] = rec;
  expired.slice(0, 50).forEach(function (c) { map[D.ROOT + "/enroll/" + c] = null; });
  await G.dbPatchRoot(map);
  return {
    status: 200, ok: true, code: code, expiresAt: rec.expiresAt,
    setBaseFromDevice: rec.setBaseFromDevice, name: name,
  };
}

async function handleRevokeDevice(body, actor) {
  const id = body.deviceId;
  if (!D.isDeviceId(id)) return { status: 400, error: "bad_device" };
  const dev = await D.loadDevice(id);
  if (!dev) return { status: 404, error: "not_found" };
  await D.patchDevice(id, {
    revoked: true, revokedAt: new Date().toISOString(), revokedBy: String(actor || ""),
  });
  return { status: 200, ok: true };
}

module.exports = async function handler(req, res) {
  if (H.guard(req, res)) return;
  const startedAt = Date.now();
  const cid = H.correlationId();

  try {
    const body = req.body || {};
    const action = H.str(body.action, 32);
    const allowed = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
    if (!allowed) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 400, "bad_action");
    }

    const ident = await D.resolveIdentity(H.str(body.idToken, 4096));
    if (!ident || allowed.indexOf(ident.role) < 0) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "forbidden");
    }
    if (!(await D.isValidAdmin(ident))) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "session_revoked");
    }

    const actor = (typeof ident.claims.t === "string" && ident.claims.t)
      ? ("admin:" + ident.claims.t) : "admin";

    const kind = Object.prototype.hasOwnProperty.call(WRITE_ACTIONS, action) ? "dvm_w" : "dvm_r";
    const limit = kind === "dvm_w" ? WRITE_LIMIT_ADMIN : READ_LIMIT_ADMIN;
    const n = await S.bumpAndCount(kind, S.sanitizeKey(actor));
    if (n > limit) {
      res.setHeader("Retry-After", "600");
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 429, "rate_limited");
    }

    let r;
    switch (action) {
      case "bootstrap": r = await handleBootstrap(); break;
      case "setFacility": r = await handleSetFacility(body, actor); break;
      case "deleteFacility": r = await handleDeleteFacility(body, actor); break;
      case "issueEnroll": r = await handleIssueEnroll(body, actor); break;
      case "revokeDevice": r = await handleRevokeDevice(body, actor); break;
      default: r = { status: 400, error: "bad_action" };
    }

    await H.withMinDuration(startedAt, MIN_MS);
    const status = r.status || 200;
    const payload = Object.assign({}, r);
    delete payload.status;
    return res.status(status).json(payload);
  } catch (e) {
    console.error("[device]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};

module.exports.ACTIONS = ACTIONS;
module.exports.WRITE_ACTIONS = WRITE_ACTIONS;
