// @req F-106
// 種別（イベント・マイルストーンの type）の候補と使用数。種別マスタ（types）と、項目で使われている値の和集合を候補にする。
import type { Schedule } from './model';

/** 種別ごとの使用数（マスタにあるが未使用のものは 0）。マスタ → 未登録の使用中の順。 */
export function typeUsage(s: Schedule): Map<string, number> {
  const m = new Map<string, number>(Object.keys(s.types).map((k) => [k, 0]));
  for (const p of Object.values(s.projects)) {
    for (const x of [...Object.values(p.events), ...Object.values(p.milestones)]) m.set(x.type, (m.get(x.type) ?? 0) + 1);
  }
  return m;
}
