# spike/ — 技術検証コード（使い捨て）

本体（`src/`）とは無関係。結果は `docs/architecture.html` 9 に記録している。依存パッケージなし（Node 22+ と Edge/Chrome、Git があれば動く）。

| ディレクトリ | 内容 | 実行 |
|---|---|---|
| `render-bench/` | SVG と Canvas の描画性能（実ブラウザを CDP で操作） | `node spike/render-bench/run.mjs edge --gpu`（`--text` でラベル付き） |
| `autosave-atomic/` | 一時ファイル→fsync→rename と、強制終了への耐性 | `node spike/autosave-atomic/crash-test.mjs 120` |
| `git-flow/` | 作業版の作成・反映・競合・退避と、500プロジェクト規模の性能 | `node spike/git-flow/flow.mjs` |

注意: `render-bench` はブラウザを起動する。結果は `results-*.json` に保存される。数値は実行環境（GPU・画面倍率）で変わる。
