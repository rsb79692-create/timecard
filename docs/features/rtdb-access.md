# RTDB のアクセス条件と honomi-board との共有

> 本書は `AGENTS.md` から移した詳細（仕様・設計理由・実測値・経緯・既知の制限・テスト）である。
> 2026-09-26 に移設し、本文は移設時の原文のまま残している（`---` 区切りは移設前の節の区切り）。
> **Claude Code は本書を自動では読み込まない。この機能を変更・調査するときに必ず読む。**
> 常時守る禁止事項と不変条件の要点は `AGENTS.md` にある。両者が食い違う場合は `AGENTS.md` を優先し、本書を直す。
> 本文中の「本書」「本ファイル」という語は、移設前の `AGENTS.md` を指している（共通ルールへの相対リンクだけは移設後の位置に合わせて直した）。

## RTDB のルールは honomi-board と共有（2026-09-06 に整理）

⚠⚠ **Firebase プロジェクト `honomi-timecard` は honomi-board と同じものを使っている。**
`database.rules.json` は**両方のルールが入った1ファイル**で、
`firebase deploy --only database` は**全体を置換する**。片方だけを deploy すると、もう片方が即死する。

| トップレベル | 持ち主 |
|---|---|
| `honomi` | timecard（`tc5_*` / `config` / `master` / `documents` / 各種トークン） |
| `rooms` / `members` / `config` / `field` / `shares` / `shareKeys` / `guestOf` | honomi-board |
| `authz` / `ratelimit` / `mileage` | ルール未定義＝デフォルト拒否。Admin SDK 経由でのみ使う |
| `morningNotify` | timecard（朝出勤未確認 LINE の通知記録）。ルール未定義＝デフォルト拒否。GitHub Actions のサービスアカウントだけが書く |

⚠ 2026-09-06 まで、**このリポジトリのコピーにはボード側のルールが1つも入っていなかった。**
ここから deploy していたら `rooms` / `members` / `shares` が全消えしていた。
いまは両リポジトリで**同一内容**（md5 一致）にしてある。**片方だけを編集しないこと。**

手順は必ず「本番の現行ルールを取得 → 既存キーを保持してマージ → deploy → 取り直して照合」。

### `/honomi` のアクセス条件（`auth != null` ではない）

| 領域 | 読み | 書き |
|---|---|---|
| `tc5_staff` / `tc_master_depts` / `master/locations` | 起動面 | `s`/`a` だけ |
| `tc5_pins` / `tc5_records` | 起動面 | 起動面。ただし読み取り専用の役割（`v`/`d`/`x`）は除外、**丸ごと消す操作は拒否** |
| `viewerTokens/$t` `demoTokens/$t` `staffDemoTokens/$t` | 起動面（**1件ずつ**。親に `.read` が無いので一覧不可） | `viewerTokens` は `a`/`d` |
| `demoIssuedViewerTokens` | 役割つき | `a`/`d` |
| **それ以外すべて** | **役割つき** | **`s`/`a` だけ** |

- **起動面** … `auth != null && guestOf に居ない`。打刻端末（匿名）はここ。
- **役割つき** … 上に加えて `auth.token.r != null` かつ `sx`（期限・UNIX秒）が切れていないこと。
  `r` は `/api/auth/{staff,admin,share}` が入れるクレーム
  （`s`=スタッフ / `a`=管理者 / `v`=労務士 / `d`=デモ / `x`=サンドボックス）。

⚠ **起動面をなぜ開けてあるか。** 打刻端末は起動時に役割を持てない（PIN を入れる前だから）。
`tc5_staff` / `tc5_pins` / `tc_master_depts` / `master/locations` / `tc5_records` は
PIN 画面を出すまでに必ず要る。ここを締めると打刻ができなくなる。

⚠ **役割つきの領域を読む前には `afterElevation()` で昇格を待つこと。**
`elevateStaffSession` / `elevateShareSession` は画面遷移を待たせないため裏で走らせている。
待たずに読むと匿名トークンのまま 401 になる。

⚠⚠ **残っている穴（次に直すならここ）。**
`tc5_pins` には PIN の平文（`plain`）が入っており、起動面なので匿名で読める。
① 匿名アカウントを作る → ② `tc5_pins` を読む → ③ `/api/auth/staff` を1回叩く、で
**役割つきの領域まで入れてしまう**。`plain` を消しても 4桁 PIN の非ソルト SHA-256 は
1万通りで戻せるので同じ。塞ぐには
(a) 「PIN 登録済みか」の真偽だけを持つ別ノードを起動面へ置き、`tc5_pins` の読みを役割つきへ戻す、
(b) `sOk` のローカル照合をやめて `/api/auth/staff` の応答で判定する
（⚠ **打刻が Vercel に依存するようになる。ここが最大の判断どころ**）、
(c) 既存 PIN の入れ替え、の3つが要る。
なお `tc5_pins` は localStorage へ保存していないので、**オフラインでの PIN ログインは今もできない**。

⚠ `s`（一般スタッフ）の役割でも `/honomi` 全体を読める（`.read` は `r` の値を見ていない）。
ノードごとに `a` / `s` を分けるのは次の作業。

⚠⚠ **`FIREBASE_API_KEY` の GitHub Secret は消さないこと。** `morning-check` だけが今も使う。
⚠ サービスアカウントのアクセストークンは**ルールを全部迂回**し、同居しているボード側
（`rooms` / `shares` / `members` / `field`）まで届く。この鍵を置く場所を増やさないこと。
⚠ `morning-check.yml` もこの Secret を受け取る（2026-09-13。通知記録 `/morningNotify` を書くため）。
Secret の保管場所は増えていないが、**参照するワークフローは3本（fcm-notify / notify-check / morning-check）**になった。

---
