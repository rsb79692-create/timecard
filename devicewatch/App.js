"use strict";
/**
 * devicewatch/App.js — 画面は1つだけ
 *
 * ・未登録: 登録コードの入力
 * ・登録済み: 監視状態の表示（施設名・監視中かどうか・権限の状態）と、権限の再要求
 *
 * ★ 履歴画面・勤怠一覧・スタッフ一覧は作らない（このアプリは持ち出し監視だけを行う）。
 * ★ JSX を使わず React.createElement で書いてある。ビルド環境が無くても
 *   `node --check` で構文検査できるようにするため。表示要素は10個程度しかない。
 */

import React from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, AppState, Alert } from "react-native";
import * as W from "./src/watch";

const e = React.createElement;

const C = {
  bg: "#f4f6f8", card: "#ffffff", line: "#adb5bd", text: "#0f172a",
  sub: "#475569", ok: "#166534", warn: "#b45309", bad: "#b91c1c", blue: "#1e40af",
};

const S = {
  root: { flex: 1, backgroundColor: C.bg },
  wrap: { padding: 20, paddingTop: 56 },
  h1: { fontSize: 20, fontWeight: "700", color: C.text, marginBottom: 4 },
  lead: { fontSize: 13, color: C.sub, marginBottom: 20, lineHeight: 20 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 2, padding: 18, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: "700", color: C.sub, marginBottom: 6 },
  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 2, padding: 14,
    fontSize: 22, letterSpacing: 4, textAlign: "center", color: C.text, backgroundColor: "#fff",
  },
  btn: { backgroundColor: C.blue, borderRadius: 2, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  btnSub: { backgroundColor: "#dde1e7", borderWidth: 1, borderColor: C.line, borderRadius: 2, paddingVertical: 12, alignItems: "center", marginTop: 10 },
  btnSubText: { color: C.sub, fontSize: 14, fontWeight: "700" },
  // ★ React Native の Text は既定で縮まない（flexShrink:0）。指定しないと
  //   「位置情報サービスOFF（検知できません）」が右端で切れ、監視が死んでいるのに
  //   正常に見える。値側を縮める・折返す・右寄せにする。
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 7, gap: 8 },
  k: { fontSize: 13, color: C.sub, flexShrink: 0 },
  v: { fontSize: 13, fontWeight: "700", color: C.text, flexShrink: 1, flexGrow: 1, textAlign: "right" },
  note: { fontSize: 11, color: "#8496a7", marginTop: 12, lineHeight: 17 },
};

const PERM_TEXT = {
  always: "常に許可（正常）",
  whenInUse: "使用中のみ（検知できません）",
  denied: "拒否（検知できません）",
  off: "位置情報サービスOFF（検知できません）",
  restricted: "OSにより制限（検知できません）",
  "": "確認できません",
};

export default function App() {
  const [creds, setCreds] = React.useState(null);
  const [perm, setPerm] = React.useState("");
  const [watching, setWatching] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");

  const refresh = React.useCallback(async function () {
    try {
    const c = await W.loadCreds();
    setCreds(c);
    setPerm(await W.permissionState());
    // ★ 落ちていたら張り直す（OS がジオフェンスを落とす／通信失敗で開始できなかった場合の復旧）
    if (c) { try { await W.ensureWatching(); } catch (e) { /* 表示は下で更新する */ } }
    setWatching(await W.isWatching());
    // 起動・復帰のたびに1回報告する。★ これが「権限が外れた」ことを伝える主な経路。
    if (c) {
      const r = await W.report("appOpen");
      if (r && r.error === "revoked") {
        setCreds(null);
        setMsg("この端末の登録は管理者によって解除されました。");
      }
    }
    } catch (e) {
      // ★ 例外を外へ出さない。出すと状態が中途半端なまま画面が固まる。
      setMsg("状態を確認できませんでした。通信状態を確認してください。");
    }
  }, []);

  React.useEffect(function () {
    refresh();
    const sub = AppState.addEventListener("change", function (st) {
      if (st === "active") refresh();
    });
    return function () { sub.remove(); };
  }, [refresh]);

  async function onRegister() {
    if (busy) return;
    const v = code.trim().toUpperCase();
    if (v.length !== 8) { Alert.alert("登録コードは8文字です"); return; }
    setBusy(true); setMsg("");
    const p = await W.requestPermissions();
    if (!p.ok) {
      setBusy(false);
      Alert.alert(
        "位置情報の許可が必要です",
        p.reason === "background"
          ? "「常に許可」を選んでください。使用中のみでは持ち出しを検知できません。"
          : "位置情報の利用を許可してください。"
      );
      return;
    }
    let r = null;
    try { r = await W.register(v); } catch (e) { r = { ok: false, error: "network" }; }
    setBusy(false);
    if (!r.ok) {
      Alert.alert("登録できませんでした", errText(r.error));
      return;
    }
    setCode("");
    // ★ Alert を2つ連続で出してはならない（RN では片方が読まれないまま置き換わる）。
    //   基準位置の結果と監視の開始状況を1通へまとめる。
    const lines = [];
    if (r.baseError === "low_accuracy") {
      lines.push("現在地の誤差が大きいため、基準位置は設定していません。管理画面から緯度・経度を設定してください。");
    } else if (r.baseError === "no_position") {
      lines.push("現在地を取得できなかったため、基準位置は設定していません。管理画面から設定してください。");
    } else if (r.baseError === "base_already_set") {
      lines.push("この施設には基準位置が既に登録されているため、そのまま使います。");
    } else if (r.baseSet) {
      lines.push("この場所を施設の基準位置として登録しました。");
    }
    if (r.watchError === "no_base_position") {
      lines.push("基準位置が未設定のため、まだ監視は始まっていません。管理画面で基準位置を設定してください。");
    } else if (r.watchError) {
      lines.push("監視はまだ開始していません。位置情報の許可と基準位置の設定を確認してください。");
    }
    Alert.alert("登録しました", lines.join("\n") || "監視を開始しました。");
    refresh();
  }

  async function onFixPermission() {
    const p = await W.requestPermissions();
    if (!p.ok) {
      Alert.alert("設定アプリから変更してください",
        "位置情報を「常に許可」に変更してください。アプリからは一度拒否すると再要求できないことがあります。");
    }
    refresh();
  }

  async function onReportNow() {
    setBusy(true);
    let r = null;
    try { r = await W.report("manual"); } catch (e) { r = { ok: false }; }
    setBusy(false);
    setMsg(r && r.ok ? "サーバへ報告しました。" : "報告できませんでした。通信状態を確認してください。");
  }

  function errText(c) {
    if (c === "bad_code") return "登録コードが正しくありません。";
    if (c === "code_expired") return "登録コードの有効期限が切れています。管理画面で発行し直してください。";
    if (c === "too_many_devices") return "登録できる端末数の上限です。管理画面で使わない端末を解除してください。";
    if (c === "rate_limited") return "試行が多すぎます。しばらく待ってからお試しください。";
    return "通信できませんでした。電波の良い場所でお試しください。";
  }

  const cfg = (creds && creds.config) || null;
  const kids = [];

  kids.push(e(Text, { key: "h1", style: S.h1 }, "施設端末 持ち出し監視"));
  kids.push(e(Text, { key: "lead", style: S.lead },
    "施設に置いている打刻用端末が施設の範囲外へ移動したとき、管理者へ通知します。位置情報以外は何も送信しません。"));

  if (!creds) {
    kids.push(e(View, { key: "reg", style: S.card }, [
      e(Text, { key: "l", style: S.label }, "登録コード（管理画面のマスター管理で発行）"),
      e(TextInput, {
        key: "i", style: S.input, value: code, onChangeText: setCode,
        autoCapitalize: "characters", autoCorrect: false, maxLength: 8, placeholder: "XXXXXXXX",
      }),
      e(TouchableOpacity, { key: "b", style: S.btn, onPress: onRegister, disabled: busy },
        e(Text, { style: S.btnText }, busy ? "登録中…" : "この端末を登録する")),
      e(Text, { key: "n", style: S.note },
        "登録すると位置情報の許可を求めます。「常に許可」を選んでください。使用中のみでは、アプリを閉じているあいだ検知できません。"),
    ]));
  } else {
    kids.push(e(View, { key: "st", style: S.card }, [
      e(Text, { key: "l", style: S.label }, "状態"),
      e(View, { key: "r1", style: S.row }, [
        e(Text, { key: "k", style: S.k }, "施設"),
        e(Text, { key: "v", style: S.v }, (cfg && cfg.facilityName) || "（未取得）"),
      ]),
      e(View, { key: "r2", style: S.row }, [
        e(Text, { key: "k", style: S.k }, "監視"),
        e(Text, { key: "v", style: [S.v, { color: (cfg && cfg.enabled === false) ? C.warn : (watching ? C.ok : C.bad) }] },
          (cfg && cfg.enabled === false) ? "管理画面でOFF（報告は継続）"
            : (watching ? "動作中" : "停止中")),
      ]),
      e(View, { key: "r3", style: S.row }, [
        e(Text, { key: "k", style: S.k }, "許容半径"),
        e(Text, { key: "v", style: S.v }, ((cfg && cfg.radiusM) || "-") + " m"),
      ]),
      e(View, { key: "r4", style: S.row }, [
        e(Text, { key: "k", style: S.k }, "位置情報"),
        e(Text, { key: "v", style: [S.v, { color: perm === "always" ? C.ok : C.bad }] },
          PERM_TEXT[perm] || PERM_TEXT[""]),
      ]),
      perm !== "always"
        ? e(TouchableOpacity, { key: "fix", style: S.btn, onPress: onFixPermission },
          e(Text, { style: S.btnText }, "位置情報の許可を直す"))
        : null,
      e(TouchableOpacity, { key: "rep", style: S.btnSub, onPress: onReportNow, disabled: busy },
        e(Text, { style: S.btnSubText }, busy ? "送信中…" : "いま報告する")),
      e(Text, { key: "n", style: S.note },
        "この端末はこのまま施設に置いておいてください。アプリを閉じても監視は続きます。"
        + "端末の電源を切る・アプリを削除する・位置情報を切ると検知できなくなります。"),
    ]));
  }

  if (msg) kids.push(e(Text, { key: "msg", style: [S.note, { color: C.warn }] }, msg));

  return e(View, { style: S.root },
    e(ScrollView, { contentContainerStyle: S.wrap }, kids));
}
