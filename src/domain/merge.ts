// @req F-506, F-518
// 3 版（共通の祖先 / 自分 / 相手）のフィールド単位マージ。ドメイン層の純関数。docs/data-model.html 11.1 / git-ux 2.3。
// Git の行単位マージは、同じイベントの隣り合うフィールドの編集や、末尾への追加どうしで、意味の上では衝突していなくても
// 競合する。そのため Git の競合マーカーは使わず、項目・フィールド単位で比較して、重ならない変更は自動で取り込み、
// 同じフィールドを別の値にした場合と「片方が削除・片方が編集」だけを競合として返す。
import type { Id, Schedule } from './model';

/** 競合の解決: 自分の値 / 相手の値 / 手入力した値。 */
export type Resolution = 'ours' | 'theirs' | { readonly manual: unknown };

export interface MergeConflict {
  /** 競合の識別子（パスを '/' でつないだもの。例: projects/A/events/e1/end）。 */
  readonly key: string;
  readonly path: readonly string[];
  /** 値（undefined = 存在しない = 削除されている）。 */
  readonly base: unknown;
  readonly ours: unknown;
  readonly theirs: unknown;
}

export interface MergeResult {
  /** マージ結果。未解決の競合は自分の値を使う。 */
  readonly schedule: Schedule;
  readonly conflicts: readonly MergeConflict[];
}

const ABSENT: unique symbol = Symbol('absent');
type V = unknown;

const isObj = (v: V): v is Record<string, V> => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (o: Record<string, V>, k: string): V => (o[k] === undefined ? ABSENT : o[k]);

function eq(a: V, b: V): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!eq(get(a, k), get(b, k))) return false;
    return true;
  }
  return false;
}

/** 中身を分けて比べず、1 つの値として扱うキー（依存の端点・タグ）。 */
const LEAF_KEYS: ReadonlySet<string> = new Set(['from', 'to', 'tags']);

export function mergeSchedules(base: Schedule, ours: Schedule, theirs: Schedule, resolutions: Readonly<Record<string, Resolution>> = {}): MergeResult {
  const conflicts: MergeConflict[] = [];

  const merge = (path: readonly string[], b: V, o: V, t: V): V => {
    if (eq(o, t)) return o;
    if (eq(o, b)) return t;
    if (eq(t, b)) return o;
    // 双方が別々に変えた。オブジェクトならフィールドごとに再帰（追加どうしは、祖先を空として比べる）
    if (!LEAF_KEYS.has(path[path.length - 1] ?? '') && isObj(o) && isObj(t) && (b === ABSENT || isObj(b))) {
      const bo = isObj(b) ? b : {};
      const out: Record<string, V> = {};
      for (const k of [...new Set([...Object.keys(bo), ...Object.keys(o), ...Object.keys(t)])].sort()) {
        const v = merge([...path, k], get(bo, k), get(o, k), get(t, k));
        if (v !== ABSENT) out[k] = v;
      }
      return out;
    }
    const key = path.join('/');
    const un = (v: V): V => (v === ABSENT ? undefined : v);
    const res = resolutions[key];
    if (res === undefined) {
      conflicts.push({ key, path, base: un(b), ours: un(o), theirs: un(t) });
      return o;
    }
    if (res === 'ours') return o;
    if (res === 'theirs') return t;
    return res.manual === undefined ? ABSENT : res.manual;
  };

  const strip = (s: Schedule): Record<string, V> => {
    const c: Record<string, V> = { ...s };
    delete c['schemaVersion'];
    return c;
  };
  const merged = merge([], strip(base), strip(ours), strip(theirs)) as Omit<Schedule, 'schemaVersion'>;
  conflicts.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return { schedule: { schemaVersion: Math.max(ours.schemaVersion, theirs.schemaVersion), ...merged } as Schedule, conflicts };
}

export interface ConflictTarget {
  readonly kind: 'project' | 'event' | 'milestone' | 'dependency' | 'type';
  readonly id: Id;
  readonly projectId?: Id;
  /** 競合したフィールド。項目ごとの削除 / 編集の競合では undefined。 */
  readonly field?: string;
}

/** 競合のパスから、何の・どのフィールドかを求める（画面で名前を引くため）。 */
export function conflictTarget(path: readonly string[]): ConflictTarget {
  const [root, id = '', a, itemId, field] = path;
  if (root === 'projects' && (a === 'events' || a === 'milestones') && itemId !== undefined) {
    return { kind: a === 'events' ? 'event' : 'milestone', id: itemId, projectId: id, ...(field !== undefined ? { field } : {}) };
  }
  if (root === 'projects') return { kind: 'project', id, ...(a !== undefined ? { field: a } : {}) };
  if (root === 'dependencies') return { kind: 'dependency', id, ...(a !== undefined ? { field: a } : {}) };
  return { kind: 'type', id, ...(a !== undefined ? { field: a } : {}) };
}
