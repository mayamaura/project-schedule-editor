// @req F-201, F-202, F-204, F-205, F-206, F-208, F-301
// コマンド（唯一の状態変更の経路）。docs/data-model.html 11, requirements F-206 / F-208 / F-301。
// applyCommand は純関数: 検証 → 新しい Schedule を返す。失敗なら理由コード付きのエラーを返し、状態を変えない。
// 依存違反は拒否せず警告のみ（A2）。構造が壊れる操作（存在しない ID・循環・不正な値）だけを拒否する。
import { isDateStr } from './date';
import {
  dependencySchema,
  eventSchema,
  idSchema,
  milestoneSchema,
  projectSchema,
  type Dependency,
  type EventData,
  type Id,
  type MilestoneData,
  type Project,
  type Schedule,
} from './model';
import { isValidOrder } from './order';

export type ProjectPatch = Partial<Pick<Project, 'name' | 'status' | 'assignee' | 'tags' | 'color' | 'note'>>;
export type EventPatch = Partial<EventData>;
export type MilestonePatch = Partial<MilestoneData>;
export type DependencyPatch = Partial<Pick<Dependency, 'from' | 'to' | 'type' | 'lagDays'>>;

export type Command =
  | { readonly type: 'addProject'; readonly project: Project }
  | { readonly type: 'updateProject'; readonly id: Id; readonly patch: ProjectPatch }
  | { readonly type: 'moveProject'; readonly id: Id; readonly parentId: Id | null; readonly order: string }
  | { readonly type: 'deleteProject'; readonly id: Id }
  | { readonly type: 'addEvent'; readonly projectId: Id; readonly id: Id; readonly event: EventData }
  | { readonly type: 'updateEvent'; readonly id: Id; readonly patch: EventPatch }
  | { readonly type: 'moveEvent'; readonly id: Id; readonly projectId: Id }
  | { readonly type: 'deleteEvent'; readonly id: Id }
  | { readonly type: 'addMilestone'; readonly projectId: Id; readonly id: Id; readonly milestone: MilestoneData }
  | { readonly type: 'updateMilestone'; readonly id: Id; readonly patch: MilestonePatch }
  | { readonly type: 'moveMilestone'; readonly id: Id; readonly projectId: Id }
  | { readonly type: 'deleteMilestone'; readonly id: Id }
  | { readonly type: 'addDependency'; readonly dependency: Dependency }
  | { readonly type: 'updateDependency'; readonly id: Id; readonly patch: DependencyPatch }
  | { readonly type: 'deleteDependency'; readonly id: Id }
  /** 複数のコマンドを1つの操作として適用する（Undo 1単位）。1つでも失敗したら全体を適用しない。 */
  | { readonly type: 'batch'; readonly commands: readonly Command[]; readonly label?: string };

export type CommandErrorCode =
  | 'not-found'
  | 'duplicate-id'
  | 'invalid-value'
  | 'end-before-start'
  | 'parent-cycle'
  | 'self-dependency'
  | 'duplicate-dependency'
  | 'dependency-cycle'
  | 'invalid-command';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
  /** batch の何番目のコマンドで失敗したか。 */
  readonly index?: number;
}

export type ApplyResult = { readonly ok: true; readonly schedule: Schedule } | { readonly ok: false; readonly error: CommandError };

const fail = (code: CommandErrorCode, message: string): ApplyResult => ({ ok: false, error: { code, message } });
const ok = (schedule: Schedule): ApplyResult => ({ ok: true, schedule });

type Located =
  | { readonly kind: 'event'; readonly project: Project; readonly data: EventData }
  | { readonly kind: 'milestone'; readonly project: Project; readonly data: MilestoneData };

function locate(s: Schedule, id: Id): Located | undefined {
  for (const p of Object.values(s.projects)) {
    const e = p.events[id];
    if (e) return { kind: 'event', project: p, data: e };
    const m = p.milestones[id];
    if (m) return { kind: 'milestone', project: p, data: m };
  }
  return undefined;
}

function idInUse(s: Schedule, id: Id): boolean {
  if (s.projects[id] || s.dependencies[id]) return true;
  for (const p of Object.values(s.projects)) if (p.events[id] || p.milestones[id]) return true;
  return false;
}

function zodMessage(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '値'}: ${i.message}`).join(' / ');
}

function mergePatch<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

const withProject = (s: Schedule, p: Project): Schedule => ({ ...s, projects: { ...s.projects, [p.id]: p } });

function withoutKey<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out: Record<string, T> = { ...rec };
  delete out[key];
  return out;
}

/** parentId から辿って ancestorId に到達するか（= candidate は ancestor の子孫か、同一）。 */
function isSelfOrDescendant(s: Schedule, ancestorId: Id, candidateId: Id | null): boolean {
  let cur: Id | null = candidateId;
  const seen = new Set<Id>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = s.projects[cur]?.parentId ?? null;
  }
  return false;
}

/** from → to の辺を加えると循環するか（to から from へ既存の辺で到達できるか）。 */
function wouldCycle(deps: readonly Dependency[], from: Id, to: Id): boolean {
  if (from === to) return true;
  const adj = new Map<Id, Id[]>();
  for (const d of deps) {
    const list = adj.get(d.from.id);
    if (list) list.push(d.to.id);
    else adj.set(d.from.id, [d.to.id]);
  }
  const stack = [to];
  const seen = new Set<Id>([to]);
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (v === from) return true;
    for (const w of adj.get(v) ?? []) {
      if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
  }
  return false;
}

function checkEndpoint(s: Schedule, ep: Dependency['from']): string | null {
  const found = locate(s, ep.id);
  if (!found) return `依存の端点「${ep.id}」が存在しない`;
  if (found.kind !== ep.kind) return `依存の端点「${ep.id}」は ${found.kind} だが ${ep.kind} と指定されている`;
  return null;
}

function validateDependency(s: Schedule, d: Dependency, ignoreId?: Id): ApplyResult | null {
  const parsed = dependencySchema.safeParse(d);
  if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
  for (const ep of [d.from, d.to]) {
    const msg = checkEndpoint(s, ep);
    if (msg) return fail('not-found', msg);
  }
  if (d.from.id === d.to.id) return fail('self-dependency', '自分自身への依存は作れない');
  const others = Object.values(s.dependencies).filter((x) => x.id !== ignoreId);
  if (others.some((x) => x.from.id === d.from.id && x.to.id === d.to.id)) return fail('duplicate-dependency', '同じ端点の依存が既にある');
  if (wouldCycle(others, d.from.id, d.to.id)) return fail('dependency-cycle', '依存が循環する');
  return null;
}

/** 指定した端点 ID を参照する依存を取り除く。 */
function dropDependenciesOf(s: Schedule, ids: ReadonlySet<Id>): Schedule {
  const keep: Record<Id, Dependency> = {};
  let changed = false;
  for (const [k, d] of Object.entries(s.dependencies)) {
    if (ids.has(d.from.id) || ids.has(d.to.id)) changed = true;
    else keep[k] = d;
  }
  return changed ? { ...s, dependencies: keep } : s;
}

function itemIdsOf(p: Project): Id[] {
  return [...Object.keys(p.events), ...Object.keys(p.milestones)];
}

function checkEventDates(e: EventData): ApplyResult | null {
  if (!isDateStr(e.start) || !isDateStr(e.end)) return fail('invalid-value', '日付が不正');
  return e.end < e.start ? fail('end-before-start', `終了日（${e.end}）が開始日（${e.start}）より前`) : null;
}

function applySingle(s: Schedule, c: Exclude<Command, { type: 'batch' }>): ApplyResult {
  switch (c.type) {
    case 'addProject': {
      const parsed = projectSchema.safeParse(c.project);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      const p = c.project;
      if (idInUse(s, p.id)) return fail('duplicate-id', `ID「${p.id}」は既に使われている`);
      if (p.parentId !== null && !s.projects[p.parentId]) return fail('not-found', `親プロジェクト「${p.parentId}」が存在しない`);
      for (const [id, e] of Object.entries(p.events)) {
        const bad = checkEventDates(e);
        if (bad) return bad;
        if (idInUse(s, id) || id === p.id) return fail('duplicate-id', `ID「${id}」は既に使われている`);
      }
      const inner = [...Object.keys(p.events), ...Object.keys(p.milestones)];
      if (new Set(inner).size !== inner.length) return fail('duplicate-id', 'プロジェクト内に重複した ID がある');
      for (const id of Object.keys(p.milestones)) if (idInUse(s, id) || id === p.id) return fail('duplicate-id', `ID「${id}」は既に使われている`);
      return ok(withProject(s, p));
    }
    case 'updateProject': {
      const p = s.projects[c.id];
      if (!p) return fail('not-found', `プロジェクト「${c.id}」が存在しない`);
      const merged = mergePatch(p, c.patch);
      const parsed = projectSchema.safeParse(merged);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      return ok(withProject(s, merged));
    }
    case 'moveProject': {
      const p = s.projects[c.id];
      if (!p) return fail('not-found', `プロジェクト「${c.id}」が存在しない`);
      if (c.parentId !== null && !s.projects[c.parentId]) return fail('not-found', `親プロジェクト「${c.parentId}」が存在しない`);
      if (!isValidOrder(c.order)) return fail('invalid-value', `並び順が不正: ${c.order}`);
      if (isSelfOrDescendant(s, c.id, c.parentId)) return fail('parent-cycle', '自分自身または子孫を親にはできない');
      return ok(withProject(s, { ...p, parentId: c.parentId, order: c.order }));
    }
    case 'deleteProject': {
      if (!s.projects[c.id]) return fail('not-found', `プロジェクト「${c.id}」が存在しない`);
      const doomed = new Set<Id>([c.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of Object.values(s.projects)) {
          if (!doomed.has(p.id) && p.parentId !== null && doomed.has(p.parentId)) {
            doomed.add(p.id);
            grew = true;
          }
        }
      }
      const keep: Record<Id, Project> = {};
      const items = new Set<Id>();
      for (const [k, p] of Object.entries(s.projects)) {
        if (doomed.has(k)) for (const id of itemIdsOf(p)) items.add(id);
        else keep[k] = p;
      }
      return ok(dropDependenciesOf({ ...s, projects: keep }, items));
    }
    case 'addEvent': {
      const p = s.projects[c.projectId];
      if (!p) return fail('not-found', `プロジェクト「${c.projectId}」が存在しない`);
      const idOk = idSchema.safeParse(c.id);
      if (!idOk.success) return fail('invalid-value', zodMessage(idOk.error));
      const parsed = eventSchema.safeParse(c.event);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      const bad = checkEventDates(c.event);
      if (bad) return bad;
      if (idInUse(s, c.id)) return fail('duplicate-id', `ID「${c.id}」は既に使われている`);
      return ok(withProject(s, { ...p, events: { ...p.events, [c.id]: c.event } }));
    }
    case 'updateEvent': {
      const f = locate(s, c.id);
      if (f?.kind !== 'event') return fail('not-found', `イベント「${c.id}」が存在しない`);
      const merged = mergePatch(f.data, c.patch);
      const parsed = eventSchema.safeParse(merged);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      const bad = checkEventDates(merged);
      if (bad) return bad;
      return ok(withProject(s, { ...f.project, events: { ...f.project.events, [c.id]: merged } }));
    }
    case 'moveEvent': {
      const f = locate(s, c.id);
      if (f?.kind !== 'event') return fail('not-found', `イベント「${c.id}」が存在しない`);
      const dest = s.projects[c.projectId];
      if (!dest) return fail('not-found', `プロジェクト「${c.projectId}」が存在しない`);
      if (dest.id === f.project.id) return ok(s);
      const moved = withProject(s, { ...f.project, events: withoutKey(f.project.events, c.id) });
      return ok(withProject(moved, { ...dest, events: { ...dest.events, [c.id]: f.data } }));
    }
    case 'deleteEvent': {
      const f = locate(s, c.id);
      if (f?.kind !== 'event') return fail('not-found', `イベント「${c.id}」が存在しない`);
      return ok(dropDependenciesOf(withProject(s, { ...f.project, events: withoutKey(f.project.events, c.id) }), new Set([c.id])));
    }
    case 'addMilestone': {
      const p = s.projects[c.projectId];
      if (!p) return fail('not-found', `プロジェクト「${c.projectId}」が存在しない`);
      const idOk = idSchema.safeParse(c.id);
      if (!idOk.success) return fail('invalid-value', zodMessage(idOk.error));
      const parsed = milestoneSchema.safeParse(c.milestone);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      if (idInUse(s, c.id)) return fail('duplicate-id', `ID「${c.id}」は既に使われている`);
      return ok(withProject(s, { ...p, milestones: { ...p.milestones, [c.id]: c.milestone } }));
    }
    case 'updateMilestone': {
      const f = locate(s, c.id);
      if (f?.kind !== 'milestone') return fail('not-found', `マイルストーン「${c.id}」が存在しない`);
      const merged = mergePatch(f.data, c.patch);
      const parsed = milestoneSchema.safeParse(merged);
      if (!parsed.success) return fail('invalid-value', zodMessage(parsed.error));
      return ok(withProject(s, { ...f.project, milestones: { ...f.project.milestones, [c.id]: merged } }));
    }
    case 'moveMilestone': {
      const f = locate(s, c.id);
      if (f?.kind !== 'milestone') return fail('not-found', `マイルストーン「${c.id}」が存在しない`);
      const dest = s.projects[c.projectId];
      if (!dest) return fail('not-found', `プロジェクト「${c.projectId}」が存在しない`);
      if (dest.id === f.project.id) return ok(s);
      const moved = withProject(s, { ...f.project, milestones: withoutKey(f.project.milestones, c.id) });
      return ok(withProject(moved, { ...dest, milestones: { ...dest.milestones, [c.id]: f.data } }));
    }
    case 'deleteMilestone': {
      const f = locate(s, c.id);
      if (f?.kind !== 'milestone') return fail('not-found', `マイルストーン「${c.id}」が存在しない`);
      return ok(dropDependenciesOf(withProject(s, { ...f.project, milestones: withoutKey(f.project.milestones, c.id) }), new Set([c.id])));
    }
    case 'addDependency': {
      const bad = validateDependency(s, c.dependency);
      if (bad) return bad;
      if (idInUse(s, c.dependency.id)) return fail('duplicate-id', `ID「${c.dependency.id}」は既に使われている`);
      return ok({ ...s, dependencies: { ...s.dependencies, [c.dependency.id]: c.dependency } });
    }
    case 'updateDependency': {
      const d = s.dependencies[c.id];
      if (!d) return fail('not-found', `依存「${c.id}」が存在しない`);
      const merged = mergePatch(d, c.patch);
      const bad = validateDependency(s, merged, c.id);
      if (bad) return bad;
      return ok({ ...s, dependencies: { ...s.dependencies, [c.id]: merged } });
    }
    case 'deleteDependency': {
      if (!s.dependencies[c.id]) return fail('not-found', `依存「${c.id}」が存在しない`);
      return ok({ ...s, dependencies: withoutKey(s.dependencies, c.id) });
    }
  }
}

export function applyCommand(s: Schedule, c: Command): ApplyResult {
  if (c.type !== 'batch') return applySingle(s, c);
  if (c.commands.length === 0) return fail('invalid-command', '空のバッチ');
  let cur = s;
  for (const [index, sub] of c.commands.entries()) {
    const r = applyCommand(cur, sub);
    if (!r.ok) return { ok: false, error: { ...r.error, index: r.error.index ?? index } };
    cur = r.schedule;
  }
  return ok(cur);
}
