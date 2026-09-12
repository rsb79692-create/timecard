"use strict";
/**
 * devicewatch/src/watch.js — 施設端末の持ち出し監視（アプリ側の全ロジック）
 *
 * ★ このアプリは「位置と権限状態をサーバへ報告する」だけである。
 *   持ち出しの確定（3分継続）・重複抑止（1回だけ通知）・LINE送信は
 *   すべてサーバ（api/device-report.js）にある。
 *   アプリを書き換えても判定を変えられないようにするため、ここに判定を置かない。
 *
 * ★ 勤怠機能は一切入れない（打刻・履歴・スタッフ一覧・帳票は持たない）。
 *   個人データを一切扱わないので、端末に残るのは deviceId / deviceToken / 施設の基準位置だけ。
 *
 * ★ JSX を使わない。ビルド環境が無くても `node --check` で構文検査できるようにしてある。
 */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// 既存の Vercel（通知・移動距離と同じデプロイ）。通知基盤を新設しない。
export const API_URL = "https://timecard-rho.vercel.app/api/device-report";

export const TASK_GEOFENCE = "honomi-devicewatch-geofence";
export const TASK_LOCATION = "honomi-devicewatch-location";
const REGION_ID = "facility";

const K_ID = "dw_device_id";
const K_TOKEN = "dw_device_token";
const K_CONFIG = "dw_config";

// 定期報告の目安。サーバの受信途絶しきい値（24時間）より十分短い。
// ★ iOS は静止している端末への背景実行を保証しない。これは「守られる約束」ではなく目安である。
const HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * 位置更新きっかけの報告の最短間隔（ms）。
 * ★ これが無いと移動中に報告が殺到する。timeInterval は Android のみ有効で、
 *   iOS は distanceInterval で駆動されるため、時速50kmなら数十秒ごとに起こされる。
 *   サーバ側のIP上限（10分120回）へ当たると、**まさに検知したい持ち出し中に弾かれる**。
 * ★ ジオフェンスの enter/exit と画面操作はこの間隔を無視する（検知の遅れを作らないため）。
 * ★ 持ち出しの確定はサーバ受信時刻で測るので、間隔が継続時間（既定180秒）より長くても
 *   「次の報告」か管理画面のスイープで確定する。
 */
const REPORT_THROTTLE_MS = 120 * 1000;
const K_LAST_REPORT = "dw_last_report_at";
// ★ メモリだけで持ってはならない。背景タスクは新しい JS コンテキストで起こされることがあり、
//   0 に戻ると間引きが効かなくなる（移動中に報告が殺到してレート制限へ当たる）。
let _lastReportAt = 0;
async function loadLastReportAt() {
  if (_lastReportAt) return _lastReportAt;
  try {
    const v = Number(await SecureStore.getItemAsync(K_LAST_REPORT));
    if (isFinite(v) && v > 0) _lastReportAt = v;
  } catch (e) { /* 取得できなければ 0 のまま（間引かない側＝安全側） */ }
  return _lastReportAt;
}
async function markReported(at) {
  _lastReportAt = at;
  try { await SecureStore.setItemAsync(K_LAST_REPORT, String(at)); } catch (e) { /* 次回はメモリ値で判定 */ }
}

// ===== 保存（端末内のみ。サーバへは何も同期しない）=====

export async function loadCreds() {
  const id = await SecureStore.getItemAsync(K_ID);
  const token = await SecureStore.getItemAsync(K_TOKEN);
  let config = null;
  try { config = JSON.parse((await SecureStore.getItemAsync(K_CONFIG)) || "null"); } catch (e) { config = null; }
  if (!id || !token) return null;
  return { deviceId: id, deviceToken: token, config: config };
}

async function saveCreds(id, token, config) {
  await SecureStore.setItemAsync(K_ID, String(id));
  await SecureStore.setItemAsync(K_TOKEN, String(token));
  await saveConfig(config);
}

export async function saveConfig(config) {
  await SecureStore.setItemAsync(K_CONFIG, JSON.stringify(config || null));
}

export async function clearCreds() {
  await SecureStore.deleteItemAsync(K_ID);
  await SecureStore.deleteItemAsync(K_TOKEN);
  await SecureStore.deleteItemAsync(K_CONFIG);
}

// ===== 権限 =====

/**
 * サーバへ申告する権限状態。サーバ側 PERM_VALUES と同じ語を使う。
 *   always     … 常に許可（これでないと持ち出しを検知できない）
 *   whenInUse  … 使用中のみ
 *   denied     … 拒否
 *   off        … 端末の位置情報サービスがOFF
 *   restricted … OSの制限
 */
export async function permissionState() {
  try {
    const on = await Location.hasServicesEnabledAsync();
    if (!on) return "off";
    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== "granted") return "denied";
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.status === "granted") return "always";
    if (bg.status === "restricted") return "restricted";
    return "whenInUse";
  } catch (e) {
    return "";   // 不明。サーバは不明な値で状態を変えない
  }
}

/** 権限を順番に要求する。★ 前景 → 背景の順でしか要求できない（OS仕様）。 */
export async function requestPermissions() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return { ok: false, reason: "foreground" };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") return { ok: false, reason: "background" };
  return { ok: true };
}

// ===== 位置 =====

async function currentPosition() {
  try {
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    if (p && p.coords) return p.coords;
  } catch (e) { /* 取得できないことはある */ }
  try {
    const p = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
    if (p && p.coords) return p.coords;
  } catch (e) { /* 無ければ位置なしで報告する */ }
  return null;
}

// ===== サーバへの報告 =====

/**
 * ★ 例外を外へ投げない。投げると呼び出し側（App.js のボタン）が catch を持たない限り
 *   「登録中…」のまま固まり、アプリを再起動するしかなくなる。
 */
async function postJson(payload) {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  } catch (e) {
    return { ok: false, status: 0, data: null };
  }
}

/**
 * 登録コードで端末を登録する。成功すると端末トークンを受け取り、監視を開始する。
 */
export async function register(code) {
  const coords = await currentPosition();
  const r = await postJson({
    action: "register",
    code: String(code || "").trim().toUpperCase(),
    platform: Platform.OS,
    label: Platform.OS === "ios" ? "iPhone" : "Android",
    lat: coords ? coords.latitude : null,
    lng: coords ? coords.longitude : null,
    acc: coords ? coords.accuracy : null,
  });
  if (!r.ok || !r.data || !r.data.ok) {
    return { ok: false, error: (r.data && r.data.error) || "network", status: r.status };
  }
  await saveCreds(r.data.deviceId, r.data.deviceToken, r.data.config);
  // ★ サーバ登録は済んでいる。監視の開始に失敗しても「登録できませんでした」にしてはならない
  //   （同じコードは二度使えないため、利用者が再登録できなくなる）。
  let watchError = "";
  try {
    const w = await startWatch(r.data.config);
    if (w && w.ok === false) watchError = w.error || "";
  } catch (e) { watchError = "start_failed"; }
  return { ok: true, config: r.data.config, baseSet: !!r.data.baseSet,
           baseError: r.data.baseError || "", watchError: watchError };
}

/**
 * 位置と権限状態を1回報告する。
 * ★ 応答に入っている設定（基準位置・半径）が変わっていたらジオフェンスを張り直す。
 *   管理者が基準位置を直したときに、古い範囲で監視し続けないため。
 */
export async function report(event) {
  const creds = await loadCreds();
  if (!creds) return { ok: false, error: "not_registered" };
  await markReported(Date.now());
  const coords = await currentPosition();
  const perm = await permissionState();
  const r = await postJson({
    action: "report",
    deviceId: creds.deviceId,
    deviceToken: creds.deviceToken,
    event: String(event || "heartbeat"),
    at: new Date().toISOString(),
    lat: coords ? coords.latitude : null,
    lng: coords ? coords.longitude : null,
    acc: coords ? coords.accuracy : null,
    permission: perm,
  });
  if (r.status === 403 && r.data && r.data.error === "revoked") {
    // 管理者が解除した端末。監視を止めて資格情報も消す。
    await stopWatch();
    await clearCreds();
    return { ok: false, error: "revoked" };
  }
  if (r.ok && r.data && r.data.config) {
    const before = creds.config || {};
    const after = r.data.config;
    await saveConfig(after);
    if (before.lat !== after.lat || before.lng !== after.lng
      || before.radiusM !== after.radiusM || before.enabled !== after.enabled) {
      await startWatch(after);
    }
  }
  return {
    ok: !!(r.ok && r.data && r.data.ok), data: r.data, status: r.status,
    error: (r.data && r.data.error) || (r.ok ? "" : "network"),
  };
}

// ===== 監視の開始・停止 =====

/**
 * OSのジオフェンスへ登録し、併せて低精度の位置更新を動かす。
 *
 * ★ ジオフェンスだけでは足りない。持ち出しの確定にはサーバ受信時刻で3分以上離れた
 *   2回目の報告が必要で、iOS の region monitoring は「出た瞬間」しか起こしてくれない。
 *   移動中は位置更新が届くため、2回目の報告はそこで入る。
 * ★ したがって通知は「範囲外になってから3分後ちょうど」ではなく、
 *   「3分以上経ったあとの最初の報告」で出る。遅れることがある。
 */
export async function startWatch(config) {
  const c = config || {};
  // ★★ 監視OFFのときに監視を止めてはならない（2026-09-12 の監査で差し戻した）。
  //   stopWatch() はジオフェンスと位置更新の両方を止めるが、report() を呼ぶ自動契機は
  //   その2つだけである。止めると端末は**新しい設定を取りに来る手段を失い**、
  //   管理者が監視をONに戻しても、施設のスマホでアプリを開くまで再開しない。
  //   OFF のあいだはサーバ側が判定・通知の対象から外すので、報告が届いても何も起きない
  //   （lastSeenAt だけ進む）。「OFF が端末へ伝わらない」ことより、
  //   「ON に戻しても再開しない」ことのほうが重い。
  if (!(Number(c.radiusM) > 0) || typeof c.lat !== "number" || typeof c.lng !== "number") {
    return { ok: false, error: "no_base_position" };
  }
  await stopWatch();
  // ★ ここで例外が出ると、ジオフェンスも位置更新も止まったまま（report の自動契機が両方消える）
  //   になる。失敗を握り潰さず、画面へ出せる形で返す（次にアプリを開けば ensureWatching が張り直す）。
  try {
    await Location.startGeofencingAsync(TASK_GEOFENCE, [{
      identifier: REGION_ID,
      latitude: c.lat,
      longitude: c.lng,
      radius: Math.max(50, Number(c.radiusM)),
      notifyOnEnter: true,
      notifyOnExit: true,
    }]);
  } catch (e) {
    return { ok: false, error: "geofence_failed" };
  }
  try {
    await Location.startLocationUpdatesAsync(TASK_LOCATION, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: HEARTBEAT_MS,          // Android で効く
      // ★ 起床距離。報告の回数は REPORT_THROTTLE_MS（120秒）で頭打ちになるので、
      //   ここを大きくしてもレート制限の保護は増えない。一方で大きすぎると
      //   「施設の数百m先へ持ち出してそのまま置かれた」場合に2回目の報告が発生せず、
      //   確定がサーバ側スイープ（＝他端末の報告か管理画面の表示）だけに依存する。
      //   許容半径（既定150m）と同程度にして、検知の確実性を優先する。
      distanceInterval: 200,
      deferredUpdatesInterval: HEARTBEAT_MS,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: "施設端末の位置を確認しています",
        notificationBody: "施設からの持ち出しを検知するために動作しています",
        notificationColor: "#1e40af",
      },
    });
  } catch (e) {
    // 位置更新が張れなくてもジオフェンスは動く。監視自体は成立させる。
  }
  return { ok: true };
}

export async function stopWatch() {
  try {
    if (await Location.hasStartedGeofencingAsync(TASK_GEOFENCE)) {
      await Location.stopGeofencingAsync(TASK_GEOFENCE);
    }
  } catch (e) { /* 未開始 */ }
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TASK_LOCATION)) {
      await Location.stopLocationUpdatesAsync(TASK_LOCATION);
    }
  } catch (e) { /* 未開始 */ }
}

export async function isWatching() {
  try { return await Location.hasStartedGeofencingAsync(TASK_GEOFENCE); } catch (e) { return false; }
}

/**
 * 監視が落ちていたら張り直す（自己復旧）。
 * ★ OS がジオフェンスを落とすことがあり、アプリを開いても「停止中」と表示するだけでは
 *   誰も直せない。開いた時点で保存済みの設定から張り直す。
 */
export async function ensureWatching() {
  const creds = await loadCreds();
  if (!creds || !creds.config) return { ok: false, error: "not_registered" };
  if (await isWatching()) return { ok: true };
  try { return await startWatch(creds.config); } catch (e) { return { ok: false, error: "start_failed" }; }
}

// ===== 背景タスク =====
// ★ defineTask はモジュールの読み込み時に必ず実行される位置へ置く（OSがアプリを
//   背景で起こしたときにタスク名が登録済みでなければイベントを受け取れない）。

TaskManager.defineTask(TASK_GEOFENCE, async function (body) {
  if (body && body.error) return;
  const ev = body && body.data ? body.data.eventType : null;
  const kind = ev === Location.GeofencingEventType.Exit ? "exit"
    : ev === Location.GeofencingEventType.Enter ? "enter" : "geofence";
  try {
    const r = await report(kind);
    // ★ 直前に定期報告が走っていると、サーバの最短間隔（10秒）で弾かれることがある。
    //   ジオフェンスの出入りは**継続計測の開始時刻そのもの**なので、落としてはならない。
    //   1回だけ待ってやり直す（ここで落とすと、確定が次の定期報告まで遅れる）。
    if (r && r.error === "too_frequent") {
      await new Promise(function (res) { setTimeout(res, 12000); });
      await report(kind);
    }
  } catch (e) { /* 次の契機で送り直す */ }
});

TaskManager.defineTask(TASK_LOCATION, async function (body) {
  if (body && body.error) return;
  // ★ 位置更新きっかけの報告だけ間隔を空ける（ジオフェンスのイベントは間引かない）。
  const last = await loadLastReportAt();
  if (last && Date.now() - last < REPORT_THROTTLE_MS) return;
  try { await report("heartbeat"); } catch (e) { /* 次の契機で送り直す */ }
});
