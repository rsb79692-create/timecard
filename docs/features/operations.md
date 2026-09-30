# QA・Agent の流れ・出荷・完了報告の詳細（timecard）

規則は `AGENTS.md` を正とする。本書は整理前の AGENTS.md から移した運用節の原文。

## QA 手順

`.claude/agents/qa-agent.md` が担当する。ビルドが無いため、構文・整合・回帰テストが中心である。

1. `git status` / `git diff` で変更を把握する
2. 変更した `.js` に `node --check`、`manifest.json` / `database.rules.json` に JSON 検証
3. `sw.js` を変えた場合は `CACHE_NAME` の更新と `OFFLINE_URLS` の参照先の実在を確認する
4. 「機能の詳細文書」の表から、変更に関係する回帰テストをすべて実行する（全件 PASS / 0 FAIL。1件でも FAIL なら「要修正」で出荷しない。関係しないテストは実施不要と報告する）
5. 通知スクリプトの変更は dryRun で確認する（`DRY_RUN=true node scripts/morning-check.js`。判定時刻ごとに `CHECK_HOUR=6` / `7`）
6. GitHub Actions の YAML を変えた場合は、構文・cron・`secrets` 参照名・`node-version` を確認する
7. **instruction files を変えた場合**（`AGENTS.md` / `CLAUDE.md` / `.claude/rules/`）は `node ../_shared_claude/config/githooks/instruction-size.js --repo .` が FAIL でないことを確認する

総合判定は「出荷可 / 要修正」。要修正なら修正して再検証する（共通 `RULES.md`「実装ループ」）。

## Agent の役割と流れ

| Agent | 役割 | コード変更 |
|---|---|---|
| `analyst-agent` | 変更前の影響範囲調査・修正案 | しない |
| `debug-agent` | 障害の再現・原因特定・修正方針 | 原則しない（修正は Claude Code 本体または `implementer`） |
| `firebase-agent` | Firebase / PWA / 通知 / GitHub Actions のインフラ層 | インフラ層のみ。Rules・ワークフロー・Secrets は人の確認が必要 |
| `review-agent` | 静的レビュー（設計・副作用・セキュリティ・品質） | しない |
| `qa-agent` | 上記 QA 手順 | しない |
| `ship-agent` | commit → push → GitHub Pages / Vercel の反映確認 | しない |
| `orchestrator-agent` | 上記を統括する | 各 Agent に委任 |

通常の実装・不具合修正では、ユーザーが毎回指示しなくても共通 `RULES.md`「実装ループ」を適用する。

実装 → 検証（構文・回帰テスト）→ review-agent / qa-agent（該当すれば security / performance / ui-print）→ 指摘があれば修正 → 影響する検証の再実行 → Critical 0 / High 0 → 出荷

review・QA で「要修正」が出たら、停止せずに修正して再検証する。停止するのは共通 `RULES.md` の停止条件（同一原因3回・安全上の停止・承認が必要な操作）に当たるときだけとする。

## commit / push / deploy

- 通常実装は、明示的な停止指示がない限り、commit → push → GitHub Pages / Vercel の反映確認 → 本番確認まで進める（共通の出荷条件を満たしたうえで）。「commit しない」「調査だけ」等の範囲指定があれば従う。
- `git add` は触ったファイルだけをパス指定する（`-A` / `.` を使わない）。commit 前に `git diff --staged` を確認する。作業開始前から在る他人の未 commit 差分を含めない。
- push 先は `origin main`。force push はしない。remote に差分があれば `git pull --rebase` を提案する。
- アプリ本体は push 後に GitHub Pages が自動反映する（30秒〜数分。`https://github.com/rsb79692-create/timecard/actions` と本番 URL で確認）。
  API（`api/*.js`）は同じ push から Vercel が Production へ自動デプロイする（`vercel ls --prod` の Ready と `githubCommitSha` の一致で確認）。**2系統を両方確認する。**
- ワークフロー・Secrets・Firebase Rules・cron-job.org の変更は自律出荷に含めない（人の確認が必要）。

## 完了報告

共通 [`../_shared_claude/REPORT.md`](../../../_shared_claude/REPORT.md) の形式に従う。timecard では次も書く。

- 禁止事項の遵守（Firebase データ・Rules・Secrets・cron-job を変更していないこと、削除なし、secret 非表示）
- QA 結果（構文 / JSON / SW 整合 / 実行した回帰テスト / dryRun）
- 本番反映（GitHub Pages と Vercel のそれぞれ）と本番確認の結果。確認できなかった項目は「未確認（理由）」
