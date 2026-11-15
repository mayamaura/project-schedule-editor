// @req F-201
// ドラッグ量（日数）→ コマンド。純関数。バーの移動・端のリサイズ・◆の移動。
// 開始 > 終了になるリサイズは、反対側の日付で止める（拒否せず丸める）。
import { addDays, daysBetween } from '../date';
import type { Command } from '../commands';
import type { Id, Schedule } from '../model';
import { STICKY_MAX_SPAN, stickySpan } from './sticky';

export function dragCommand(s: Schedule, id: Id, part: 'body' | 'start' | 'end', deltaDays: number): Command | null {
  if (!Number.isInteger(deltaDays) || deltaDays === 0) return null;
  for (const p of Object.values(s.projects)) {
    const e = p.events[id];
    if (e) {
      if (part === 'body') return { type: 'updateEvent', id, patch: { start: addDays(e.start, deltaDays), end: addDays(e.end, deltaDays) } };
      if (part === 'start') {
        const d = Math.min(deltaDays, daysBetween(e.start, e.end));
        return d === 0 ? null : { type: 'updateEvent', id, patch: { start: addDays(e.start, d) } };
      }
      const d = Math.max(deltaDays, -daysBetween(e.start, e.end));
      return d === 0 ? null : { type: 'updateEvent', id, patch: { end: addDays(e.end, d) } };
    }
    const m = p.milestones[id];
    if (m) return { type: 'updateMilestone', id, patch: { date: addDays(m.date, deltaDays) } };
    const n = p.stickies?.[id];
    if (n) {
      // 付箋（F-108）: 本体 = 日付、左端 = 日付と幅（右端は動かさない）、右端 = 幅。紐づく付箋は日付を動かせない（対象に追従）
      const span = stickySpan(n);
      if (part === 'end') {
        const w = Math.min(STICKY_MAX_SPAN, Math.max(1, span + deltaDays));
        return w === span ? null : { type: 'updateSticky', id, patch: { span: w } };
      }
      if (n.attachedTo !== undefined) return null;
      if (part === 'body') return { type: 'updateSticky', id, patch: { date: addDays(n.date, deltaDays) } };
      const d = Math.min(deltaDays, span - 1);
      return d === 0 ? null : { type: 'updateSticky', id, patch: { date: addDays(n.date, d), span: span - d } };
    }
  }
  return null;
}
