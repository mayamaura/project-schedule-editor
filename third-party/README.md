# third-party

配布物に同梱するサードパーティのライセンス文書。

- `copilot-cli-LICENSE.md` — GitHub Copilot CLI License（`github/copilot-cli` の LICENSE.md の写し。2026-11-08 取得）。
  Copilot の実行本体（`@github/copilot-sdk-<platform>` に含まれる）を同梱して配布するための条件: 変更せずに配布する、
  ライセンスのコピーと著作権・商標・帰属の表示を残す、実質的な機能を持つアプリの一部として配布する。
  electron-builder の `extraResources` で、インストール先の `resources/licenses/` に入る。決定 I2（docs/open-questions.html）。
