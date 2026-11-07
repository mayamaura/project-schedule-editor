// @req F-211, F-510
// 変更（diffSchedule の結果）を日本語の1行にする。復元の一覧で使う（Phase 4 の保存・履歴の要約もこれを拡張する）。
import type { Change } from './diff';

const item = (k: 'event' | 'milestone'): string => (k === 'event' ? 'イベント' : 'マイルストーン');
const v = (x: unknown): string => (x === null || x === undefined ? '（なし）' : Array.isArray(x) ? x.join(', ') : String(x));
const range = (r: { start: string; end: string }): string => (r.start === r.end ? r.start : `${r.start}〜${r.end}`);

export function summarizeChange(c: Change): string {
  switch (c.kind) {
    case 'project-added':
      return `プロジェクト「${c.name}」を追加`;
    case 'project-removed':
      return `プロジェクト「${c.name}」を削除`;
    case 'project-moved':
      return `プロジェクト「${c.name}」の親を変更`;
    case 'project-reordered':
      return `プロジェクト「${c.name}」の並びを変更`;
    case 'project-attr':
      return `プロジェクト「${c.name}」の${c.field}: ${v(c.from)} → ${v(c.to)}`;
    case 'item-added':
      return `${item(c.itemKind)}「${c.name}」を追加（${c.start === c.end ? c.start : `${c.start}〜${c.end}`}）`;
    case 'item-removed':
      return `${item(c.itemKind)}「${c.name}」を削除`;
    case 'item-moved':
      return `${item(c.itemKind)}「${c.name}」を別のプロジェクトへ移動`;
    case 'item-dates':
      return `${item(c.itemKind)}「${c.name}」の日付: ${range(c.from)} → ${range(c.to)}`;
    case 'item-attr':
      return `${item(c.itemKind)}「${c.name}」の${c.field}: ${v(c.from)} → ${v(c.to)}`;
    case 'dependency-added':
      return '依存を追加';
    case 'dependency-removed':
      return '依存を削除';
    case 'dependency-changed':
      return `依存の${c.field}: ${v(c.from)} → ${v(c.to)}`;
  }
}
