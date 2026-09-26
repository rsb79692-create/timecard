# 使用技術と Firebase / GitHub Pages / Vercel の実態

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## 使用技術

- **フロントエンド**: 単一 `index.html`（バニラ JS、ビルドなし）。Firebase JS SDK 10.12.0（`firebase-app-compat` / `firebase-messaging-compat`、CDN）。
- **DB/認証**: Firebase **Realtime Database**（REST `…/honomi/<path>.json` を `authFetch` で読み書き）。認証は Firebase Identity Toolkit（`accounts:signUp` + `securetoken` リフレッシュ）でトークンを取得しヘッダ付与。
- **Push**: Firebase Cloud Messaging（FCM。`FCM_MESSAGING_SENDER_ID` / `FCM_VAPID_KEY` を `index.html` に保持）。
- **サーバー側 API**: Node.js（`https` モジュール）製 Vercel サーバーレス関数（`api/line-notify.js`・`api/discord-notify.js`）。
- **バッチ/通知スクリプト**: Node.js（`scripts/*.js`、GitHub Actions の `node-version: "20"` で実行）。
- **インフラ**: GitHub Pages（静的配信）、Vercel（通知API）、GitHub Actions（cron/手動）、Firebase（RTDB/Auth/FCM/Storage）。
- `firebase.json` は `database`（`database.rules.json`）と `storage`（`storage.rules`）のみ定義。**`hosting` は未定義**（＝Firebase Hosting は使っていない）。

---

---

## Firebase / Realtime Database / Hosting / GitHub Pages / Vercel の実態

| 項目 | 実態（確認できた事実） |
|---|---|
| Firebase Realtime Database | 使用。データは `…/honomi/` 配下（`tc5_records` ほか）。`database.rules.json` は `honomi` の `.read`/`.write` = `auth != null`。**`honomi/tc5_records` に `.indexOn: ["date"]` あり**（2026-08-28 追加。索引指定のみで権限は不変） |
| Firebase Auth | Identity Toolkit でトークン取得（`accounts:signUp` + securetoken refresh）。詳細な認証方式（匿名 or その他）の Console 設定は**未確認** |
| Firebase Cloud Messaging | 使用（打刻修正申請の Push）。`scripts/fcm-check.js` + `FIREBASE_SERVICE_ACCOUNT_KEY` |
| Firebase Storage | `storage.rules` あり（書類/写真アップロード用と推測されるが詳細は**未確認**） |
| Firebase Hosting | **不使用**（`firebase.json` に `hosting` 定義なし） |
| GitHub Pages | アプリ本体の配信先。`https://rsb79692-create.github.io/timecard/`（コード内 URL から確認） |
| Vercel | API（`api/*.js`：通知・認証・移動距離・施設端末の持ち出し監視）の配信先 `timecard-rho.vercel.app`。**本リポジトリの `main` push から Production へ自動デプロイされる**（2026-08-14 実測。`source: "git"` / `githubDeployment: "1"`） |

---
