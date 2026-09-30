# honomi-board 側 database.rules.json の本番一致状況（2026-09-26 時点の旧記載）

整理前の timecard-git/AGENTS.md「マルチテナント」節にあった記載の原文。**現行の事実として扱わない。**
honomi-board 側の記録には、同じ 2026-09-26 に本番・両 repo の 3 者が完全一致したと実測した旨の記載があり、本記載と食い違う。
どちらが正しいかは本記録では判定しない。deploy 前は必ず本番の現行ルールを取得して照合する（`AGENTS.md`「RTDB のルールは honomi-board と共有している」）。

- honomi-board リポジトリの `database.rules.json` は本番と未一致（2026-09-26 時点）。ボード側から deploy する前に必ず本番を取り直してマージする。
