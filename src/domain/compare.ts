// @req F-505, F-510
// 2 つの版の比較（どの日程がどう動いたか）。純関数。diffSchedule が「フィールド単位の変更」を返すのに対し、
// こちらは画面で「項目ごとに、前の位置と今の位置・動いた日数」を見せるための単位。docs/data-model.html 4.5。
import { compareDates, daysBetween, type DateStr } from './date';
import type { EventData, Id, MilestoneData, Schedule } from './model';

export interface Span {
  readonly start: DateStr;
  readonly end: DateStr;
}

export interface ItemChange {
  readonly kind: 'event' | 'milestone';
  readonly id: Id;
  readonly projectId: Id;
  readonly projectName: string;
  readonly name: string;
  /** moved = 日付が動いた / edited = 日付以外（名称・種別・メモ・所属など）だけ変わった。 */
  readonly change: 'added' | 'removed' | 'moved' | 'edited';
  readonly old?: Span;
  readonly new?: Span;
  /** 動いた日数。後ろ倒しは正、前倒しは負（開始が動いていれば開始、終了だけなら終了の差）。動いていなければ 0。 */
  readonly shiftDays: number;
}

interface Found {
  readonly kind: 'event' | 'milestone';
  readonly projectId: Id;
  readonly projectName: string;
  readonly data: EventData | MilestoneData;
}

function index(s: Schedule): Map<Id, Found> {
  const m = new Map<Id, Found>();
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) m.set(id, { kind: 'event', projectId: p.id, projectName: p.name, data: e });
    for (const [id, x] of Object.entries(p.milestones)) m.set(id, { kind: 'milestone', projectId: p.id, projectName: p.name, data: x });
  }
  return m;
}

const spanOf = (f: Found): Span => ('date' in f.data ? { start: f.data.date, end: f.data.date } : { start: f.data.start, end: f.data.end });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** a（前）から b（後）への、項目ごとの変化。日付が動いた項目と、追加・削除・その他の編集を返す。 */
export function compareSchedules(a: Schedule, b: Schedule): ItemChange[] {
  const ia = index(a);
  const ib = index(b);
  const out: ItemChange[] = [];
  for (const [id, f] of ib) {
    const o = ia.get(id);
    const span = spanOf(f);
    const base = { kind: f.kind, id, projectId: f.projectId, projectName: f.projectName, name: f.data.name } as const;
    if (!o) {
      out.push({ ...base, change: 'added', new: span, shiftDays: 0 });
      continue;
    }
    const os = spanOf(o);
    if (os.start !== span.start || os.end !== span.end) {
      const shiftDays = os.start !== span.start ? daysBetween(os.start, span.start) : daysBetween(os.end, span.end);
      out.push({ ...base, change: 'moved', old: os, new: span, shiftDays });
    } else if (o.projectId !== f.projectId || !same(o.data, f.data)) {
      out.push({ ...base, change: 'edited', old: os, new: span, shiftDays: 0 });
    }
  }
  for (const [id, o] of ia) {
    if (!ib.has(id)) out.push({ kind: o.kind, id, projectId: o.projectId, projectName: o.projectName, name: o.data.name, change: 'removed', old: spanOf(o), shiftDays: 0 });
  }
  return out.sort((x, y) => (x.projectName < y.projectName ? -1 : x.projectName > y.projectName ? 1 : x.id < y.id ? -1 : 1));
}

/** 後ろ倒しになった項目を、遅れの大きい順に（F-510）。 */
export function delayedItems(changes: readonly ItemChange[]): ItemChange[] {
  return changes.filter((c) => c.change === 'moved' && c.shiftDays > 0).sort((x, y) => y.shiftDays - x.shiftDays);
}

export interface ChangeFilter {
  readonly projectId?: Id;
  /** 期間（変更前か変更後の日付が重なる項目に絞る）。 */
  readonly from?: DateStr;
  readonly to?: DateStr;
}

export function filterChanges(changes: readonly ItemChange[], f: ChangeFilter): ItemChange[] {
  const overlaps = (s: Span | undefined): boolean => s !== undefined && (f.from === undefined || compareDates(s.end, f.from) >= 0) && (f.to === undefined || compareDates(s.start, f.to) <= 0);
  return changes.filter((c) => (f.projectId === undefined || c.projectId === f.projectId) && (f.from === undefined && f.to === undefined ? true : overlaps(c.old) || overlaps(c.new)));
}
