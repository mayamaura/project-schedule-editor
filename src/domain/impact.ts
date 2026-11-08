// @req F-306
// 影響範囲: 選択した項目の上流（先行の連鎖）と下流（後続の連鎖）。依存グラフを推移的にたどる純関数。影響調査に使う。
import type { Id, Schedule } from './model';

export interface Impact {
  /** 先行をたどって行き着く項目（自分は含まない）。 */
  readonly up: ReadonlySet<Id>;
  /** 後続をたどって行き着く項目（自分は含まない）。 */
  readonly down: ReadonlySet<Id>;
}

export function impactOf(s: Schedule, id: Id): Impact {
  const next = new Map<Id, Id[]>(); // 先行 → 後続
  const prev = new Map<Id, Id[]>(); // 後続 → 先行
  for (const d of Object.values(s.dependencies)) {
    next.set(d.from.id, [...(next.get(d.from.id) ?? []), d.to.id]);
    prev.set(d.to.id, [...(prev.get(d.to.id) ?? []), d.from.id]);
  }
  const walk = (graph: Map<Id, Id[]>): Set<Id> => {
    const seen = new Set<Id>();
    const stack = [...(graph.get(id) ?? [])];
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (seen.has(v)) continue;
      seen.add(v);
      stack.push(...(graph.get(v) ?? []));
    }
    return seen;
  };
  const up = walk(prev);
  const down = walk(next);
  // 循環で自分自身に戻る場合も、自分は含めない
  up.delete(id);
  down.delete(id);
  return { up, down };
}
