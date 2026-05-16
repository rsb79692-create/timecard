# LINE_TO_ID の取得方法 / 自動取得モード解説

## TL;DR — 最速セットアップ

**LINE_TO_ID は設定しなくてもよい（推奨）。**  
Bot を友だち追加した全員へ自動で通知されます。

必要な GitHub Secret は 3 つだけです:

| Secret 名 | 値 |
|-----------|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers のチャネルアクセストークン |
| `FIREBASE_API_KEY` | Firebase ウェブ API キー |
| `FIREBASE_DATABASE_URL` | `https://honomi-timecard-default-rtdb.asia-southeast1.firebasedatabase.app/honomi` |

`LINE_TO_ID` を登録しない（または値を `temp` にする）と **自動取得モード** になります。

---

## 自動取得モードの仕組み

`LINE_TO_ID` が未設定または `temp` のとき、`morning-check.js` は以下を実行します。

```
LINE Messaging API
GET https://api.line.me/v2/bot/followers/ids
→ Bot を友だち追加したユーザーの userId 一覧を取得
→ 全員へ multicast で一括送信
```

- Webhook サーバー・ngrok・手動 ID 確認は**不要**です
- フォロワーが増えても自動的に全員へ届きます
- フォロワーが 0 人の場合はエラーになります（Bot を友だち追加してください）

---

## 必要な前提条件

| 条件 | 説明 |
|------|------|
| Bot を友だち追加 | 通知を受け取りたい人が LINE で Bot を友だち追加している |
| プラン確認 | Followers API はほぼ全プランで使用可能（Messaging API チャネル） |

---

## LINE_TO_ID を手動指定したい場合

特定の個人またはグループにだけ送りたいときは `LINE_TO_ID` を設定します。

| 送信先 | ID の形式 | 取得方法 |
|--------|---------|---------|
| 個人ユーザー | `U` + 32文字 | 下記「方法A」参照 |
| グループ | `C` + 32文字 | 下記「方法B」参照 |

### 方法A: 管理者自身の userId（最速）

1. [LINE Developers](https://developers.line.biz/) にログイン
2. 対象チャネル → **Messaging API 設定** → **Your user ID** を確認
3. その値を `LINE_TO_ID` に登録する

これで Bot 管理者だけに通知が届きます。

### 方法B: グループへの送信

1. LINE でグループを作成し、Bot チャネルを招待する
2. グループ内でメッセージを1件送る
3. Webhook で `event.source.groupId`（`C` から始まる ID）を取得する
4. その値を `LINE_TO_ID` に登録する

Webhook で groupId を取得する最小コード（ローカルで一時的に動かすだけ）:

```js
// get-line-id.js（一時利用。本番コードには含めない）
const http = require("http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      (j.events || []).forEach((e) => {
        if (e.source.groupId)  console.log("groupId :", e.source.groupId);
        if (e.source.roomId)   console.log("roomId  :", e.source.roomId);
        if (e.source.userId)   console.log("userId  :", e.source.userId);
      });
    } catch (_) {}
    res.end("OK");
  });
}).listen(3000, () => console.log("listening on :3000"));
```

ID が取得できたら `get-line-id.js` は削除して構いません。

---

## GitHub Secrets への登録手順

```
リポジトリ → Settings → Secrets and variables → Actions → New repository secret
```

| Secret 名 | 自動モード | 手動指定モード |
|-----------|-----------|--------------|
| `LINE_CHANNEL_ACCESS_TOKEN` | 必須 | 必須 |
| `FIREBASE_API_KEY` | 必須 | 必須 |
| `FIREBASE_DATABASE_URL` | 必須 | 必須 |
| `LINE_TO_ID` | 不要 | 任意（設定すると優先される） |

---

## morning-check.js の動作フロー

```
起動
  ↓
必須 Secrets チェック（LINE_TOKEN / FB_API_KEY / FB_DB_URL）
  ↓ 不足あり → エラー出力して終了 (exit 1)
  ↓ 問題なし
Firebase Anonymous Auth → RTDB から records・施設マスタ取得
  ↓
本日の clockIn を集計 → 未確認施設を抽出
  ↓ 未確認なし → "未確認施設なし" を出力して正常終了 (exit 0)
  ↓ 未確認あり
LINE_TO_ID が設定済み? → YES → その ID へ push (1件)
             ↓ NO（または "temp"）
Followers API で全フォロワー取得 → multicast で一括送信
  ↓
正常終了 (exit 0)
```

---

## 注意事項

- `LINE_CHANNEL_ACCESS_TOKEN` は絶対にログへ出力しない（スクリプト内で保証済み）
- `LINE_TO_ID` に `temp` を設定しても自動取得モードとして動作する
- Bot がどのユーザーにも友だち追加されていない場合、自動モードはエラーになる
- Channel secret は今回のスクリプトでは使わない（Push/Multicast には不要）
