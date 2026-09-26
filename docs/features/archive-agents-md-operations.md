# 移設前の AGENTS.md の運用節（原文・参照用）

> 2026-09-26 に AGENTS.md を整理したときの、docs/features/ の各文書へ移さなかった節の**移設前の原文**である。
> **規範ではない。** 現行の規範は AGENTS.md と共通 _shared_claude/ にある。内容が食い違う場合は現行側が正しい
> （例: 禁止事項 8・15、Agent の流れは実装ループに合わせて改めた）。記述の経緯を確認するときだけ読む。

# AGENTS.md — 穂乃味タイムカード（timecard）

このファイルは timecard を Claude Code / 各種 Agent で手放し運用するための単一の参照元（Single Source of Truth）です。
`.claude/agents/*.md` の各 Agent はこのファイルの「禁止事項」「QA手順」「commit/push/deploy確認ルール」に従います。

> 本ファイルは**確認できた事実のみ**を記載しています。確認できていない項目は明示的に「未確認」と記載しています。
> 推測でルールを足さないでください。事実が変わったら本ファイルを更新してください。
> リポジトリ名はローカルでは `timecard-git`、GitHub remote は `rsb79692-create/timecard`。

---

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

## 実在する npm scripts

- **なし**（`package.json` が存在しないため npm scripts は無い）。
- したがって `npm run build` / `npm test` / `npm run lint` など**存在しないコマンドを使わない**。

---

## 環境変数名・secret名（名前のみ。値は絶対に表示・記録しない）

> いずれも**名前のみ**。値の表示・出力・記録・commit は禁止。`index.html` 内の Firebase web 設定値（`FB_API_KEY` 等）も**値は引用しない**。

- **GitHub Actions Secrets**: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY`
- **Vercel 環境変数**: `api/` 配下が `process.env` で参照している名前は次の**9件**（2026-09-13 に
  `grep -rho "process\.env\.[A-Z_0-9]*" api/` で実測。値は未確認）。
  `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `DISCORD_WEBHOOK_URL` /
  `FIREBASE_SERVICE_ACCOUNT_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_PROJECT_ID` /
  `TC_ENC_KEY` / `TC_PIN_PEPPER` / `DEVICE_SWEEP_KEY`
  - ⚠⚠ **この一覧を「未使用の整理」の根拠に使ってはならない**（`AUTH.md` §8：登録済みの変数を
    未使用と判断して削除してはならない）。実際に消すと壊れるものの例:
    `TC_PIN_PEPPER` → `api/_lib/secrets.js` の `pepper()` が throw して **PIN 認証が全滅**。
    `TC_ENC_KEY` → 保存済み PIN の平文が**復号不能**。
    `DEVICE_SWEEP_KEY` → `action:"sweep"` が 503 になり**持ち出し検知の確定の主経路が止まる**
    （保険の経路だけが残る）。
- **会社ごとの通知用（任意・名前のみ）**: 穂乃味以外の会社は、上の通知用の名前に `__<会社ID大文字>` を付けたものを使う
  （例 `LINE_CHANNEL_ACCESS_TOKEN__MANTEL` / `LINE_TO_ID__MANTEL` / `DISCORD_WEBHOOK_URL__MANTEL`）。
  **未設定の会社の通知は送られない**（穂乃味の宛先へは倒さない）。2026-09-26 時点で未登録。
- **クライアント側（`index.html` に埋め込み。Firebase 公開クライアント設定）**: `FB_URL`（Realtime Database URL）/ `FB_API_KEY` / `FCM_MESSAGING_SENDER_ID` / `FCM_VAPID_KEY`
- **スクリプトの実行制御**: `DRY_RUN` / `TEST_NOTIFY` / `TARGET_DATE`（秘匿情報ではないが、挙動に影響）

---

## 禁止事項（全 Agent 共通・厳守）

> 共通の禁止事項・姿勢の正本は [`../_shared_claude/RULES.md`](../../../_shared_claude/RULES.md)（データ破壊的操作の汎用原則は
> [`../_shared_claude/DB.md`](../../../_shared_claude/DB.md) の**汎用安全原則のみ**＝上記「DB.md の適用範囲」参照）。以下は timecard 固有のパス・対象を明示した上乗せ。

1. **secret 値を表示・出力・記録・commit しない**（Secrets/環境変数/`index.html` 内 Firebase 設定値を含む）
2. **DB（Firebase Realtime Database）を変更しない**（`tc5_*` データの作成/更新/削除を実行しない）
3. **Firebase データを変更しない**（Storage/RTDB/FCM トークン等のデータ操作をしない）。**`/morningNotify`（朝通知の送信記録）も手で書き換えない**（消すと同じ枠へ再送され、`sent` を書くとその枠の通知が止まる）
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
13. **`/tenants`・`/srv`・`/tenantReg`（他社の業務データ・サーバ専用データ・会社の利用状態）を変更・削除しない**。作成は `scripts/bootstrap-tenant.js` をユーザーの確認後に実行するときだけ
13b. **`/devmon`（施設端末の持ち出し監視）のデータを変更・削除しない**。`/devmon/facilities`（基準位置・許容半径・監視ON/OFF）と `/devmon/devices`（端末トークンのハッシュと状態）は検知の成否そのものを決める。読み取り・コードレビューのみ
14. **`fix-monthly-days-year.js` 等の副作用スクリプトを勝手に実行しない**
15. **判断に迷ったら編集・実行せず停止してユーザーに報告**

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

- **通常実装は、ユーザーの明示的な停止指示がない限り、commit → push → GitHub Pages 反映確認 → 本番確認まで進める**
  （共通 [`../_shared_claude/RULES.md`](../../../_shared_claude/RULES.md)「Git・出荷」／[`../_shared_claude/DEPLOY.md`](../../../_shared_claude/DEPLOY.md)）。
  ローカル確認だけで停止してはならない。**出荷前に共通 `AGENTS.md` の出荷条件（Critical 0 / High 0 / review 完了 /
  QA 完了）を満たしていること**が前提であり、未達なら出荷しない。
  ★ 共通側の「Vercel READY 確認」は本 repo では **GitHub Actions の成否と本番 URL の反映確認**へ読み替える
  （`PROJECT_TYPES.md` Type C）。
  「commit しない」「push しない」「本番へ出さない」「調査だけ」等の**範囲指定があれば従う**。
  ★ **下の「出荷フローに含めない」項目（ワークフロー・Secrets・Firebase Rules・cron-job.org）は
  この自律出荷の対象外である。** 自律で進めてよいのは通常のアプリコード変更に限る。
- `git add` は今回触ったファイルのみ個別に指定（`git add -A` / `git add .` は原則禁止）。commit 前に `git diff --staged` を確認。
- commit message は内容が分かる短い形式（例: `fix: 打刻処理の修正` / `feat: …` / `chore: …` / `docs: …`）。
- **push 先は `origin main`**。`git push --force` は提案しない。remote に差分がある場合は `git pull --rebase` を提案。
- **デプロイは push 後の GitHub Pages 自動反映が前提**（30秒〜数分）。状況は `https://github.com/rsb79692-create/timecard/actions` と本番 URL で確認。**手動 `vercel --prod` はしない**。
- ワークフロー・Secrets・Firebase Rules・cron-job.org の変更は出荷フローに含めない（人間の確認が必要）。
  ★ **`database.rules.json` は honomi-board と同一の Firebase プロジェクト `honomi-timecard` に同居している**
  （`PROJECT_TYPES.md` Type C）。`firebase deploy --only database` はルール全体を置換するため、
  timecard 側から出すと honomi-board の `rooms` / `members` / `config` / `field` /
  `shares` / `shareKeys` / `guestOf` が消え、共有ボードが即座に止まる。
  この repo の自律出荷に Rules のデプロイを含めてはならない。

---

## 完了報告テンプレート

> 共通の報告様式は [`../_shared_claude/REPORT.md`](../../../_shared_claude/REPORT.md)（起動 agent / agent チェーン /
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
commit / push        : 実施（commit ID・push先 origin main）/ 未実施（理由。範囲指定・出荷条件未達・失敗のいずれか）
本番反映             : 反映待ち（GitHub Pages 自動）/ 反映済み / 未デプロイ
本番確認             : 実施（確認内容）/ 未確認（理由）
次アクション・要確認 : （残課題・未確認事項。無ければ「なし」）
```
