# AGENTS.md — 穂乃味タイムカード（timecard）

このファイルは timecard を Claude Code / 各種 Agent で手放し運用するための単一の参照元（Single Source of Truth）です。
`.claude/agents/*.md` の各 Agent はこのファイルの「禁止事項」「QA手順」「commit/push/deploy確認ルール」に従います。

> 本ファイルは**確認できた事実のみ**を記載しています。確認できていない項目は明示的に「未確認」と記載しています。
> 推測でルールを足さないでください。事実が変わったら本ファイルを更新してください。
> リポジトリ名はローカルでは `timecard-git`、GitHub remote は `rsb79692-create/timecard`。

---

## 共通運用ルール（_shared_claude 参照）

> **本リポジトリは `_shared_claude` 参照運用の Type C（Firebase + GitHub Pages）基準リポジトリであり、全7リポジトリ移行の最後（7例目）である。**
> 全リポジトリ共通の運用ルール（姿勢・禁止事項・agent 役割・報告の手順）は
> [`../_shared_claude/`](../_shared_claude/) を **single source of truth** として参照する。本 AGENTS.md には
> **timecard 固有の事実とルール** を残し、共通項は重複させず参照に寄せる。共通ルールと矛盾した場合は、
> **timecard 固有の「事実」（Firebase/GitHub Pages/index.html 単体/通知系など。下記各セクション）を優先**する。

作業開始時、まず以下の共通ファイルを前提として読む。timecard は技術構成タイプ **Type C（Firebase + GitHub Pages）**。Type A/B（Supabase/Neon・Vercel・npm ビルド）の前提を持ち込まない。

| 参照ファイル | 適用範囲 | timecard での扱い |
|---|---|---|
| [`../_shared_claude/RULES.md`](../_shared_claude/RULES.md) | 最優先ルール・共通禁止事項（推測禁止・指示外/削除禁止・secret 非出力・破壊的変更の事前説明・orchestrator 起点） | そのまま適用（「禁止事項」節で固有を上乗せ） |
| [`../_shared_claude/AGENTS.md`](../_shared_claude/AGENTS.md) | 共通の agent 役割定義・標準チェーン・完了報告にチェーン記載 | 適用。ただし **DB 担当は `migration-agent` ではなく `firebase-agent`**（下記）。チェーンは「Agent の役割と正しい流れ」節が正 |
| [`../_shared_claude/DEPLOY.md`](../_shared_claude/DEPLOY.md) | commit→push→Vercel READY→health→commit ID 必須 | **⚠ 読み替え適用**。**「Vercel READY」は GitHub Pages 自動デプロイ／GitHub Actions の確認に読み替える**（下記「DEPLOY.md の読み替え」） |
| [`../_shared_claude/DB.md`](../_shared_claude/DB.md) | Supabase/migration/RLS/rollback/破壊的 DDL 原則禁止 | **⚠ ほぼ非適用**。**Supabase/RLS/migration 前提は適用しない**。汎用の安全原則のみ参照（下記「DB.md の適用範囲」） |
| [`../_shared_claude/REPORT.md`](../_shared_claude/REPORT.md) | 完了報告の標準フォーマット | 適用（timecard 版テンプレートを併用） |
| [`../_shared_claude/PROJECT_TYPES.md`](../_shared_claude/PROJECT_TYPES.md) | タイプ別方針（timecard = Type C） | **Type C（Firebase + GitHub Pages）の分岐に従う** |

### DB.md の適用範囲（Type C / Firebase 固有・重要）

`_shared_claude/DB.md` は Supabase（PostgreSQL）を前提に書かれているため、timecard では **汎用の安全原則のみを参照**し、Supabase/RLS/migration 固有部は適用しない。

- ✅ **適用する汎用安全原則**: **本番 DB（Firebase RTDB の `tc5_*`）を変更しない**／**データの破壊的操作（削除・上書き）は事前にリスク提示・人間承認必須**／**変更前に現状確認**／**secret・接続情報・トークンを出力しない**。
- ❌ **適用しない Supabase/SQL 固有部**: **migration ファイル・`supabase/migrations/`・連番/タイムスタンプ命名**（timecard に **migration の概念は無い**）／**RLS / `CREATE POLICY` / `auth.uid()` / service role**／**`supabase db push` / `db diff` / `db reset`**／`@supabase/*` クライアント。
- timecard の実態: **Firebase Realtime Database**（REST `…/honomi/<path>.json`）／認証は **Firebase Auth**（`database.rules.json` の `.read`/`.write` = `auth != null`。Anonymous 想定だが Console 設定詳細は未確認）／**スキーマ相当＝`database.rules.json`**（変更は **`firebase-agent` が方針提示し人間が確認**。本タスクでは変更禁止）。

### DEPLOY.md の読み替え（Type C）

`_shared_claude/DEPLOY.md` の骨子（commit→push→デプロイ確認→health→commit ID 必須）は流用するが、デプロイ確認手段を読み替える。

- **「Vercel READY 待機」→ GitHub Pages の自動デプロイ反映を待つ**（push `origin main` 後、30秒〜数分）。
- **デプロイ状況の確認先**: **GitHub Actions**（`https://github.com/rsb79692-create/timecard/actions`）の成否＋本番 URL。
- **health check 先**: 本番 URL **`https://rsb79692-create.github.io/timecard/`**（GitHub Pages。Vercel ではない）。通知 API のみ別 Vercel（`timecard-rho.vercel.app`）だが**出荷対象ではない**。
- **手動 `vercel --prod` はしない**。`agent:ship`／`ship.mjs` は**存在しない**（出荷は `git push origin main` → GitHub Pages 自動配信）。

### migration-agent ではなく firebase-agent を正とする

- 本リポジトリに **`migration-agent` は存在しない**。`_shared_claude/AGENTS.md` の「migration-agent（DB変更担当）」の役割は、timecard では **`firebase-agent`** が担う（Firebase RTDB・`database.rules.json`・FCM・PWA・GitHub Actions のインフラ層）。
- DB/スキーマ相当の検討が要る場合の入口は **`firebase-agent`**。ただし `database.rules.json`・Firebase データ・Secrets・ワークフローの**変更は人間の確認必須**（本タスクでは変更禁止）。

## プロジェクト概要

- **名称**: 穂乃味タイムカード（リポジトリ `timecard`）
- **種別**: バニラ JavaScript（ビルドなし）+ Firebase の **PWA**。単一の `index.html` にアプリ本体（JS）を内包。
- **用途**: 打刻・打刻修正申請・有給申請/付与・月別出勤日数管理・各種通知を行う勤怠アプリ。
- **配信構成（確認できた実態）**:
  - **アプリ本体（静的サイト）= GitHub Pages**。本番 URL: `https://rsb79692-create.github.io/timecard/`（`api/line-notify.js` / `api/discord-notify.js` の `ALLOWED_ORIGIN`・`ADMIN_URL`、`?token=all` で確認）。
  - **通知用 API = 別の Vercel デプロイ**。`index.html` の `NOTIFY_API_URL="https://timecard-rho.vercel.app/api/discord-notify"`。`api/*.js` は Vercel サーバーレス関数。
  - **定期実行 = GitHub Actions**（`.github/workflows/`）。
- `package.json` は**存在しない**（npm プロジェクトではない）。

---

## 主要機能

- **打刻**: Realtime Database `tc5_records`（`index.html`）。
- **打刻修正申請**: `tc5_correction_requests`。承認は `tc5_approvals`。未対応申請は FCM Push で通知（`scripts/fcm-check.js`）。
- **有給**: 申請 `tc5_paid_leave_requests`、残数 `tc5_paid_leave_balances`。付与・承認時にスタッフ本人へアプリ内通知（直近コミットで実装）。
- **月別出勤日数**: `tc5_monthly_days_import`（`scripts/fix-monthly-days-year.js` は年度補正用の保守スクリプト）。関連: ルートの `勤務日数管理.xlsx`。
- **ピン留め等**: `tc5_pins`。
- **通知系**:
  - 朝出勤確認 LINE通知（`scripts/morning-check.js`、`.github/workflows/morning-check.yml`、毎日 06:03 JST）
  - 通知確認 LINE通知（`scripts/notify-check.js`、`.github/workflows/notify-check.yml`、手動 `workflow_dispatch` のみ）
  - 打刻修正申請 FCM Push通知（`scripts/fcm-check.js`、`.github/workflows/fcm-notify.yml`、JST 8–22時に30分間隔）
  - 写真アップロード通知（管理者向け。LINE: `api/line-notify.js` / Discord: `api/discord-notify.js`、いずれも Vercel）
- **PWA**: `manifest.json` + Service Worker `sw.js`（オフライン対応・キャッシュ）。

> 各機能の業務上の詳細仕様（締め日・集計ロジック等）は本リポジトリからは断定できない部分があり、その範囲は**未確認**。

---

## 使用技術

- **フロントエンド**: 単一 `index.html`（バニラ JS、ビルドなし）。Firebase JS SDK 10.12.0（`firebase-app-compat` / `firebase-messaging-compat`、CDN）。
- **DB/認証**: Firebase **Realtime Database**（REST `…/honomi/<path>.json` を `authFetch` で読み書き）。認証は Firebase Identity Toolkit（`accounts:signUp` + `securetoken` リフレッシュ）でトークンを取得しヘッダ付与。
- **Push**: Firebase Cloud Messaging（FCM。`FCM_MESSAGING_SENDER_ID` / `FCM_VAPID_KEY` を `index.html` に保持）。
- **サーバー側 API**: Node.js（`https` モジュール）製 Vercel サーバーレス関数（`api/line-notify.js`・`api/discord-notify.js`）。
- **バッチ/通知スクリプト**: Node.js（`scripts/*.js`、GitHub Actions の `node-version: "20"` で実行）。
- **インフラ**: GitHub Pages（静的配信）、Vercel（通知API）、GitHub Actions（cron/手動）、Firebase（RTDB/Auth/FCM/Storage）。
- `firebase.json` は `database`（`database.rules.json`）と `storage`（`storage.rules`）のみ定義。**`hosting` は未定義**（＝Firebase Hosting は使っていない）。

---

## 実在する npm scripts

- **なし**（`package.json` が存在しないため npm scripts は無い）。
- したがって `npm run build` / `npm test` / `npm run lint` など**存在しないコマンドを使わない**。

---

## build / lint / test / deploy 手順

- **build**: ビルド工程は**無い**（静的 `index.html`。トランスパイル/バンドルなし）。
- **lint**: lint 設定・コマンドは**未整備**（ESLint 等の設定ファイルなし）。「lint して」と言われても存在しないコマンドを実行しない。
- **test**: 自動テストフレームワーク・Playwright・smoke・`agent:ship` は**未整備**。実施可能な確認は手動の構文チェックと dryRun のみ:
  - JS 構文: `node --check scripts/morning-check.js`（同様に `notify-check.js` / `fcm-check.js` / `api/line-notify.js` / `api/discord-notify.js` / `sw.js`）
  - JSON 構文: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`（`database.rules.json` も同様）
  - 通知ロジック dryRun（送信なし）: `DRY_RUN=true node scripts/morning-check.js`（PowerShell: `$env:DRY_RUN="true"; node scripts/morning-check.js`）。`FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` 未設定時はスキップ。
- **deploy**:
  - アプリ本体: `git push origin main` → **GitHub Pages が自動デプロイ**（`https://rsb79692-create.github.io/timecard/`）。本リポジトリに Pages 用ワークフローや `CNAME` は無く、ブランチ配信前提（Pages 設定自体はリポジトリ設定側で管理＝リポジトリ内からは設定値まで未確認）。
  - 通知 API: `api/*.js` は Vercel（`timecard-rho.vercel.app`）。**Vercel が本リポジトリから自動デプロイされるか否かは未確認**（`vercel.json` / `.vercel` はリポジトリ内に無い）。Agent から `vercel --prod` 等の手動デプロイはしない。
  - GitHub Actions のワークフローは push で反映されるが、**ワークフローや Secrets は Agent から変更しない**。

---

## Firebase / Realtime Database / Hosting / GitHub Pages / Vercel の実態

| 項目 | 実態（確認できた事実） |
|---|---|
| Firebase Realtime Database | 使用。データは `…/honomi/` 配下（`tc5_records` ほか）。`database.rules.json` は `honomi` の `.read`/`.write` = `auth != null` |
| Firebase Auth | Identity Toolkit でトークン取得（`accounts:signUp` + securetoken refresh）。詳細な認証方式（匿名 or その他）の Console 設定は**未確認** |
| Firebase Cloud Messaging | 使用（打刻修正申請の Push）。`scripts/fcm-check.js` + `FIREBASE_SERVICE_ACCOUNT_KEY` |
| Firebase Storage | `storage.rules` あり（書類/写真アップロード用と推測されるが詳細は**未確認**） |
| Firebase Hosting | **不使用**（`firebase.json` に `hosting` 定義なし） |
| GitHub Pages | アプリ本体の配信先。`https://rsb79692-create.github.io/timecard/`（コード内 URL から確認） |
| Vercel | 通知 API（`api/*.js`）の配信先 `timecard-rho.vercel.app`。本リポジトリとの自動デプロイ連携の有無は**未確認** |

---

## cron-job.org / GitHub PAT / 通知系の扱い

- **定期実行の実態**: スケジュール実行は **GitHub Actions の cron** で行われている（`morning-check.yml` = 毎日 06:03 JST、`fcm-notify.yml` = JST 8–22時に30分間隔）。
- **cron-job.org**: 本リポジトリ内に cron-job.org への参照・設定は**見つからない（未確認）**。外部で cron-job.org を併用しているかは本リポジトリからは判断できない。**cron-job.org の設定は変更しない**（変更が必要なら人間に依頼）。
- **GitHub PAT**: 本リポジトリ内に PAT（`ghp_…` / `github_pat_…`）や `api.github.com` / `dispatches` 呼び出しは**見つからない（未確認）**。アプリから GitHub API を叩く実装は確認できなかった。
- **通知系まとめ**:
  - LINE Push: GitHub Actions（`morning-check` / `notify-check`）から直接送信（`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID`）。アップロード通知は Vercel `api/line-notify.js`。
  - Discord Webhook: Vercel `api/discord-notify.js`（`DISCORD_WEBHOOK_URL`）。`index.html` がアップロード時に呼ぶ。
  - FCM Push: GitHub Actions `fcm-notify` → `scripts/fcm-check.js`（`FIREBASE_SERVICE_ACCOUNT_KEY`）。
  - 通知のテストは必ず **dryRun**（`DRY_RUN=true` / `workflow_dispatch` の `dryRun`）で行い、実送信は人間の承認を得る。

---

## 有給・打刻・月別出勤日数・通知機能の注意点

- **打刻 / 打刻修正申請**: `tc5_records` / `tc5_correction_requests` / `tc5_approvals` は**本番の勤怠データ**。Agent はこれらのデータを変更・削除しない（読み取り・コードレビューのみ）。
- **有給**: `tc5_paid_leave_requests` / `tc5_paid_leave_balances`。付与・残数の計算は給与に直結するため、ロジック変更は必ず analyst → review を通し、データ自体は触らない。
- **月別出勤日数**: `tc5_monthly_days_import`。`scripts/fix-monthly-days-year.js` は**データ補正系の保守スクリプトで副作用がある**ため、Agent から実行しない（人間が確認のうえ実行）。
- **通知機能**: 誤送信は実利用者（管理者・スタッフ）に届くため、検証は dryRun 限定。送信先 ID・Webhook・トークンは Secrets/環境変数で管理されており、値を表示しない。

---

## 環境変数名・secret名（名前のみ。値は絶対に表示・記録しない）

> いずれも**名前のみ**。値の表示・出力・記録・commit は禁止。`index.html` 内の Firebase web 設定値（`FB_API_KEY` 等）も**値は引用しない**。

- **GitHub Actions Secrets**: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY`
- **Vercel 環境変数（`api/*.js` のコメントより）**: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `DISCORD_WEBHOOK_URL`
- **クライアント側（`index.html` に埋め込み。Firebase 公開クライアント設定）**: `FB_URL`（Realtime Database URL）/ `FB_API_KEY` / `FCM_MESSAGING_SENDER_ID` / `FCM_VAPID_KEY`
- **スクリプトの実行制御**: `DRY_RUN` / `TEST_NOTIFY` / `TARGET_DATE`（秘匿情報ではないが、挙動に影響）

---

## 禁止事項（全 Agent 共通・厳守）

> 共通の禁止事項・姿勢の正本は [`../_shared_claude/RULES.md`](../_shared_claude/RULES.md)（データ破壊的操作の汎用原則は
> [`../_shared_claude/DB.md`](../_shared_claude/DB.md) の**汎用安全原則のみ**＝上記「DB.md の適用範囲」参照）。以下は timecard 固有のパス・対象を明示した上乗せ。

1. **secret 値を表示・出力・記録・commit しない**（Secrets/環境変数/`index.html` 内 Firebase 設定値を含む）
2. **DB（Firebase Realtime Database）を変更しない**（`tc5_*` データの作成/更新/削除を実行しない）
3. **Firebase データを変更しない**（Storage/RTDB/FCM トークン等のデータ操作をしない）
4. **GitHub Secrets を変更しない**
5. **cron-job.org の設定を変更しない**
6. **GitHub Actions ワークフロー（`.github/workflows/`）を目的外で変更しない**（変更は人間の確認必須）
7. **`database.rules.json`（Firebase Rules）を勝手に変更しない**（本番データに直結。変更は firebase-agent で方針提示し人間が確認）
8. **アプリコードを目的外で変更しない**。特に:
   - `index.html`（変更は方針確認後のみ）
   - `sw.js`（変更時は **`CACHE_NAME` のバージョンアップ必須**）
   - `api/*.js`（Vercel 通知関数）
9. **削除操作禁止**（ファイル削除・`git clean`・`git stash`・`git reset --hard`・`git push --force`・データ削除）
10. **存在しない npm script を使わない**（npm プロジェクトではない。build/lint/test の npm コマンドは無い）
11. **未整備のものを勝手に使わない**: Playwright / smoke / `agent:ship` は**未整備**。使わず、必要なら未整備である旨を報告する
12. **Vercel への手動デプロイ（`vercel --prod` 等）をしない**（連携の有無も未確認）。デプロイは git push → GitHub Pages 自動配信が前提
13. **`fix-monthly-days-year.js` 等の副作用スクリプトを勝手に実行しない**
14. **判断に迷ったら編集・実行せず停止してユーザーに報告**

---

## QA 手順

`.claude/agents/qa-agent.md` が担当。標準フロー（ビルドが無いため構文・整合チェック中心）:

1. **変更把握**: `git diff HEAD` / `git status`
2. **JS 構文チェック**: 変更した `.js` / `sw.js` に `node --check`
3. **JSON 構文チェック**: `manifest.json` / `database.rules.json`
4. **Service Worker 整合**: `sw.js` の `CACHE_NAME` がファイル変更に合わせて更新されているか、`OFFLINE_URLS` の参照ファイルが存在するか
5. **通知スクリプト dryRun**: `DRY_RUN=true node scripts/morning-check.js`（環境変数未設定ならスキップして報告。実送信はしない）
6. **GitHub Actions YAML 確認**: 構文・cron・`secrets` 参照名・`node-version`

総合判定は「出荷可 / 要修正」。要修正なら ship に進まない。

---

## Agent の役割と正しい流れ

| Agent | 役割 | コード変更 |
|---|---|---|
| `analyst-agent` | 変更前の影響範囲調査・修正案提示 | しない |
| `debug-agent` | 障害調査・原因特定・修正方針提示（修正は要確認） | 方針確認後のみ |
| `firebase-agent` | Firebase/PWA/通知/GitHub Actions のインフラ層の調査・確認・修正 | インフラ層のみ・要確認 |
| `review-agent` | 静的コードレビュー（設計・副作用・セキュリティ・品質） | しない |
| `qa-agent` | 構文/JSON/SW整合/通知dryRun/Actions 確認 | しない |
| `ship-agent` | commit → push → GitHub Pages 自動デプロイ | しない |
| `orchestrator-agent` | 上記を統括し順番に実行（失敗時は即停止） | 各 Agent に委任 |

### review-agent → qa-agent → ship-agent の正しい流れ

```
（実装・修正、必要に応じて firebase-agent でインフラ確認）
   ↓
review-agent  ── 静的レビュー（設計・副作用・Firebase Rules整合・SW・通知）。問題あれば修正へ戻す
   ↓ 承認
qa-agent      ── 構文/JSON/SW整合/dryRun/Actions。総合判定「出荷可」
   ↓ 出荷可
ship-agent    ── git add 済み前提で commit → push origin main → GitHub Pages 自動デプロイ
```

- review-agent が「要修正」→ 修正に戻す（qa へ進まない）
- qa-agent が「要修正」→ ship を**開始しない**
- staged ファイルが 0 件、または commit message 未指定なら ship を**開始しない**

---

## commit / push / deploy 確認ルール

- **commit / push はユーザーが明示的に承認するまで行わない**。Agent が勝手に commit/push しない。
- `git add` は今回触ったファイルのみ個別に指定（`git add -A` / `git add .` は原則禁止）。commit 前に `git diff --staged` を確認。
- commit message は内容が分かる短い形式（例: `fix: 打刻処理の修正` / `feat: …` / `chore: …` / `docs: …`）。
- **push 先は `origin main`**。`git push --force` は提案しない。remote に差分がある場合は `git pull --rebase` を提案。
- **デプロイは push 後の GitHub Pages 自動反映が前提**（30秒〜数分）。状況は `https://github.com/rsb79692-create/timecard/actions` と本番 URL で確認。**手動 `vercel --prod` はしない**。
- ワークフロー・Secrets・Firebase Rules・cron-job.org の変更は出荷フローに含めない（人間の確認が必要）。

---

## 完了報告テンプレート

> 共通の報告様式は [`../_shared_claude/REPORT.md`](../_shared_claude/REPORT.md)（起動 agent / agent チェーン /
> 変更ファイル / 検証結果 / commit ID / push・deploy 結果 / 未対応 / リスク）。以下は timecard 版（併用可）。

作業完了時は以下の形式で報告する（該当しない項目は「該当なし」）:

```
■ 作業完了報告

着手前 git status   : （要点。M / ?? の概況）
変更ファイル一覧     : （パス列挙。無ければ「なし」）
確認できた事実       : （箇条書き）
未確認事項           : （箇条書き。無ければ「なし」）
禁止事項の遵守       : Firebaseデータ変更なし / Rules変更なし / Secrets変更なし / cron-job変更なし / 削除なし / secret非表示
QA結果               : 構文 / JSON / SW整合 / dryRun（実施した場合）。未実施なら「未実施」
commit / push        : 未実施（ユーザー承認待ち）/ 実施（commit ID・push先 origin main）
本番反映             : 反映待ち（GitHub Pages 自動）/ 反映済み / 未デプロイ
次アクション・要確認 : （commit 可否など）
```
