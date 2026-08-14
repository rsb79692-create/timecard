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
const A = require("./_lib/mileage-auto");     // 打刻→経路の共通計算（index.html と同一ソース）
const P = require("./_lib/mileage-punch");    // 打刻データの読み取り専用アクセス
const STD = require("./_lib/mileage-standard"); // 7施設42方向の標準距離と取り込み計画（純粋計算）

const MIN_MS = 60;

// 書込系の上限（10分窓）。1日1件の申請にこの回数は通常あり得ない。
// ★ 上限を設けないと、認証済みの1名でも /mileage/audit を無制限に増やせる
//   （RTDB に TTL は無く、肥大化すると管理画面の取得も重くなる）。
// ★ 打刻のような賃金事故に直結する経路ではないので、ここはハード上限（429）でよい。
const WRITE_LIMIT_STAFF = 60;
const WRITE_LIMIT_ADMIN = 300;
// 自動集計の確認（autoCheck）は打刻を全件読むため、書込ではないが上限を設ける。
const READ_LIMIT_ADMIN = 120;

/** 書込系 action か（ACTIONS と対で管理する）。 */
const WRITE_ACTIONS = {
  saveRequest: 1, deleteRequest: 1, setEnabled: 1, savePlace: 1, deletePlace: 1,
  saveLeg: 1, deleteLeg: 1, importLegs: 1, setSettings: 1, approveRequest: 1, approveAll: 1, rejectRequest: 1,
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
  autoCheck: ["a"],
  setEnabled: ["a"],
  savePlace: ["a"],
  deletePlace: ["a"],
  saveLeg: ["a"],
  deleteLeg: ["a"],
  importLegs: ["a"],
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

  // ★ 利用ONの職員の氏名を返す。管理画面はこの氏名で打刻（tc5_records）を突き合わせ、
  //   自動集計を手元で計算して表示する（表示のたびに全打刻をサーバへ取りに行かないため）。
  //   確定に使う値は必ずサーバ側で計算し直す（closeMonth / autoCheck）。
  const names = {};
  for (const eid of Object.keys(enabled)) if (nameByEid[eid]) names[eid] = nameByEid[eid];
  if (node && typeof node === "object") {
    for (const eid of Object.keys(node)) if (nameByEid[eid]) names[eid] = nameByEid[eid];
  }

  return {
    status: 200, ok: true, ym: ym,
    byStaff: byStaff,
    enabledMap: enabled,
    names: names,
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

  // 打刻の施設名との対応づけ。★ 同じ施設名を複数の地点へ割り当てると
  //   自動集計がどちらの地点か決められず、その施設を含む日が丸ごと「距離未登録」になる。
  const facility = M.normText(body.facility, 40);
  // aliases ＝ 旧施設名。改名（施設マスタでは削除＋追加）後も過去打刻を同じ地点へ寄せるために使う。
  const aliases = M.normFacilityList(body.aliases, facility);
  // ★ 打刻の施設を選ばずに旧施設名だけ入れさせない。
  //   facilities が非空になると placeMap は「地点名＝施設名」の暗黙対応を**行わなくなる**ため、
  //   その施設が丸ごと未対応になる。しかも画面は「（地点名が一致）」と出続けるので、
  //   誤支給は起きない（要確認で確定が止まる）が、原因が分からないまま月次確定が止まる。
  if (!facility && aliases.length) return { status: 400, error: "alias_without_facility" };
  // ★ 現在名と旧名の両方を、他の地点が使っていないか検査する。
  //   片方だけ検査すると「A地点の現在名 ＝ B地点の旧名」が成立し、その施設が未対応になる。
  const mine = (facility ? [facility] : []).concat(aliases);
  for (const nm of mine) {
    const fdup = places.find(function (p) {
      if (p.id === placeId) return false;
      // placeMap は非アクティブな地点を対応表に入れない。ここで弾くと、集計上は誰も使っていない
      // 旧地点を理由に 409 になり、外す設定も無く行き止まりになる。規則を placeMap へ揃える。
      if (p.active === false) return false;
      const fl = p.facilities || [];
      if (fl.indexOf(nm) >= 0) return true;   // 明示指定（facility / aliases）で既に持っている
      // ★ 明示指定が無い地点は「地点名＝施設名」で**暗黙に**対応している（placeMap の名前フォールバック）。
      //   ここを見ないと、その施設名を別地点の旧施設名として登録できてしまう。placeMap は明示指定を
      //   優先するため、409 にも要確認にもならないまま、その施設の打刻が別地点の距離で計算される
      //   ＝**支給額が警告なく変わる**。画面の地点一覧は元の地点に「（地点名が一致）」と表示し続けるため、
      //   表示と実際の集計が食い違ったまま気づけない。
      return fl.length === 0 && String(p.name || "").trim() === nm;
    });
    // implicit ＝ 相手地点は「打刻の施設」を設定しておらず、地点名が一致しているだけ。
    //   この区別を返さないと、管理者が相手地点を開いても外すべき設定が無く詰まる。
    if (fdup) {
      return { status: 409, error: "duplicate_facility", conflictWith: fdup.name, facility: nm,
               implicit: (fdup.facilities || []).length === 0 };
    }
  }

  await M.ensureMeta();
  const prev = places.find(function (p) { return p.id === placeId; });
  // ★ PUT は置換なので createdAt を必ず持ち回る（更新のたびに作成日時が消えないように）
  const prevRaw = prev ? await G.dbGet(ROOT + "/places/" + placeId) : null;
  await G.dbPut(ROOT + "/places/" + placeId, {
    name: name,
    order: isFinite(order) ? order : (prev ? prev.order : places.length + 1),
    active: active,
    facility: facility,
    aliases: aliases,
    createdAt: (prevRaw && prevRaw.createdAt) ? String(prevRaw.createdAt) : M.nowIso(),
    updatedAt: M.nowIso(),
  });
  M.audit(actor, prev ? "place.update" : "place.create", placeId,
    { name: name, active: active, facility: facility, aliases: aliases.length });
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

/**
 * 標準区間距離（7施設42方向）の取り込み。
 *
 * ★ この action の安全性は「何を書かないか」で決まる。
 *   ・書くのは status==="new"（未登録）だけ。
 *   ・"same"（既に同値）は書かない → 何度実行しても結果が変わらない＝冪等。
 *   ・"conflict"（既存値が違う）は**絶対に自動上書きしない**。管理者が個別に判断する。
 *     ここで上書きすると、現地で実測して直した値が初期データで巻き戻り、
 *     しかも巻き戻ったことが誰にも見えない。
 *   ・"no_place"（施設に対応する地点が無い／一意に決まらない）は書けないので報告だけする。
 *   apply=false なら一切書かず差分だけ返す（管理画面が確認用に使う）。
 */
async function handleImportLegs(body, actor) {
  const apply = body.apply === true;
  const [places, legs] = await Promise.all([M.loadPlaces(), M.loadLegs()]);
  const plan = STD.planLegImport(places, legs);

  if (!apply) {
    return { status: 200, ok: true, applied: false, rows: plan.rows, counts: plan.counts,
             missingFacilities: plan.missingFacilities, total: plan.total };
  }

  const now = M.nowIso();
  // ★ 書き込む patch の組み立ては STD.buildLegImportPatch（純粋関数）だけが行う。
  //   ここに書き込みループを増やしてはならない（既存値の上書き経路になる）。
  const patch = STD.buildLegImportPatch(plan, ROOT + "/legs", now, actor);
  const written = Object.keys(patch).length;
  if (written > 0) {
    await M.ensureMeta();
    await G.dbPatchRoot(patch);
  }
  M.audit(actor, "leg.import", "standard", {
    written: written, newCount: plan.counts.new, same: plan.counts.same,
    conflict: plan.counts.conflict, noPlace: plan.counts.no_place,
  });
  // 書込後の状態を返す（画面が再取得しなくても結果が分かるように、new は same 相当になる）
  return { status: 200, ok: true, applied: true, written: written,
           rows: plan.rows, counts: plan.counts,
           missingFacilities: plan.missingFacilities, total: plan.total };
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

// ===== 応援打刻からの自動集計（サーバ側が確定の正本）=====

/** 申請ノード → { 日付: {status,totalKm,routeText} }。1日1件（reqId = d_YYYYMMDD）。 */
function manualByDateOf(node) {
  const out = {};
  listRequests(node).forEach(function (r) {
    if (!r.date) return;
    const prev = out[r.date];
    // 万一同じ日に複数あった場合は「承認済み > 未処理 > 却下」を優先（金額の取りこぼしを防ぐ）
    const rank = function (s) { return s === "approved" ? 3 : s === "pending" ? 2 : 1; };
    if (prev && rank(prev.status) >= rank(r.status)) return;
    out[r.date] = {
      status: r.status,
      totalKm: M.round1(r.totalKm),
      routeText: (r.legs || []).length
        ? [].concat(r.legs.map(function (l) { return l.fromName; }),
                    [r.legs[r.legs.length - 1].toName]).join(" → ")
        : "",
    };
  });
  return out;
}

/**
 * 対象年月の全職員分を集計する。
 *
 * ★ 自動集計の対象は「利用ONの職員」だけ（要件）。
 *   ただし利用OFFにした後も、その月に承認済みの手入力申請が残っていることはある。
 *   それを黙って落とすと支給漏れになるため、申請がある職員は手入力分だけ集計へ含める。
 */
async function computeAutoMonth(ym) {
  const [enabledRaw, nameByEid, places, legs, reqNode] = await Promise.all([
    G.dbGet(ROOT + "/enabled"), M.loadStaffNames(), M.loadPlaces(), M.loadLegs(), G.dbGet(reqPath(ym)),
  ]);
  const enabled = {};
  if (enabledRaw && typeof enabledRaw === "object") {
    for (const eid of Object.keys(enabledRaw)) if (enabledRaw[eid] === true) enabled[eid] = true;
  }

  const targets = [];
  const seenEid = {};
  const nameSet = {};
  function addTarget(eid, auto) {
    if (!M.isEmployeeId(eid) || seenEid[eid]) return;
    seenEid[eid] = true;
    const nm = String(nameByEid[eid] || "");
    targets.push({ employeeId: eid, staffName: nm, auto: auto });
    if (auto && nm) nameSet[nm] = true;
  }
  for (const eid of Object.keys(enabled)) addTarget(eid, true);
  if (reqNode && typeof reqNode === "object") for (const eid of Object.keys(reqNode)) addTarget(eid, false);

  // 打刻と未処理の打刻修正申請は、自動集計対象の職員の分だけ取り出す
  const [punch, pendCorrByName] = await Promise.all([
    P.loadMonthPunches(ym, nameSet), P.loadPendingCorrections(ym, nameSet),
  ]);
  const punchByName = punch.byStaff;
  // ★ 打刻ノードそのものが空で返ってきた場合、「移動が無い月」と区別できない。
  //   自動集計の対象者がいるのに1件も打刻が無いのは通常ありえないので、確定を止める材料として返す。
  const punchUnavailable = (punch.totalRecords === 0 && Object.keys(nameSet).length > 0);

  const ctx = { placeByFacility: A.placeMap(places), legs: legs };
  const staff = [];
  const missingFacilities = {};
  let unresolved = 0;
  for (const t of targets) {
    const auto = (t.auto && t.staffName)
      ? A.month(punchByName[t.staffName] || [], ym, ctx)
      : { days: {}, dates: [] };
    const manual = manualByDateOf(reqNode && reqNode[t.employeeId]);
    const merged = A.merge(auto.days, manual, (pendCorrByName[t.staffName] || {}));
    merged.rows.forEach(function (r) {
      (r.missingPlaces || []).forEach(function (f) { if (f) missingFacilities[f] = true; });
    });
    // ★ 利用ONなのに /mileage/staff に氏名が無い＝打刻と突き合わせられない。
    //   これを見逃すと 0km のまま確定され、黙って支給漏れになる（他の要確認と扱いを揃える）。
    const nameBlocked = (t.auto && !t.staffName);
    if (nameBlocked) merged.blockers.push({ date: "", status: "name_unresolved" });
    unresolved += merged.blockers.length;
    staff.push({
      employeeId: t.employeeId,
      staffName: t.staffName,
      autoTarget: !!t.auto,
      // 氏名が /mileage/staff に無い＝打刻と突き合わせられない（利用設定のやり直しが必要）
      nameResolved: !!t.staffName,
      totalKm: merged.totalKm,
      rows: merged.rows,
      blockers: merged.blockers,
    });
  }
  staff.sort(function (a, b) { return String(a.employeeId).localeCompare(String(b.employeeId), "ja"); });
  return { staff: staff, unresolved: unresolved, missingFacilities: Object.keys(missingFacilities),
           punchUnavailable: punchUnavailable };
}

/**
 * 確定対象の内容そのものから作る指紋。
 * ★ 管理者が画面で確認した内容と、実際に確定される内容が同一であることを保証するために使う。
 *   自動集計には「1件ずつ承認する」工程が無いため、これが唯一の「人が確認した」証跡になる。
 *   確認から確定までの間に打刻が変わっていれば一致せず、やり直しになる。
 */
function confirmDigest(ym, staffRows) {
  const parts = [ym];
  staffRows.forEach(function (s) {
    const days = s.rows
      .filter(function (r) { return r.status === "auto" || r.status === "manual"; })
      .map(function (r) { return r.date + ":" + r.km + ":" + r.source + ":" + (r.sig || ""); })
      .join(",");
    parts.push(s.employeeId + "=" + s.totalKm + "[" + days + "]");
  });
  return require("crypto").createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * 管理者向けの確認。
 * ・未確定の月 : 要確認（起点未確定／距離未登録／打刻修正待ち／未処理の手入力申請）の一覧
 * ・確定済みの月: 確定後に打刻が変わって金額が動く日（＝確定後差異あり）の一覧
 * ★ どちらも読み取りだけ。確定済みの金額を自動で書き換えることは絶対にしない。
 */
async function handleAutoCheck(body) {
  const ym = H.str(body.ym, 7);
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };

  const [comp, closing] = await Promise.all([
    computeAutoMonth(ym), G.dbGet(ROOT + "/closings/" + ym),
  ]);
  const closed = !!(closing && typeof closing === "object");

  const out = {
    status: 200, ok: true, ym: ym, closed: closed,
    unresolved: comp.unresolved,
    missingFacilities: comp.missingFacilities,
    punchUnavailable: comp.punchUnavailable,
    // 管理者が確認した内容で確定させるための指紋（closeMonth へそのまま渡す）
    confirmToken: confirmDigest(ym, comp.staff),
    totalKm: comp.staff.reduce(function (a, s) { return M.round1(a + s.totalKm); }, 0),
    staff: comp.staff.map(function (s) {
      return {
        employeeId: s.employeeId, staffName: s.staffName,
        autoTarget: s.autoTarget, nameResolved: s.nameResolved,
        totalKm: s.totalKm, blockers: s.blockers, attentionDays: s.rows.filter(function (r) { return r.attention; }).length,
        dayCount: s.rows.filter(function (r) { return r.status === "auto" || r.status === "manual"; }).length,
      };
    }),
  };

  if (closed) {
    const monthlyRaw = await G.dbGet(ROOT + "/monthly");
    const drift = [];
    comp.staff.forEach(function (s) {
      const snap = (monthlyRaw && monthlyRaw[s.employeeId] && monthlyRaw[s.employeeId][ym]) || null;
      const snapDays = (snap && Array.isArray(snap.days)) ? snap.days : [];
      // 確定前の古いスナップショット（日別内訳を持たない）は差異判定の対象外にする。
      // 「差異なし」と誤って報告しないよう、判定できないことを明示する。
      if (snap && !Array.isArray(snap.days)) {
        drift.push({ employeeId: s.employeeId, staffName: s.staffName, unknown: true, days: [] });
        return;
      }
      const diffs = A.diff(snapDays, s.rows);
      if (!diffs.length) return;
      let after = 0;
      s.rows.forEach(function (r) { if (r.status === "auto" || r.status === "manual") after = M.round1(after + r.km); });
      drift.push({
        employeeId: s.employeeId, staffName: s.staffName,
        beforeKm: snap ? M.round1(snap.totalKm) : 0, afterKm: after,
        days: diffs.slice(0, 60),
      });
    });
    out.drift = drift;
  }
  return out;
}

/**
 * 月次確定。給与計算の正本 /mileage/monthly/{employeeId}/{ym} を作る。
 * ★ ここで単価・端数処理・合計距離・支給額をスナップショットする。
 *   以後 settings を変えても、この月の金額は動かない。
 * ★ 集計はサーバ側で打刻から計算し直す。画面の表示値は受け取らない。
 * ★ 未解決の「要確認」が1件でもあれば確定しない（未確定データを給与へ混入させない）。
 */
async function handleCloseMonth(body, actor) {
  const ym = H.str(body.ym, 7);
  if (!M.isYm(ym)) return { status: 400, error: "bad_ym" };

  // 確定済み判定と単価の取得は互いに独立なので、1往復ぶん逐次にしない。
  // 確定は打刻の全件取得を伴い時間予算が厳しいため、削れる RTT は削る。
  const [existing, settings] = await Promise.all([
    G.dbGet(ROOT + "/closings/" + ym), M.loadSettings(),
  ]);
  if (existing && typeof existing === "object") return { status: 409, error: "already_closed" };

  // ★ km単価が一度も設定されていない状態で確定させない。
  //   既定値のまま確定すると、誰も決めていない単価で給与データが作られる。
  if (!settings.configured) return { status: 409, error: "rate_not_configured" };

  const comp = await computeAutoMonth(ym);

  // ★ 打刻が1件も取れていない状態で「移動が無い月」として確定しない（未取得と 0 を区別する）。
  if (comp.punchUnavailable) return { status: 409, error: "punch_unavailable" };

  // 要確認が残っていたら確定しない。どの職員のどの日かを返す（管理者が直せるように）。
  if (comp.unresolved > 0) {
    const detail = [];
    comp.staff.forEach(function (s) {
      s.blockers.forEach(function (b) {
        if (detail.length < 200) {
          detail.push({ employeeId: s.employeeId, staffName: s.staffName, date: b.date, status: b.status });
        }
      });
    });
    return { status: 409, error: "unresolved", unresolved: comp.unresolved, detail: detail,
             missingFacilities: comp.missingFacilities };
  }

  // ★ 管理者が画面で確認した内容と一致するときだけ確定する。
  //   自動集計は日ごとの承認工程を持たないため、ここが「人が見て承認した」唯一の関門になる。
  //   確認から確定までの間に打刻が変わっていれば一致せず、確認からやり直させる。
  const expected = confirmDigest(ym, comp.staff);
  if (H.str(body.confirmToken, 64) !== expected) {
    return { status: 409, error: "stale_confirmation" };
  }

  const now = M.nowIso();
  const patch = {};
  const rows = [];
  for (const s of comp.staff) {
    if (!(s.totalKm > 0)) continue;   // 移動が無い職員は出力しない
    const days = s.rows
      .filter(function (r) { return r.status === "auto" || r.status === "manual"; })
      .map(function (r) {
        return { date: r.date, km: r.km, source: r.source, sig: r.sig || "",
                 route: M.normText(r.routeText, 200) };
      });
    const row = {
      employeeId: s.employeeId,
      staffName: s.staffName,
      ym: ym,
      totalKm: s.totalKm,
      ratePerKm: settings.ratePerKm,
      roundMode: settings.roundMode,
      amount: M.monthlyAmount(s.totalKm, settings.ratePerKm, settings.roundMode),
      dayCount: days.length,
      // ★ 日別内訳と経路の指紋（sig）を残す。これが無いと「確定後に打刻が変わったか」を
      //   後から判定できない（＝確定後差異ありを検知できない）。
      days: days,
      closedAt: now,
      closedBy: actor,
    };
    patch[ROOT + "/monthly/" + s.employeeId + "/" + ym] = row;
    rows.push(row);
  }

  patch[ROOT + "/closings/" + ym] = {
    closedAt: now, closedBy: actor,
    ratePerKm: settings.ratePerKm, roundMode: settings.roundMode,
    staffCount: rows.length,
    excludedPending: 0,
    source: "auto",
  };
  await M.ensureMeta();
  await G.dbPatchRoot(patch);
  M.audit(actor, "month.close", ym, { staffCount: rows.length, mode: "auto" });
  return { status: 200, ok: true, ym: ym, rows: rows, excludedPending: 0 };
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

  // ★ ym が空のときは確定済み月の一覧を返すだけで monthly を使わない。
  //   /mileage/monthly は全職員×全月の1ノードで、日別内訳 days[] を持つぶん肥大する。
  //   労務士画面は「一覧取得 → 対象月取得」で2回呼ぶため、取って捨てる分をここで削る。
  const [closingsRaw, monthlyRaw] = await Promise.all([
    G.dbGet(ROOT + "/closings"),
    ym ? G.dbGet(ROOT + "/monthly") : Promise.resolve(null),
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

  // ★ closing を素通ししない。closedBy は監査用の actor で、管理者トークンに t クレーム
  //   （トークンハッシュ先頭16桁）が付く実装を入れた瞬間、労務士がそれを読めるようになる。
  //   これは /mileage/audit を API から返さない取り決めと同じ理由で外へ出してはならない値。
  //   rows と同じく「返す欄を列挙する」方針に揃える。
  const c0 = closingsRaw[ym] || {};
  const out = {
    status: 200, ok: true, ym: ym, closed: true,
    closing: {
      closedAt: String(c0.closedAt || ""),
      ratePerKm: Number(c0.ratePerKm) || 0,
      roundMode: String(c0.roundMode || ""),
      staffCount: Number(c0.staffCount) || 0,
      source: String(c0.source || ""),
    },
    closedMonths: closedMonths, rows: rows,
  };

  if (withDetail) {
    // 日別明細も確定済みのスナップショットだけから作る（未確定・要確認は混ぜない）
    const detail = [];
    const inReport = {};
    rows.forEach(function (r) { inReport[r.employeeId] = r; });

    // ★ 新方式（自動集計）の確定は日別内訳をスナップショットしている。それを正本にする。
    let fromSnapshot = false;
    for (const eid of Object.keys(inReport)) {
      const snap = monthlyRaw && monthlyRaw[eid] && monthlyRaw[eid][ym];
      if (!snap || !Array.isArray(snap.days)) continue;
      fromSnapshot = true;
      snap.days.forEach(function (d) {
        detail.push({
          employeeId: eid, staffName: inReport[eid].staffName,
          date: String(d.date || ""),
          route: String(d.route || String(d.sig || "").replace(/>/g, " → ").replace(/\|/g, " ／ ")),
          totalKm: M.round1(d.km),
          note: String(d.source || "") === "manual" ? "手入力" : "",
        });
      });
    }

    // 旧方式（申請ベース）で確定済みの月は、従来どおり承認済み申請から作る
    const node = fromSnapshot ? null : await G.dbGet(reqPath(ym));
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

    // ★ 打刻の全件取得を伴う action は連打させない（コストとタイムアウトの抑止）。
    //   closeMonth も同じ全件取得を行い、しかも要確認が残っている月では 409 を返すまでに
    //   必ずそこへ到達する。書込上限（300回/10分）だけでは抑止の意図が届かないため、
    //   autoCheck と同じ読み取り上限を掛ける。
    if (action === "autoCheck" || action === "closeMonth") {
      const n = await S.bumpAndCount("mlg_r", S.sanitizeKey(actor));
      if (n > READ_LIMIT_ADMIN) {
        res.setHeader("Retry-After", "600");
        await H.withMinDuration(startedAt, MIN_MS);
        return H.fail(res, 429, "rate_limited");
      }
    }

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
        const [node, closing, snap] = await Promise.all([
          G.dbGet(reqPath(ym, staff.employeeId)), G.dbGet(ROOT + "/closings/" + ym),
          G.dbGet(ROOT + "/monthly/" + staff.employeeId + "/" + ym),
        ]);
        const isClosed = !!(closing && typeof closing === "object");
        r = { status: 200, ok: true, ym: ym, requests: listRequests(node), closed: isClosed };
        // ★ 確定済みの月は、現在の打刻から計算し直した値ではなく確定額を見せる。
        //   確定後に打刻が直されても支給額は動かないため、再計算値を出すと画面と給与が食い違う。
        if (isClosed && snap && typeof snap === "object") {
          r.snapshot = {
            totalKm: M.round1(snap.totalKm), amount: Number(snap.amount) || 0,
            ratePerKm: Number(snap.ratePerKm) || 0, dayCount: Number(snap.dayCount) || 0,
            days: Array.isArray(snap.days) ? snap.days.map(function (d) {
              return { date: String(d.date || ""), km: M.round1(d.km),
                       source: String(d.source || ""), route: String(d.route || "") };
            }) : null,
          };
        }
        break;
      }
      case "saveRequest": r = await handleSaveRequest(body, staff); break;
      case "deleteRequest": r = await handleDeleteRequest(body, staff); break;
      case "adminMonth": r = await handleAdminMonth(body); break;
      case "autoCheck": r = await handleAutoCheck(body); break;
      case "setEnabled": r = await handleSetEnabled(body, actor); break;
      case "savePlace": r = await handleSavePlace(body, actor); break;
      case "deletePlace": r = await handleDeletePlace(body, actor); break;
      case "saveLeg": r = await handleSaveLeg(body, actor); break;
      case "deleteLeg": r = await handleDeleteLeg(body, actor); break;
      case "importLegs": r = await handleImportLegs(body, actor); break;
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
