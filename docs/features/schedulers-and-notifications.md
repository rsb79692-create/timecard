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
  | **5分ごと**（2026-10-22 20:10 JST に毎分から変更） | `POST https://timecard-rho.vercel.app/api/device-report` | `{"action":"sweep","key":"<DEVICE_SWEEP_KEY>"}` | 持ち出しの確定と LINE 通知（管理画面を開かなくても出す） | 2026-09-13 登録（ジョブ名「timecard 端末持ち出し監視」）。**2026-10-22 時点で正常に成功（200）していることを確認済み** |

  ⚠⚠ **2026-09-13 の障害**: この登録の直後、`action:"sweep"` が**毎分 HTTP 500** を返していた。
  原因は ①cron が送る本文が有効な JSON でないこと ②それを 500 `server_error` として返していたこと
  （`api/device-report.js` の `readJsonBody` で 400 `bad_json` ＋ 指紋を返すよう是正した）。
  その後 cron-job.org 側の Body は直り、2026-10-22 時点で 200 を確認済み。再発したときは応答の `hint` が原因を示す。

  ★ 間隔は**5分**（2026-10-22 社長判断「1分である必要はない」）。範囲外の観測が2回届いたあと電源を切られて
  持ち去られた場合の通知は、最初の範囲外の報告から3〜8分（最悪約8分）。電源が入ったまま移動していれば端末の位置報告で
  検知されるので影響はほぼ無い（静止すると定期実行頼みになる）。
  受信途絶・位置不明（24時間）の通知は影響なし。詳細は `device-watch.md`「定期実行の間隔は5分」。

  ⚠ `Content-Type: application/json` が必須（無いと 415）。鍵が違えば 403、鍵が未設定なら 503 を返すので、
  cron-job.org 側の実行履歴（HTTP ステータス）で設定ミスに気づける。**2xx 以外の通知を有効にしておくこと。**

  ⚠ 22:03 の行は**登録したという事実だけ**で、発火は確認できていない。確認手順は上記「主要機能」の朝出勤確認 LINE通知を参照し、
  **初回発火のログを目視するまで「稼働確認済み」と扱わない**（本書冒頭の「確認できていない項目は未確認と記載する」に従う）。

  ⚠ この2本は**同一の GitHub 資格情報**で dispatch している。失効すると6時・7時の**両方が同時に静かに止まり**、
  1〜2時間遅れる `schedule` cron だけが残る（Actions は毎日 success のままなので気づきにくい）。

  **外部スケジューラの設定は Agent から変更しない**（変更が必要なら人間に依頼）。

### マンテールの朝出勤確認（オーナー作業の手順書）— 2026-11-03

ワークフロー `.github/workflows/morning-check-mantel.yml`（`workflow_dispatch` だけ。`schedule` は無い）。仕様は
[`main-features-and-morning-check.md`](main-features-and-morning-check.md)「マンテール」。**以下はすべて人（オーナー）が行う。Agent は Secrets・cron-job.org・Firebase を変更しない。**

0. **`morning-check-mantel.yml` を含む変更を main へ取り込む**（出荷は別作業）。ワークフローが main に無いと Run workflow ボタンが出ず、REST も 404 になる。
1. **GitHub Secrets を登録する**（Settings → Secrets and variables → Actions）: `LINE_CHANNEL_ACCESS_TOKEN__MANTEL`（マンテールの LINE 公式アカウントのチャネルアクセストークン）と `LINE_TO_ID__MANTEL`（送り先の userId `U…` または groupId `C…`。取得方法は `scripts/line-webhook-id-helper.md`）。
   `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY` は穂乃味と共用で登録済み（変更しない）。
2. **マンテールが「利用中」であることを確かめる**（システム管理者画面の会社一覧）。停止中（`/tenantReg/mantel/active` が `true` でない）のあいだは、以下のどの実行も `[SKIP] 会社 mantel は利用停止中です` で何もせずに終わる。
3. **判定だけを試す（送らない）**: Actions → 「朝出勤確認 LINE通知（マンテール）」→ Run workflow。`checkHour` = `6`、`dryRun` = ON（既定）。
   ログの `[FAC]` で施設が11件（6時）に並び、`[WARN] DEFAULT_FACILITIES に無い施設` や「設定異常」が無いことを見る。`checkHour` = `5` でも同様に あんず苑 の1件を確かめる。
   施設マスタの表記がスタッフ一覧と違えば（特に ``Kiyomi`s郷あゆむ``）、ここで分かる。
4. **二重通知防止の確認（送らない）**: `selfTest` = ON で実行（`checkHour` は空でよい）。`[SELFTEST] PASS` を確かめる（`/srv/mantel/morningNotify/_selftest` だけを書く）。
5. **テスト送信（1通だけ届く）**: `testNotify` = ON、`dryRun` = **OFF**、`checkHour` は空でよい。マンテールの宛先へ「【マンテール タイムカード】テスト通知」が1通届くことを確かめる。
   判定はしない・通知記録も書かない固定文なので、施設の状況とは無関係に安全に試せる（穂乃味の宛先へは送られない）。
6. **cron-job.org にジョブを2本登録する**（既存の穂乃味のジョブと同じ GitHub 資格情報・同じヘッダーで、URL と本文だけ変える）:

   | 時刻（UTC） | JST | URL（POST） | Body（**値はすべて文字列**） |
   |---|---|---|---|
   | 20:03 毎日 | 05:03 | `https://api.github.com/repos/rsb79692-create/timecard/actions/workflows/morning-check-mantel.yml/dispatches` | `{"ref":"main","inputs":{"checkHour":"5","dryRun":"false"}}` |
   | 21:03 毎日 | 06:03 | 同上 | `{"ref":"main","inputs":{"checkHour":"6","dryRun":"false"}}` |

   - ⚠ **`"dryRun":"false"` を必ず付ける。** このワークフローの dryRun の既定は ON（送らない）なので、`{"checkHour":"5"}` だけでは毎朝判定ログが出るだけで LINE は届かない（失敗にもならないので気づきにくい）。
     dryRun を付けずに数日運用して判定ログを見てから付ける、という段階的な始め方もできる。
   - ⚠ `"5"` を数値 `5` で送ると GitHub API が 422 を返し run が作られない（Actions に何も出ない。cron-job.org の実行履歴でしか分からない）。2xx 以外の通知を有効にしておく。
   - `checkHour` を書き忘れた（空の）呼び出しは run が赤く失敗する（既定の時刻では走らない）。
   - ⚠ cron-job.org はジョブごとにタイムゾーンを持つ。UTC なら 20:03 / 21:03、Asia/Tokyo なら 05:03 / 06:03 で登録する。
   - cron-job.org で分かるのは dispatch の応答だけで、Actions の実行が赤く失敗しても分からない。**GitHub の通知設定で Actions の失敗メールを受け取れるようにしておく**（マンテールには保険の cron が無いので、失敗した回の通知はその日は出ない。会社の利用状態の読み取りは一時的な失敗を3回まで再試行する）。
   - 成功の応答は HTTP 204。初回の発火の後に Actions のログで `判定時刻: 5時（決定元: inputs.checkHour）` / `6時` を1度ずつ目視するまで「稼働確認済み」と扱わない。
7. （任意・後日）外部スケジューラが止まった日の保険として、`morning-check-mantel.yml` に `schedule` の cron（`3 20 * * *` → 5、`3 21 * * *` → 6）と case を足すかを決める。足しても通知記録で二重通知にはならないが、ワークフローの変更は人の確認が要る。

- **GitHub PAT**: 本リポジトリ内に PAT（`ghp_…` / `github_pat_…`）や `api.github.com` / `dispatches` 呼び出しは**見つからない（未確認）**。アプリから GitHub API を叩く実装は確認できなかった。
- **通知系まとめ**:
  - LINE Push: GitHub Actions（`morning-check` / `morning-check-mantel` / `notify-check` / `paid-leave-notify`）から直接送信（`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID`。マンテールは `__MANTEL` 付き）。`paid-leave-notify`（有給の付与日。2026-11-03 追加）は cron `40 22 * * *` の1本だけで、外部スケジューラからは呼ばない（通知記録を持たないため二重になる）。詳細: [`paid-leave-grant-notify.md`](paid-leave-grant-notify.md)。アップロード通知は Vercel `api/line-notify.js`。
  - Discord Webhook: Vercel `api/discord-notify.js`（`DISCORD_WEBHOOK_URL`）。`index.html` がアップロード時に呼ぶ。
  - FCM Push: GitHub Actions `fcm-notify` → `scripts/fcm-check.js`（`FIREBASE_SERVICE_ACCOUNT_KEY`）。
  - 通知のテストは必ず **dryRun**（`DRY_RUN=true` / `workflow_dispatch` の `dryRun`）で行い、実送信は人間の承認を得る。

---
