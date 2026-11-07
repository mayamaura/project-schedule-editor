// @req F-509, F-510, F-512
// 日程変更の検出（F-509）。2つの Schedule を ID で対応付けて、業務上意味のある変更の一覧にする。
// 行単位の git diff は解析しない。改名・並べ替え・プロジェクト間の移動でも、同じ ID なら同一物として追跡する。
// 保存・共有・履歴・版の比較・競合解決・AI 提案のプレビューの全てで再利用する（data-model 4.5, 11）。
import { daysBetween } from './date';
import type { Dependency, Id, Project, Schedule } from './model';

export type Value = string | number | readonly string[] | null;
export type ItemKind = 'event' | 'milestone';

export type Change =
  | { readonly kind: 'project-added'; readonly projectId: Id; readonly name: string; readonly eventCount: number; readonly milestoneCount: number }
  | { readonly kind: 'project-removed'; readonly projectId: Id; readonly name: string; readonly eventCount: number; readonly milestoneCount: number }
  | { readonly kind: 'project-moved'; readonly projectId: Id; readonly name: string; readonly fromParentId: Id | null; readonly toParentId: Id | null }
  | { readonly kind: 'project-reordered'; readonly projectId: Id; readonly name: string }
  | { readonly kind: 'project-attr'; readonly projectId: Id; readonly name: string; readonly field: string; readonly from: Value; readonly to: Value }
  | { readonly kind: 'item-added'; readonly itemKind: ItemKind; readonly id: Id; readonly projectId: Id; readonly name: string; readonly start: string; readonly end: string }
  | { readonly kind: 'item-removed'; readonly itemKind: ItemKind; readonly id: Id; readonly projectId: Id; readonly name: string; readonly start: string; readonly end: string }
  | { readonly kind: 'item-moved'; readonly itemKind: ItemKind; readonly id: Id; readonly name: string; readonly fromProjectId: Id; readonly toProjectId: Id }
  | {
      readonly kind: 'item-dates';
      readonly itemKind: ItemKind;
      readonly id: Id;
      readonly projectId: Id;
      readonly name: string;
      readonly from: { readonly start: string; readonly end: string };
      readonly to: { readonly start: string; readonly end: string };
      /** 開始日・終了日の変動日数（後ろ倒しが正）。マイルストーンは両方とも日付の変動。 */
      readonly startShiftDays: number;
      readonly endShiftDays: number;
    }
  | { readonly kind: 'item-attr'; readonly itemKind: ItemKind; readonly id: Id; readonly projectId: Id; readonly name: string; readonly field: string; readonly from: Value; readonly to: Value }
  | { readonly kind: 'dependency-added'; readonly id: Id; readonly dependency: Dependency }
  | { readonly kind: 'dependency-removed'; readonly id: Id; readonly dependency: Dependency }
  | { readonly kind: 'dependency-changed'; readonly id: Id; readonly field: 'type' | 'lagDays' | 'from' | 'to'; readonly from: Value; readonly to: Value };

interface Item {
  readonly kind: ItemKind;
  readonly id: Id;
  readonly projectId: Id;
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly attrs: Readonly<Record<string, Value | undefined>>;
}

function indexItems(s: Schedule): Map<Id, Item> {
  const map = new Map<Id, Item>();
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) {
      map.set(id, { kind: 'event', id, projectId: p.id, name: e.name, start: e.start, end: e.end, attrs: { name: e.name, type: e.type, color: e.color, style: e.style, note: e.note } });
    }
    for (const [id, m] of Object.entries(p.milestones)) {
      map.set(id, { kind: 'milestone', id, projectId: p.id, name: m.name, start: m.date, end: m.date, attrs: { name: m.name, type: m.type, style: m.style, note: m.note } });
    }
  }
  return map;
}

const norm = (v: Value | undefined): Value => (v === undefined ? null : v);
const same = (a: Value, b: Value): boolean => JSON.stringify(a) === JSON.stringify(b);
const endpointStr = (ep: Dependency['from']): string => `${ep.kind}:${ep.id}`;

const PROJECT_ATTRS = ['name', 'status', 'assignee', 'tags', 'color', 'note'] as const;

const RANK: Record<Change['kind'], number> = {
  'project-added': 0,
  'project-removed': 1,
  'project-moved': 2,
  'project-reordered': 3,
  'project-attr': 4,
  'item-added': 5,
  'item-removed': 6,
  'item-moved': 7,
  'item-dates': 8,
  'item-attr': 9,
  'dependency-added': 10,
  'dependency-removed': 11,
  'dependency-changed': 12,
};

function keyOf(c: Change): string {
  const id = c.kind.startsWith('project') ? (c as { projectId: Id }).projectId : (c as { id: Id }).id;
  const field = 'field' in c ? c.field : '';
  return `${String(RANK[c.kind]).padStart(2, '0')}\u0000${id}\u0000${field}`;
}

export function diffSchedule(oldS: Schedule, newS: Schedule): Change[] {
  const out: Change[] = [];
  const counts = (p: Project): { eventCount: number; milestoneCount: number } => ({ eventCount: Object.keys(p.events).length, milestoneCount: Object.keys(p.milestones).length });

  // --- プロジェクト ---
  for (const [id, p] of Object.entries(newS.projects)) {
    const o = oldS.projects[id];
    if (!o) {
      out.push({ kind: 'project-added', projectId: id, name: p.name, ...counts(p) });
      continue;
    }
    if (o.parentId !== p.parentId) out.push({ kind: 'project-moved', projectId: id, name: p.name, fromParentId: o.parentId, toParentId: p.parentId });
    if (o.order !== p.order) out.push({ kind: 'project-reordered', projectId: id, name: p.name });
    for (const f of PROJECT_ATTRS) {
      const a = norm(o[f]);
      const b = norm(p[f]);
      if (!same(a, b)) out.push({ kind: 'project-attr', projectId: id, name: p.name, field: f, from: a, to: b });
    }
  }
  for (const [id, o] of Object.entries(oldS.projects)) {
    if (!newS.projects[id]) out.push({ kind: 'project-removed', projectId: id, name: o.name, ...counts(o) });
  }

  // --- イベント・マイルストーン（追加・削除されたプロジェクト内の項目は、プロジェクトの変更に含める）---
  const oldItems = indexItems(oldS);
  const newItems = indexItems(newS);
  for (const [id, n] of newItems) {
    const o = oldItems.get(id);
    if (!o || o.kind !== n.kind) {
      if (oldS.projects[n.projectId]) out.push({ kind: 'item-added', itemKind: n.kind, id, projectId: n.projectId, name: n.name, start: n.start, end: n.end });
      continue;
    }
    if (o.projectId !== n.projectId) out.push({ kind: 'item-moved', itemKind: n.kind, id, name: n.name, fromProjectId: o.projectId, toProjectId: n.projectId });
    if (o.start !== n.start || o.end !== n.end) {
      out.push({
        kind: 'item-dates',
        itemKind: n.kind,
        id,
        projectId: n.projectId,
        name: n.name,
        from: { start: o.start, end: o.end },
        to: { start: n.start, end: n.end },
        startShiftDays: daysBetween(o.start, n.start),
        endShiftDays: daysBetween(o.end, n.end),
      });
    }
    for (const f of Object.keys({ ...o.attrs, ...n.attrs })) {
      const a = norm(o.attrs[f]);
      const b = norm(n.attrs[f]);
      if (!same(a, b)) out.push({ kind: 'item-attr', itemKind: n.kind, id, projectId: n.projectId, name: n.name, field: f, from: a, to: b });
    }
  }
  for (const [id, o] of oldItems) {
    const n = newItems.get(id);
    if ((!n || n.kind !== o.kind) && newS.projects[o.projectId]) {
      out.push({ kind: 'item-removed', itemKind: o.kind, id, projectId: o.projectId, name: o.name, start: o.start, end: o.end });
    }
  }

  // --- 依存 ---
  for (const [id, d] of Object.entries(newS.dependencies)) {
    const o = oldS.dependencies[id];
    if (!o) {
      out.push({ kind: 'dependency-added', id, dependency: d });
      continue;
    }
    if (o.type !== d.type) out.push({ kind: 'dependency-changed', id, field: 'type', from: o.type, to: d.type });
    if (o.lagDays !== d.lagDays) out.push({ kind: 'dependency-changed', id, field: 'lagDays', from: o.lagDays, to: d.lagDays });
    if (endpointStr(o.from) !== endpointStr(d.from)) out.push({ kind: 'dependency-changed', id, field: 'from', from: endpointStr(o.from), to: endpointStr(d.from) });
    if (endpointStr(o.to) !== endpointStr(d.to)) out.push({ kind: 'dependency-changed', id, field: 'to', from: endpointStr(o.to), to: endpointStr(d.to) });
  }
  for (const [id, o] of Object.entries(oldS.dependencies)) {
    if (!newS.dependencies[id]) out.push({ kind: 'dependency-removed', id, dependency: o });
  }

  return out.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
