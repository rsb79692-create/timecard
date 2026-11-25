# 月次精査完了の状態 API（`GET /api/review-status`・株式会社 穂乃味専用）

2026-11-25 ユーザー指示で追加。実装は `api/review-status.js`、回帰テストは `node scripts/test-review-status.js`。

## 何を返すか

- `GET https://timecard-rho.vercel.app/api/review-status?ym=YYYY-MM`
- 応答（200）は次の **4項目だけ**: `{ "ok": true, "ym": "2026-11", "reviewed": true/false, "reviewedAt": "ISO文字列" または null }`
  - `reviewed` は記録の `reviewed` が真偽値の `true` のときだけ `true`。
  - `reviewedAt` は `reviewed:true` のときだけ ISO 文字列（日時として読めなければ `null`）。
  - 記録が無い月・精査完了を解除した月（`reviewed:false`）は `reviewed:false, reviewedAt:null`。
- `ym` が `/^\d{4}-\d{2}$/` 以外（複数指定を含む）は 400 `{ "error": "bad_ym" }`。GET 以外は 405。
  IP ごとの回数制限（10分あたり300回＝1分あたり30回程度、`rvs_ip`）を超えると 429（`Retry-After: 600`）。DB の失敗は 500 `server_error`。
- `Cache-Control: no-store`。CORS 応答ヘッダは付けない（ブラウザの画面からは使わない）。

## 誰が使うか

- Claude の毎月の自動送信タスク。管理画面で「精査完了」が押された翌日に、労務士へ書類を送るかの判断に使う。
- 打刻画面・管理画面は使わない（画面は従来どおり RTDB を直接読む）。

## 仕組みと不変条件

- 読むのは穂乃味の `/honomi/tc5_monthly_review_status/{ym}`（`index.html` の `reviewStatusSave()` が書く場所）だけ。
  サーバのサービスアカウントで読むため **`database.rules.json` は変更していない**（honomi-board と共用。触らない）。
- ★ 返すのは上の4項目だけ。`reviewedBy` などの他の項目、打刻・スタッフの情報は返さない（記録をそのまま流さず、項目ごとに組み立て直す）。
- ★ 書き込みはレート制限のカウンタ（`/ratelimit`）だけ。精査完了の記録は変えない。
- 認証なし（curl から呼ぶため）。返るのは「その月の精査が終わったか」と完了時刻だけで、個人の情報は含まない。
- `H.guard` は POST・Origin・JSON 専用なので使わず、GET だけを入口で受ける。`T.handler` は GET を会社の判定なしに通すため、
  会社は穂乃味に固定して `T.run("honomi")` で明示する（会社コンテキストの無い DB アクセスを作らない）。他社には対応しない。
- 回数制限は DB の本体を読む前に数える。
