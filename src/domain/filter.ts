// @req F-402
// 表示フィルタ（名称検索・状態・担当・タグ・期間）。日程そのものは変えず、表示用の日程（絞り込んだコピー）を返す純関数。
// 項目の ID は変わらないので、絞り込んだ表示の上でも、選択・編集は元の日程に対して行える。docs/ui-design.html。
import { compareDates, isDateStr, type DateStr } from './date';
import type { Dependency, Id, Project, Schedule } from './model';

export type Status = NonNullable<Project['status']>;

export interface ViewFilter {
  /** 名称検索（項目名・メモ・プロジェクト名。大文字小文字を区別しない）。 */
  readonly text?: string;
  readonly statuses?: Status[];
  readonly assignees?: string[];
  readonly tags?: string[];
  /** 期間（この期間に重なる項目だけ）。 */
  readonly from?: DateStr;
  readonly to?: DateStr;
}

const has = (a: readonly unknown[] | undefined): boolean => a !== undefined && a.length > 0;

export function isFilterActive(f: ViewFilter): boolean {
  return (f.text ?? '').trim() !== '' || has(f.statuses) || has(f.assignees) || has(f.tags) || !!f.from || !!f.to;
}

/** 選べる担当・タグの一覧（日程に出てくるもの）。 */
export function filterOptions(s: Schedule): { assignees: string[]; tags: string[] } {
  const assignees = new Set<string>();
  const tags = new Set<string>();
  for (const p of Object.values(s.projects)) {
    if (p.assignee) assignees.add(p.assignee);
    for (const t of p.tags ?? []) tags.add(t);
  }
  const sort = (x: Set<string>): string[] => [...x].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { assignees: sort(assignees), tags: sort(tags) };
}

export function filterSchedule(s: Schedule, f: ViewFilter): Schedule {
  if (!isFilterActive(f)) return s;
  const text = (f.text ?? '').trim().toLowerCase();
  const inText = (v: string | undefined): boolean => v !== undefined && v.toLowerCase().includes(text);
  const overlaps = (a: DateStr, b: DateStr): boolean => isDateStr(a) && isDateStr(b) && (!f.from || compareDates(b, f.from) >= 0) && (!f.to || compareDates(a, f.to) <= 0);

  const projectOk = (p: Project): boolean =>
    (!has(f.statuses) || (p.status !== undefined && f.statuses!.includes(p.status))) &&
    (!has(f.assignees) || (p.assignee !== undefined && f.assignees!.includes(p.assignee))) &&
    (!has(f.tags) || (p.tags ?? []).some((t) => f.tags!.includes(t)));

  const itemOk = (p: Project, name: string, note: string | undefined, a: DateStr, b: DateStr): boolean =>
    (text === '' || inText(name) || inText(note) || inText(p.name) || inText(p.note)) && overlaps(a, b);

  const keptItems = new Map<Id, { events: Project['events']; milestones: Project['milestones'] }>();
  const matched = new Set<Id>();
  for (const p of Object.values(s.projects)) {
    if (!projectOk(p)) continue;
    const events: Project['events'] = {};
    const milestones: Project['milestones'] = {};
    for (const [id, e] of Object.entries(p.events)) if (itemOk(p, e.name, e.note, e.start, e.end)) events[id] = e;
    for (const [id, m] of Object.entries(p.milestones)) if (itemOk(p, m.name, m.note, m.date, m.date)) milestones[id] = m;
    // 項目の条件（名称・期間）があるときは、一致する項目が無いプロジェクトは出さない
    const itemCriteria = text !== '' || !!f.from || !!f.to;
    if (itemCriteria && Object.keys(events).length + Object.keys(milestones).length === 0) continue;
    keptItems.set(p.id, { events, milestones });
    matched.add(p.id);
  }
  // 一致したプロジェクトの祖先は、文脈として残す（項目は出さない）
  const visible = new Set(matched);
  for (const id of matched) {
    let cur = s.projects[id]?.parentId ?? null;
    while (cur !== null && !visible.has(cur) && s.projects[cur]) {
      visible.add(cur);
      cur = s.projects[cur]!.parentId;
    }
  }
  const projects: Record<Id, Project> = {};
  const present = new Set<Id>();
  for (const id of visible) {
    const p = s.projects[id]!;
    const k = keptItems.get(id);
    projects[id] = { ...p, events: k?.events ?? {}, milestones: k?.milestones ?? {} };
    for (const x of Object.keys(projects[id]!.events)) present.add(x);
    for (const x of Object.keys(projects[id]!.milestones)) present.add(x);
  }
  const dependencies: Record<Id, Dependency> = {};
  for (const d of Object.values(s.dependencies)) if (present.has(d.from.id) && present.has(d.to.id)) dependencies[d.id] = d;
  return { ...s, projects, dependencies };
}
