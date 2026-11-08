// @req F-203, F-207
// キーボード操作・複数選択の純関数: 矢印キーでの選択の移動、複数項目の一括移動（日数シフト）、コピー & 貼り付け、一括削除。
// 状態は変えず、コマンド（1 つの batch = Undo 1 単位）を作る。検証は applyCommand が行う。
import { addDays, isDateStr, toDays } from './date';
import type { Command } from './commands';
import { newId } from './edit';
import type { EventData, Id, MilestoneData, Project, Schedule } from './model';
import { withDescendants } from './export/snapshot';
import { itemDays, type Layout } from './timeline/layout';

export type NavDir = 'left' | 'right' | 'up' | 'down';

interface Pos {
  readonly id: Id;
  readonly row: number;
  readonly start: number;
}

/** 表示行ごとの項目を、開始日の順に並べる（日付が不正な項目は除く）。 */
function itemsByRow(s: Schedule, layout: Layout): Pos[][] {
  const out: Pos[][] = layout.rows.map(() => []);
  for (const [ri, row] of layout.rows.entries()) {
    const p = s.projects[row.projectId];
    if (!p) continue;
    const days = itemDays(p);
    for (const id of [...Object.keys(p.events), ...Object.keys(p.milestones)]) {
      const d = days.get(id);
      if (d) out[ri]!.push({ id, row: ri, start: d.s });
    }
    out[ri]!.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return out;
}

/** 矢印キーで、選択を隣の項目へ。左右 = 同じ行で開始日の前後、上下 = 隣の表示行で開始日が近い項目。無ければ null。 */
export function neighborItem(s: Schedule, layout: Layout, id: Id, dir: NavDir): Id | null {
  const rows = itemsByRow(s, layout);
  let cur: Pos | undefined;
  for (const r of rows) cur = cur ?? r.find((p) => p.id === id);
  if (!cur) return null;
  const same = rows[cur.row]!;
  if (dir === 'left' || dir === 'right') {
    const i = same.findIndex((p) => p.id === id);
    return same[dir === 'left' ? i - 1 : i + 1]?.id ?? null;
  }
  // 項目の無い行は飛ばして、最も近い行の項目を探す
  for (let ri = cur.row + (dir === 'up' ? -1 : 1); ri >= 0 && ri < rows.length; ri += dir === 'up' ? -1 : 1) {
    const cand = rows[ri]!;
    if (cand.length === 0) continue;
    return cand.reduce((best, p) => (Math.abs(p.start - cur.start) < Math.abs(best.start - cur.start) ? p : best)).id;
  }
  return null;
}

export interface ShiftOptions {
  /** プロジェクトを選んだとき、子孫のプロジェクトの項目も動かす。 */
  readonly descendants?: boolean;
}

/** 選んだ項目（イベント・マイルストーン。プロジェクトならその項目）を days 日ずらす。0 日・対象なしは null。 */
export function shiftCommand(s: Schedule, ids: readonly Id[], days: number, opt: ShiftOptions = {}): Command | null {
  if (days === 0 || !Number.isFinite(days)) return null;
  const targets = new Set<Id>();
  for (const id of ids) {
    if (s.projects[id]) {
      for (const pid of opt.descendants ? withDescendants(s, [id]) : [id]) {
        const p = s.projects[pid]!;
        for (const e of Object.keys(p.events)) targets.add(e);
        for (const m of Object.keys(p.milestones)) targets.add(m);
      }
    } else targets.add(id);
  }
  const commands: Command[] = [];
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) {
      if (targets.has(id) && isDateStr(e.start) && isDateStr(e.end)) commands.push({ type: 'updateEvent', id, patch: { start: addDays(e.start, days), end: addDays(e.end, days) } });
    }
    for (const [id, m] of Object.entries(p.milestones)) {
      if (targets.has(id) && isDateStr(m.date)) commands.push({ type: 'updateMilestone', id, patch: { date: addDays(m.date, days) } });
    }
  }
  return commands.length === 0 ? null : { type: 'batch', commands, label: `${commands.length} 件を ${days > 0 ? `${days} 日後ろへ` : `${-days} 日前へ`}ずらす` };
}

export type ClipItem = { readonly kind: 'event'; readonly data: EventData } | { readonly kind: 'milestone'; readonly data: MilestoneData };

/** 選んだ項目の写し（貼り付け用）。依存は写さない。 */
export function copyItems(s: Schedule, ids: readonly Id[]): ClipItem[] {
  const want = new Set(ids);
  const out: { start: number; item: ClipItem }[] = [];
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) if (want.has(id)) out.push({ start: toDays(e.start), item: { kind: 'event', data: e } });
    for (const [id, m] of Object.entries(p.milestones)) if (want.has(id)) out.push({ start: toDays(m.date), item: { kind: 'milestone', data: m } });
  }
  return out.sort((a, b) => a.start - b.start).map((x) => x.item);
}

/** コピーした項目を、プロジェクトに貼り付けるコマンド（新しい ID。日付・種別・メモは同じ）。 */
export function pasteCommand(s: Schedule, clip: readonly ClipItem[], projectId: Id, rand?: () => number): { command: Command; ids: Id[] } | null {
  const project: Project | undefined = s.projects[projectId];
  if (!project || clip.length === 0) return null;
  const used = new Set<Id>();
  const fresh = (): Id => {
    for (;;) {
      const id = newId(s, rand);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const ids: Id[] = [];
  const commands: Command[] = clip.map((c) => {
    const id = fresh();
    ids.push(id);
    return c.kind === 'event' ? { type: 'addEvent', projectId, id, event: { ...c.data } } : { type: 'addMilestone', projectId, id, milestone: { ...c.data } };
  });
  return { command: { type: 'batch', commands, label: `${commands.length} 件を貼り付け` }, ids };
}

/** 選んだ項目（イベント・マイルストーン）をまとめて削除するコマンド。存在しないものは無視。無ければ null。 */
export function deleteItemsCommand(s: Schedule, ids: readonly Id[]): Command | null {
  const commands: Command[] = [];
  const want = new Set(ids);
  for (const p of Object.values(s.projects)) {
    for (const id of Object.keys(p.events)) if (want.has(id)) commands.push({ type: 'deleteEvent', id });
    for (const id of Object.keys(p.milestones)) if (want.has(id)) commands.push({ type: 'deleteMilestone', id });
  }
  return commands.length === 0 ? null : { type: 'batch', commands, label: `${commands.length} 件を削除` };
}
