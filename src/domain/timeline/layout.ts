// @req F-101, F-103, F-105, F-401, F-107
// レイアウト: プロジェクトツリーを表示行に平坦化し、行内のイベント・マイルストーンをサブレーンに並べる。
// docs/architecture.html 12.4。DOM 非依存の純関数。
import { isDateStr, toDays } from '../date';
import type { Id, Project, Schedule } from '../model';

export interface LayoutOptions {
  /** 折りたたんだプロジェクト（その子孫は出さない）。未指定 = 全て展開。 */
  readonly collapsed?: ReadonlySet<Id>;
  /** 表示するプロジェクト（F-401）。未指定 = 全て。外した行は出ないが、その子は個別の選択に従って出る。 */
  readonly visible?: ReadonlySet<Id>;
  readonly laneHeight?: number;
  readonly rowPad?: number;
  readonly minRowHeight?: number;
}

export const DEFAULT_LANE_HEIGHT = 22;
export const DEFAULT_ROW_PAD = 5;
export const DEFAULT_MIN_ROW_HEIGHT = 32;

export interface LaneInfo {
  readonly laneOf: ReadonlyMap<Id, number>;
  readonly lanes: number;
}

export interface ItemDays {
  /** 開始日・終了日の通算日数（マイルストーンは両方とも日付）。 */
  readonly s: number;
  readonly e: number;
}

const daysCache = new WeakMap<Project, ReadonlyMap<Id, ItemDays | null>>();

/**
 * プロジェクト内の項目の日付（通算日数）。不正な日付の項目は null。プロジェクトの参照でキャッシュするので、
 * 描画のたびに日付文字列をパースしない（編集していないプロジェクトは再計算しない）。
 */
export function itemDays(p: Project): ReadonlyMap<Id, ItemDays | null> {
  const cached = daysCache.get(p);
  if (cached) return cached;
  const map = new Map<Id, ItemDays | null>();
  for (const [id, e] of Object.entries(p.events)) map.set(id, isDateStr(e.start) && isDateStr(e.end) ? { s: toDays(e.start), e: toDays(e.end) } : null);
  for (const [id, m] of Object.entries(p.milestones)) map.set(id, isDateStr(m.date) ? { s: toDays(m.date), e: toDays(m.date) } : null);
  daysCache.set(p, map);
  return map;
}

const laneCache = new WeakMap<Project, LaneInfo>();

/**
 * サブレーンの割り当て。日付だけで決める貪欲法（開始日順に、空いている最初のレーンへ）なので、
 * ズームに依存せず、拡縮してもバーが上下に飛ばない。終了日を含むため「前の終了日 < 次の開始日」で同じレーンに置ける。
 * マイルストーンは1日分。不正な日付の項目はレーン 0（検証が別に指摘する）。結果はプロジェクトの参照でキャッシュする。
 */
export function assignLanes(p: Project): LaneInfo {
  const cached = laneCache.get(p);
  if (cached) return cached;
  const items: { id: Id; start: number; end: number }[] = [];
  const laneOf = new Map<Id, number>();
  for (const [id, d] of itemDays(p)) {
    if (d) items.push({ id, start: d.s, end: d.e });
    else laneOf.set(id, 0);
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lastEnd: number[] = [];
  for (const it of items) {
    let lane = lastEnd.findIndex((e) => e < it.start);
    if (lane < 0) lane = lastEnd.length;
    lastEnd[lane] = it.end;
    laneOf.set(it.id, lane);
  }
  const info: LaneInfo = { laneOf, lanes: Math.max(1, lastEnd.length) };
  laneCache.set(p, info);
  return info;
}

export interface RowInfo {
  readonly projectId: Id;
  readonly name: string;
  readonly depth: number;
  readonly y: number;
  readonly height: number;
  readonly lanes: number;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
}

export interface Layout {
  readonly rows: readonly RowInfo[];
  readonly totalHeight: number;
  readonly rowOfProject: ReadonlyMap<Id, number>;
  /** イベント・マイルストーン ID → 行とレーン（依存線の端点の位置に使う）。 */
  readonly itemPos: ReadonlyMap<Id, { readonly row: number; readonly lane: number }>;
  readonly laneHeight: number;
  readonly rowPad: number;
}

const byOrderThenId = (a: Project, b: Project): number => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildLayout(s: Schedule, o: LayoutOptions = {}): Layout {
  const laneHeight = o.laneHeight ?? DEFAULT_LANE_HEIGHT;
  const rowPad = o.rowPad ?? DEFAULT_ROW_PAD;
  const minRowHeight = o.minRowHeight ?? DEFAULT_MIN_ROW_HEIGHT;
  const all = Object.values(s.projects);

  const children = new Map<Id | null, Project[]>();
  for (const p of all) {
    const key = p.parentId !== null && s.projects[p.parentId] ? p.parentId : null; // 親が無ければ根として扱う
    const list = children.get(key);
    if (list) list.push(p);
    else children.set(key, [p]);
  }
  for (const list of children.values()) list.sort(byOrderThenId);

  const rows: RowInfo[] = [];
  const rowOfProject = new Map<Id, number>();
  const itemPos = new Map<Id, { row: number; lane: number }>();
  const seen = new Set<Id>();
  let y = 0;

  const emit = (p: Project, depth: number): void => {
    const kids = children.get(p.id) ?? [];
    const collapsed = o.collapsed?.has(p.id) ?? false;
    if (!o.visible || o.visible.has(p.id)) {
      const info = assignLanes(p);
      const height = Math.max(minRowHeight, rowPad * 2 + info.lanes * laneHeight);
      const row = rows.length;
      rows.push({ projectId: p.id, name: p.name, depth, y, height, lanes: info.lanes, hasChildren: kids.length > 0, collapsed });
      rowOfProject.set(p.id, row);
      for (const [id, lane] of info.laneOf) itemPos.set(id, { row, lane });
      y += height;
    }
    if (collapsed) for (const k of kids) markSubtreeSeen(k);
    else for (const k of kids) walk(k, depth + 1);
  };
  // 折りたたんだ親の子孫は「出さない」だけで、根として復活させない（下の後処理の対象にしない）
  const markSubtreeSeen = (p: Project): void => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    for (const k of children.get(p.id) ?? []) markSubtreeSeen(k);
  };
  // 反復ではなく再帰だが、深さは階層の深さ（実用上 10 程度）で、スタックを使い切る心配はない
  const walk = (p: Project, depth: number): void => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    emit(p, depth);
  };

  for (const r of children.get(null) ?? []) walk(r, 0);
  // 親子が循環しているなど、根から辿れないプロジェクトも消さずに根として出す
  for (const p of [...all].sort(byOrderThenId)) if (!seen.has(p.id)) walk(p, 0);

  return { rows, totalHeight: y, rowOfProject, itemPos, laneHeight, rowPad };
}

/** 表示範囲 [scrollY, scrollY + height) にかかる行の範囲 [first, last)。行は y 昇順なので二分探索。 */
export function visibleRowRange(l: Layout, scrollY: number, height: number): [number, number] {
  const rows = l.rows;
  const lowerBound = (target: number): number => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = rows[mid]!;
      if (r.y + r.height <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const first = lowerBound(scrollY);
  let last = first;
  while (last < rows.length && rows[last]!.y < scrollY + height) last++;
  return [first, last];
}

/** y（スクロール前の座標）にある行。範囲外は -1。 */
export function rowAtY(l: Layout, y: number): number {
  if (y < 0 || y >= l.totalHeight) return -1;
  const [first] = visibleRowRange(l, y, 1);
  return first;
}

/** データ全体の日付範囲（通算日数）。項目が無ければ null。初期表示の範囲合わせに使う。 */
export function spanOf(s: Schedule): { minDay: number; maxDay: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const take = (a: string, b: string): void => {
    if (!isDateStr(a) || !isDateStr(b)) return;
    min = Math.min(min, toDays(a));
    max = Math.max(max, toDays(b));
  };
  for (const p of Object.values(s.projects)) {
    for (const e of Object.values(p.events)) take(e.start, e.end);
    for (const m of Object.values(p.milestones)) take(m.date, m.date);
  }
  return min === Infinity ? null : { minDay: min, maxDay: max };
}
