// @req F-607, F-608, F-601
// 出力用スナップショット（HTML ビューアに埋め込む、読み取り専用のコピー）。docs/data-model.html 10。
// 出力範囲（全体 / 選択プロジェクト）・期間・メモや担当者の有無を反映する。除外した項目は、データ自体に含めない
// （ビューア上で隠すだけにしない。プライバシー）。純 TypeScript。
import { calendarSchema, defaultCalendar, type Calendar } from '../calendar';
import { compareDates, isDateStr, type DateStr } from '../date';
import type { Dependency, Id, Project, Schedule } from '../model';
import type { HeaderMode } from '../timeline/axis';

export interface ExportScope {
  /** 出力するプロジェクト（その子孫を含む）。未指定 = 全体。 */
  readonly projectIds?: readonly Id[];
  /** 期間（この期間に重なる項目だけを出す）。未指定 = 全期間。 */
  readonly from?: DateStr;
  readonly to?: DateStr;
}

export interface SnapshotOptions {
  /** メモを含めるか（既定は含めない。決定 J2）。 */
  readonly includeNotes: boolean;
  /** 担当者を含めるか（既定は含めない。決定 J2）。 */
  readonly includeAssignee: boolean;
  /** 依存線を含めるか。 */
  readonly dependencies: boolean;
  /** 日付ヘッダの初期表示。 */
  readonly headerMode: HeaderMode;
}

export const defaultSnapshotOptions = (): SnapshotOptions => ({ includeNotes: false, includeAssignee: false, dependencies: true, headerMode: 'weekMonth' });

export interface SnapshotMeta {
  /** 出力日時（ISO 8601）。 */
  readonly generatedAt: string;
  /** 版の表記（例: 正式版 / 作業版: 11月改訂案）。 */
  readonly label: string;
  /** 画面上部に出す題名。 */
  readonly title: string;
}

export interface Snapshot {
  readonly snapshotVersion: 1;
  readonly generatedAt: string;
  readonly source: { readonly label: string };
  readonly title: string;
  readonly options: SnapshotOptions;
  readonly range: { readonly from: DateStr; readonly to: DateStr } | null;
  readonly types: Schedule['types'];
  readonly calendar: Calendar;
  readonly projects: readonly Project[];
  readonly dependencies: Readonly<Record<Id, Dependency>>;
}

/** 選択したプロジェクトとその子孫の ID。 */
export function withDescendants(s: Schedule, ids: readonly Id[]): Set<Id> {
  const out = new Set<Id>();
  const stack = ids.filter((id) => s.projects[id]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const p of Object.values(s.projects)) if (p.parentId === id) stack.push(p.id);
  }
  return out;
}

const overlaps = (start: DateStr, end: DateStr, from?: DateStr, to?: DateStr): boolean =>
  isDateStr(start) && isDateStr(end) && (from === undefined || compareDates(end, from) >= 0) && (to === undefined || compareDates(start, to) <= 0);

function omit<T extends object>(o: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out as T;
}

export function buildSnapshot(s: Schedule, calendar: Calendar, scope: ExportScope, opt: SnapshotOptions, meta: SnapshotMeta): Snapshot {
  const keep = scope.projectIds ? withDescendants(s, scope.projectIds) : null;
  const rootOfSelection = new Set(scope.projectIds ?? []);
  const projects: Project[] = [];
  const keptItems = new Set<Id>();
  let min: DateStr | null = null;
  let max: DateStr | null = null;
  const take = (a: DateStr, b: DateStr): void => {
    if (!isDateStr(a) || !isDateStr(b)) return;
    if (min === null || a < min) min = a;
    if (max === null || b > max) max = b;
  };
  for (const p of Object.values(s.projects)) {
    if (keep && !keep.has(p.id)) continue;
    const events: Project['events'] = {};
    const milestones: Project['milestones'] = {};
    for (const [id, e] of Object.entries(p.events)) {
      if (!overlaps(e.start, e.end, scope.from, scope.to)) continue;
      events[id] = opt.includeNotes ? e : omit(e, ['note']);
      keptItems.add(id);
      take(e.start, e.end);
    }
    for (const [id, m] of Object.entries(p.milestones)) {
      if (!overlaps(m.date, m.date, scope.from, scope.to)) continue;
      milestones[id] = opt.includeNotes ? m : omit(m, ['note']);
      keptItems.add(id);
      take(m.date, m.date);
    }
    let q: Project = { ...p, events, milestones };
    if (!opt.includeNotes) q = omit(q, ['note']);
    if (!opt.includeAssignee) q = omit(q, ['assignee']);
    // 選択の根は、親を切って根にする（親が出力に含まれないため）
    if (rootOfSelection.has(p.id) || (p.parentId !== null && keep && !keep.has(p.parentId))) q = { ...q, parentId: null };
    projects.push(q);
  }
  projects.sort((a, b) => (a.id < b.id ? -1 : 1));
  const dependencies: Record<Id, Dependency> = {};
  if (opt.dependencies) for (const d of Object.values(s.dependencies)) if (keptItems.has(d.from.id) && keptItems.has(d.to.id)) dependencies[d.id] = d;
  return {
    snapshotVersion: 1,
    generatedAt: meta.generatedAt,
    source: { label: meta.label },
    title: meta.title,
    options: opt,
    range: min !== null && max !== null ? { from: min, to: max } : null,
    types: s.types,
    calendar,
    projects,
    dependencies,
  };
}

/** スナップショットから日程を作る（ビューア用）。構造を確かめ、読めなければ null。表示は fillText / textContent のみ。 */
export function scheduleFromSnapshot(raw: unknown): { readonly schedule: Schedule; readonly snapshot: Snapshot } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<Snapshot>;
  if (r.snapshotVersion !== 1 || !Array.isArray(r.projects)) return null;
  const projects: Record<Id, Project> = {};
  for (const p of r.projects) {
    if (typeof p !== 'object' || p === null || typeof p.id !== 'string' || typeof p.name !== 'string') return null;
    projects[p.id] = { ...p, events: p.events ?? {}, milestones: p.milestones ?? {} };
  }
  const cal = calendarSchema.safeParse(r.calendar);
  const snapshot: Snapshot = {
    snapshotVersion: 1,
    generatedAt: String(r.generatedAt ?? ''),
    source: { label: String(r.source?.label ?? '') },
    title: String(r.title ?? ''),
    options: { ...defaultSnapshotOptions(), ...(r.options ?? {}) },
    range: r.range ?? null,
    types: r.types ?? {},
    calendar: cal.success ? cal.data : defaultCalendar(),
    projects: r.projects,
    dependencies: r.dependencies ?? {},
  };
  return { schedule: { schemaVersion: 1, projects, dependencies: snapshot.dependencies, types: snapshot.types }, snapshot };
}
