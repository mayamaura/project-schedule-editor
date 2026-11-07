// @req F-201, F-202, F-209
// ヒットテスト: キャンバス上の座標 → 項目 / つまみ / 空白の行と日付 / ヘッダ。docs/architecture.html 12.5。
// 描画した項目の箱（表示範囲内のみ）を、後ろから（手前に描いたものを優先して）走査する。索引は使わない。
import type { Id } from '../model';
import { xToDay } from './axis';
import type { DrawList, TimelineViewport } from './drawlist';
import { rowAtY, type Layout } from './layout';

/** イベントの両端のつまみの幅（px）。開始日・終了日の変更（Phase 3）に使う。 */
export const EDGE_GRAB_PX = 6;
/** つまみを設けるバーの最小幅（これより狭いと全体を「本体」とする）。 */
export const MIN_BAR_FOR_EDGES = 16;

export type Hit =
  | { readonly kind: 'event' | 'milestone'; readonly id: Id; readonly projectId: Id; readonly part: 'body' | 'start' | 'end' }
  /** 項目の無い場所（作成・右クリックメニューの文脈）。day は通算日数（整数）。 */
  | { readonly kind: 'row'; readonly projectId: Id; readonly day: number }
  | { readonly kind: 'header' }
  | { readonly kind: 'none' };

export function hitTest(dl: DrawList, layout: Layout, vp: TimelineViewport, x: number, y: number): Hit {
  if (y < dl.headerHeight) return { kind: 'header' };
  const by = y - dl.headerHeight;
  for (let i = dl.hitBoxes.length - 1; i >= 0; i--) {
    const b = dl.hitBoxes[i]!;
    if (x < b.x || x > b.x + b.w || by < b.y || by > b.y + b.h) continue;
    let part: 'body' | 'start' | 'end' = 'body';
    if (b.kind === 'event' && b.w >= MIN_BAR_FOR_EDGES) {
      if (x - b.x <= EDGE_GRAB_PX) part = 'start';
      else if (b.x + b.w - x <= EDGE_GRAB_PX) part = 'end';
    }
    return { kind: b.kind, id: b.id, projectId: b.projectId, part };
  }
  const ri = rowAtY(layout, by + vp.scrollY);
  if (ri < 0) return { kind: 'none' };
  return { kind: 'row', projectId: layout.rows[ri]!.projectId, day: Math.floor(xToDay(x, vp)) };
}
