# 従業員向けマニュアル（ミュゲの泉・打刻と衛生・温度・保存食）の作り方

- `manual-shots.js` … 作業ツリーの `index.html` を Chromium で開き、出勤・衛生・朝の温度・退勤・日中/夕方の温度・保存食の画面を撮る。
  ★ ネットワークはすべて模擬（本番の Firebase・Vercel へ接続しない・書き込まない）。氏名・データは架空で、画面上の氏名は PDF で隠す。
- `build-manual.js` … 撮った画像に番号・赤枠・矢印・氏名の隠しを重ね、A4縦の PDF を作る。

```
NODE_PATH=<playwright のある node_modules> node tests/visual/manual/manual-shots.js . <撮影の出力先>
NODE_PATH=<playwright のある node_modules> node tests/visual/manual/build-manual.js <撮影の出力先> <PDF の出力先>
```

できた PDF は honomi-monthly-docs の `public/manual.pdf`（`/manual` から開く）に置く。撮影の出力・PDF をこのリポジトリに置かない（公開リポジトリ）。
打刻の画面・流れを変えたら撮り直す。
★ 実データ・本番の画面では撮らない（PDF の氏名の隠しは画像の上に重ねているだけで、元の画像は PDF に残る）。
