# AGENTS.md — 穂乃味タイムカード（timecard）

Claude Code が**常時**読む指示ファイルである。置いてよいのは、禁止事項・恒久的な不変条件・開発と出荷のルール・
セキュリティと環境の重要事項・詳細文書への参照だけとする（共通 `RULES.md`「AGENTS.md の役割」）。
機能ごとの詳細設計・実測値・経緯・既知の制限の詳細・テストの説明は **`docs/features/`** に置く（自動では読み込まれない）。
**機能を変更・調査するときは、下の「機能の詳細文書」から該当する文書を必ず読む。**
文字数は `node ../_shared_claude/config/githooks/instruction-size.js --repo .` で確認する（30,000 超で警告、40,000 超で FAIL）。

リポジトリ名はローカルで `timecard-git`、GitHub remote は `rsb79692-create/timecard`。
本書には確認できた事実だけを書く。確認できていない事項は「未確認」と書く。

---

## 共通運用ルール（_shared_claude 参照）

- 共通ルールの正本は [`../_shared_claude/`](../_shared_claude/)。本リポジトリは **Type C（Firebase + GitHub Pages）** である。
  Type A/B（Supabase/Neon・Vercel 出荷・npm ビルド）の前提を持ち込まない。
- 共通ルールと矛盾した場合は、timecard 固有の**事実**（Firebase / GitHub Pages / index.html 単体 / 通知系）を優先する。
  **ただし「レビュー範囲」は例外で、共通 `AGENTS.md`「レビュー範囲」が常に優先する**（本書・`.claude/**`・`docs/**` で狭めない）。
- `DB.md`: Supabase / RLS / migration 固有部は**適用しない**。汎用の安全原則（本番 DB を変えない・破壊的操作は事前承認・変更前に現状確認・secret を出さない）だけを適用する。
- `DEPLOY.md`: 「Vercel READY」は **GitHub Actions の成否と GitHub Pages の本番 URL 反映**に読み替える。
- `migration-agent` は存在しない。DB 相当（RTDB・`database.rules.json`・FCM・PWA・GitHub Actions）は **`firebase-agent`** が担う。
- 読み替えの詳細: [`docs/features/shared-rules-mapping.md`](docs/features/shared-rules-mapping.md)

## プロジェクト概要

- バニラ JavaScript（ビルドなし）+ Firebase の **PWA**。アプリ本体は単一の `index.html`。`package.json` は無い（npm プロジェクトではない）。
- 配信: アプリ本体 = **GitHub Pages** `https://rsb79692-create.github.io/timecard/`／API（`api/*.js`）= **Vercel** `timecard-rho.vercel.app`／定期実行 = GitHub Actions（`.github/workflows/`）＋外部スケジューラ（cron-job.org）。
- ⚠ **公開リポジトリである。** GitHub Pages はリポジトリ直下を丸ごと配信する（`docs/` も公開される）。資格情報・実データを置かない。
- 環境の実態の詳細: [`docs/features/infrastructure.md`](docs/features/infrastructure.md)

## RTDB のルールは honomi-board と共有している（★最重要）

- Firebase プロジェクト `honomi-timecard` を **honomi-board と共用**している。`database.rules.json` は両方のルールが入った1ファイルで、
  `firebase deploy --only database` は**全体を置換する**。片方だけを deploy すると、もう片方が即座に止まる。
- 手順は必ず「本番の現行ルールを取得 → 既存キーを保持してマージ → deploy → 取り直して照合」。**両リポジトリの内容を一致させ、片方だけを編集しない。**
- トップレベルの持ち主: `honomi`（timecard）／`rooms` `members` `config` `field` `shares` `shareKeys` `guestOf`（honomi-board）／
  `tenants` `srv` `tenantReg`（マルチテナント）／`authz` `ratelimit` `mileage` `devmon` `morningNotify`（ルール未定義＝デフォルト拒否。Admin SDK 専用）。
- `/honomi` は `auth != null` ではない。**起動面**（匿名可: `tc5_staff` `tc5_pins` `tc5_records` `tc_master_depts` `master/locations` の読み、`tc5_records` の書き）と
  **役割つき**（`auth.token.r` と期限 `sx`）に分かれる。役割つきの領域を読む前は `afterElevation()` で昇格を待つ。
- 匿名認証は打刻の起動経路なので**無効化しない**。`tc5_pins` の平文 PIN が匿名で読める穴は未解消（次に直す箇所）。
- `FIREBASE_API_KEY` の GitHub Secret は `morning-check` が使うので消さない。サービスアカウントの鍵はルールを全部迂回するので、置き場所を増やさない。
- 詳細: [`docs/features/rtdb-access.md`](docs/features/rtdb-access.md)

## 機能の詳細文書（変更前に必ず読む）

| 機能 | 文書 | 回帰テスト（関係する変更では実行必須・全件 PASS / 0 FAIL） |
|---|---|---|
| 主要機能の一覧・朝出勤確認 LINE 通知 | [`main-features-and-morning-check.md`](docs/features/main-features-and-morning-check.md) | `node scripts/test-morning-check.js` |
| 外部スケジューラ・通知系 | [`schedulers-and-notifications.md`](docs/features/schedulers-and-notifications.md) | — |
| 移動距離申請 | [`mileage.md`](docs/features/mileage.md) | `node scripts/test-mileage.js` |
| 有給取得履歴 | [`paid-leave-history.md`](docs/features/paid-leave-history.md) | `node scripts/test-paid-leave-history.js` |
| 有給残日数・打刻・月別出勤日数の注意点 | [`business-data-notes.md`](docs/features/business-data-notes.md) | `node scripts/test-paid-leave-grant-edit.js` |
| `tc5_records` の取得範囲・承認漏れ集計 | [`records-range.md`](docs/features/records-range.md) | `node scripts/test-records-range.js` / `node scripts/test-unapproved-summary.js` |
| index.html（app shell）のキャッシュ・`sw.js`・配信版の自動更新 | [`app-shell-cache.md`](docs/features/app-shell-cache.md) | `node scripts/test-records-range.js` / `node scripts/test-app-auto-update.js` |
| 打刻の端末保存と自動再送 | [`punch-outbox.md`](docs/features/punch-outbox.md) | `node scripts/test-punch-outbox.js` |
| 管理者による勤怠編集 | [`admin-attendance-edit.md`](docs/features/admin-attendance-edit.md) | `node scripts/test-admin-attendance-edit.js` |
| 打刻時の顔撮影 | [`face-photo.md`](docs/features/face-photo.md) | `node scripts/test-face-photo.js` |
| 施設端末の持ち出し検知 | [`device-watch.md`](docs/features/device-watch.md) | `node scripts/test-device-watch.js` |
| マルチテナント（会社間分離） | [`multitenant.md`](docs/features/multitenant.md) | `node scripts/test-multitenant.js`（Rules 変更時は `tests/rules`、画面変更時は `tests/visual/*`） |
| 従業員・施設マスタの保存（1件単位） | [`master-save.md`](docs/features/master-save.md) | `node scripts/test-staff-save.js` |
| CSV一括登録（施設・従業員） | [`csv-import.md`](docs/features/csv-import.md) | `node scripts/test-csv-import.js` |
| 管理者URLトークン・管理者PINの設定状態 | [`qa-tests.md`](docs/features/qa-tests.md) | `node scripts/test-admin-token-state.js` |

テストはすべて依存パッケージなし・送信なし・本番データ非アクセス。**テスト件数は増減するため固定値を規範にしない。**
各テストの対象範囲と実行条件の詳細は [`docs/features/qa-tests.md`](docs/features/qa-tests.md)。
2026-09-26 の整理前の運用節の原文は [`docs/features/archive-agents-md-operations.md`](docs/features/archive-agents-md-operations.md)（経緯の確認用。規範ではない）。

## 機能ごとの主要な不変条件（★変えてはならない。**抜粋**である）

ここにあるのは常時守る要点だけで、**全項目ではない**。各文書の「★」の付いた記述もすべて同じ強さの不変条件であり、
変更前に該当文書を読んで守る。

**打刻（`punch-outbox.md`）**
- 打刻は **IndexedDB へ保存成功してから**画面を打刻済みにし、送信は結果を待たない。保存失敗は打刻失敗とし、localStorage やサーバ直送へフォールバックしない。
- 送信は `/tc5_records/{eventId}.json` への **PUT**。**POST（push）で採番させない。再送で `eventId` を採り直さない。** 打刻時刻（`timestamp`/`time`/`date`）は再送で変えない。
- サーバから `tc5_records` を取り直すときは必ず `punchOutboxMergeInto()`（`mergeRecordsRange()` 経由を含む）を通す。`records=arr` の全置換をしない。
- `punchOutboxEnabled()`（`writePolicy==="full" && !viewerMode`）の境界を緩めない。PIN 未取得（`staffPinsLoaded` 偽）のまま PIN 新規登録へ進めない（`tc5_pins` の全体 PUT で他人の PIN が消える）。

**tc5_records の取得範囲・キャッシュ（`records-range.md` / `app-shell-cache.md`）**
- クライアントは `tc5_records` を全件取得しない。範囲取得は必ず `date` 索引で行い、**`orderBy="$key"` + `startAt` を使わない**（ID が時系列順でない）。`id` に時系列の意味を持たせない。
- 取得済み範囲は区間の集合（`_recIvs`）。当月・当年の上限は `recMonthEnd()` / `recYearEnd()` で当日に丸める。日付の基準は `fmtDateKey()`。
- 未取得の期間を「0件」と断定しない（`recordsMonthKnown()` の判定順・`recordsOperationStartMonth()` と `recordsOldestMonth()` の使い分けを変えない）。承認漏れは集計確定まで「集計中」を表示し続ける。
- 過去分スキャンは「完了 → 即連鎖」、同時取得 `HISTORY_CONCURRENCY` は 1（実測なしで上げない）。停滞時の逃げ道は表示用・過去分の両方に置く。追い越された古い応答は捨てる。
- `sw.js` を変えたら必ず **`CACHE_NAME` を上げる**。Cache Storage へ入れるのは配信物（app shell と `OFFLINE_URLS`）だけ。Firebase・認証・`/api/*` はキャッシュしない。キャッシュキーは `/timecard/` に正規化する。
- `tc5_approvals` の読み取りだけを月に絞らない（`saveApprovals()` がノード全体 PUT のため他月の承認が消える）。

**移動距離申請（`mileage.md`）**
- データは `/mileage`（ルート直下・ルール未定義）に置き、`/honomi` に置かない。読み書きは `POST /api/mileage` だけ。
- 本人の特定は `/mileage/identity` だけで行う。**`tc5_staff` / `tc5_pins` から社員番号を引かない。** サーバから `/honomi` を読むのは読み取り専用の `api/_lib/mileage-punch.js` だけ。
- `SHARED-AUTO` ブロックは `api/_lib/mileage-auto.js` と `index.html` で1文字も違えない。確定済み月の金額を自動で書き換えない。`no_origin` などの要確認を推測で確定しない。0km を登録しない。非対称な距離を補正しない。
- `/mileage/audit` を API から返さない。職員画面・管理画面・閲覧用 URL は役割トークンの確立を待ってから API を呼ぶ。
- `isValidAdmin()` は `S.adminSessionValid()` を通す。`isValidViewer()` は呼び出しのたびに `viewerTokens` を引き直す。`setEnabled` の `pin_not_registered` / `identity_conflict` 検査を外さず、サブジェクト導出用の氏名を `trim` しない。
- サーバから `master/locations` を読まない（管理者の確認を経ずに取り込まない）。地点の取り込みは逐次で行い並列化しない。

**有給（`business-data-notes.md` / `paid-leave-history.md`）**
- 残日数の正本は `remainDays`。**`grantedDays - usedDays` で再計算しない**（登録前の消化分が復活する）。`usedDays` は FIFO 消化関数以外から書き換えない。
- 取得履歴は `tc5_paid_leave_requests` から表示のたびに組み立てる（二重保存しない）。社員番号があれば番号一致だけで突き合わせる。pending を取得済みにしない。「本システムで承認した分のみ」の注記・改名時の重複表示抑止を外さない。

**管理者の勤怠編集（`admin-attendance-edit.md`）**
- 未取得の月（`recordsMonthKnown(selMonth)` 偽）と当日より後の日は、未打刻セルを編集させない（重複ノードで実働時間が変わる）。既定の休憩控除を実装で足さない。

**朝出勤確認 LINE 通知（`main-features-and-morning-check.md`）**
- 施設ごとの判定時刻の正本は `scripts/morning-check.js` の `LATE_CHECK_FACILITIES`（コード側）。**施設マスタ側に持たせない。** `morning-check.js` と `index.html` の同名 `DEFAULT_FACILITIES` を同期しない。
- `CHECK_HOURS` に時刻を足すときは `morning-check.yml` の cron も足す。`CHECK_HOUR` 不正時は既定へ倒さず `exit 1`。判定時刻を実行時の現在時刻から決めない。
- 通知の重複抑止記録は `FIREBASE_DATABASE_URL` のオリジン直下 `/morningNotify`（`/honomi` 配下にしない）。未確定の送信を本文と retry key を作り直して送らない。ワークフローへ `concurrency:` を足さない。cron と外部スケジューラのどちらも外さない。

**従業員・施設マスタの保存（`master-save.md`）**
- `tc5_staff` / `master/locations` を手元の一覧で全体 PUT しない。保存のたびに最新を取り直し、変える1件の添字だけに書く（追加は `if-match: null_etag`、削除は末尾の1件を移す1回の PATCH で配列に空きを作らない）。

**CSV一括登録（`csv-import.md`）**
- 従業員の本人の識別子は氏名。登録済みと同じ氏名は上書きせずスキップし、表記ゆれ（施設名・氏名）を推測で紐付けない。書き込みは登録直前の再取得・再検証のうえ1回の PATCH（既存行を丸ごと上書きしない）。

**顔撮影（`face-photo.md`）**
- `facePhoto === true` のときだけ ON。写真は保存・送信しない（fetch / storage / Blob / dataURL を使わない。打刻画面のプレビューも画面に映すだけ）。撮影は打刻を止めず await しない。打刻前は大きなインカメラ映像だけを出し、枠に説明文は出さない（2026-09-30 ユーザー指示）。撮影時の開示は画面上端の固定表示で行い、「管理者設定により撮影」の文言を外さない。プレビューは打刻ボタンへ重ねず、カメラは打刻完了・画面離脱・放置・バックグラウンドで必ず止める。ON/OFF をサーバ側へ移す場合も、打刻のたびに問い合わせる形にしない。

**施設端末の持ち出し検知（`device-watch.md`）**
- 設定と状態は `/devmon`（ルール未定義）に置き、`/honomi` や `master/locations` に置かない。判定はサーバ側だけで行い、経過時間はサーバ受信時刻で測る。**位置は端末の自己申告であり真正性は保証しない。**
- 状態の既定値を `inside` にしない。判定できていない端末を「監視中」と表示しない。持ち出し検知は送信成功後に確定を書く（取り逃しより重複を選ぶ）。
- 端末 API（`api/device-report.js`）は CORS 応答ヘッダを返さず Cookie を使わない。管理 API（`api/device.js`）と1本にまとめない。レート制限のキーを本文の `deviceId` にしない（IP 単位）。`devicewatch/App.js` を JSX にしない。
- 定期実行 `action:"sweep"` の鍵照合はレート制限より前に置き、鍵は32文字以上を強制する。判定は `runSweep` だけに置く。保険の経路（端末報告時・管理画面表示時）を外さない。不正な本文は 500 でなく 400 `bad_json` とし、指紋に本文の内容を含めない。
- Vercel の Serverless Function は 11 本（Hobby の上限 12）。エンドポイントを足す前に上限を確認する。

**マルチテナント（`multitenant.md`）**
- 会社ごとにコードを複製・分岐しない。会社を足すときは同文書の4か所に1件ずつ足す。穂乃味（`honomi`）の既存パス・トークン・URL・端末保存キーを変えない。
- 会社間の遮断は画面・トークン（`c`/`sx`）・API（`T.handler` と `verifyIdToken` の会社一致検査）・RTDB/Storage Rules・端末保存の各層で行う。会社コンテキストの無い DB アクセスを穂乃味へ倒さない。
- マンテールは匿名サインインを使わず、スタッフ PIN を端末に置かない。システム管理者 PIN と会社管理者 PIN を別にする。`TC_PIN_PEPPER` / `TC_ENC_KEY` を変更・再生成しない。
- PIN の値はサーバ（`/api/auth/admin-pin-set`）経由でだけ作る。システム管理者 PIN の初回設定は条件付き書き込みで1回だけ成功させる。漏えいを疑ってシステム管理者 PIN を変更するときは、変更直前30秒（`ADMIN_AT_SKEW_SEC`）のセッションが残るため、30秒以上あけてもう一度変更する。
- honomi-board リポジトリの `database.rules.json` は本番と未一致（2026-09-26 時点）。ボード側から deploy する前に必ず本番を取り直してマージする。

## 実在するコマンド

- npm scripts は**無い**。build / lint の工程も無い。`npm run build` / `npm test` / `npm run lint`・Playwright の smoke・`agent:ship` は使わない（`tests/rules` と `tests/visual` だけは各ディレクトリの手順に従う）。
- 構文: `node --check <変更した .js>`（`sw.js` を含む）。JSON: `manifest.json` / `database.rules.json` を `JSON.parse` で検証する。
- 通知の検証は dryRun（`DRY_RUN=true`）に限る。実送信は人の承認を得る。

## 環境変数名・secret 名（名前のみ。値は表示・記録しない）

- **GitHub Actions Secrets**: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY`
- **Vercel**（`api/` が参照する9件）: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` / `DISCORD_WEBHOOK_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_PROJECT_ID` / `TC_ENC_KEY` / `TC_PIN_PEPPER` / `DEVICE_SWEEP_KEY`
  - ⚠ この一覧を「未使用の整理」の根拠にしない（`AUTH.md` §8）。`TC_PIN_PEPPER` を消すと PIN 認証が全滅、`TC_ENC_KEY` を消すと保存済み PIN が復号不能、`DEVICE_SWEEP_KEY` を消すと持ち出し検知の確定の主経路が止まる。
- **会社ごとの通知用**: 上の通知用の名前に `__<会社ID大文字>` を付ける（例 `DISCORD_WEBHOOK_URL__MANTEL`）。未設定の会社の通知は送らない（穂乃味の宛先へ倒さない）。
- **クライアント埋め込み（Firebase 公開設定）**: `FB_URL` / `FB_API_KEY` / `FCM_MESSAGING_SENDER_ID` / `FCM_VAPID_KEY`（値は引用しない）
- **スクリプトの実行制御**: `DRY_RUN` / `TEST_NOTIFY` / `TARGET_DATE` / `CHECK_HOUR` / `TENANT_ID`

## 禁止事項（全 Agent 共通・厳守）

共通の正本は [`../_shared_claude/RULES.md`](../_shared_claude/RULES.md)。以下は timecard 固有の上乗せである。

1. **secret 値を表示・出力・記録・commit しない**（Secrets・環境変数・`index.html` 内の Firebase 設定値を含む）
2. **本番 DB（Firebase RTDB）のデータを変更しない**（`tc5_*` の作成・更新・削除をしない）
3. **Firebase のデータを変更しない**（Storage / RTDB / FCM トークン等）。`/morningNotify` も手で書き換えない（消すと再送され、`sent` を書くと通知が止まる）
4. **GitHub Secrets を変更しない**
5. **cron-job.org の設定を変更しない**（必要なら人へ依頼する）
6. **GitHub Actions ワークフロー（`.github/workflows/`）を目的外で変更しない**（変更は人の確認が必要）
7. **`database.rules.json` を勝手に変更・deploy しない**（firebase-agent が方針を示し、人が確認する。上の「RTDB のルールは honomi-board と共有している」に従う）
8. **依頼範囲外のアプリコードを変更しない。** 依頼の実装に必要な `index.html` / `api/*.js` の変更は共通の実装ループで進めてよい。`sw.js` を変えるときは `CACHE_NAME` を必ず上げる
9. **削除操作をしない**（ファイル削除・`git clean`・`git stash`・`git reset --hard`・`git push --force`・データ削除）
10. **存在しない npm script を使わない**
11. **未整備のもの（Playwright の smoke・`agent:ship`）を使わない**。必要なら未整備である旨を報告する
12. **Vercel への手動デプロイ（`vercel --prod` 等）をしない**
13. **`/tenants`・`/srv`・`/tenantReg` を変更・削除しない**（作成は `scripts/bootstrap-tenant.js` をユーザーの確認後に実行するときだけ）
14. **`/devmon` と `/mileage` のデータを変更・削除しない**（検知の成否・支給額に直結する。`/devmon/devices/*/tokenHash` の値を表示・記録しない。`/mileage/monthly` `/mileage/closings` は確定済みの支給額）
15. **副作用のある保守スクリプト（`scripts/fix-monthly-days-year.js` 等）を勝手に実行しない**
16. **安全に判断できず、結果が大きく変わる場合は、編集・実行せず停止して報告する**（共通 `RULES.md`「安全」と同じ基準。迷うだけで止まらない）

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

共通 [`../_shared_claude/REPORT.md`](../_shared_claude/REPORT.md) の形式に従う。timecard では次も書く。

- 禁止事項の遵守（Firebase データ・Rules・Secrets・cron-job を変更していないこと、削除なし、secret 非表示）
- QA 結果（構文 / JSON / SW 整合 / 実行した回帰テスト / dryRun）
- 本番反映（GitHub Pages と Vercel のそれぞれ）と本番確認の結果。確認できなかった項目は「未確認（理由）」
