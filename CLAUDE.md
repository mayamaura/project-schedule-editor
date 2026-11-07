# プロジェクトスケジュールエディタ — AI 作業ルール

Electron 製デスクトップアプリ。縦=プロジェクト、横=日付の Excel 風（見た目のみ。操作は Excel と異なる）UI で日程を編集し、データは専用 Git リポジトリ（GitHub）で管理する。
人間向けの詳細は `docs/development-rules.html`。このファイルはその要約（AI 用）。

## 唯一の正（Source of Truth）
`docs/*.html` が仕様。コードより先にドキュメントを読む。

| 知りたいこと | 文書 |
|---|---|
| 何を作るか（要件ID・優先度） | docs/requirements.html |
| データ形式・Git上のファイル・差分検出 | docs/data-model.html |
| 技術選定・構成・イベント処理方針 | docs/architecture.html |
| 画面・操作・日付ヘッダ | docs/ui-design.html |
| Git の UX・競合解決 | docs/git-ux.html |
| 決定済み/未決の事項 | docs/open-questions.html |
| 仕様変更の履歴 | docs/changelog.html |
| MVP・フェーズ計画・要件の割り当て | docs/roadmap.html |
| 開発・テスト・レビューのルール | docs/development-rules.html |

## 絶対ルール
1. **仕様とコードを食い違わせない。** 仕様に影響する変更は、関連する全文書を同じ作業内で更新し、`docs/changelog.html` に追記する。コードと文書が矛盾していたら黙って片方に合わせず、ユーザーに報告する。
2. **未決事項を勝手に決めない。** `open-questions.html` で「決定:」が無い項目に依存する場合は、実装前にユーザーに確認する。
3. **要件IDで追跡する。** 実装・テストには `@req F-201` の形でタグを付ける。新機能は requirements.html に要件IDがあることが前提。無ければ先に追加（`/spec-change`）。**新しい要件は docs/roadmap.html のフェーズ（またはリリース）に必ず割り当てる**（`check-docs` が検査する）。
4. **完了 = `node scripts/verify.mjs` が通ること。** 通っていないものを「完了」と報告しない。失敗したら出力をそのまま伝える。
5. **破壊的操作をしない。** force push / reset --hard / `--no-verify` / 履歴書き換えは禁止。コミット・push はユーザーが依頼したときだけ。
6. **新しい依存ライブラリは勝手に足さない。** 追加時は architecture.html に理由を追記し、ユーザーに報告する（d3 の追加モジュールは自由）。**商用（有償・商用ライセンス必須）ライブラリは使わない**。許容は MIT/ISC/BSD/Apache-2.0 等で、`scripts/check-licenses.mjs` が検査する。

## アーキテクチャ制約（要点）
- `src/domain/`: 純 TypeScript。`electron` / `node:*` / `react` / DOM を import しない。日付計算・依存検証・`diffSchedule`・マイグレーション・コマンド適用はここ。
- `src/main/`（Git・FS・IPC）、`src/preload/`、`src/renderer/`（React UI）、`src/shared/`（IPC型・zodスキーマ）、`src/viewer/`（出力する単一 HTML に埋め込む閲覧専用ビューア。React 非依存で、`src/domain/` の描画コードを共有。外部通信・編集機能は持たない。docs/architecture.html 10）。renderer は main を import しない。FS/Git は main のみ、renderer は preload の IPC 経由。
- Electron: `contextIsolation: true`、`nodeIntegration: false`、IPC は型付き・入力検証あり。
- 日付は文字列 `YYYY-MM-DD`（Date 型・タイムゾーンを持ち込まない）。
- データ JSON は出力規則（キー昇順・インデント2・LF・ID キーのオブジェクト）を厳守。書式を変える変更は schemaVersion とマイグレーションを伴う。
- ドラッグ等の連続操作は ref + rAF で処理し、確定時に 1 コマンドとしてストアへ（Undo 1 単位）。
- UI 文言に Git 用語（commit / branch / merge / push 等）を出さない。「保存」「作業版」「正式版」「反映」などの業務語を使う（docs/git-ux.html）。ファイル書き込みは必ず一時ファイル＋rename の原子的置換（自動保存、docs/architecture.html 8）。
- Git: 実行ファイルは同梱（dugite）と外部（システム）の両方に対応し、`execFile` に引数配列で渡す（シェル経由禁止）。`GIT_TERMINAL_PROMPT=0`（バックグラウンド処理では `GCM_INTERACTIVE=never` も）。認証は GCM のブラウザ認証が第一候補。認証情報を設定・`.git/config`・引数・ログに残さない（docs/architecture.html 3.5）。
- AI（GitHub Copilot SDK）: `src/main/ai/` に隔離。AI に公開するツールは読み取りと提案作成のみ、**AI に日程を直接書き換えさせない**（提案→差分確認→承認）。SDK は 1.0.x だが一部 API が実験的なので、型定義・README で確認してから実装する（docs/architecture.html 6.1, 9.4）。テストは SDK をモックする。
- 目標規模: 500プロジェクト × 50イベント × 8年（約25,000イベント）。タイムライン本体は **Canvas**（SVG は実測で限界: docs/architecture.html 9.1）。描画は `buildDrawList`（純関数）+ `draw(ctx, drawList)` に分け、ヒットテストも DrawList から行う。左ペインと操作オーバーレイ（ハンドル・メニュー・入力欄）は React の DOM/SVG。表示範囲だけを描く仮想化は必須。

## テスト
- `src/domain/` は **テスト先行**（失敗するテスト → 実装）。Vitest。カバレッジ目標 90%+。
- バグ修正は再現テストを先に書く。
- 性能に関わる変更は 25,000 イベントのベンチで確認。
- UI の主要フローのみ Playwright E2E。

## 作業の進め方
- 実装: `/implement-feature`、仕様変更: `/spec-change`、整合監査: `/doc-audit`、技術検証: `/tech-spike`。
- レビュー用サブエージェント: `doc-auditor`（文書整合）、`arch-reviewer`（レイヤ違反・セキュリティ）。
- コミットメッセージ: `type(scope): 概要 [F-201]`（type = feat/fix/docs/test/refactor/chore）。
- 言語: 文書・コメント・UI 文言・やり取りは日本語。識別子は英語。

## 開発コマンド
`npm run build` / `typecheck` / `lint` / `test` / `test:e2e` / `pack` / `verify`（詳細は docs/development-rules.html 9）。E2E・`dev` は `ELECTRON_RUN_AS_NODE` が設定された環境（VS Code 拡張など）では Electron が起動しない（docs/architecture.html 11.4）。

## 現状の注意
- Phase 0（スキャフォールド）は完了。Phase 1（ドメイン層）は実装済み（未実装は roadmap の Phase 1「進捗」欄を参照）。`typecheck` / `lint` / `test`（カバレッジ閾値つき）が定義済みで、ESLint がレイヤ境界を強制する。Phase 2（Canvas 表示。読み取り専用）は実装済みで、未完了は roadmap の Phase 2「進捗」欄を参照（F-401 の UI、他 PC・画面倍率での実機計測）。Phase 3（編集: ドラッグ編集・メニュー・詳細パネル・プロジェクト操作・依存・自動保存と復元）は実装済みで、制約は docs/architecture.html 13.5（復元の基準は Git 連携までは `.autosave/base.json` で代用）。Phase 4（Git）は S4-1・S4-2（GitService・保存・履歴・戻す・診断）まで実装済みで、S4-0（Git 未経験者 3 名のモック確認）の結果待ちのため S4-3 以降は未着手（docs/architecture.html 14）。Git は `src/main/git/gitService.ts`、画面は `src/renderer/VersionControls.tsx`。同梱 Git（dugite）は未導入。UI の操作→コマンドの変換は `src/domain/edit.ts` / `src/domain/timeline/edit.ts`、画面は `src/renderer/timeline/`、自動保存は `src/renderer/App.tsx` + `src/main/ipc.ts`（`repo:save`）+ `src/main/fileRepository.ts`（`beginSession`）。進捗は docs/roadmap.html。タイムラインのドメインは `src/domain/timeline/`、画面は `src/renderer/timeline/`（docs/architecture.html 12）。E2E は状態を引き継ぐため serial モード。ドメインの公開口は `src/domain/index.ts`、仕様は docs/data-model.html 11。
