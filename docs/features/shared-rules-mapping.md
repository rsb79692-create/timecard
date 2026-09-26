# 共通運用ルール（_shared_claude）の読み替え（Type C）

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## 共通運用ルール（_shared_claude 参照）

> **本リポジトリは `_shared_claude` 参照運用の Type C（Firebase + GitHub Pages）基準リポジトリであり、全7リポジトリ移行の最後（7例目）である。**
> 全リポジトリ共通の運用ルール（姿勢・禁止事項・agent 役割・報告の手順）は
> [`../_shared_claude/`](../../../_shared_claude/) を **single source of truth** として参照する。本 AGENTS.md には
> **timecard 固有の事実とルール** を残し、共通項は重複させず参照に寄せる。共通ルールと矛盾した場合は、
> **timecard 固有の「事実」（Firebase/GitHub Pages/index.html 単体/通知系など。下記各セクション）を優先**する。
> **ただし「レビュー範囲」は本例外の対象外である。** 初回レビューと再確認の範囲、および
> **広いレビューへ戻す条件**は [`../_shared_claude/AGENTS.md`](../../../_shared_claude/AGENTS.md)「レビュー範囲」を正本とし、
> 本書・`CLAUDE.md`・`.claude/**`・`docs/**` で同節より狭い範囲を定めない（同節が timecard 側の記載に優先する）。

作業開始時、まず以下の共通ファイルを前提として読む。timecard は技術構成タイプ **Type C（Firebase + GitHub Pages）**。Type A/B（Supabase/Neon・Vercel・npm ビルド）の前提を持ち込まない。

| 参照ファイル | 適用範囲 | timecard での扱い |
|---|---|---|
| [`../_shared_claude/RULES.md`](../../../_shared_claude/RULES.md) | 最優先ルール・共通禁止事項（推測禁止・指示外/削除禁止・secret 非出力・破壊的変更の事前説明・orchestrator 起点） | そのまま適用（「禁止事項」節で固有を上乗せ） |
| [`../_shared_claude/AGENTS.md`](../../../_shared_claude/AGENTS.md) | 共通の agent 役割定義・標準チェーン・完了報告にチェーン記載 | 適用。ただし **DB 担当は `migration-agent` ではなく `firebase-agent`**（下記）。チェーンは「Agent の役割と正しい流れ」節が正 |
| [`../_shared_claude/DEPLOY.md`](../../../_shared_claude/DEPLOY.md) | commit→push→Vercel READY→health→commit ID 必須 | **⚠ 読み替え適用**。**「Vercel READY」は GitHub Pages 自動デプロイ／GitHub Actions の確認に読み替える**（下記「DEPLOY.md の読み替え」） |
| [`../_shared_claude/DB.md`](../../../_shared_claude/DB.md) | Supabase/migration/RLS/rollback/破壊的 DDL 原則禁止 | **⚠ ほぼ非適用**。**Supabase/RLS/migration 前提は適用しない**。汎用の安全原則のみ参照（下記「DB.md の適用範囲」） |
| [`../_shared_claude/REPORT.md`](../../../_shared_claude/REPORT.md) | 完了報告の標準フォーマット | 適用（timecard 版テンプレートを併用） |
| [`../_shared_claude/PROJECT_TYPES.md`](../../../_shared_claude/PROJECT_TYPES.md) | タイプ別方針（timecard = Type C） | **Type C（Firebase + GitHub Pages）の分岐に従う** |

### DB.md の適用範囲（Type C / Firebase 固有・重要）

`_shared_claude/DB.md` は Supabase（PostgreSQL）を前提に書かれているため、timecard では **汎用の安全原則のみを参照**し、Supabase/RLS/migration 固有部は適用しない。

- ✅ **適用する汎用安全原則**: **本番 DB（Firebase RTDB の `tc5_*`）を変更しない**／**データの破壊的操作（削除・上書き）は事前にリスク提示・人間承認必須**／**変更前に現状確認**／**secret・接続情報・トークンを出力しない**。
- ❌ **適用しない Supabase/SQL 固有部**: **migration ファイル・`supabase/migrations/`・連番/タイムスタンプ命名**（timecard に **migration の概念は無い**）／**RLS / `CREATE POLICY` / `auth.uid()` / service role**／**`supabase db push` / `db diff` / `db reset`**／`@supabase/*` クライアント。
- timecard の実態: **Firebase Realtime Database**（REST `…/honomi/<path>.json`）／認証は **Firebase Auth**（Anonymous ＋ `/api/auth/*` が発行するカスタムトークン）／**スキーマ相当＝`database.rules.json`**（変更は **`firebase-agent` が方針提示し人間が確認**）。
  ⚠⚠ **`database.rules.json` は honomi-board と同居している。**（下記「RTDB のルールは honomi-board と共有」）
  ⚠ **`/honomi` の `.read`/`.write` はもう `auth != null` ではない**（2026-09-06 に変更）。同節を必ず読むこと。

### DEPLOY.md の読み替え（Type C）

`_shared_claude/DEPLOY.md` の骨子（commit→push→デプロイ確認→health→commit ID 必須）は流用するが、デプロイ確認手段を読み替える。

- **「Vercel READY 待機」→ GitHub Pages の自動デプロイ反映を待つ**（push `origin main` 後、30秒〜数分）。
- **デプロイ状況の確認先**: **GitHub Actions**（`https://github.com/rsb79692-create/timecard/actions`）の成否＋本番 URL。
- **health check 先**: 本番 URL **`https://rsb79692-create.github.io/timecard/`**（GitHub Pages。Vercel ではない）。通知 API のみ別 Vercel（`timecard-rho.vercel.app`）だが**出荷対象ではない**。
- **手動 `vercel --prod` はしない**。`agent:ship`／`ship.mjs` は**存在しない**（出荷は `git push origin main` → GitHub Pages 自動配信）。

### migration-agent ではなく firebase-agent を正とする

- 本リポジトリに **`migration-agent` は存在しない**。`_shared_claude/AGENTS.md` の「migration-agent（DB変更担当）」の役割は、timecard では **`firebase-agent`** が担う（Firebase RTDB・`database.rules.json`・FCM・PWA・GitHub Actions のインフラ層）。
- DB/スキーマ相当の検討が要る場合の入口は **`firebase-agent`**。ただし `database.rules.json`・Firebase データ・Secrets・ワークフローの**変更は人間の確認必須**（本タスクでは変更禁止）。
