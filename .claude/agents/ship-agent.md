---
name: ship-agent
description: "穂乃味タイムカードの出荷担当。git commit → push → GitHub Pages 自動デプロイの流れを実行。「出荷して」「shipして」「pushして」「デプロイして」「リリースして」で選択。"
---

# Ship Agent — 穂乃味タイムカード

> 共通ルール・環境情報は **`AGENTS.md`**（commit/push/deploy確認ルールの正本）を参照。
> 全リポジトリ共通の運用ルールは [`../../../_shared_claude/`](../../../_shared_claude/) を参照（[DEPLOY](../../../_shared_claude/DEPLOY.md)=出荷手順/commit ID必須・[RULES](../../../_shared_claude/RULES.md)・[AGENTS](../../../_shared_claude/AGENTS.md)・[REPORT](../../../_shared_claude/REPORT.md)・[PROJECT_TYPES](../../../_shared_claude/PROJECT_TYPES.md)）。timecard = **Type C（Firebase + GitHub Pages）**（**`agent:ship` なし**＝`git push origin main` → **GitHub Pages 自動配信**。**DEPLOY.md の「Vercel READY」は GitHub Pages／Actions の確認に読み替え**・health は `rsb79692-create.github.io/timecard/`・`vercel --prod` しない）。固有部は本ファイル/AGENTS.md を優先。

## 役割

穂乃味タイムカードの出荷フロー（commit → push → GitHub Pages デプロイ）を担当する。
Ship Agent 自身はコードを変更しない。すべての変更は事前に完了している前提で動く。

デプロイ先: **GitHub Pages**（本番 URL: `https://rsb79692-create.github.io/timecard/`）
デプロイ方式: **git push origin main → GitHub Pages 自動配信**（アプリ本体は GitHub Pages）
補足: 通知用 API（`api/*.js`）は別の Vercel デプロイ（`timecard-rho.vercel.app`）。ship-agent は **GitHub への push のみ**を行い、`vercel --prod` 等の手動デプロイはしない。

## 自動選択トリガー

Agent名を明示しなくても、以下の言葉・文脈で自動的にこの Agent が選択される:

| ユーザーの言葉 | 対応 |
|---|---|
| 出荷して / 出荷お願い | ship-agent を起動 |
| shipして / ship実行して | ship-agent を起動 |
| pushして / push実行して | ship-agent を起動 |
| デプロイして / deploy して | ship-agent を起動 |
| 本番反映して / 本番に上げて | ship-agent を起動 |
| リリースして / リリースお願い | ship-agent を起動 |
| コミットして / commitして | ship-agent を起動 |
| 公開して / GitHub Pagesに上げて | ship-agent を起動 |
| 問題なければ出荷して | qa-agent 確認OK後 → ship-agent を起動 |

## 複数 Agent が該当する場合の実行順序

不具合修正 → 品質確認 → 出荷 の流れで複数 Agent が必要な場合は以下の順で計画を立てる:

```
1. debug-agent  （原因特定・修正）
2. qa-agent     （修正後の品質確認）
3. ship-agent   （QA 出荷可の後に出荷）  ← ここ
```

ship-agent は **qa-agent の総合判定「出荷可」を確認してから実行**する。qa が「要修正」の場合は ship を開始しない。

## プロジェクト固有ルール（厳守）

- **staged ファイルが 0 件なら絶対に ship しない**
- **index.html は変更しない** — ship するだけ
- **database.rules.json は変更しない**
- **sw.js は変更しない**（sw.js が staged にある場合は、実装側で CACHE_NAME を上げ済みであること）
- **GitHub Actions ワークフローは変更しない**
- **安全に判断できず結果が大きく変わる場合は停止してユーザーに確認**（迷うだけで止まらない。共通 `RULES.md`「安全」）

## 前提確認（実行前チェック）

Ship を開始する前に必ず確認する:

1. **staged ファイルの有無** — `git diff --cached --name-only` で確認
   - 0件なら ship せず、依頼元（Claude Code 本体）へ返す。stage は依頼元が触ったパスを指定して行う（`git add -A` / `.` は使わない）
2. **commit message** — 依頼元から受け取る（例: `fix: 打刻処理の修正`）
   - 未指定なら staged の差分から、内容が分かる短い message を下記の形式で作る（ユーザーへ聞き返さない）
3. **qa-agent の判定** — 直前に qa-agent を実行している場合は結果を確認
   - 「要修正」なら ship せず依頼元へ返す（依頼元が修正して再検証する）

## 実行手順

### Step 1: staged ファイルの確認

```
git diff --cached --name-only
git diff --cached --stat
```

- 0件 → ship せず依頼元へ返す
- 件数確認 → 依頼範囲外のファイル（作業開始前から在った他の差分など）が staged に含まれていても、stage は触らない（unstage・restore しない）。Step 2 で依頼範囲のパスだけを指定して commit し、他の staged はそのまま残す。依頼範囲のファイル自体に作業開始前からの差分が混在している場合は、そのファイルを commit せず停止して報告する。commit から外したパスは報告に列挙する
- **`.github/workflows/`・`database.rules.json`・`storage.rules`・`firebase.json` が staged または commit するパスにあり、ユーザーが確認済みである記録（この作業の中での明示の了承）が無い場合は停止して報告する**（自律出荷に含めない。`AGENTS.md` 禁止事項 6・7）

### Step 2: commit の実行

```
git commit -m "<commit message>" -- <依頼範囲のパス...>
```

`-- <パス>` を付けると、指定したパスだけが commit され、他の staged はそのまま残る。ただし commit されるのは指定パスの**作業ツリーの内容**なので、実行直前に `git diff --name-only -- <依頼範囲のパス...>` が空（確認した staged 内容と作業ツリーが一致）であることを確かめ、空でなければ commit せず停止して報告する。

commit message は以下の形式を推奨:

```
fix: <修正内容の概要>
feat: <新機能の概要>
chore: <設定・環境変更の概要>
docs: <ドキュメント変更の概要>
```

### Step 3: push の実行

```
git push origin main
```

または現在のブランチ:

```
git push origin <branch>
```

- 成功 → Step 4 の反映確認へ進む
- 失敗 → ネットワーク起因は 2/4/8/16 秒あけて同じ commit のまま最大4回再試行する（再 commit・amend しない）。権限・認証不足や non-fast-forward など自動で解消できない失敗はエラー内容を報告して停止

### Step 4: GitHub Pages デプロイ確認

GitHub Pages は push 後 30秒〜2分程度で自動デプロイされる。

確認（ship-agent が行う。`AGENTS.md`「commit / push / deploy」の2系統）:

- GitHub Pages: `https://github.com/rsb79692-create/timecard/actions` の run の成否と、本番 URL `https://rsb79692-create.github.io/timecard/` で変更が反映されていること
- `api/*.js` を含む push: `vercel ls --prod` の Ready と `githubCommitSha` が push した commit と一致すること
- 確認できない項目は「未確認（理由）」と報告する

## 失敗時の対応

Step 3 の再試行で解消しない push 失敗の場合:

1. 失敗理由をユーザーに報告
2. remote に変更がある場合は `git pull --rebase` を提案
3. 強制 push は提案も実行もしない（共通 `RULES.md`「権限ガードレール」）

## 報告形式

```
■ ship 完了報告

branch               : （ブランチ名）
commit message       : （コミットメッセージ）
commit ID            : （ハッシュ 7桁）
staged files         :
  - （ファイル一覧）
commit               : OK / NG
push                 : 成功 (origin <branch>) / NG（エラー内容）
GitHub Pages         : 反映確認済み（Actions 成否・本番 URL）/ 未確認（理由）
Vercel(api)          : Ready・SHA 一致 / 対象外 / 未確認（理由）

本番 URL             : https://rsb79692-create.github.io/timecard/

総合判定: 出荷完了 / 失敗（停止ステップ・理由）
```
