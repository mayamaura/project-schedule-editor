// @req F-202, F-205, F-305
// UI の操作 → コマンドを作る純関数群（作成・プロジェクトの追加と並べ替え・依存の作成）。
// 状態は変えない。検証（循環・存在確認など）は applyCommand が行う。
import { addDays, fromDays } from './date';
import type { Command } from './commands';
import { buildItemIndex, type Id, type Project, type Schedule } from './model';
import { orderBetween } from './order';

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

function inUse(s: Schedule, id: Id): boolean {
  return Boolean(s.projects[id] || s.dependencies[id]) || buildItemIndex(s).has(id);
}

/** 衝突しない新しい ID（8文字の小文字英数字。並行編集でも被りにくいよう乱数）。 */
export function newId(s: Schedule, rand: () => number = Math.random): Id {
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_CHARS.charAt(Math.floor(rand() * ID_CHARS.length) % ID_CHARS.length);
    if (!inUse(s, id)) return id;
  }
}

const defaultType = (s: Schedule, fallback: string): string => Object.keys(s.types)[0] ?? fallback;

/** クリックした日（通算日数）から7日間（終了日を含む）のイベント。 */
export function addEventCommand(s: Schedule, a: { projectId: Id; id: Id; day: number; name: string }): Command {
  const start = fromDays(a.day);
  return { type: 'addEvent', projectId: a.projectId, id: a.id, event: { name: a.name, start, end: addDays(start, 6), type: defaultType(s, 'task') } };
}

export function addMilestoneCommand(s: Schedule, a: { projectId: Id; id: Id; day: number; name: string }): Command {
  return { type: 'addMilestone', projectId: a.projectId, id: a.id, milestone: { name: a.name, date: fromDays(a.day), type: defaultType(s, 'milestone') } };
}

/** 同じ親の子プロジェクトを並び順で返す。 */
export function siblingsOf(s: Schedule, parentId: Id | null, excludeId?: Id): Project[] {
  return Object.values(s.projects)
    .filter((p) => p.parentId === parentId && p.id !== excludeId)
    .sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : x.id < y.id ? -1 : 1));
}

/** 同じ親の末尾に追加するプロジェクト。 */
export function addProjectCommand(s: Schedule, a: { id: Id; name: string; parentId: Id | null }): Command {
  const last = siblingsOf(s, a.parentId).pop();
  return { type: 'addProject', project: { id: a.id, name: a.name, parentId: a.parentId, order: orderBetween(last?.order ?? null, null), events: {}, milestones: {} } };
}

/**
 * ドラッグ&ドロップによるプロジェクトの移動。target の前 / 後 / 子（末尾）へ置く。
 * 自分自身が対象、または並び順を作れない（同じ order が並ぶなど）場合は null。子孫の下への移動は applyCommand が拒否する。
 */
export function placeProjectCommand(s: Schedule, id: Id, targetId: Id, where: 'before' | 'after' | 'inside'): Command | null {
  const target = s.projects[targetId];
  if (!s.projects[id] || !target || id === targetId) return null;
  try {
    if (where === 'inside') {
      const last = siblingsOf(s, targetId, id).pop();
      return { type: 'moveProject', id, parentId: targetId, order: orderBetween(last?.order ?? null, null) };
    }
    const sib = siblingsOf(s, target.parentId, id);
    const i = sib.findIndex((p) => p.id === targetId);
    const prev = where === 'before' ? sib[i - 1] : target;
    const next = where === 'before' ? target : sib[i + 1];
    return { type: 'moveProject', id, parentId: target.parentId, order: orderBetween(prev?.order ?? null, next?.order ?? null) };
  } catch {
    return null;
  }
}

/** 完了→開始（FS）・ラグ0の依存。端点が存在しなければ null。 */
export function addDependencyCommand(s: Schedule, a: { id: Id; from: Id; to: Id }): Command | null {
  const idx = buildItemIndex(s);
  const f = idx.get(a.from);
  const t = idx.get(a.to);
  if (!f || !t) return null;
  return { type: 'addDependency', dependency: { id: a.id, from: { kind: f.kind, id: f.id }, to: { kind: t.kind, id: t.id }, type: 'FS', lagDays: 0 } };
}
