# プロジェクトスケジュールエディタ

縦軸にプロジェクト、横軸に年月日の時間軸を持つ画面で、複数プロジェクトの日程を編集・閲覧するデスクトップアプリ（Electron）。
1つのプロジェクト（1行）に、複数のイベント（開始日〜終了日）とマイルストーン（日付）を置ける。日程データは専用の Git リポジトリ（GitHub）で管理し、Git に詳しくない人でも使える UI（作業版 → 正式版への反映）を備える予定。

**現在の状態:** 開発中（Phase 0〜2 完了）。日程データのフォルダを開く（またはサンプルを表示して）**読み取り専用**のタイムラインで閲覧できる（ズーム・スクロール・年月週/年月の切替・依存線・折りたたみ）。編集・Git 連携は未実装。進捗と計画は [docs/roadmap.html](docs/roadmap.html)。

対応 OS: Windows（将来 macOS / Linux を追加する想定）。

## 必要なもの

- Node.js 22.12 以上（24 で動作確認）と npm
- Git（テストの一部が実際の `git` を使う）

## セットアップ

```powershell
npm install
node node_modules/electron/install.js   # Electron 本体のバイナリを取得（下の注意を参照）
git config core.hooksPath .githooks      # コミット前の品質ゲートを有効化（クローンごとに1回）
```

> Electron のパッケージは `postinstall` を持たないため、`npm install` だけではバイナリが入らない。上の2行目が必要（CI も同様）。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発モード（HMR）で起動 |
| `npm run build` | main / preload / renderer をビルド（`out/`） |
| `npm run typecheck` | 型チェック（4つの tsconfig） |
| `npm run lint` | ESLint（**レイヤ境界の違反もここで検出**） |
| `npm test` | 単体テスト（Vitest）＋ドメイン層のカバレッジ閾値 |
| `npm run test:e2e` | 実際の Electron を起動する E2E（Playwright）。**事前に `npm run build`** |
| `npm run pack` | 署名なしの展開形式パッケージを `dist/win-unpacked/` に作成 |
| `npm run dist` | 署名なしの Windows インストーラ（NSIS）を `dist/` に作成 |
| `npm run verify` | 品質ゲート一式（下記） |

### ビルドして配布物を作る

```powershell
npm run build
npm run dist      # dist/ProjectScheduleEditor Setup <version>.exe
```

コード署名・自動更新は未対応（Phase 5 で対応予定）。

### 品質ゲート（`npm run verify`）

「完了」の基準。次を順に実行し、1つでも失敗すれば失敗する。

1. `check-docs` — ドキュメントの整合性（リンク、ナビ、要件ID参照、全要件がロードマップに割り当て済みか、仕様変更時の変更履歴の更新）
2. `trace` — コード・テストの `@req F-xxx` タグと要件IDの対応
3. `licenses` — 依存パッケージのライセンス検査（商用ライブラリを使わない方針）
4. `typecheck` / `lint` / `test`

`git commit` 時にも自動で実行される（`.githooks/pre-commit`）。

## 注意事項

- **`ELECTRON_RUN_AS_NODE` が設定された環境では、`npm run dev` と `npm run test:e2e` で Electron が起動しない。** VS Code など Electron 製のツールから起動したターミナルで起きる。起動しない場合は、その変数を解除してから実行する（`Remove-Item Env:ELECTRON_RUN_AS_NODE`）。E2E のテストコード側では取り除いて起動している。
- パッケージ版（`npm run pack` の成果物）は、セキュリティ設定（Electron Fuses）により Playwright では操作できない。E2E は `out/` のビルドに対して実行する。
- Windows のパスのドライブレターが小文字（`c:\...`）のまま `npm test` を実行すると、Vitest が失敗することがある。品質ゲートのスクリプトは大文字に正規化している。

## ディレクトリ構成

```
docs/        仕様・設計・計画（HTML。これが唯一の正）
src/
  domain/    ドメイン層（純 TypeScript。日付・コマンド・検証・差分・保存形式）
  shared/    IPC の型定義（zod）
  main/      Electron main（ファイル入出力・IPC。将来 Git・AI）
  preload/   contextBridge（Renderer に公開する API）
  renderer/  React の画面
tests/
  domain/    ドメイン層の単体テスト（性能テストを含む）
  main/      FileRepository・実際の Git でのマージ検証
  lint/      レイヤ境界の lint ルールのテスト
  unit/      その他の単体テスト
  e2e/       Playwright（Electron の起動・セキュリティ設定）
scripts/     品質ゲート（check-docs / trace / check-licenses / verify）とフック
spike/       技術検証の使い捨てコード（本体とは無関係。再現手順は spike/README.md）
.claude/     Claude Code 用の設定・スキル・レビュー用エージェント
```

### レイヤ境界（ESLint で強制）

`domain` ← `shared` ← `main` / `preload` / `renderer`。`domain` は electron・Node・React・DOM に依存しない。`renderer` は `main` を import しない（ファイルや Git は IPC 経由）。違反は `npm run lint` で検出される。

## ドキュメント

まず [docs/index.html](docs/index.html) をブラウザで開く。

| 文書 | 内容 |
|---|---|
| [requirements.html](docs/requirements.html) | 要件（ID・優先度） |
| [data-model.html](docs/data-model.html) | データ形式、Git 上のファイル構成、ドメイン層の実装仕様 |
| [architecture.html](docs/architecture.html) | 技術選定、構成、技術検証の結果 |
| [ui-design.html](docs/ui-design.html) | 画面・操作 |
| [git-ux.html](docs/git-ux.html) | Git 初心者向けの UX（作業版・反映・競合解決） |
| [roadmap.html](docs/roadmap.html) | MVP の定義、フェーズごとの設計・実装・テスト計画 |
| [open-questions.html](docs/open-questions.html) | 決定事項と未決事項 |
| [development-rules.html](docs/development-rules.html) | 開発・テスト・レビューのルール |
| [changelog.html](docs/changelog.html) | 仕様変更の履歴 |

## 開発のルール（要点）

- **仕様は文書が先。** 仕様に影響する変更は、関連する文書を同じ作業で更新し、`docs/changelog.html` に追記する。
- **要件IDで追跡する。** 実装とテストに `@req F-201` の形でタグを付ける。新しい要件は `docs/roadmap.html` のフェーズに割り当てる。
- **ドメイン層はテスト先行。** カバレッジ閾値は 90%。
- 新しい依存パッケージを追加するときは、理由を `docs/architecture.html` に記録する。**商用ライブラリは使わない**。
- 破壊的な Git 操作（強制 push、`reset --hard`、`--no-verify`）はしない。

詳細は [docs/development-rules.html](docs/development-rules.html)。AI（Claude Code）向けの作業ルールは [CLAUDE.md](CLAUDE.md)。

## ライセンス

未定（`package.json` は `UNLICENSED`）。
