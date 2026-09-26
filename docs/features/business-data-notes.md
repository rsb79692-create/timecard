# 有給・打刻・月別出勤日数・通知機能の注意点（有給残日数の正本を含む）

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## 有給・打刻・月別出勤日数・通知機能の注意点

- **打刻 / 打刻修正申請**: `tc5_records` / `tc5_correction_requests` / `tc5_approvals` は**本番の勤怠データ**。Agent はこれらのデータを変更・削除しない（読み取り・コードレビューのみ）。
- **有給**: `tc5_paid_leave_requests` / `tc5_paid_leave_balances`。付与・残数の計算は給与に直結するため、ロジック変更は必ず analyst → review を通し、データ自体は触らない。

  ★ **残日数の正本は `remainDays` であり、`grantedDays - usedDays` で再計算してはならない**（2026-08-14 実測で確定）。
  `usedDays` は「このシステムで承認して消化した累計」でしかない。有給付与登録モーダルは
  **付与日数と別に残日数を入力できる**ため（運用開始前にすでに取得済みの分を残日数だけ減らして登録する）、
  その付与行では恒久的に

  ```
  grantedDays − usedDays − remainDays = 登録時点ですでに消化していた日数（carryIn）
  ```

  という差が残る。**本番実測（2026-08-14）では 40 付与行中 14 行がこの状態**で、最大 10日 の差がある。
  例: 付与7日 / `usedDays`3日 / `remainDays`2日 ＝ 登録時点で 2日 消化済み（消化済み合計 5日）。

  ・したがって **「消化済み合計」は `grantedDays − remainDays`** であり、`usedDays` ではない。
  ・付与日数を修正するときの残日数は **`remainDays(現) + (grantedDays(新) − grantedDays(現))`** で求める。
  　`grantedDays − usedDays` で再計算すると **carryIn が残日数として復活し、取得済みの有給が戻る**
  　（2026-08-14 に確認モーダルの表示・保存の両方で発生していた不具合。修正済み）。
  ・`usedDays` は **`applyFifoConsumption` / `reverseFifoConsumption` 以外から書き換えない**。
  　表示用残日数（`buildFutureApprovedLeaveMap`）が「未来日の取得予定を戻す上限」に `usedDays` を使っており、
  　ここを動かすと一覧の「第N回」表示と残日数合計が崩れる。
  ・`normalizePaidLeaveBalance` の `remainDays` 欠落時フォールバック（`granted - used`）は、
  　**値が無い行の既定値補完**であって再計算式ではない。再計算に流用しないこと。
  ・回帰テスト: `node scripts/test-paid-leave-grant-edit.js`
- **月別出勤日数**: `tc5_monthly_days_import`。`scripts/fix-monthly-days-year.js` は**データ補正系の保守スクリプトで副作用がある**ため、Agent から実行しない（人間が確認のうえ実行）。
- **施設端末の持ち出し検知**: `/devmon` 配下（ルート直下）は**検知の成否を決める設定**。基準位置・許容半径・監視ON/OFFを書き換えると持ち出しを検知できなくなる。Agent はデータを変更・削除しない（設定変更は管理画面から人が行う）。`/devmon/devices/*/tokenHash` は端末の資格情報のハッシュであり、値を表示・記録してはならない。
- **移動距離申請**: `/mileage` 配下（ルート直下）は**給与に直結する本番データ**。Agent はデータを変更・削除しない。特に `/mileage/monthly` と `/mileage/closings` は確定済みの支給額スナップショットであり、書き換えると過去月の給与計算が変わる。`/mileage/settings`（km単価・端数処理）の変更も金額に直結するため、コードからの既定値変更を含め人間の確認が必要。
- **通知機能**: 誤送信は実利用者（管理者・スタッフ）に届くため、検証は dryRun 限定。送信先 ID・Webhook・トークンは Secrets/環境変数で管理されており、値を表示しない。

---
