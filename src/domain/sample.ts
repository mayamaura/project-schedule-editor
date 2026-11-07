// @req NF-001
// 性能・往復の検証用のサンプルデータ生成（決定的。同じ引数なら常に同じ結果）。
// 既定は仕様上限: 500プロジェクト × 50イベント × 8年（約25,000イベント）。
import { addDays, fromDays, toDays } from './date';
import { SCHEMA_VERSION, type Dependency, type EventData, type MilestoneData, type Project, type Schedule } from './model';
import { orderBetween } from './order';

export interface SampleOptions {
  readonly projects?: number;
  readonly eventsPerProject?: number;
  readonly years?: number;
  readonly startYear?: number;
  readonly seed?: number;
}

const TYPES = ['phase', 'review', 'release'] as const;

export function generateSample(opts: SampleOptions = {}): Schedule {
  const n = opts.projects ?? 500;
  const per = opts.eventsPerProject ?? 50;
  const years = opts.years ?? 8;
  const start = `${String(opts.startYear ?? 2026).padStart(4, '0')}-01-01`;
  const spanDays = toDays(addDays(start, years * 365)) - toDays(start);

  let seed = (opts.seed ?? 1) >>> 0 || 1;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; // 線形合同法（決定的）
    return seed / 4294967296;
  };

  const ROOTS = Math.min(20, n);
  const lastOrder = new Map<string | null, string>(); // 兄弟の最後の並び順
  const projects: Record<string, Project> = {};
  const dependencies: Record<string, Dependency> = {};

  for (let i = 0; i < n; i++) {
    const id = `p${String(i).padStart(4, '0')}`;
    const parentIdx = i < ROOTS ? null : Math.floor((i - ROOTS) / 8);
    const parentId = parentIdx === null ? null : `p${String(parentIdx).padStart(4, '0')}`;
    const order = orderBetween(lastOrder.get(parentId) ?? null, null);
    lastOrder.set(parentId, order);

    const events: Record<string, EventData> = {};
    const milestones: Record<string, MilestoneData> = {};
    const evIds: string[] = [];
    for (let k = 0; k < per; k++) {
      const eid = `${id}-e${String(k).padStart(2, '0')}`;
      const s = toDays(start) + Math.floor(rnd() * spanDays);
      const len = 5 + Math.floor(rnd() * 60);
      events[eid] = { name: `イベント${k}`, start: fromDays(s), end: fromDays(s + len), type: TYPES[k % 3] ?? 'phase' };
      evIds.push(eid);
    }
    for (let k = 0; k < Math.min(5, per); k++) {
      const mid = `${id}-m${k}`;
      milestones[mid] = { name: `マイルストーン${k}`, date: fromDays(toDays(start) + Math.floor(rnd() * spanDays)), type: 'review' };
    }
    projects[id] = { id, name: `プロジェクト${i}`, parentId, order, events, milestones };

    // 各プロジェクトに、日付が先行→後続の順になっている依存を数件（循環しない）
    for (let k = 0; k + 1 < Math.min(evIds.length, 8); k += 2) {
      const a = evIds[k]!;
      const b = evIds[k + 1]!;
      const [first, second] = events[a]!.end <= events[b]!.start ? [a, b] : events[b]!.end <= events[a]!.start ? [b, a] : [a, b];
      const did = `${id}-d${k}`;
      dependencies[did] = { id: did, from: { kind: 'event', id: first }, to: { kind: 'event', id: second }, type: 'FS', lagDays: 0 };
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    projects,
    dependencies,
    types: {
      phase: { name: 'フェーズ', color: '#2364aa', eventStyle: 'bar' },
      review: { name: 'レビュー', color: '#2d7d46', milestoneStyle: 'diamond' },
      release: { name: 'リリース', color: '#c0392b', milestoneStyle: 'flag' },
    },
  };
}
