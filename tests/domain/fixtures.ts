// テスト用の小さな日程データを組み立てる補助。
import type { Dependency, EventData, MilestoneData, Project, Schedule } from '../../src/domain/model';

export const ev = (name: string, start: string, end: string, extra: Partial<EventData> = {}): EventData => ({ name, start, end, type: 'phase', ...extra });
export const ms = (name: string, date: string, extra: Partial<MilestoneData> = {}): MilestoneData => ({ name, date, type: 'review', ...extra });

export function proj(id: string, p: Partial<Project> = {}): Project {
  return { id, name: p.name ?? `P-${id}`, parentId: null, order: 'i', events: {}, milestones: {}, ...p };
}

export function dep(id: string, from: [Dependency['from']['kind'], string], to: [Dependency['to']['kind'], string], extra: Partial<Dependency> = {}): Dependency {
  return { id, from: { kind: from[0], id: from[1] }, to: { kind: to[0], id: to[1] }, type: 'FS', lagDays: 0, ...extra };
}

export function schedule(projects: Project[] = [], dependencies: Dependency[] = []): Schedule {
  return {
    schemaVersion: 1,
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    dependencies: Object.fromEntries(dependencies.map((d) => [d.id, d])),
    types: {},
  };
}

/** 再帰的に凍結する。実装が入力データを書き換えると（strict モードで）例外になる。 */
export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** 基本のサンプル: A（設計→試作→◆リリース）と、その子 A1。 */
export function basic(): Schedule {
  return schedule(
    [
      proj('A', {
        name: '新製品A',
        order: 'i',
        events: { e1: ev('設計', '2026-11-01', '2026-12-15'), e2: ev('試作', '2026-12-16', '2027-03-31') },
        milestones: { m1: ms('リリース', '2027-04-01', { type: 'release' }) },
      }),
      proj('A1', { name: '筐体', parentId: 'A', order: 'i', events: { e3: ev('金型', '2026-12-01', '2027-02-28') } }),
    ],
    [dep('d1', ['event', 'e1'], ['event', 'e2'])],
  );
}
