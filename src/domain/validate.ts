// @req F-208, F-305, F-704
// 整合性チェック（ルールベース。AI 不要）。docs/data-model.html 11, requirements F-208 / F-305 / F-704。
// 依存違反は「警告」のみ（A2: 自動連動しない・編集の自由を優先）。構造が壊れているものは「エラー」。
import { isDateStr, toDays } from './date';
import { buildItemIndex, type Dependency, type Id, type ItemRef, type Schedule } from './model';

export type Severity = 'error' | 'warning';
export type TargetKind = 'project' | 'event' | 'milestone' | 'dependency';

export type Rule =
  | 'date-invalid'
  | 'end-before-start'
  | 'dependency-violation'
  | 'dependency-cycle'
  | 'dangling-reference'
  | 'parent-cycle'
  | 'duplicate-id'
  | 'id-mismatch'
  | 'child-outside-parent'
  | 'duplicate-item';

export interface ValidationIssue {
  readonly rule: Rule;
  readonly severity: Severity;
  readonly target: { readonly kind: TargetKind; readonly id: Id };
  readonly message: string;
}

/**
 * 依存の充足判定（終了日を含む前提）。違反なら不足日数（正の値）、満たしていれば 0 を返す。
 *   FS: 後続.開始 ≥ 先行.終了 + 1 + ラグ / SS: 後続.開始 ≥ 先行.開始 + ラグ
 *   FF: 後続.終了 ≥ 先行.終了 + ラグ     / SF: 後続.終了 ≥ 先行.開始 + ラグ
 */
export function dependencyShortfall(type: Dependency['type'], lagDays: number, from: ItemRef, to: ItemRef): number {
  return shortfallDays(type, lagDays, toDays(from.start), toDays(from.end), toDays(to.start), toDays(to.end));
}

/** dependencyShortfall の通算日数版（描画など、大量に判定する場所で使う。判定式はここだけに持つ）。 */
export function shortfallDays(type: Dependency['type'], lagDays: number, fromStart: number, fromEnd: number, toStart: number, toEnd: number): number {
  const required = type === 'FS' ? fromEnd + 1 + lagDays : type === 'SS' ? fromStart + lagDays : type === 'FF' ? fromEnd + lagDays : fromStart + lagDays;
  const actual = type === 'FS' || type === 'SS' ? toStart : toEnd;
  const diff = required - actual;
  return diff > 0 ? diff : 0;
}

/** 依存グラフで、サイクルに含まれる依存の ID 集合を返す（Tarjan の強連結成分）。 */
export function dependenciesInCycles(deps: readonly Dependency[]): Set<Id> {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const d of deps) {
    nodes.add(d.from.id);
    nodes.add(d.to.id);
    const list = adj.get(d.from.id);
    if (list) list.push(d.to.id);
    else adj.set(d.from.id, [d.to.id]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  const compSize = new Map<number, number>();
  let counter = 0;
  let compId = 0;

  // 再帰を避けた反復版（依存が長く連なっても呼び出しスタックを使い切らない）
  for (const root of [...nodes].sort()) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const nexts = adj.get(top.v) ?? [];
      if (top.i < nexts.length) {
        const w = nexts[top.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
        if (low.get(top.v) === index.get(top.v)) {
          let size = 0;
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, compId);
            size++;
            if (w === top.v) break;
          }
          compSize.set(compId, size);
          compId++;
        }
      }
    }
  }
  const result = new Set<Id>();
  for (const d of deps) {
    const a = comp.get(d.from.id);
    const b = comp.get(d.to.id);
    if (a !== undefined && a === b && (d.from.id === d.to.id || (compSize.get(a) ?? 0) > 1)) result.add(d.id);
  }
  return result;
}

const byRuleThenId = (a: ValidationIssue, b: ValidationIssue): number =>
  a.rule === b.rule ? (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0) : a.rule < b.rule ? -1 : 1;

export function validateSchedule(s: Schedule): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (rule: Rule, severity: Severity, kind: TargetKind, id: Id, message: string): void => {
    issues.push({ rule, severity, target: { kind, id }, message });
  };

  // --- ID（キーと内容の一致、全体で一意）---
  const seen = new Map<Id, TargetKind>();
  const claim = (kind: TargetKind, id: Id): void => {
    const prev = seen.get(id);
    if (prev) add('duplicate-id', 'error', kind, id, `ID「${id}」が重複している（${prev} と ${kind}）`);
    else seen.set(id, kind);
  };
  for (const [key, p] of Object.entries(s.projects)) {
    if (p.id !== key) add('id-mismatch', 'error', 'project', key, `プロジェクトのキー「${key}」と id「${p.id}」が一致しない`);
    claim('project', key);
    for (const id of Object.keys(p.events)) claim('event', id);
    for (const id of Object.keys(p.milestones)) claim('milestone', id);
  }
  for (const [key, d] of Object.entries(s.dependencies)) {
    if (d.id !== key) add('id-mismatch', 'error', 'dependency', key, `依存のキー「${key}」と id「${d.id}」が一致しない`);
    claim('dependency', key);
  }

  // --- 日付 ---
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) {
      const okS = isDateStr(e.start);
      const okE = isDateStr(e.end);
      if (!okS || !okE) add('date-invalid', 'error', 'event', id, `イベント「${e.name}」の日付が不正（${e.start} 〜 ${e.end}）`);
      else if (e.end < e.start) add('end-before-start', 'error', 'event', id, `イベント「${e.name}」の終了日（${e.end}）が開始日（${e.start}）より前`);
    }
    for (const [id, m] of Object.entries(p.milestones)) {
      if (!isDateStr(m.date)) add('date-invalid', 'error', 'milestone', id, `マイルストーン「${m.name}」の日付が不正（${m.date}）`);
    }
  }

  // --- プロジェクトの親子 ---
  for (const p of Object.values(s.projects)) {
    if (p.parentId !== null && !s.projects[p.parentId]) {
      add('dangling-reference', 'error', 'project', p.id, `プロジェクト「${p.name}」の親「${p.parentId}」が存在しない`);
    }
  }
  const inParentCycle = new Set<Id>();
  for (const start of Object.values(s.projects)) {
    const path = new Set<Id>();
    let cur: string | null = start.id;
    while (cur !== null && !path.has(cur)) {
      path.add(cur);
      cur = s.projects[cur]?.parentId ?? null;
    }
    if (cur !== null && cur === start.id) inParentCycle.add(start.id);
  }
  for (const id of inParentCycle) add('parent-cycle', 'error', 'project', id, `プロジェクト「${s.projects[id]?.name ?? id}」の親子関係が循環している`);

  // --- 依存 ---
  const items = buildItemIndex(s);
  const deps = Object.values(s.dependencies);
  const resolvable: Dependency[] = [];
  for (const d of deps) {
    const from = items.get(d.from.id);
    const to = items.get(d.to.id);
    const bad = (ep: Dependency['from'], ref: ItemRef | undefined): boolean => ref === undefined || ref.kind !== ep.kind;
    if (bad(d.from, from) || bad(d.to, to)) {
      add('dangling-reference', 'error', 'dependency', d.id, `依存の端点が存在しない（${d.from.kind}:${d.from.id} → ${d.to.kind}:${d.to.id}）`);
    } else resolvable.push(d);
  }
  const cyc = dependenciesInCycles(resolvable);
  for (const id of cyc) add('dependency-cycle', 'error', 'dependency', id, '依存関係が循環している');
  for (const d of resolvable) {
    if (cyc.has(d.id)) continue;
    const from = items.get(d.from.id)!;
    const to = items.get(d.to.id)!;
    if (!isDateStr(from.start) || !isDateStr(from.end) || !isDateStr(to.start) || !isDateStr(to.end)) continue;
    const short = dependencyShortfall(d.type, d.lagDays, from, to);
    if (short > 0) add('dependency-violation', 'warning', 'dependency', d.id, `依存（${d.type}、ラグ${d.lagDays}日）を満たしていない（${short}日不足）`);
  }

  // --- 子の期間が親の期間を逸脱（警告。親の期間は親自身の項目の範囲）---
  const span = (id: Id): { min: string; max: string } | null => {
    const p = s.projects[id];
    if (!p) return null;
    let min: string | null = null;
    let max: string | null = null;
    const take = (a: string, b: string): void => {
      if (!isDateStr(a) || !isDateStr(b)) return;
      if (min === null || a < min) min = a;
      if (max === null || b > max) max = b;
    };
    for (const e of Object.values(p.events)) take(e.start, e.end);
    for (const m of Object.values(p.milestones)) take(m.date, m.date);
    return min !== null && max !== null ? { min, max } : null;
  };
  for (const p of Object.values(s.projects)) {
    if (p.parentId === null || inParentCycle.has(p.id)) continue;
    const ps = span(p.parentId);
    const cs = span(p.id);
    if (ps && cs && (cs.min < ps.min || cs.max > ps.max)) {
      add('child-outside-parent', 'warning', 'project', p.id, `プロジェクト「${p.name}」（${cs.min}〜${cs.max}）が親の期間（${ps.min}〜${ps.max}）をはみ出している`);
    }
  }

  // --- 同一項目の重複（警告）: 同じプロジェクトで、名称・日付（・種別）が全て同じ項目。後に出てくるほうに付ける ---
  for (const p of Object.values(s.projects)) {
    const seenEv = new Set<string>();
    for (const [id, e] of Object.entries(p.events).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = JSON.stringify([e.name, e.start, e.end, e.type]);
      if (seenEv.has(key)) add('duplicate-item', 'warning', 'event', id, `イベント「${e.name}」（${e.start}〜${e.end}）が同じ内容で重複している`);
      seenEv.add(key);
    }
    const seenMs = new Set<string>();
    for (const [id, m] of Object.entries(p.milestones).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = JSON.stringify([m.name, m.date]);
      if (seenMs.has(key)) add('duplicate-item', 'warning', 'milestone', id, `マイルストーン「${m.name}」（${m.date}）が同じ内容で重複している`);
      seenMs.add(key);
    }
  }

  return issues.sort(byRuleThenId);
}

/** 変更前には無く、変更後に新しく生じた指摘（F-512 / F-518）。同じ規則・同じ対象は「以前からある」とみなす。 */
export function newIssues(before: Schedule, after: Schedule): ValidationIssue[] {
  const known = new Set(validateSchedule(before).map((i) => `${i.rule}:${i.target.id}`));
  return validateSchedule(after).filter((i) => !known.has(`${i.rule}:${i.target.id}`));
}
