/**
 * POST /api/mileage — 移動距離申請の唯一のサーバ窓口
 *
 * ★ 読み取りも書き込みも、すべてこのエンドポイントを通す。
 *   データは RTDB のルート直下 /mileage（Rules 未定義＝デフォルト拒否）にあり、
 *   クライアントからは直接読み書きできない。＝UI非表示ではなくサーバ側の権限制御。
 *
 * 入力 : { idToken, action, ...params }
 * 出力 : { ok:true, ... } / 失敗は { error: <code> }
 *
 * ===== 権限マトリクス（ACTIONS が唯一の正本）=====
 *   role "s"(職員) : 自分の申請の参照・作成・更新・削除のみ。利用ON必須。
 *   role "a"(管理者): マスタ・単価・利用ON/OFF・承認・月次確定。adminSessionValid 必須。
 *   role "v"(労務士): 確定済み月次データの参照のみ。書込系は role 判定で必ず拒否。
 *   それ以外（匿名・デモ・サンドボックス）: 全 action 拒否。
 *
 * ★ 職員の社員番号は「トークンから解決」する。body の申告は使わない。
 *   使うと、ONの職員が他人の社員番号を送るだけで他人のデータへ到達できる。
 */
"use strict";

const H = require("./_lib/http");
const G = require("./_lib/google");
const S = require("./_lib/secrets");
const M = require("./_lib/mileage");

const MIN_MS = 60;

// 書込系の上限（10分窓）。1日1件の申請にこの回数は通常あり得ない。
// ★ 上限を設けないと、認証済みの1名でも /mileage/audit を無制限に増やせる
//   （RTDB に TTL は無く、肥大化すると管理画面の取得も重くなる）。
// ★ 打刻のような賃金事故に直結する経路ではないので、ここはハード上限（429）でよい。
const WRITE_LIMIT_STAFF = 60;
const WRITE_LIMIT_ADMIN = 300;

/** 書込系 action か（ACTIONS と対で管理する）。 */
const WRITE_ACTIONS = {
  saveRequest: 1, deleteRequest: 1, setEnabled: 1, savePlace: 1, deletePlace: 1,
  saveLeg: 1, deleteLeg: 1, setSettings: 1, approveRequest: 1, approveAll: 1, rejectRequest: 1,
  reopenRequest: 1, closeMonth: 1, reopenMonth: 1,
};

// action ごとの必要ロール。ここに無い action は存在しないものとして 400。
// ★ 書込系に "v"（労務士）を絶対に入れない。労務士は完全読み取り専用。
const ACTIONS = {
  bootstrap: ["s", "a", "v"],
  myMonth: ["s"],
  saveRequest: ["s"],
  deleteRequest: ["s"],
  adminMonth: ["a"],
  setEnabled: ["a"],
  savePlace: ["a"],
  deletePlace: ["a"],
  saveLeg: ["a"],
  deleteLeg: ["a"],
  setSettings: ["a"],
  approveRequest: ["a"],
  approveAll: ["a"],
  rejectRequest: ["a"],
  reopenRequest: ["a"],
  closeMonth: ["a"],
  reopenMonth: ["a"],
  monthlyReport: ["a", "v"],
};

const ROOT = M.ROOT;

function reqPath(ym, employeeId, requestId) {
  let p = ROOT + "/requests/" + ym;
  if (employeeId) p += "/" + employeeId;
  if (requestId) p += "/" + requestId;
  return p;
}

/** 申請レコードを画面表示用に整える（内部キーを増やさない）。 */
function normRequest(id, r) {
  if (!r || typeof r !== "object") return null;
  return {
    id: id,
    employeeId: String(r.employeeId || ""),
    staffName: String(r.staffName || ""),
    date: String(r.date || ""),
    placeIds: Array.isArray(r.placeIds) ? r.placeIds.map(String) : [],
    legs: Array.isArray(r.legs) ? r.legs : [],
    totalKm: M.round1(r.totalKm),
    note: String(r.note || ""),
    status: String(r.status || "pending"),
    createdAt: String(r.createdAt || ""),
    updatedAt: String(r.updatedAt || ""),
    approvedBy: String(r.approvedBy || ""),
    approvedAt: String(r.approvedAt || ""),
    rejectReason: String(r.rejectReason || ""),
  };
}

/** /mileage/requests/{ym}/{employeeId} 配下を配列にする。 */
function listRequests(node) {
  const out = [];
  if (node && typeof node === "object") {
    for (const id of Object.keys(node)) {
      const r = normRequest(id, node[id]);
      if (r) out.push(r);
    }
  }
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

// ===== 職員の申請保存 =====

async function handleSaveRequest(body, staff) {
  const date = H.str(body.date, 10);
  if (!M.isDate(date)) return { status: 400, error: "bad_date" };
  // 過去12か月〜翌月末の範囲外は受け付けない（打ち間違いによる遠い年月の混入を防ぐ）
  if (!M.isDateInWindow(date)) return { status: 400, error: "date_out_of_range" };
  const ym = M.ymOf(date);

  // 確定済みの月へは書き込ませない（給与計算済みの月が後から動くのを防ぐ）
  const closing = await G.dbGet(ROOT + "/closings/" + ym);
  if (closing && typeof closing === "object") return { status: 409, error: "month_closed" };

  const placeIds = Array.isArray(body.placeIds) ? body.placeIds.map(function (v) { return String(v); }) : null;
  const note = M.normText(body.note, 200);

  const [places, legMap] = await Promise.all([M.loadPlaces(), M.loadLegs()]);
  const placeById = {};
  places.forEach(function (p) { placeById[p.id] = p; });

  const v = M.validateRoute(placeIds, placeById);
  if (v.error) return { status: 400, error: v.error };

  const route = M.buildRoute(placeIds, legMap, placeById);
  // ★ 未登録区間は 0km にしない。保存自体を拒否し、どの区間が未登録かを返す。
  if (route.missing.length) {
    return {
      status: 409,
      error: "missing_leg",
      missing: route.missing.map(function (m) {
        return { from: m.from, to: m.to,
          fromName: placeById[m.from] ? placeById[m.from].name : "",
          toName: placeById[m.to] ? placeById[m.to].name : "" };
      }),
    };
  }

  // 1日1件。★ ID を日付から決定的に導出して PUT を冪等にする。
  //   「検索してから新IDで INSERT」だと、同時に2回送られたとき両方が「既存なし」と
  //   判断して同じ日の申請が2件でき、月次合計＝支給額が二重になる
  //   （アプリ側の事前確認だけを排他制御に使わない、という共通ルール）。
  const id = "d_" + date.replace(/-/g, "");
  const existing = await G.dbGet(reqPath(ym, staff.employeeId, id));
  const existingId = (existing && typeof existing === "object") ? id : "";
  // 承認済みは本人が書き換えられない（金額確定後の改ざん防止）
  if (existing && typeof existing === "object" && String(existing.status) === "approved") {
    return { status: 409, error: "already_approved" };
  }

  const now = M.nowIso();
  const rec = {
    id: id,
    employeeId: staff.employeeId,
    staffName: staff.name,
    date: date,
    ym: ym,
    placeIds: placeIds,
    legs: route.legs,
    totalKm: route.totalKm,
    note: note,
    status: "pending",
    createdAt: existing && existing.createdAt ? String(existing.createdAt) : now,
    updatedAt: now,
    approvedBy: "",
    approvedAt: "",
    rejectReason: "",
  };
  await G.dbPut(reqPath(ym, staff.employeeId, id), rec);
  M.audit("staff:" + staff.employeeId, existingId ? "request.update" : "request.create",
    ym + "/" + staff.employeeId + "/" + id, { date: date, totalKm: route.totalKm });

  return { status: 200, ok: true, request: normRequest(id, rec) };
}

async function handleDeleteRequest(body, staff) {
  const ym = H.str(body.ym, 7);
  const requestId = H.str(body.requestId, 64);
  if (!M.isYm(ym) || !M.isId(requestId)) return { status: 400, error: "bad_params" };

  const closing = await G.dbGet(ROOT + "/closings/" + ym);
  if (closing && typeof closing === "object") return { status: 409, error: "month_closed" };

  const rec = await G.dbGet(reqPath(ym, staff.employeeId, requestId));
  if (!rec || typeof rec !== "object") return { status: 404, error: "not_found" };
  if (String(rec.status) === "approved") return { status: 409, error: "already_approved" };

  await G.dbPut(reqPath(ym, staff.employeeId, requestId), null);
  M.audit("staff:" + staff.employeeId, "request.delete",
    ym + "/" + staff.employeeId + "/" + requestId, { date: rec.date, totalKm: rec.totalKm });
  return { status: 200, ok: true };
}

// ===== 管理者 =====

async function handleAdminMonth(body) {
  const ym = H.str(body.ym, 7);
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };

  // ★ 氏名は /mileage/staff（管理者が許可したときのスナップショット）から引く。
  //   誰でも書ける /honomi/tc5_staff を管理画面の表示元にしない。
  const [node, enabledRaw, nameByEid, closing, monthlyRaw, settings] = await Promise.all([
    G.dbGet(reqPath(ym)),
    G.dbGet(ROOT + "/enabled"),
    M.loadStaffNames(),
    G.dbGet(ROOT + "/closings/" + ym),
    G.dbGet(ROOT + "/monthly"),
    M.loadSettings(),
  ]);

  const byStaff = [];
  if (node && typeof node === "object") {
    for (const eid of Object.keys(node)) {
      const list = listRequests(node[eid]);
      if (!list.length) continue;
      let approvedKm = 0, pending = 0, rejected = 0;
      list.forEach(function (r) {
        if (r.status === "approved") approvedKm = M.round1(approvedKm + r.totalKm);
        else if (r.status === "rejected") rejected++;
        else pending++;
      });
      byStaff.push({
        employeeId: eid,
        staffName: nameByEid[eid] || (list[0] && list[0].staffName) || "",
        requests: list,
        approvedKm: approvedKm,
        pendingCount: pending,
        rejectedCount: rejected,
      });
    }
  }
  byStaff.sort(function (a, b) { return String(a.employeeId).localeCompare(String(b.employeeId), "ja"); });

  // 確定済みスナップショット（この月の分だけ）
  const snapshots = {};
  if (monthlyRaw && typeof monthlyRaw === "object") {
    for (const eid of Object.keys(monthlyRaw)) {
      const m = monthlyRaw[eid] && monthlyRaw[eid][ym];
      if (m && typeof m === "object") snapshots[eid] = m;
    }
  }

  const enabled = {};
  if (enabledRaw && typeof enabledRaw === "object") {
    for (const eid of Object.keys(enabledRaw)) if (enabledRaw[eid] === true) enabled[eid] = true;
  }

  return {
    status: 200, ok: true, ym: ym,
    byStaff: byStaff,
    enabledMap: enabled,
    settings: settings,
    closing: (closing && typeof closing === "object") ? closing : null,
    snapshots: snapshots,
  };
}

/**
 * 職員別の利用ON/OFF。
 *
 * ★ ここが「認証サブジェクト（氏名ハッシュ）→ 社員番号」の対応表を作る唯一の場所である。
 *   対応表を `/mileage`（Rules 未定義＝サーバ以外書けない）に置くことで、
 *   誰でも書ける `/honomi/tc5_staff` を経由した成りすましを断つ。
 *
 * ★ 氏名は管理者の申告（スタッフ管理で保存しようとしている値）を使う。
 *   tc5_staff から引くと、改名と同時に保存したときに「まだ古い名前」を読んでしまう。
 *   管理者は `r:"a"` ＋ adminSessionValid を通っており、そもそも全操作の権限を持つ。
 */
async function handleSetEnabled(body, actor) {
  const employeeId = H.str(body.employeeId, 32);
  if (!M.isEmployeeId(employeeId)) return { status: 400, error: "bad_employee_id" };
  // ★ trim しない。ログイン側（/api/auth/staff）は tc5_staff の氏名をそのまま
  //   subjectKey へ通すため、ここで正規化するとサブジェクトが食い違い、
  //   当人が恒久的に 403 になる（原因が画面から分からない形で壊れる）。
  const staffName = M.normName(body.staffName, 128);
  if (!staffName.trim()) return { status: 400, error: "bad_staff_name" };
  const on = body.enabled === true;
  const subject = M.subjectOf(staffName);
  // 社員番号の訂正・付け替えは、管理者が「どの番号から変えるか」を明示したときだけ許す
  const rebindFrom = H.str(body.rebindFrom, 32);

  const identityRaw = await G.dbGet(ROOT + "/identity");
  const identity = (identityRaw && typeof identityRaw === "object") ? identityRaw : {};

  // ★ 1つの氏名（＝1つのログイン）に複数の社員番号を割り当てない。
  //   割り当てると、その氏名でPINを登録した人物が「どちらの社員番号か」で
  //   別人の申請へ到達しうる。
  //   ただし「同じ人の社員番号を訂正する」運用は現実に起きる。区別できないので、
  //   管理者が rebindFrom で意図を明示したときだけ付け替えを許す。
  const cur = identity[subject];
  const curEid = (cur && typeof cur === "object") ? String(cur.employeeId || "") : "";
  if (curEid && curEid !== employeeId && rebindFrom !== curEid) {
    return { status: 409, error: "identity_conflict", conflictWith: curEid };
  }

  // ★★ 「前の社員番号」を必ず特定する。★★
  //   氏名だけを変えた場合はサブジェクトが変わるだけなので `curEid` で分かるが、
  //   **氏名と社員番号を同時に変えると `subject` も変わるため `curEid` は空になる。**
  //   そこを取りこぼすと、旧サブジェクトの対応表と `enabled/{旧番号}` が残ったままになり、
  //   第三者が旧氏名を tc5_staff へ書き戻して自分のPINを登録するだけで
  //   （管理者の操作を一切必要とせずに）旧番号の権限を取得できてしまう。
  //   管理者が明示した rebindFrom を「前の番号」として同じ後始末に載せる。
  let prevEid = curEid;
  if (!prevEid && M.isEmployeeId(rebindFrom) && rebindFrom !== employeeId) prevEid = rebindFrom;

  // 新旧いずれかの社員番号に紐づく「別サブジェクト」の対応表は必ず外す
  // （旧姓のままでも入れてしまう＝資格が二重に残るのを防ぐ）。
  const staleSubjects = Object.keys(identity).filter(function (k) {
    if (k === subject || !/^[A-Za-z0-9_]{1,64}$/.test(k)) return false;
    const v = identity[k];
    if (!v || typeof v !== "object") return false;
    const e = String(v.employeeId);
    return e === employeeId || (!!prevEid && e === prevEid);
  });
  // このログイン（または前の番号のログイン）が既に確立済みか
  const isRename = staleSubjects.length > 0 || (!!curEid && curEid !== employeeId);

  // ★ 退役した社員番号は再利用させない。
  //   付け替え前の申請・月次確定は旧番号のまま残るため、その番号が別人へ回ると
  //   前任者の申請が新しい人の画面に出て、未承認分は上書き・削除できてしまう。
  // ★ ただし (1) 剥奪（on=false）は常に通す (2) 直前の付け替えを元へ戻す操作は許す。
  //   戻せないと、打ち間違いで付け替えた瞬間に復旧不能な行き止まりになる。
  let revertRetired = false;
  if (on) {
    const retired = await G.dbGet(ROOT + "/retired/" + employeeId);
    if (retired && typeof retired === "object") {
      if (prevEid && String(retired.replacedBy || "") === prevEid) revertRetired = true;
      else return { status: 409, error: "employee_id_retired", retiredAt: String(retired.at || ""), replacedBy: String(retired.replacedBy || "") };
    }
  }

  // ★ 実在するログインにしか社員番号を割り当てない。
  //   /authz/pins が無い氏名を有効化すると、その氏名のPINを第三者が先に登録して
  //   （pin-set の新規登録経路）当人として入れてしまう。
  //
  // ★ ただし次の2つでは「拒否」しない。
  //   (1) 利用を止める操作（on=false）… 権限の剥奪は常に通す。検査で止めると
  //       「PINが消えた職員の利用許可を外せない」という逆向きの事故になる。
  //   (2) 改名にともなう付け替え … そのログインの実在は前回の有効化時に確認済み。
  //       改名時は pin-set の付け替え（renamePinInAuthz）と本APIが並行して走り、
  //       こちらが先に着地すると「PIN未登録」という事実と違う失敗になる。
  //
  // ★ 拒否しない場合でも PIN レコードは必ず読む。読まないと pinUpdatedAt が常に 0 になり、
  //   「PINが未登録のまま紐付けが確定した」ことを管理者へ知らせられない。
  const pinRec = await G.dbGet(S.AUTHZ + "/pins/" + subject);
  let pinExists = !!(pinRec && typeof pinRec === "object");
  // ★ 改名でも「どこかに実在するログイン」であることは必ず要求する。
  //   検査を丸ごと飛ばすと、PINがまだ無い氏名へ有効な社員番号を紐づけられてしまい、
  //   第三者がその氏名でPINを新規登録するだけで当人の申請を作成・改変できる。
  //   pin-set の改名は「新へ書く → 旧を消す」順なので、着地順に関わらず新旧どちらかは必ず存在する。
  //   ＝正常な改名は通り、「どこにもログインが無い」場合だけ止まる。
  if (on && !pinExists && isRename) {
    for (const k of staleSubjects) {
      const alt = await G.dbGet(S.AUTHZ + "/pins/" + k);
      if (alt && typeof alt === "object") { pinExists = true; break; }
    }
  }
  if (on && !pinExists) {
    return { status: 409, error: "pin_not_registered" };
  }

  let rebound = [];

  const patch = {};
  rebound = staleSubjects.slice();
  for (const k of rebound) patch[ROOT + "/identity/" + k] = null;

  const now = M.nowIso();
  // 社員番号の付け替え時は、旧番号の利用許可と表示名も同じ更新で消す。
  // ★ 2回のAPI呼び出しに分けてはならない。片方だけ成功すると
  //   「OFFにはなったが新番号で有効化できない」復旧不能な状態が残る。
  // ★ 旧番号は退役させて再利用を禁じる（旧番号の申請・確定データが残るため）。
  if (prevEid && prevEid !== employeeId && M.isEmployeeId(prevEid)) {
    patch[ROOT + "/enabled/" + prevEid] = null;
    patch[ROOT + "/staff/" + prevEid] = null;
    patch[ROOT + "/retired/" + prevEid] = { at: now, by: actor, replacedBy: employeeId };
  }
  // 直前の付け替えを元へ戻す場合は、退役の印も同じ更新で外す
  if (revertRetired) patch[ROOT + "/retired/" + employeeId] = null;

  patch[ROOT + "/identity/" + subject] = { employeeId: employeeId, name: staffName, updatedAt: now, updatedBy: actor };
  patch[ROOT + "/staff/" + employeeId] = { name: staffName, subject: subject, updatedAt: now };
  patch[ROOT + "/enabled/" + employeeId] = on ? true : null;

  await M.ensureMeta();
  await G.dbPatchRoot(patch);
  M.audit(actor, "enabled.set", employeeId, {
    enabled: on, subject: subject, previousEmployeeId: curEid || null, reboundSubjects: rebound.length,
  });
  return {
    status: 200, ok: true, employeeId: employeeId, enabled: on,
    created: !curEid,                       // 新規に対応表を作ったか
    previousEmployeeId: curEid || "",       // 付け替え前の社員番号（空なら付け替えなし）
    reboundSubjects: rebound.length,        // 無言で外した他サブジェクトの数
    // ★ このログイン（PIN）がいつ登録されたか。
    //   tc5_staff は誰でも書けるため、第三者が氏名を足して自分でPINを登録し、
    //   管理者にONを押させる経路が原理的に残る（既知の残存リスク・AGENTS.md 参照）。
    //   直前に登録されたPINであることが管理者に見えれば、その場で気づける。
    pinUpdatedAt: (pinRec && typeof pinRec.updatedAt === "number") ? pinRec.updatedAt : 0,
  };
}

async function handleSavePlace(body, actor) {
  const name = M.normText(body.name, 40);
  if (!name) return { status: 400, error: "bad_name" };
  let placeId = H.str(body.placeId, 40);
  const order = Number(body.order);
  const active = body.active !== false;

  const places = await M.loadPlaces();
  if (placeId) {
    if (!M.isId(placeId)) return { status: 400, error: "bad_place_id" };
    if (!places.find(function (p) { return p.id === placeId; })) return { status: 404, error: "not_found" };
  } else {
    // 同名の重複登録は事故のもと（どちらの地点か区別できない）
    if (places.find(function (p) { return p.name === name; })) return { status: 409, error: "duplicate_name" };
    placeId = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  const dup = places.find(function (p) { return p.name === name && p.id !== placeId; });
  if (dup) return { status: 409, error: "duplicate_name" };

  await M.ensureMeta();
  const prev = places.find(function (p) { return p.id === placeId; });
  // ★ PUT は置換なので createdAt を必ず持ち回る（更新のたびに作成日時が消えないように）
  const prevRaw = prev ? await G.dbGet(ROOT + "/places/" + placeId) : null;
  await G.dbPut(ROOT + "/places/" + placeId, {
    name: name,
    order: isFinite(order) ? order : (prev ? prev.order : places.length + 1),
    active: active,
    createdAt: (prevRaw && prevRaw.createdAt) ? String(prevRaw.createdAt) : M.nowIso(),
    updatedAt: M.nowIso(),
  });
  M.audit(actor, prev ? "place.update" : "place.create", placeId, { name: name, active: active });
  return { status: 200, ok: true, placeId: placeId };
}

async function handleDeletePlace(body, actor) {
  const placeId = H.str(body.placeId, 40);
  if (!M.isId(placeId)) return { status: 400, error: "bad_place_id" };

  // ★ 過去の申請は地点名を snapshot 済みだが、区間マスタは placeId 参照。
  //   区間が残ったまま地点だけ消すと「名前の無い区間」ができるため、区間も併せて消す。
  const legsRaw = await G.dbGet(ROOT + "/legs");
  const patch = {};
  if (legsRaw && typeof legsRaw === "object") {
    for (const k of Object.keys(legsRaw)) {
      const parts = k.split("__");
      if (parts[0] === placeId || parts[1] === placeId) patch[ROOT + "/legs/" + k] = null;
    }
  }
  patch[ROOT + "/places/" + placeId] = null;
  await G.dbPatchRoot(patch);
  M.audit(actor, "place.delete", placeId, { removedLegs: Object.keys(patch).length - 1 });
  return { status: 200, ok: true };
}

async function handleSaveLeg(body, actor) {
  const fromId = H.str(body.fromId, 40);
  const toId = H.str(body.toId, 40);
  const km = M.normKm(body.km);
  if (!M.isId(fromId) || !M.isId(toId) || fromId === toId) return { status: 400, error: "bad_leg" };
  if (km == null) return { status: 400, error: "bad_km" };

  const places = await M.loadPlaces();
  const ids = {};
  places.forEach(function (p) { ids[p.id] = true; });
  if (!ids[fromId] || !ids[toId]) return { status: 404, error: "unknown_place" };

  await M.ensureMeta();
  const now = M.nowIso();
  const patch = {};
  patch[ROOT + "/legs/" + M.legKey(fromId, toId)] = { km: km, updatedAt: now, updatedBy: actor };
  // ★ 補助操作。既定では逆方向を書かない（方向別が正本のため）。
  //   管理者が明示的に選んだときだけ、逆方向へ同じ距離を入れる。
  if (body.alsoReverse === true) {
    patch[ROOT + "/legs/" + M.legKey(toId, fromId)] = { km: km, updatedAt: now, updatedBy: actor };
  }
  await G.dbPatchRoot(patch);
  M.audit(actor, "leg.set", M.legKey(fromId, toId), { km: km, alsoReverse: body.alsoReverse === true });
  return { status: 200, ok: true };
}

async function handleDeleteLeg(body, actor) {
  const fromId = H.str(body.fromId, 40);
  const toId = H.str(body.toId, 40);
  if (!M.isId(fromId) || !M.isId(toId)) return { status: 400, error: "bad_leg" };
  await G.dbPut(ROOT + "/legs/" + M.legKey(fromId, toId), null);
  M.audit(actor, "leg.delete", M.legKey(fromId, toId), null);
  return { status: 200, ok: true };
}

async function handleSetSettings(body, actor) {
  const rate = M.normRate(body.ratePerKm);
  const mode = M.ROUND_MODES.indexOf(body.roundMode) >= 0 ? body.roundMode : null;
  if (rate == null) return { status: 400, error: "bad_rate" };
  if (!mode) return { status: 400, error: "bad_round_mode" };

  await M.ensureMeta();
  const prev = await M.loadSettings();
  await G.dbPut(ROOT + "/settings", {
    ratePerKm: rate, roundMode: mode, updatedAt: M.nowIso(), updatedBy: actor,
  });
  M.audit(actor, "settings.set", "settings",
    { from: { ratePerKm: prev.ratePerKm, roundMode: prev.roundMode }, to: { ratePerKm: rate, roundMode: mode } });
  return { status: 200, ok: true, settings: { ratePerKm: rate, roundMode: mode } };
}

/** 承認・却下・差し戻し。対象は必ず {ym}/{employeeId}/{requestId} で指定させる。 */
async function handleRequestStatus(body, actor, next) {
  const ym = H.str(body.ym, 7);
  const employeeId = H.str(body.employeeId, 32);
  const requestId = H.str(body.requestId, 64);
  if (!M.isYm(ym) || !M.isEmployeeId(employeeId) || !M.isId(requestId)) return { status: 400, error: "bad_params" };

  const closing = await G.dbGet(ROOT + "/closings/" + ym);
  if (closing && typeof closing === "object") return { status: 409, error: "month_closed" };

  const rec = await G.dbGet(reqPath(ym, employeeId, requestId));
  if (!rec || typeof rec !== "object") return { status: 404, error: "not_found" };

  const now = M.nowIso();
  // ★ 承認と却下で欄を分ける。却下を approvedBy/approvedAt に入れると
  //   一覧で「承認者」として表示され、事実と食い違う。
  const patch = { status: next, updatedAt: now, decidedBy: actor, decidedAt: now };

  if (next === "approved") {
    // ★ 承認時に現在のマスタで距離を引き直す。承認＝「この内容で確定」なので、
    //   申請後にマスタが直された場合は直った値で確定させる。差異は監査ログへ残す。
    const [places, legMap] = await Promise.all([M.loadPlaces(), M.loadLegs()]);
    const placeById = {};
    places.forEach(function (p) { placeById[p.id] = p; });
    const ids = Array.isArray(rec.placeIds) ? rec.placeIds.map(String) : [];
    const v = M.validateRoute(ids, placeById);
    if (v.error) return { status: 409, error: "route_invalid", detail: v.error };
    const route = M.buildRoute(ids, legMap, placeById);
    if (route.missing.length) return { status: 409, error: "missing_leg", missing: route.missing };
    if (M.round1(rec.totalKm) !== route.totalKm) {
      patch.recalculatedFrom = M.round1(rec.totalKm);
      M.audit(actor, "request.recalculated", ym + "/" + employeeId + "/" + requestId,
        { from: M.round1(rec.totalKm), to: route.totalKm });
    }
    patch.legs = route.legs;
    patch.totalKm = route.totalKm;
    patch.rejectReason = "";
    patch.approvedBy = actor;
    patch.approvedAt = now;
  } else if (next === "rejected") {
    patch.rejectReason = M.normText(body.reason, 120);
    patch.approvedBy = "";
    patch.approvedAt = "";
  } else {
    // 差し戻し（pending へ戻す）
    patch.approvedBy = "";
    patch.approvedAt = "";
    patch.rejectReason = "";
  }

  await G.dbPatch(reqPath(ym, employeeId, requestId), patch);
  M.audit(actor, "request." + next, ym + "/" + employeeId + "/" + requestId,
    { totalKm: patch.totalKm !== undefined ? patch.totalKm : M.round1(rec.totalKm) });
  return { status: 200, ok: true };
}

/**
 * 職員1名・1か月分の未処理申請をまとめて承認する。
 *
 * ★ 1件ずつ HTTP を往復させない。30名×20日規模の月末承認では往復数が数百になり、
 *   遅いうえに書込レート制限にも当たる（承認作業の途中で止まるのが最悪の失敗）。
 *   1リクエスト＝1書込としてまとめる。
 */
async function handleApproveAll(body, actor) {
  const ym = H.str(body.ym, 7);
  const employeeId = H.str(body.employeeId, 32);
  if (!M.isYm(ym) || !M.isEmployeeId(employeeId)) return { status: 400, error: "bad_params" };

  const closing = await G.dbGet(ROOT + "/closings/" + ym);
  if (closing && typeof closing === "object") return { status: 409, error: "month_closed" };

  const node = await G.dbGet(reqPath(ym, employeeId));
  if (!node || typeof node !== "object") return { status: 200, ok: true, approved: 0, skipped: [] };

  const [places, legMap] = await Promise.all([M.loadPlaces(), M.loadLegs()]);
  const placeById = {};
  places.forEach(function (p) { placeById[p.id] = p; });

  const now = M.nowIso();
  const patch = {};
  const skipped = [];
  const approvedDates = [];
  let approved = 0;

  for (const id of Object.keys(node)) {
    if (!M.isId(id)) continue;
    const rec = node[id];
    if (!rec || typeof rec !== "object" || String(rec.status) !== "pending") continue;
    const ids = Array.isArray(rec.placeIds) ? rec.placeIds.map(String) : [];
    const v = M.validateRoute(ids, placeById);
    if (v.error) { skipped.push({ id: id, date: String(rec.date || ""), reason: v.error }); continue; }
    const route = M.buildRoute(ids, legMap, placeById);
    // ★ 未登録区間が残っている申請は承認しない（0km で確定させない）
    if (route.missing.length) { skipped.push({ id: id, date: String(rec.date || ""), reason: "missing_leg" }); continue; }
    const base = reqPath(ym, employeeId, id);
    patch[base + "/status"] = "approved";
    patch[base + "/legs"] = route.legs;
    patch[base + "/totalKm"] = route.totalKm;
    patch[base + "/updatedAt"] = now;
    patch[base + "/decidedBy"] = actor;
    patch[base + "/decidedAt"] = now;
    patch[base + "/approvedBy"] = actor;
    patch[base + "/approvedAt"] = now;
    patch[base + "/rejectReason"] = "";
    if (M.round1(rec.totalKm) !== route.totalKm) patch[base + "/recalculatedFrom"] = M.round1(rec.totalKm);
    approvedDates.push(String(rec.date || ""));
    approved++;
  }

  if (!approved) return { status: 200, ok: true, approved: 0, skipped: skipped };
  await G.dbPatchRoot(patch);
  // ★ 給与に直結する操作なので、どの申請を承認したかまで残す（件数だけにしない）。
  M.audit(actor, "request.approveAll", ym + "/" + employeeId,
    { approved: approved, dates: approvedDates, skipped: skipped.length });
  return { status: 200, ok: true, approved: approved, skipped: skipped };
}

/**
 * 月次確定。給与計算の正本 /mileage/monthly/{employeeId}/{ym} を作る。
 * ★ ここで単価・端数処理・合計距離・支給額をスナップショットする。
 *   以後 settings を変えても、この月の金額は動かない。
 */
async function handleCloseMonth(body, actor) {
  const ym = H.str(body.ym, 7);
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };

  const existing = await G.dbGet(ROOT + "/closings/" + ym);
  if (existing && typeof existing === "object") return { status: 409, error: "already_closed" };

  const [node, nameByEid, settings] = await Promise.all([
    G.dbGet(reqPath(ym)), M.loadStaffNames(), M.loadSettings(),
  ]);
  // ★ km単価が一度も設定されていない状態で確定させない。
  //   既定値のまま確定すると、誰も決めていない単価で給与データが作られる。
  if (!settings.configured) return { status: 409, error: "rate_not_configured" };

  const now = M.nowIso();
  const patch = {};
  const rows = [];
  let pendingTotal = 0;

  if (node && typeof node === "object") {
    for (const eid of Object.keys(node)) {
      if (!M.isEmployeeId(eid)) continue;
      const list = listRequests(node[eid]);
      const approved = list.filter(function (r) { return r.status === "approved"; });
      pendingTotal += list.filter(function (r) { return r.status === "pending"; }).length;
      // ★ 承認済みが1件も無い職員は出力対象にしない（未確定データを給与へ混入させない）
      if (!approved.length) continue;
      let totalKm = 0;
      approved.forEach(function (r) { totalKm = M.round1(totalKm + r.totalKm); });
      if (!(totalKm > 0)) continue;
      const row = {
        employeeId: eid,
        staffName: nameByEid[eid] || (approved[0] && approved[0].staffName) || "",
        ym: ym,
        totalKm: totalKm,
        ratePerKm: settings.ratePerKm,
        roundMode: settings.roundMode,
        amount: M.monthlyAmount(totalKm, settings.ratePerKm, settings.roundMode),
        dayCount: approved.length,
        closedAt: now,
        closedBy: actor,
      };
      patch[ROOT + "/monthly/" + eid + "/" + ym] = row;
      rows.push(row);
    }
  }

  patch[ROOT + "/closings/" + ym] = {
    closedAt: now, closedBy: actor,
    ratePerKm: settings.ratePerKm, roundMode: settings.roundMode,
    staffCount: rows.length,
    excludedPending: pendingTotal,
  };
  await M.ensureMeta();
  await G.dbPatchRoot(patch);
  M.audit(actor, "month.close", ym, { staffCount: rows.length, excludedPending: pendingTotal });
  return { status: 200, ok: true, ym: ym, rows: rows, excludedPending: pendingTotal };
}

/** 確定解除。スナップショットも消す（「確定済み」と言える状態を中途半端に残さない）。 */
async function handleReopenMonth(body, actor) {
  const ym = H.str(body.ym, 7);
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };
  const monthlyRaw = await G.dbGet(ROOT + "/monthly");
  const patch = {};
  if (monthlyRaw && typeof monthlyRaw === "object") {
    for (const eid of Object.keys(monthlyRaw)) {
      // 既存キー由来でも必ず形式検証を通す（不正キーで dbPatchRoot が throw して 500 にならないように）
      if (!M.isEmployeeId(eid)) continue;
      if (monthlyRaw[eid] && monthlyRaw[eid][ym]) patch[ROOT + "/monthly/" + eid + "/" + ym] = null;
    }
  }
  patch[ROOT + "/closings/" + ym] = null;
  await G.dbPatchRoot(patch);
  M.audit(actor, "month.reopen", ym, { removed: Object.keys(patch).length - 1 });
  return { status: 200, ok: true };
}

/**
 * 月次レポート（労務士・管理者の参照用）。
 * ★ 確定済み（closings に存在する）月のスナップショットだけを返す。
 *   未確定の月は行を返さない＝給与計算用データに未確定分が混入しない。
 * ★ 現在の単価から計算し直さない。スナップショットの値をそのまま返す。
 */
async function handleMonthlyReport(body) {
  const ym = H.str(body.ym, 7);
  const withDetail = body.withDetail === true;

  const [closingsRaw, monthlyRaw] = await Promise.all([
    G.dbGet(ROOT + "/closings"), G.dbGet(ROOT + "/monthly"),
  ]);
  const closedMonths = [];
  if (closingsRaw && typeof closingsRaw === "object") {
    for (const k of Object.keys(closingsRaw)) if (M.isYm(k)) closedMonths.push(k);
  }
  closedMonths.sort().reverse();

  if (!ym) return { status: 200, ok: true, closedMonths: closedMonths, rows: [], ym: "" };
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };
  if (closedMonths.indexOf(ym) < 0) {
    return { status: 200, ok: true, closedMonths: closedMonths, rows: [], ym: ym, closed: false };
  }

  const rows = [];
  if (monthlyRaw && typeof monthlyRaw === "object") {
    for (const eid of Object.keys(monthlyRaw)) {
      const r = monthlyRaw[eid] && monthlyRaw[eid][ym];
      if (!r || typeof r !== "object") continue;
      rows.push({
        employeeId: String(r.employeeId || eid),
        staffName: String(r.staffName || ""),
        ym: ym,
        totalKm: M.round1(r.totalKm),
        ratePerKm: Number(r.ratePerKm) || 0,
        roundMode: String(r.roundMode || ""),
        amount: Number(r.amount) || 0,
        dayCount: Number(r.dayCount) || 0,
      });
    }
  }
  rows.sort(function (a, b) { return String(a.employeeId).localeCompare(String(b.employeeId), "ja"); });

  const out = {
    status: 200, ok: true, ym: ym, closed: true,
    closing: closingsRaw[ym], closedMonths: closedMonths, rows: rows,
  };

  if (withDetail) {
    // 日別明細も確定済みの承認データだけから作る
    const node = await G.dbGet(reqPath(ym));
    const detail = [];
    const inReport = {};
    rows.forEach(function (r) { inReport[r.employeeId] = r; });
    if (node && typeof node === "object") {
      for (const eid of Object.keys(node)) {
        if (!inReport[eid]) continue;   // 確定に含まれない職員は明細も出さない
        listRequests(node[eid]).forEach(function (r) {
          if (r.status !== "approved") return;
          detail.push({
            employeeId: eid,
            staffName: inReport[eid].staffName,
            date: r.date,
            route: (r.legs || []).length
              ? [].concat(r.legs.map(function (l) { return l.fromName; }), [r.legs[r.legs.length - 1].toName]).join(" → ")
              : "",
            totalKm: r.totalKm,
            note: r.note,
          });
        });
      }
    }
    detail.sort(function (a, b) {
      if (a.employeeId !== b.employeeId) return String(a.employeeId).localeCompare(String(b.employeeId), "ja");
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    out.detail = detail;
  }
  return out;
}

// ===== エントリポイント =====

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

    const ident = await M.resolveIdentity(H.str(body.idToken, 4096));
    if (!ident || allowed.indexOf(ident.role) < 0) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "forbidden");
    }

    // --- 管理者 ---
    if (ident.role === "a") {
      // ★ 管理者PIN/URL変更で失効した旧セッションを締め出す（既存の取り決め）
      if (!(await M.isValidAdmin(ident))) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 403, "session_revoked");
      }
    }
    // --- 労務士（読み取り専用） ---
    if (ident.role === "v" && !(await M.isValidViewer(ident))) {
      await H.withMinDuration(startedAt, MIN_MS);
      return H.fail(res, 403, "forbidden");
    }

    // --- 職員 ---
    let staff = null;
    if (ident.role === "s") {
      staff = await M.resolveStaff(ident);
      if (!staff) { await H.withMinDuration(startedAt, MIN_MS); return H.fail(res, 403, "forbidden"); }
      if (!staff.employeeId) { await H.withMinDuration(startedAt, MIN_MS); return H.fail(res, 409, "no_employee_id"); }
      // ★ bootstrap 以外は利用ONが必須。OFFの職員は API そのものが通らない。
      if (action !== "bootstrap" && !(await M.isEnabled(staff.employeeId))) {
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 403, "feature_disabled");
      }
    }

    // 監査ログの actor。
    // ★ 管理者トークンに t クレーム（トークンハッシュ先頭16桁）が付いていればそれを残す。
    //   現在の /api/auth/admin は t を付けないため、実質は admin になる。
    //   付いていないときに「PIN経由」などの経路を断定するラベルを書かない
    //   （管理者URL経由の操作まで誤ったラベルで記録され、事実と食い違うため）。
    const actor = ident.role === "a"
      ? (typeof ident.claims.t === "string" && ident.claims.t ? ("admin:" + ident.claims.t) : "admin")
      : ident.role === "s" ? ("staff:" + staff.employeeId) : "viewer";

    // 書込系はハード上限を設ける（監査ログの無制限増加とAPI連打の抑止）
    if (Object.prototype.hasOwnProperty.call(WRITE_ACTIONS, action)) {
      const limit = ident.role === "a" ? WRITE_LIMIT_ADMIN : WRITE_LIMIT_STAFF;
      const n = await S.bumpAndCount("mlg_w", S.sanitizeKey(actor));
      if (n > limit) {
        res.setHeader("Retry-After", "600");
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 429, "rate_limited");
      }
    }

    let r;

    switch (action) {
      case "bootstrap": {
        const settings = await M.loadSettings();
        if (ident.role === "s") {
          const on = await M.isEnabled(staff.employeeId);
          // ★ 未許可でも氏名は返す。クライアントは「サーバが解決した本人」と
          //   「いま画面に出ているスタッフ」の一致を見て、前の職員のトークンで
          //   取得してしまった応答を捨てる。氏名が空だと一致扱いになり照合が効かない。
          //   本人自身の氏名なので、返しても新たに漏れる情報は無い。
          if (!on) { r = { status: 200, ok: true, role: "s", enabled: false, staffName: staff.name }; break; }
          const [places, legs] = await Promise.all([M.loadPlaces(), M.loadLegs()]);
          r = { status: 200, ok: true, role: "s", enabled: true,
                employeeId: staff.employeeId, staffName: staff.name,
                settings: { ratePerKm: settings.ratePerKm, roundMode: settings.roundMode },
                places: places.filter(function (p) { return p.active; }), legs: legs };
        } else if (ident.role === "a") {
          const [places, legs, enabledRaw] = await Promise.all([
            M.loadPlaces(), M.loadLegs(), G.dbGet(ROOT + "/enabled"),
          ]);
          const enabled = {};
          if (enabledRaw && typeof enabledRaw === "object") {
            for (const eid of Object.keys(enabledRaw)) if (enabledRaw[eid] === true) enabled[eid] = true;
          }
          r = { status: 200, ok: true, role: "a", settings: settings, places: places, legs: legs, enabledMap: enabled };
        } else {
          r = { status: 200, ok: true, role: "v", settings: { ratePerKm: settings.ratePerKm, roundMode: settings.roundMode } };
        }
        break;
      }
      case "myMonth": {
        const ym = H.str(body.ym, 7);
        if (!M.isYm(ym)) { r = { status: 400, error: "bad_ym" }; break; }
        const [node, closing] = await Promise.all([
          G.dbGet(reqPath(ym, staff.employeeId)), G.dbGet(ROOT + "/closings/" + ym),
        ]);
        r = { status: 200, ok: true, ym: ym, requests: listRequests(node),
              closed: !!(closing && typeof closing === "object") };
        break;
      }
      case "saveRequest": r = await handleSaveRequest(body, staff); break;
      case "deleteRequest": r = await handleDeleteRequest(body, staff); break;
      case "adminMonth": r = await handleAdminMonth(body); break;
      case "setEnabled": r = await handleSetEnabled(body, actor); break;
      case "savePlace": r = await handleSavePlace(body, actor); break;
      case "deletePlace": r = await handleDeletePlace(body, actor); break;
      case "saveLeg": r = await handleSaveLeg(body, actor); break;
      case "deleteLeg": r = await handleDeleteLeg(body, actor); break;
      case "setSettings": r = await handleSetSettings(body, actor); break;
      case "approveRequest": r = await handleRequestStatus(body, actor, "approved"); break;
      case "approveAll": r = await handleApproveAll(body, actor); break;
      case "rejectRequest": r = await handleRequestStatus(body, actor, "rejected"); break;
      case "reopenRequest": r = await handleRequestStatus(body, actor, "pending"); break;
      case "closeMonth": r = await handleCloseMonth(body, actor); break;
      case "reopenMonth": r = await handleReopenMonth(body, actor); break;
      case "monthlyReport": r = await handleMonthlyReport(body); break;
      default: r = { status: 400, error: "bad_action" };
    }

    await H.withMinDuration(startedAt, MIN_MS);
    const status = r.status || 200;
    const payload = Object.assign({}, r);
    delete payload.status;
    return res.status(status).json(payload);
  } catch (e) {
    console.error("[mileage]", cid, e && e.message);
    await H.withMinDuration(startedAt, MIN_MS);
    return H.serverError(res, cid);
  }
};
