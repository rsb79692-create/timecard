# 外部スケジューラ（cron-job.org）・GitHub PAT・通知系

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## cron-job.org / GitHub PAT / 通知系の扱い

- **定期実行の実態**: ⚠ **`schedule` の cron は指定時刻どおりには走らない**（2026-09-11 実測で 1時間45分〜2時間22分遅れ、過去には8時間遅れ。`fcm-notify` は取りこぼしも発生）。**時刻どおりの通知は外部スケジューラからの `workflow_dispatch`** が担っている（`morning-check` の6時分＝毎日 21:03:03 UTC ちょうど）。詳細と7時分の登録内容は上記「主要機能」の朝出勤確認 LINE通知を参照。`morning-check.yml` の cron 2本（`"3 21 * * *"` / `"3 22 * * *"`）は取りこぼし防止の位置づけ。
- **cron-job.org**: 本リポジトリ内に cron-job.org への参照・設定は**見つからない**が、**外部スケジューラの実体は cron-job.org である**（2026-09-11 にユーザーが確認）。`morning-check` を `workflow_dispatch` で起動しており、登録は次の2本:

  | 時刻（UTC） | JST | inputs | 判定時刻 | 状態 |
  |---|---|---|---|---|
  | 21:03 | 06:03 | （空） | 6時 | **稼働中**。毎日 21:03:03 ちょうどに着火（2026-09-11 に `gh run list` で9日連続を実測） |
  | 22:03 | 07:03 | `{"checkHour": "7"}` | 7時 | 2026-09-11 登録。**未発火・実効性は未確認**。初回発火は 2026-09-12 07:03 JST |

  加えて、**施設端末の持ち出し検知の定期実行**を cron-job.org へ登録する（2026-09-13 追加）。
  こちらは GitHub ではなく **Vercel の API を直接叩く**（`workflow_dispatch` ではない）。

  | 間隔 | 宛先 | Body | 目的 | 状態 |
  |---|---|---|---|---|
  | **毎分** | `POST https://timecard-rho.vercel.app/api/device-report` | `{"action":"sweep","key":"<DEVICE_SWEEP_KEY>"}` | 持ち出しの確定と LINE 通知（管理画面を開かなくても出す） | **2026-09-13 登録済み・毎分発火を実測**。⚠ 本文が JSON として読めておらず 400 のまま（本文の修正はユーザー作業） |

  ⚠⚠ **2026-09-13 の障害**: この登録の直後、`action:"sweep"` が**毎分 HTTP 500** を返していた。
  原因は ①cron が送る本文が有効な JSON でないこと ②それを 500 `server_error` として返していたこと
  （`api/device-report.js` の `readJsonBody` で 400 `bad_json` ＋ 指紋を返すよう是正した）。
  **cron-job.org 側の Body を直すまで確定の主経路は通らない。** 応答の `hint` が原因を示す。

  ⚠ `Content-Type: application/json` が必須（無いと 415）。鍵が違えば 403、鍵が未設定なら 503 を返すので、
  cron-job.org 側の実行履歴（HTTP ステータス）で設定ミスに気づける。**2xx 以外の通知を有効にしておくこと。**

  ⚠ 22:03 の行は**登録したという事実だけ**で、発火は確認できていない。確認手順は上記「主要機能」の朝出勤確認 LINE通知を参照し、
  **初回発火のログを目視するまで「稼働確認済み」と扱わない**（本書冒頭の「確認できていない項目は未確認と記載する」に従う）。

  ⚠ この2本は**同一の GitHub 資格情報**で dispatch している。失効すると6時・7時の**両方が同時に静かに止まり**、
  1〜2時間遅れる `schedule` cron だけが残る（Actions は毎日 success のままなので気づきにくい）。

  **外部スケジューラの設定は Agent から変更しない**（変更が必要なら人間に依頼）。
- **GitHub PAT**: 本リポジトリ内に PAT（`ghp_…` / `github_pat_…`）や `api.github.com` / `dispatches` 呼び出しは**見つからない（未確認）**。アプリから GitHub API を叩く実装は確認できなかった。
- **通知系まとめ**:
  - LINE Push: GitHub Actions（`morning-check` / `notify-check`）から直接送信（`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID`）。アップロード通知は Vercel `api/line-notify.js`。
  - Discord Webhook: Vercel `api/discord-notify.js`（`DISCORD_WEBHOOK_URL`）。`index.html` がアップロード時に呼ぶ。
  - FCM Push: GitHub Actions `fcm-notify` → `scripts/fcm-check.js`（`FIREBASE_SERVICE_ACCOUNT_KEY`）。
  - 通知のテストは必ず **dryRun**（`DRY_RUN=true` / `workflow_dispatch` の `dryRun`）で行い、実送信は人間の承認を得る。

---
