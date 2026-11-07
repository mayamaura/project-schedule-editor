// @req F-201, F-206
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../../src/domain/commands';
import type { Schedule } from '../../../src/domain/model';
import { dragCommand } from '../../../src/domain/timeline/edit';

const sched: Schedule = {
  projects: {
    p1: {
      id: 'p1',
      name: 'P',
      parentId: null,
      order: 'i',
      tags: [],
      events: { e1: { name: 'E', start: '2026-01-30', end: '2026-02-02', type: 'task' } },
      milestones: { m1: { name: 'M', date: '2026-02-28' } },
    },
  },
  dependencies: {},
} as unknown as Schedule;

describe('dragCommand', () => {
  it('本体のドラッグは開始・終了を同じ日数だけ動かす（月跨ぎ）', () => {
    const c = dragCommand(sched, 'e1', 'body', 3)!;
    expect(c).toEqual({ type: 'updateEvent', id: 'e1', patch: { start: '2026-02-02', end: '2026-02-05' } });
  });
  it('開始側のリサイズは終了を超えられない（終了日で止まる）', () => {
    const c = dragCommand(sched, 'e1', 'start', 99)!;
    expect(c).toEqual({ type: 'updateEvent', id: 'e1', patch: { start: '2026-02-02' } });
    expect(applyCommand(sched, c)).toMatchObject({ ok: true });
  });
  it('終了側のリサイズは開始より前にならない', () => {
    const c = dragCommand(sched, 'e1', 'end', -99)!;
    expect(c).toEqual({ type: 'updateEvent', id: 'e1', patch: { end: '2026-01-30' } });
  });
  it('マイルストーンは日付が動く（閏年なし 2 月末 → 3 月）', () => {
    expect(dragCommand(sched, 'm1', 'body', 1)).toEqual({ type: 'updateMilestone', id: 'm1', patch: { date: '2026-03-01' } });
  });
  it('変化なし・存在しない ID は null', () => {
    expect(dragCommand(sched, 'e1', 'body', 0)).toBeNull();
    expect(dragCommand(sched, 'zz', 'body', 1)).toBeNull();
  });
});
