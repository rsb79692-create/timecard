# LINE_TO_ID の取得方法（朝出勤確認 LINE 通知の送り先）

> 2026-11-03 改訂。以前の版にあった「`LINE_TO_ID` を設定しなければフォロワー全員へ自動送信する（自動取得モード）」は
> **実装されていない**（`scripts/morning-check.js` に Followers API・multicast の処理は無い）。誤りなので削除した。

## 結論

**`LINE_TO_ID` は必須。** 未設定または値が `temp` のとき、`scripts/morning-check.js` は
`[ERROR] LINE_TO_ID が未設定です` を出して `exit 1` で止まり、何も送らない（フォロワー全員へ送る動きは無い）。
マンテールでは `[ERROR] LINE_TO_ID__MANTEL が未設定です` になる。
送り先は1か所（1人のユーザーまたは1つのグループ）で、LINE の push API で送る。

## 会社ごとの Secret 名

| 会社 | ワークフロー | LINE の Secret | その他に使う Secret |
|---|---|---|---|
| 穂乃味（既定） | `.github/workflows/morning-check.yml` | `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TO_ID` | `FIREBASE_API_KEY` / `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY` |
| マンテール（`mantel`） | `.github/workflows/morning-check-mantel.yml` | `LINE_CHANNEL_ACCESS_TOKEN__MANTEL` / `LINE_TO_ID__MANTEL` | `FIREBASE_DATABASE_URL` / `FIREBASE_SERVICE_ACCOUNT_KEY` |

他社は名前の末尾に `__<会社ID大文字>` を付ける。未設定なら止まる（穂乃味の宛先へは倒さない）。
値はログ・文書・commit に書かない。

## 送り先 ID の調べ方

| 送り先 | ID の形式 | 調べ方 |
|---|---|---|
| 個人ユーザー | `U` + 32文字 | 方法A |
| グループ | `C` + 32文字 | 方法B |

### 方法A: 管理者自身の userId

1. [LINE Developers](https://developers.line.biz/) にログイン
2. 対象チャネル → **Messaging API 設定**（または チャネル基本設定）→ **Your user ID** を確認
3. その値を `LINE_TO_ID`（マンテールは `LINE_TO_ID__MANTEL`）に登録する

これでその管理者だけに通知が届く（Bot を友だち追加しておくこと）。

### 方法B: グループの groupId

1. LINE でグループを作り、Bot（公式アカウント）を招待する
2. 一時的な Webhook で `event.source.groupId` を受け取る。リポジトリの `scripts/line-webhook-id.js` が使える
   （手順はファイル冒頭のコメント。ローカルで動かし、トンネルの URL を LINE Developers の Webhook URL に一時設定する）
3. グループ内でメッセージを1件送ると、ターミナルに groupId が表示される
4. その値を `LINE_TO_ID`（マンテールは `LINE_TO_ID__MANTEL`）に登録する
5. Webhook URL を元に戻し、サーバーを止める

## GitHub Secrets への登録

```
リポジトリ → Settings → Secrets and variables → Actions → New repository secret
```

登録は人が行う（Agent は GitHub Secrets を変更しない）。

## morning-check.js の動作（要約）

```
起動
  ↓
必須 Secret の確認（会社ごとの名前。LINE_TO_ID が未設定・temp なら exit 1）
  ↓
（他社のみ）/tenantReg/<会社ID>/active が true でなければ何もせず終了
  ↓
RTDB から打刻・施設マスタを取得（穂乃味は匿名認証、他社はサービスアカウント）
  ↓
判定時刻の施設のうち、当日の出勤打刻が無い施設を抽出
  ↓ 無ければ送らずに終了
通知記録（同一日・同一施設・同一判定時刻で最大1回）を確保して LINE_TO_ID へ push
```

詳細は `docs/features/main-features-and-morning-check.md`。
