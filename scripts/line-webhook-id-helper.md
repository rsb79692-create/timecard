# LINE_TO_ID の取得方法

`LINE_TO_ID` は LINE Messaging API の Push メッセージ送信先を指定する ID です。  
個人ユーザー・グループ・トークルームの3種類があり、それぞれ形式が異なります。

---

## 1. 送信先の種類と ID 形式

| 種類 | ID 形式 | 説明 |
|------|---------|------|
| 個人ユーザー | `U` + 32文字 | 友だち追加したユーザーの userId |
| グループ | `C` + 32文字 | Bot が参加しているグループの groupId |
| トークルーム | `R` + 32文字 | Bot が参加しているトークルームの roomId |

---

## 2. userId（個人）の取得方法

### 方法A: LINE Developers コンソールで確認（テスト用）

1. [LINE Developers](https://developers.line.biz/) へログイン
2. 対象チャネル → **Messaging API 設定** → **Your user ID** を確認
3. これは Bot 管理者自身の userId です

### 方法B: Webhook で受け取る（本番向け）

Bot のチャネルに Webhook URL を設定し、ユーザーがメッセージを送ってきたとき  
`event.source.userId` を取得します。

簡易確認手順（ローカル不要 / ngrok 使用例）:

```bash
# ngrok をインストール済みの場合
ngrok http 3000
```

Webhook を受け取るだけの最小サーバー（Node.js）:

```js
// get-line-id.js
const http = require("http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      (j.events || []).forEach((e) => {
        console.log("userId  :", e.source.userId);
        console.log("groupId :", e.source.groupId);
        console.log("roomId  :", e.source.roomId);
      });
    } catch (_) {}
    res.end("OK");
  });
}).listen(3000, () => console.log("listening on :3000"));
```

1. `node get-line-id.js` を起動
2. ngrok の URL を LINE Developers の Webhook URL に設定
3. LINE で Bot にメッセージを送る
4. コンソールに userId / groupId が表示される

### 方法C: LINE Notify の代替（個人通知のみ）

個人への通知だけで十分な場合、LINE Notify（`https://notify-api.line.me/api/notify`）を使うと  
userId 不要でトークンだけで送信できます。  
ただし LINE Notify は 2025年3月末でサービス終了済みのため、本番利用は Messaging API を推奨。

---

## 3. groupId（グループ）の取得方法

1. LINE でグループを作成し、Bot（チャネル）を招待する
2. グループ内でメッセージを送る
3. Webhook の `event.source.groupId` を取得する

---

## 4. GitHub Secrets への登録

```
リポジトリ → Settings → Secrets and variables → Actions → New repository secret

Name  : LINE_TO_ID
Value : Uxxxxxxxxxx...（取得した userId または groupId）
```

---

## 5. 注意事項

- userId を取得するには、そのユーザーが事前に Bot を **友だち追加** している必要があります
- Push API は **友だち追加済みのユーザー** または **Bot が参加しているグループ** にのみ送信できます
- LINE_CHANNEL_ACCESS_TOKEN はこのファイルに記載しないでください
- Webhook サーバーを本番コードに含める必要はありません（ID 取得後は不要）

---

## 6. LINE_TO_ID 未設定時の挙動

`morning-check.js` は起動時に必要な Secrets を検証します。  
`LINE_TO_ID` が未設定の場合、以下のメッセージを出力して **終了コード 1** で停止します。

```
[ERROR] 以下の GitHub Secret が未設定です: LINE_TO_ID
```

GitHub Actions のジョブは失敗（❌）として記録されます。  
LINE へのメッセージ送信は行われません。
