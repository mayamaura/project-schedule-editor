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

describe('付箋のドラッグ（F-108）', () => {
  const withNotes = (): Schedule => ({
    ...sched,
    projects: { p1: { ...sched.projects['p1']!, stickies: { n1: { text: 'a', date: '2026-02-10', span: 10 }, n2: { text: 'b', date: '2026-01-30', attachedTo: 'e1' } } } },
  } as unknown as Schedule);
  const after = (cmd: ReturnType<typeof dragCommand>) => {
    if (!cmd) return null;
    const r = applyCommand(withNotes(), cmd);
    if (!r.ok) throw new Error(r.error.message);
    return r.schedule.projects['p1']!.stickies;
  };
  it('本体: 日付が動く。左端: 日付と幅が変わり右端は動かない。右端: 幅だけ変わる', () => {
    expect(after(dragCommand(withNotes(), 'n1', 'body', 3))?.['n1']).toMatchObject({ date: '2026-02-13', span: 10 });
    expect(after(dragCommand(withNotes(), 'n1', 'start', 3))?.['n1']).toMatchObject({ date: '2026-02-13', span: 7 });
    expect(after(dragCommand(withNotes(), 'n1', 'end', 5))?.['n1']).toMatchObject({ date: '2026-02-10', span: 15 });
  });
  it('幅は 1 日未満にならない（左端を右へ、右端を左へ行き過ぎても止まる）', () => {
    expect(after(dragCommand(withNotes(), 'n1', 'start', 99))?.['n1']).toMatchObject({ date: '2026-02-19', span: 1 });
    expect(after(dragCommand(withNotes(), 'n1', 'end', -99))?.['n1']).toMatchObject({ date: '2026-02-10', span: 1 });
  });
  it('紐づく付箋は日付を動かせない（本体・左端は無効）。右端で幅は変えられる', () => {
    expect(dragCommand(withNotes(), 'n2', 'body', 3)).toBeNull();
    expect(dragCommand(withNotes(), 'n2', 'start', 3)).toBeNull();
    expect(after(dragCommand(withNotes(), 'n2', 'end', 4))?.['n2']).toMatchObject({ date: '2026-01-30', span: 18 });
  });
});
