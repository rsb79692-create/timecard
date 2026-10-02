# 職員の本人確認 API（honomi-shift 連携用）`/api/auth/employee-verify`

honomi-shift（Supabase Edge Function）がサーバ間で呼び、「社員番号・PIN・氏名ハッシュ」が timecard の職員 1 名と一致するかだけを返す。
実装: `api/auth/employee-verify.js`。準備状況の診断: `scripts/report-employee-verify-readiness.js`（読み取り専用・件数のみ出力）。

## 契約

- `POST https://timecard-rho.vercel.app/api/auth/employee-verify`。POST 以外は 405。CORS ヘッダは返さない。`Cache-Control: no-store`。
- 本文（生バイト列・最大 2048 バイト、超過は 413）: `{"employeeId": string, "pin": string, "nameHash": string}`
- 署名ヘッダ:
  - `X-Hv-Ts` … UNIX 秒（整数）。`|now - ts| <= 60`
  - `X-Hv-Nonce` … 16 進 32 文字
  - `X-Hv-Sig` … 16 進 64 文字 = `HMAC-SHA256(hexdecode(EMPLOYEE_VERIFY_SECRET), canonical)`
  - `canonical = "employee-verify/v1\nPOST\n/api/auth/employee-verify\n" + ts + "\n" + nonce + "\n" + sha256hex(rawBody)`
- 鍵: Vercel 環境変数 `EMPLOYEE_VERIFY_SECRET`（16 進 64 文字＝32 バイト。値は記録しない）。
- 入力の正規化: `employeeId` は `NFKC` + `trim` 後に `^[0-9A-Za-z_-]{1,32}$`／`pin` は `^\d{4,8}$`／`nameHash` は `^[0-9a-f]{64}$`
  = `sha256hex("honomi-staff-name/v1:" + normName(氏名))`、`normName(s) = NFKC(s)` から空白をすべて除去。

| 状態 | 応答 | DB・レート制限 |
|---|---|---|
| 鍵が未設定・不正 | 503 `{"ok":false,"error":"not_configured"}` | 触れない |
| 本文 2048 バイト超 | 413 `{"ok":false,"error":"too_large"}` | 触れない |
| 時刻・nonce・署名の不一致 | 401 `{"ok":false,"error":"bad_signature"}` | 触れない |
| 本文の形式不正 | 400 `{"ok":false,"error":"bad_request"}` | 触れない（計上しない） |
| 上限超過 | 429 `{"ok":false,"error":"rate_limited"}` | 加算のみ・照合しない |
| 本人確認の失敗（理由を問わない） | 401 `{"ok":false}`（最小 300ms） | 加算済み |
| RTDB の取得失敗 | 503 `{"ok":false,"error":"unavailable"}` | 成功へ倒さない |
| 成功 | 200 `{"ok":true}`（最小 300ms） | 本人単位の 10 分カウンタだけ戻す |

## 本人確認の規則（フェイルクローズ）

- 会社は穂乃味に固定（`T.run("honomi")`）。名簿は `/honomi/tc5_staff`（配列・オブジェクトどちらも可）。
- 社員番号が一致する行は、**退職者を含む全行で厳密に 1 行**であること。0 行・2 行以上は失敗。
- `status === "退職"` は失敗。**休職は許可**（ユーザーの業務判断）。
- 氏名: 姓と名が両方あれば `姓+名`、無ければ `name` を `normName` してハッシュし、`nameHash` と定数時間比較。
- 同じ正規化氏名の**別の行**（在籍状態によらない）があれば失敗（PIN 記録は氏名で引くため本人を特定できない）。
- PIN: `/authz/pins/<subjectKey(row.name)>` を `verifyPinCompat` で照合。記録が無ければ失敗。
  **`/honomi/tc5_pins` は読まない。** レガシー（sha256）記録でも照合はするが、**昇格の書き込みはしない**。

## レート制限（打刻とは別の予算）

- 照合の**前**に加算し、その値で判定する（`pin_sub` / `pin_dev` / `pin_ip` / `pin_all` は読まない・戻さない）。
- 本人単位（正規化した社員番号）: **10 分 5 回** かつ **1 日 20 回**。全体: **10 分 100 回** かつ **1 日 300 回**。
- 10 分窓は既存の `S.bumpAndCount`（`/ratelimit/<10分スロット>/evf_emp|evf_all/<id>`）。
- 日次は共有ライブラリを変えずに本ファイル内で同じ方式（サーバ値インクリメント → 読み直し）で
  `/ratelimit/evd_<JST の YYYYMMDD>/evf_emp|evf_all/<id>` に数える。2 日前の日次ツリーは全体カウンタの加算時に回収する。
- 成功時は本人単位の 10 分カウンタだけ戻す。日次と全体は戻さない。

## 既知の制限

- **PIN の秘匿性は既存の `tc5_pins` の露出と同じ水準でしかない。** `tc5_pins` は匿名クライアントから読める（`rtdb-access.md`「残っている穴」）。
  本 API は `tc5_pins` を読まないが、PIN そのものが既に漏れうるため、PIN だけを強い本人確認とみなさない。
- **初回登録の経路**: `/authz/pins` に記録が無い職員は失敗する。記録は打刻側の PIN 新規登録（`/api/auth/pin-set`）でしか作られず、
  その経路は「まだ PIN を持たない職員の名前で最初に登録した者が PIN を持つ」性質を持つ。
- **PIN を変更しても honomi-shift 側の既存セッションは失効しない**（最大 12 時間残る）。本 API は照合の瞬間しか見ない。
- **429 は嫌がらせに使える**: 署名鍵を持つ呼び出し元（＝honomi-shift 経由で誤った PIN を入れられる者）が、特定の社員番号の窓を使い切ると、
  その職員は窓が明けるまで（最長で当日中）確認できない。全体の上限を使い切れば全員が止まる。打刻には影響しない（予算が別）。
- nonce の再利用は記録していない。同じ署名付き要求は 60 秒以内なら再送できる（結果は同じで、レート制限を 1 回分消費する）。
- 応答時間の下限は 300ms。失敗理由によって RTDB の往復数（PIN 記録の取得の有無）が違うため、下限を超える遅延がある環境では差が出うる。
- Vercel の Serverless Function は本ファイルで **12 本**（Hobby の上限 12）。次のエンドポイント追加は deploy が失敗する。
