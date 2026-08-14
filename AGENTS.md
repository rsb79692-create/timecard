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
- **移動距離申請**: 職員別ON/OFFの独立モジュール（2026-08 追加）。詳細は下記「移動距離申請」節。
- **PWA**: `manifest.json` + Service Worker `sw.js`（オフライン対応・キャッシュ）。

> 各機能の業務上の詳細仕様（締め日・集計ロジック等）は本リポジトリからは断定できない部分があり、その範囲は**未確認**。

---

## 移動距離申請（2026-08 追加・独立モジュール）

職員が移動した地点を順に選ぶだけで、区間距離・日合計・月合計・支給額をアプリが計算する機能。
既存の打刻・出退勤計算・有給・賄い・スタッフ管理・管理者PIN・Service Worker には手を入れていない。

### データの置き場所（重要）

**RTDB のルート直下 `/mileage`。`/honomi` の外＝`database.rules.json` に未定義＝デフォルト拒否。**

`/honomi` は `.read`/`.write` = `auth != null` であり匿名でも読み書きできるため、
そこへ置くと職員が開発者ツールから「自分の利用ON/OFFフラグ」「区間距離」「km単価」「承認状態」を
書き換えられる。したがってこの機能のデータは `/honomi` に置かない。

```
/mileage/_meta                                   {createdAt, version}
/mileage/settings                                {ratePerKm, roundMode, updatedAt, updatedBy}
/mileage/enabled/{employeeId}                    true            ← 利用許可。未存在＝OFF（既定は必ずOFF）
/mileage/identity/{subject}                      {employeeId, name, ...}  ← ★認証サブジェクト→社員番号の唯一の正本
/mileage/staff/{employeeId}                      {name, subject, ...}     ← 社員番号→氏名（管理画面・CSVの表示元）
/mileage/places/{placeId}                        {name, order, active, createdAt, updatedAt}
/mileage/legs/{fromId}__{toId}                   {km, updatedAt, updatedBy}   ← ★方向別が正本
/mileage/requests/{YYYY-MM}/{employeeId}/{reqId} 申請1件（1日1件。reqId = "d_YYYYMMDD" で冪等）
/mileage/monthly/{employeeId}/{YYYY-MM}          月次確定スナップショット（給与計算の正本）
/mileage/closings/{YYYY-MM}                      {closedAt, closedBy, ratePerKm, roundMode, ...}
/mileage/audit/{YYYY-MM}/{logId}                 変更履歴（誰が・いつ・何を）
```

### 「誰の申請か」の決め方（★ここを間違えると成りすましが成立する）

`/api/auth/staff` が発行するトークンの uid は `"s:" + subjectKey(氏名)` である。
これを社員番号へ変換する対応表を **`/mileage/identity/{subject}` に置き、`tc5_staff` は一切参照しない。**

**`tc5_staff` から引いてはならない理由**：`tc5_staff` は `/honomi` 配下にあり Rules が `auth != null` なので、
匿名サインインした第三者でも行を追加・書き換えできる。そこから社員番号を引くと、

1. 攻撃者が `tc5_staff` へ「任意の氏名 ＋ 被害者の社員番号」の行を足す
2. その氏名で PIN を登録して staff ロールのトークンを取る
3. サーバが被害者の社員番号として解決する

という経路で、「自分の申請だけ」も「利用ONの職員だけ」も同時に破れる。
**body の申告を使わないだけでは足りない。参照先が誰でも書ける場所ではいけない。**

対応表を書くのは `setEnabled`（管理者が「使用する／しない」を設定する操作）だけである。

- **`/authz/pins/{subject}` が存在する（＝実在するログイン）職員にしか割り当てない**（`pin_not_registered`）。
  PIN未登録の氏名を有効化すると、その氏名のPINを第三者が先に登録して当人として入れてしまう。
- 同じ氏名に別の社員番号を割り当てようとすると `identity_conflict` で拒否する（同姓同名の取り違え防止）。
- **社員番号の訂正は `rebindFrom` を付けた1回の呼び出しで行う。**
  「旧番号をOFF → 新番号をON」の2段にすると、片方だけ成功したときに
  「OFFにはなったが新番号では有効化できない」復旧不能な状態が残る（実際にその実装で作り込んだ）。
- 改名では、古いサブジェクトの対応を必ず外す（資格が二重に残らないようにする）。
- **サブジェクト導出用の氏名を `trim` してはならない。** ログイン側（`/api/auth/staff`）は
  `tc5_staff` の氏名をそのまま `subjectKey` へ通すため、片方だけ正規化すると
  当人だけが恒久的に 403 になり、原因が画面から分からない形で壊れる。
- **改名にともなう付け替えでは PIN 実在検査を行わない。** 改名時は `renamePinInAuthz`
  （`/api/auth/pin-set`）と本APIが並行して走り、こちらが先に着地すると
  「PIN未登録」という事実と違う失敗になり、当人が無言で利用不可になる。
  同じ社員番号が別サブジェクトへ紐づいている＝そのログインの実在は前回確認済み、と扱う。
- **利用を止める操作（OFF）も PIN 実在検査で止めない。** 権限の剥奪は常に通す。

### 既知の残存リスク（未解消・運用で認識しておくこと）

1. **`tc5_staff` が誰でも書けることに由来する経路は完全には塞げていない。**
   第三者が `/honomi/tc5_staff` へ氏名を足し、`/api/auth/pin-set` の初回登録経路で
   自分でPINを登録したうえで、**管理者がその行の「ONにする」を押してしまう**と、
   その人物が当該社員番号の申請者として扱われる。
   緩和として、`setEnabled` の応答に `pinUpdatedAt`（PINの登録時刻）を含め、
   **48時間以内に登録されたPINの職員を新規に有効化するときは管理画面が警告する**。
   根本解決は `/honomi` の Rules 強化か `pin-set` 初回登録の本人確認であり、本機能の範囲外。
   → **見覚えのない氏名を「ONにする」前に必ず本人確認すること。**
2. **社員番号を付け替えると、旧番号の申請・月次確定データは旧番号のまま残る。**
   同じ月に旧番号の承認済み申請があると、月次確定・労務士CSVに
   **同じ氏名で2行（旧番号・新番号）**が並ぶ。金額は壊れないが給与側で名寄せが要る。
   → **付け替えは月初（その月の申請が無い時点）に行うこと。**
   旧番号は `/mileage/retired/{旧番号}` へ退役登録され、他の職員へ再利用できない。
3. **利用をOFFにしても `/mileage/identity` と `/mileage/staff` の行は残る**（`enabled` だけ消える）。
   OFF後も「以前使っていた職員」として管理画面に出る。掃除の運用は未定義。
4. **`/mileage/audit` を API から返してはならない。** 監査ログには `claims.t`
   （管理者・閲覧用トークンのハッシュ先頭16桁）が入る。Rules 未定義でクライアントからは
   読めないが、API で返すとハッシュを外へ出すことになる。
5. **利用設定の送信が失敗したときの再送はメモリ上のフラグ（`mileage.syncFailed`）に依存する。**
   失敗のアラートを見た管理者がその場で保存し直さず、画面を再読み込みするとフラグが消える。
   その場合は「移動距離」タブの利用職員一覧で ON/OFF を付け直すこと。
6. **PIN登録時刻の警告は誤検知しうる。** 本人が最近PINを変更した／久しぶりにログインして
   旧形式PINが自動昇格した場合も `updatedAt` が更新されるため、48時間の警告が出る。
   警告＝不正ではない。「見覚えのない氏名かどうか」で判断すること。

### 出荷前に実機で必ず確認すること（静的確認では代替できない）

- 利用OFFの職員に移動距離メニューが出ないこと／URL直打ちでも操作できないこと
- 利用ONの職員が申請〜承認〜月次確定〜労務士CSVまで通ること
- **氏名と社員番号を同時に変更したあと**、旧番号の `enabled` と旧サブジェクトの `identity` が
  残っていないこと（残ると第三者に旧番号の権限を取られる）
- 有効化済みの職員を**改名**した直後に、本人が新しい氏名でログインして移動距離が使えること
- 共有端末でスタッフを切り替えたとき、前の職員の申請一覧が残らないこと

`database.rules.json` は**変更していない**（`/mileage` はルール未定義のまま＝クライアントから到達不能）。

### API（唯一の窓口）

**`POST /api/mileage`**（`api/mileage.js`。共通ロジックは `api/_lib/mileage.js`）。
読み取りも書き込みもすべてここを通す。`index.html` から `/mileage` へ `authFetch` することはない。

権限は `api/mileage.js` の `ACTIONS` テーブルが正本。役割は Firebase Custom Token の claims から取る。

| role | 取得元 | できること |
|---|---|---|
| `s`（職員） | `/api/auth/staff` | 自分の申請の参照・作成・更新・削除のみ。**利用ONが必須** |
| `a`（管理者） | `/api/auth/admin` | マスタ・単価・利用ON/OFF・承認・月次確定。`S.adminSessionValid` 必須 |
| `v`（労務士） | `/api/auth/share` | **確定済み月の参照のみ（完全読み取り専用）** |
| `d`/`x`/匿名 | — | 全 action 拒否 |

- 職員の**社員番号はトークン → `/mileage/identity` から解決する**（`resolveStaff`）。
  body の申告も `tc5_staff` も使わない（上記「誰の申請か」の節を参照）。
- `r:"a"` を特権として扱うため、`isValidAdmin()` が **`S.adminSessionValid(claims)` を通している**
  （管理者PIN・管理者URL変更で失効した旧セッションを締め出す既存の取り決めに従う）。
- `r:"v"`（労務士）は **呼び出しのたびに `viewerTokens` の有効性を引き直す**（`isValidViewer`）。
  Firebase の refresh token は「トークンを無効化した」だけでは失効しないため、
  これをしないと閲覧用URLを止めても支給額を読み続けられる。
- 書込系 action にはハード上限（10分窓・職員60/管理者300）を設けている。
  監査ログ `/mileage/audit` は RTDB に TTL が無く自動削除されないため、無制限に増やさせない。
- `api/_lib/google.js` の `dbRequest` ルート直下ルーティングと `allowedRootTops()` に `mileage` を追加済み。

### 業務仕様（現行Excel `■移動距離申請（谷村）.xlsm` を実測して決定。推測ではない）

| 項目 | 実測値 | 実装 |
|---|---|---|
| km単価 | **16 円/km**（月次シート `J5`） | 既定値16。管理画面で変更可。コードに固定しない |
| 距離表 | `baseT` シートの行=出発地／列=到着地のマトリクス | 同じ構造。**方向別が正本** |
| 方向別の根拠 | ハーベスト→貝塚 **5.3** / 貝塚→ハーベスト **11.9**、ハーベスト→春木 **11.9** / 春木→ハーベスト **13.9** と**非対称な組が実在** | 対称と決め打たない。管理画面に「逆方向にも同じ距離を登録」の補助操作あり |
| 距離の取得 | 地点を順に選び `INDEX`+`MATCH` で自動取得 | 同じ。職員は距離を入力しない |
| 日別金額 | `=IF(Q="","",$J$5*Q)`（単価×その日の距離） | 同じ |
| 月合計 | `=SUM(...)` の単純合計 | 同じ |
| **端数処理** | **行っていない（1円未満を小数のまま保持）**。実測で確定 → 下記 | **設定値**（四捨五入／切り捨て／切り上げ／丸めない）。**既定は「丸めない」＝現行Excelと同じ** |

**端数処理の実測根拠（推測ではない）**

- 日別金額 `R列 = IF(Q="","",$J$5*Q)`、月合計 `K39 = SUM(R8:R38)`。**どちらにも丸め関数が無い。**
- キャッシュ値も小数のまま保存されている:
  - 日別: `105.6` / `89.6` / `198.4` / `201.6` / `252.8` / `390.4`
  - 月合計: 202603=`1379.2` / 202604=`2590.4` / 202605=`2339.2` / 202606=`1782.4` / 202607=`2604.8`
- 表示書式は `##.0"Km"`（小数1桁。金額欄に `"Km"` が付いた書式の誤り）。
  **「整数に見せている」のではなく、本当に小数を保持している。**
- シート内に `CEILING` が48箇所あるが、**すべて `CEILING(x,"0:30")` ＝ 勤務時間の30分丸め**で、
  しかも全て `#REF!` エラー。移動距離の金額とは無関係。
- 距離は0.1km刻みなので、`16円/km` では末尾が `.0` / `.5` 以外のとき必ず1円未満が発生する。
  上記のとおり実データで発生しており、Excelはそれを丸めずに支給額としている。

- 丸める設定にした場合は「**月合計距離 × 単価**」に対して**1回だけ**行う（日ごとに丸めると日の分け方で金額が変わるため）。
- 円単位で支給したい場合だけ管理画面「単価・端数」で変更すること。変更しても**確定済みの月の金額は変わらない**。

### 金額が後から変わらない仕組み

- 申請には確定時の**区間距離と地点名をスナップショット**する。
- 承認時は現在のマスタで引き直す（＝承認＝この内容で確定）。差異は監査ログへ残す。
- **月次確定（`closeMonth`）で `totalKm` / `ratePerKm` / `roundMode` / `amount` をスナップショット**する。
  以後 `settings` を変えても確定済み月の金額は動かない。CSV も再計算せずこのスナップショットを出力する。
- **km単価が一度も保存されていない状態では確定できない**（`rate_not_configured`）。
  誰も決めていない既定値で給与データを作らせない。
- 申請は `reqId = "d_YYYYMMDD"` で冪等。「検索してから INSERT」にすると同時実行で同じ日の申請が
  2件でき、月合計＝支給額が二重になるため、日付から決定的に導出して上書き更新にしている。
- 確定済みの月は職員も管理者も申請を変更できない（`month_closed`）。

### 画面

- **職員（打刻画面）**: 利用ONのときだけ「🚗 移動距離申請」カードを表示。日付＋地点を順に選ぶだけ。
  よく使う地点の上位表示／前回ルートのコピー／＋移動先追加／距離・金額の即時自動計算。
  **未登録区間があると申請ボタンが押せない（0kmで保存しない）**。
- **管理者（タブ「移動距離」）**: 申請の承認／地点・区間距離（マトリクス表示）／単価・端数／月次確定／利用職員。
- **スタッフ管理モーダル**: 「移動距離申請：使用する」チェックボックス。
  ★ **`tc5_staff` には保存しない。** サーバの `/mileage/enabled` が正本（保存時に `setEnabled` を呼ぶ）。
- **労務士（閲覧用URL）**: 「🚗 移動距離（確定済みのみ）」。対象年月を選び、月次CSV／日別明細CSVを自分でダウンロードする。
  管理者がファイルを作って渡す運用にはしない。編集系のUIも API もない。

### 運用の流れ

**職員が申請 → 管理者が承認 → 管理者が月次確定 → 労務士が対象月を選んで自分でダウンロード**

### テスト

`node scripts/test-mileage.js`（依存パッケージなし・送信なし・本番データ非アクセス）。
**移動距離申請に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。
金額計算・未登録区間・権限マトリクス（労務士に書込系が入らないこと）・クライアントとサーバの計算一致・
CSV形式を固定する。テスト件数は増減するため固定値を規範にしない。

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
- **test**: テストフレームワーク（Playwright / Jest 等）・smoke・`agent:ship` は**未整備**。実施可能な確認は手動の構文チェック・dryRun・下記の回帰テストのみ:
  - JS 構文: `node --check scripts/morning-check.js`（同様に `notify-check.js` / `fcm-check.js` / `api/line-notify.js` / `api/discord-notify.js` / `sw.js`）
  - JSON 構文: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`（`database.rules.json` も同様）
  - **移動距離申請の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-mileage.js`。金額計算・端数処理・未登録区間・権限マトリクス（労務士に書込系が入らないこと）・クライアント/サーバの計算一致・CSV形式を検証する。**移動距離申請（`api/mileage.js` / `api/_lib/mileage.js` / `index.html` の移動距離モジュール）に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
  - **管理者トークン状態の回帰テスト（依存パッケージなし・送信なし・本番データ非アクセス）**: `node scripts/test-admin-token-state.js`。`index.html` の管理者URLトークン「設定状態」判定ブロックを抽出して検証する。**管理者URLトークン・管理者PINの設定状態表示・`/config/adminTokenSet.json` / `adminTokenHash.json` / `adminToken.json` の取得処理に関係する変更では実行必須**（全件 PASS / 0 FAIL でなければ出荷しない）。テスト件数は増減するため固定値を規範にしない。
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
- **移動距離申請**: `/mileage` 配下（ルート直下）は**給与に直結する本番データ**。Agent はデータを変更・削除しない。特に `/mileage/monthly` と `/mileage/closings` は確定済みの支給額スナップショットであり、書き換えると過去月の給与計算が変わる。`/mileage/settings`（km単価・端数処理）の変更も金額に直結するため、コードからの既定値変更を含め人間の確認が必要。
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
5. **移動距離申請の回帰テスト**: `node scripts/test-mileage.js`（全件 PASS / 0 FAIL を確認）。**移動距離申請に関係する変更では実行必須**。関係しない変更では実施不要（その旨を報告する）
6. **管理者トークン状態の回帰テスト**: `node scripts/test-admin-token-state.js`（全件 PASS / 0 FAIL を確認）。**管理者URLトークン・管理者PINの設定状態表示・`/config/adminTokenSet.json` / `adminTokenHash.json` / `adminToken.json` の取得処理に関係する `index.html` の変更では実行必須**。1件でも FAIL なら「要修正」とし ship に進まない。関係しない変更では実施不要（その旨を報告する）
7. **通知スクリプト dryRun**: `DRY_RUN=true node scripts/morning-check.js`（環境変数未設定ならスキップして報告。実送信はしない）
8. **GitHub Actions YAML 確認**: 構文・cron・`secrets` 参照名・`node-version`

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
