# build / lint / test / deploy 手順と QA 手順の詳細

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## build / lint / test / deploy 手順

- **build**: ビルド工程は**無い**（静的 `index.html`。トランスパイル/バンドルなし）。
- **lint**: lint 設定・コマンドは**未整備**（ESLint 等の設定ファイルなし）。「lint して」と言われても存在しないコマンドを実行しない。
- **test**: テストフレームワーク（Playwright / Jest 等）・smoke・`agent:ship` は**未整備**。実施可能な確認は手動の構文チェック・dryRun・下記の回帰テストのみ:
  - JS 構文: `node --check scripts/morning-check.js`（同様に `notify-check.js` / `fcm-check.js` / `api/line-notify.js` / `api/discord-notify.js` / `sw.js`）
  - JSON 構文: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`（`database.rules.json` も同様）
  - **移動距離申請の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-mileage.js`。金額計算・端数処理・未登録区間・権限マトリクス（労務士に書込系が入らないこと）・クライアント/サーバの計算一致・CSV形式を検証する。**移動距離申請（`api/mileage.js` / `api/_lib/mileage.js` / `index.html` の移動距離モジュール）に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **管理者トークン状態の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-admin-token-state.js`。`index.html` の管理者URLトークン「設定状態」判定ブロックを抽出して検証する。**管理者URLトークン・管理者PINの設定状態表示・`/config/adminTokenSet.json` / `adminTokenHash.json` / `adminToken.json` の取得処理に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **有給「付与日数の修正」の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-paid-leave-grant-edit.js`。`index.html` の付与日数修正ブロックを抽出し、残日数の再計算式・下限判定・確認表示と保存値の一致・`usedDays` と他の付与行を変更しないことを検証する。**有給の付与日数修正・残日数の計算に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **有給取得履歴の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-paid-leave-history.js`。`index.html` の `PL-HISTORY-BEGIN/END` ブロックを抽出し、承認済み実績と未来日の取得予定の分離・pending を取得済みにしないこと・複数日申請の取得日単位への展開・未知 status を捨てないこと・同姓同名の取り違え防止・正本を書き換えないこと・表示系ハンドラが通信/書込をしないことを検証する。**有給取得履歴に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **打刻の端末永続保存・自動再送の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-punch-outbox.js`。`index.html` の `PUNCH-OUTBOX-BEGIN/END` ブロックを抽出し、IndexedDB 保存の成否・二重登録防止・実打刻時刻の不変性・syncing の復旧・多重送信の抑止・認証切れ・警告条件・旧 localStorage キューからの移行・sandbox/デモ/閲覧用での無効化・`index.html` 側の結線を検証する。**打刻に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **tc5_records の期間取得と app shell キャッシュの回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-records-range.js`。`index.html` の `RECORDS-RANGE-BEGIN/END` ブロックを抽出し、区間集合の境界条件・未取得部分だけの取得・管理画面の入口で全件取得しないこと・月単位の分割スキャン・月/年セレクタの選択肢・フェイルクローズ、および `sw.js` が app shell 以外（Firebase / 認証 / API）を Cache Storage へ入れないことを検証する。**`tc5_records` の取得範囲・管理画面の入口・月/年セレクタ・`sw.js` に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **管理者の勤怠編集（未打刻日の新規作成）の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-admin-attendance-edit.js`。`index.html` のスタッフ別詳細の時刻セル描画と `attachTimeCellHandlers` の保存処理を抽出し、未打刻からの新規作成・既存打刻の非破壊・未取得の月のフェイルクローズ・承認済み日の読み取り専用を検証する。**管理者の勤怠編集・時刻セルの描画条件に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **承認漏れサマリー・通知件数集計の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-unapproved-summary.js`。`index.html` の `UNAPPROVED-SUMMARY-BEGIN/END` ブロックと `validateAttendanceRecord` / `isPastDate` を抽出し、過去日の未承認だけを数えること・当日を数えないこと・承認済みを誤検出しないこと・打刻の無い日や削除済みだけの日を承認漏れにしないこと・出勤のみ／退勤のみ／時刻欠落／勤務時間異常の判定・**索引版が素朴版（`records` 全件 filter）と完全一致すること**・正本を書き換えないことを検証する。**承認漏れの集計・通知件数・打刻漏れ判定に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **承認漏れ集計の所要時間の計測（回帰テストではない・依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/bench-history-scan.js`。`index.html` の `RECORDS-RANGE` ブロックを実タイマーで動かし、ネットワークを「RTT ＋ 共有帯域」で模擬して、集計完了・表示月確保・月切替の待ち時間を測る。第1引数に別の `index.html` を渡すと修正前と比較できる。**合否は判定しない**（AGENTS.md に載せた数値の追試用）。
  - **打刻イベントの適用確認（本番データを読むだけ・書き込みなし）**: `node scripts/verify-punch-events.js`。`FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` を環境変数で渡す。`eventId` の重複・ノード名との一致・サーバ受信時刻の妥当性を確認する。
  - **朝出勤未確認の施設別判定時刻の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-morning-check.js`。`scripts/morning-check.js` の `MORNING-CHECK-HOURS-BEGIN/END` ブロックを抽出し、施設ごとの判定時刻の決定（**施設マスタ側の値で判定時刻を動かせないこと**・施設名の正規化・表記ゆれ重複の寄せ・継承プロパティを引かないこと）、6時の回と7時の回が排他であること（二重通知の不在）、改名・表記ゆれの検出、施設名のサニタイズ（LINE 本文への改行・制御文字の注入対策）、**公開 Actions ログへ氏名・施設トークン・LINE 宛先を出さないこと**、`CHECK_HOURS` の各時刻に対応する cron と `case` 分岐が `morning-check.yml` に在ること（導出で検証）、および既存の未打刻判定・LINE送信経路を変えていないことを検証する。加えて、**同一日 × 同一施設 × 同一判定時刻の通知が最大1回であること**を、条件付き書き込みを再現した記録と retry key を再現した LINE の模擬で実際に動かして検証する（外部スケジューラ → 保険 cron の順次実行、2〜5実行のランダムな同時実行300通り、LINE の 5xx・タイムアウト・受付後の 5xx・4xx、確保直後や送信直後に落ちた実行、retry key の期限切れ、記録を読めない・書けないときは送らないこと）。**朝出勤未確認 LINE通知・判定時刻・`morning-check.yml` の cron に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **打刻時の顔撮影の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス・カメラも使わない）**: `node scripts/test-face-photo.js`。`index.html` の `FACECAM-BEGIN/END` ブロックを抽出し、既定OFF（`facePhoto===true` 以外はすべてOFF）・出勤退勤だけ撮影すること・sandbox/デモ/閲覧用では撮影しないこと・**撮影した画像を保存も送信もしないこと（fetch / localStorage / IndexedDB / Cache / Blob / dataURL を使わない）**・撮影後の破棄とトラック停止・カメラ拒否でも打刻を止めないこと・`_execPunch` の結線（端末保存の成功後・送信前・await しない）・**勝手にONへ移行する処理が無いこと**を検証する。**顔撮影・スタッフ管理モーダルの当該項目・`_execPunch` の結線に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **施設端末の持ち出し検知の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-device-watch.js`。`api/_lib/device.js` の純粋関数を直接呼び、距離計算・入力値の正規化・3分継続での確定・持ち出し中の再通知抑止と範囲内復帰での再アーム・GPS誤差の差し引きと粗い測位の扱い・**サーバ受信時刻で経過を測ること**・監視OFF/基準位置未設定でのフェイルクローズ・権限喪失の1回通知・受信途絶の1回通知・LINE本文（施設名への改行注入を含む）・権限マトリクス（管理APIは管理者だけ）・**`/devmon` が `database.rules.json` に無い（クライアントから到達不能）こと**・端末APIが業務データ（`tc5_*` / `master/locations`）を読まないことを検証する。加えて、**`POST /api/device-report` の handler を実際に動かして**（冒頭で `api/_lib/google.js` をスタブへ差し替えている）定期実行 `action:"sweep"` の結線を検証する（鍵の照合・未認証では RTDB へ1往復もしないこと・管理画面を開かずに確定して LINE を1通送ること・確定の書き込みが失敗しても毎分送り直さないこと・送信が失敗した持ち出しは次で必ず送り直すこと・**本文が JSON でなければ 500 ではなく 400 `bad_json` を返し、指紋に鍵を含めないこと**）。**持ち出し検知・`/devmon`・`api/device*.js`・管理画面の監視UIに関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - 通知ロジック dryRun（送信なし）: `DRY_RUN=true node scripts/morning-check.js`（PowerShell: `$env:DRY_RUN="true"; node scripts/morning-check.js`）。`FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` 未設定時はスキップ。
- **deploy**:
  - アプリ本体: `git push origin main` → **GitHub Pages が自動デプロイ**（`https://rsb79692-create.github.io/timecard/`）。本リポジトリに Pages 用ワークフローや `CNAME` は無く、ブランチ配信前提（Pages 設定自体はリポジトリ設定側で管理＝リポジトリ内からは設定値まで未確認）。
  - API: `api/*.js` は Vercel（`timecard-rho.vercel.app`）。**`git push origin main` で Production へ自動デプロイされる**（2026-08-14 実測で確定。旧記載の「未確認」を訂正）。`vercel.json` は無いが `.vercel/`（プロジェクトリンク）は存在する。Agent から `vercel --prod` 等の手動デプロイはしない。
    - 確認方法: `vercel ls --prod` で最新 Production が `● Ready`、`vercel inspect <deployment>` または Vercel MCP の `get_deployment` で `meta.githubCommitSha` が push した commit と一致することを確認する（実測時は `source: "git"` / `githubDeployment: "1"` / alias に `timecard-rho.vercel.app` を含むことも確認済み）。
    - ⚠ **GitHub Pages（アプリ本体）と Vercel（API）は別系統で、同じ push から独立に反映される。** 出荷確認は両方を見ること。
  - GitHub Actions のワークフローは push で反映されるが、**ワークフローや Secrets は Agent から変更しない**。

---

---

## QA 手順

`.claude/agents/qa-agent.md` が担当。標準フロー（ビルドが無いため構文・整合チェック中心）:

1. **変更把握**: `git diff HEAD` / `git status`
2. **JS 構文チェック**: 変更した `.js` / `sw.js` に `node --check`
3. **JSON 構文チェック**: `manifest.json` / `database.rules.json`
4. **Service Worker 整合**: `sw.js` の `CACHE_NAME` がファイル変更に合わせて更新されているか、`OFFLINE_URLS` の参照ファイルが存在するか
5. **移動距離申請の回帰テスト**: `node scripts/test-mileage.js`（全件 PASS / 0 FAIL を確認）。**移動距離申請に関係する変更では実行必須**。関係しない変更では実施不要（その旨を報告する）
6. **管理者トークン状態の回帰テスト**: `node scripts/test-admin-token-state.js`（全件 PASS / 0 FAIL を確認）。**管理者URLトークン・管理者PINの設定状態表示・`/config/adminTokenSet.json` / `adminTokenHash.json` / `adminToken.json` の取得処理に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
7. **有給付与日数修正の回帰テスト**: `node scripts/test-paid-leave-grant-edit.js`（全件 PASS / 0 FAIL を確認）。**有給の付与日数修正・残日数の計算に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
8. **打刻の端末永続保存・自動再送の回帰テスト**: `node scripts/test-punch-outbox.js`（全件 PASS / 0 FAIL を確認）。**打刻・`_execPunch`・`tc5_records` への書き込み・起動時／polling の打刻取得に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
9. **tc5_records の期間取得・app shell キャッシュの回帰テスト**: `node scripts/test-records-range.js`（全件 PASS / 0 FAIL を確認）。**`tc5_records` の取得範囲・管理画面の入口・月/年セレクタ・`sw.js` に関係する変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
10. **有給取得履歴の回帰テスト**: `node scripts/test-paid-leave-history.js`（全件 PASS / 0 FAIL を確認）。**有給取得履歴の表示・`plBuildLeaveHistory`・実績/予定の境界に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
11. **管理者の勤怠編集の回帰テスト**: `node scripts/test-admin-attendance-edit.js`（全件 PASS / 0 FAIL を確認）。**管理者の勤怠編集・時刻セルの描画条件・`attachTimeCellHandlers` に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
12. **承認漏れサマリー・通知件数集計の回帰テスト**: `node scripts/test-unapproved-summary.js`（全件 PASS / 0 FAIL を確認）。**承認漏れの集計・通知件数・打刻漏れ判定・全期間スキャンに関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
13. **朝出勤未確認の施設別判定時刻の回帰テスト**: `node scripts/test-morning-check.js`（全件 PASS / 0 FAIL を確認）。**朝出勤未確認 LINE通知・施設別の判定時刻・`morning-check.yml` の cron に関係する変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
14. **打刻時の顔撮影の回帰テスト**: `node scripts/test-face-photo.js`（全件 PASS / 0 FAIL を確認）。**顔撮影・スタッフ管理モーダルの当該項目・`_execPunch` の結線に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
15. **施設端末の持ち出し検知の回帰テスト**: `node scripts/test-device-watch.js`（全件 PASS / 0 FAIL を確認）。**持ち出し検知・`api/device.js` / `api/device-report.js` / `api/_lib/device.js`・`/devmon`・管理画面の監視UIに関係する変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
15b. **マルチテナント（会社間分離）の検証**: `node scripts/test-multitenant.js`（全件 PASS / 0 FAIL）。**`api/` 全般・`index.html` の会社設定／認証／端末保存・`database.rules.json`・`storage.rules`・`sw.js`・通知スクリプトに関係する変更では実行必須**。Rules を変えた場合は `tests/rules`（エミュレータ）、画面を変えた場合は `node tests/visual/client-isolation.js` と `node tests/visual/visual-regression.js`（穂乃味が変更前と同一）も実行する
16. **通知スクリプト dryRun**: `DRY_RUN=true node scripts/morning-check.js`（環境変数未設定ならスキップして報告。実送信はしない）。判定時刻ごとに確認する場合は `CHECK_HOUR=6` / `CHECK_HOUR=7` を付ける
17. **GitHub Actions YAML 確認**: 構文・cron・`secrets` 参照名・`node-version`

総合判定は「出荷可 / 要修正」。要修正なら ship に進まない。

---
