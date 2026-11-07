---
name: spec-change
description: 要件・データ形式・UI・技術選定などの仕様を追加/変更/決定するときに使う。関連文書を漏れなく同期し changelog に記録する。
---

# 仕様変更の手順

1. **影響範囲の特定**: 変更内容に関係する文書を全て列挙する（requirements / data-model / architecture / ui-design / git-ux / open-questions）。`grep` で関連キーワード・要件IDを検索し、古い記述が残る箇所も洗い出す。
2. **要件ID**: 新規は requirements.html の最大番号の次を採番（機能 F-xxx、非機能 NF-xxx）。削除する要件は欠番にし、再利用しない。優先度(M/S/C)を付ける。
3. **更新**: 影響する全文書を同一作業内で更新する。決定事項は open-questions.html の回答欄に `<strong>決定:</strong>` で記録。
4. **changelog**: `docs/changelog.html` の表の先頭に 日付・変更内容・影響文書・要件ID を追記する。
5. **検証**: `node scripts/check-docs.mjs --worktree` を実行し、error が 0 になるまで直す。
6. **既存コードへの影響**: `src/` に影響する場合は、影響箇所を列挙してユーザーに報告する（勝手に大規模改修しない）。
7. 不明点・矛盾はユーザーに質問する。推測で決めない。
