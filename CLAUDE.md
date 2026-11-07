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
| 開発・テスト・レビューのルール | docs/development-rules.html |

## 絶対ルール
1. **仕様とコードを食い違わせない。** 仕様に影響する変更は、関連する全文書を同じ作業内で更新し、`docs/changelog.html` に追記する。コードと文書が矛盾していたら黙って片方に合わせず、ユーザーに報告する。
2. **未決事項を勝手に決めない。** `open-questions.html` で「決定:」が無い項目に依存する場合は、実装前にユーザーに確認する。
3. **要件IDで追跡する。** 実装・テストには `@req F-201` の形でタグを付ける。新機能は requirements.html に要件IDがあることが前提。無ければ先に追加（`/spec-change`）。
4. **完了 = `node scripts/verify.mjs` が通ること。** 通っていないものを「完了」と報告しない。失敗したら出力をそのまま伝える。
5. **破壊的操作をしない。** force push / reset --hard / `--no-verify` / 履歴書き換えは禁止。コミット・push はユーザーが依頼したときだけ。
6. **新しい依存ライブラリは勝手に足さない。** 追加時は architecture.html に理由を追記し、ユーザーに報告する（d3 の追加モジュールは自由）。**商用（有償・商用ライセンス必須）ライブラリは使わない**。許容は MIT/ISC/BSD/Apache-2.0 等で、`scripts/check-licenses.mjs` が検査する。

## アーキテクチャ制約（要点）
- `src/domain/`: 純 TypeScript。`electron` / `node:*` / `react` / DOM を import しない。日付計算・依存検証・`diffSchedule`・マイグレーション・コマンド適用はここ。
- `src/main/`（Git・FS・IPC）、`src/preload/`、`src/renderer/`（React UI）、`src/shared/`（IPC型・zodスキーマ）。renderer は main を import しない。FS/Git は main のみ、renderer は preload の IPC 経由。
- Electron: `contextIsolation: true`、`nodeIntegration: false`、IPC は型付き・入力検証あり。
- 日付は文字列 `YYYY-MM-DD`（Date 型・タイムゾーンを持ち込まない）。
- データ JSON は出力規則（キー昇順・インデント2・LF・ID キーのオブジェクト）を厳守。書式を変える変更は schemaVersion とマイグレーションを伴う。
- ドラッグ等の連続操作は ref + rAF で処理し、確定時に 1 コマンドとしてストアへ（Undo 1 単位）。
- AI（GitHub Copilot SDK）: `src/main/ai/` に隔離。AI に公開するツールは読み取りと提案作成のみ、**AI に日程を直接書き換えさせない**（提案→差分確認→承認）。SDK は技術プレビューなので、仕様は公式ドキュメントで確認してから実装する。テストは SDK をモックする。
- 目標規模: 500プロジェクト × 50イベント × 8年（約25,000イベント）。描画は仮想化必須。

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

## 現状の注意
- アプリ本体は未スキャフォールド。作成時に `package.json` へ `typecheck` / `lint` / `test` スクリプトを定義すること（`verify.mjs` が自動で拾う）。ESLint でレイヤ境界（上記 `src/domain` の import 制限）を強制する。
