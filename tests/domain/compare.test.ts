// @req F-505, F-510
import { describe, expect, it } from 'vitest';
import { compareSchedules, delayedItems, filterChanges } from '../../src/domain/compare';
import { basic, ev, ms, proj, schedule } from './fixtures';

const before = () =>
  schedule([
    proj('P', {
      name: '新製品A',
      events: { e1: ev('設計', '2026-11-01', '2026-12-15'), e2: ev('試作', '2027-01-05', '2027-03-31'), e3: ev('旧', '2026-11-01', '2026-11-10') },
      milestones: { m1: ms('レビュー', '2026-12-20') },
    }),
    proj('Q', { name: '新製品B', events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
  ]);

describe('版の比較（F-505）', () => {
  it('同じ日程なら変更なし', () => {
    expect(compareSchedules(basic(), basic())).toEqual([]);
  });

  it('動いた項目: 後ろ倒しは正、前倒しは負の日数。開始が動けば開始、終了だけなら終了の差', () => {
    const after = schedule([
      proj('P', {
        name: '新製品A',
        events: { e1: ev('設計', '2026-11-15', '2026-12-29'), e2: ev('試作', '2027-01-05', '2027-03-10'), e3: ev('旧', '2026-11-01', '2026-11-10') },
        milestones: { m1: ms('レビュー', '2026-12-10') },
      }),
      proj('Q', { name: '新製品B', events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
    ]);
    const r = compareSchedules(before(), after);
    const by = (id: string) => r.find((c) => c.id === id)!;
    expect(by('e1')).toMatchObject({ change: 'moved', shiftDays: 14, projectName: '新製品A', old: { start: '2026-11-01', end: '2026-12-15' }, new: { start: '2026-11-15', end: '2026-12-29' } });
    expect(by('e2')).toMatchObject({ change: 'moved', shiftDays: -21 }); // 終了だけが前倒し
    expect(by('m1')).toMatchObject({ kind: 'milestone', change: 'moved', shiftDays: -10 });
    expect(r).toHaveLength(3);
  });

  it('追加・削除・日付以外の編集（名称など）を区別する', () => {
    const after = schedule([
      proj('P', {
        name: '新製品A',
        events: { e1: ev('設計（改）', '2026-11-01', '2026-12-15'), e2: ev('試作', '2027-01-05', '2027-03-31'), e4: ev('新規', '2027-04-01', '2027-04-10') },
        milestones: { m1: ms('レビュー', '2026-12-20') },
      }),
      proj('Q', { name: '新製品B', events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
    ]);
    const r = compareSchedules(before(), after);
    expect(r.map((c) => `${c.id}:${c.change}`).sort()).toEqual(['e1:edited', 'e3:removed', 'e4:added']);
    expect(r.find((c) => c.id === 'e3')).toMatchObject({ name: '旧', old: { start: '2026-11-01' }, shiftDays: 0 });
    expect(r.find((c) => c.id === 'e1')!.shiftDays).toBe(0);
  });

  it('別のプロジェクトへ移っても同じ項目として比べる', () => {
    const after = schedule([
      proj('P', {
        name: '新製品A',
        events: { e2: ev('試作', '2027-01-05', '2027-03-31'), e3: ev('旧', '2026-11-01', '2026-11-10') },
        milestones: { m1: ms('レビュー', '2026-12-20') },
      }),
      proj('Q', { name: '新製品B', events: { f1: ev('調査', '2026-11-01', '2026-11-30'), e1: ev('設計', '2026-11-01', '2026-12-15') } }),
    ]);
    const r = compareSchedules(before(), after);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'e1', change: 'edited', projectId: 'Q', projectName: '新製品B' });
  });
});

describe('後ろ倒しの一覧と絞り込み（F-510）', () => {
  const after = schedule([
    proj('P', {
      name: '新製品A',
      events: { e1: ev('設計', '2026-11-15', '2026-12-29'), e2: ev('試作', '2027-01-20', '2027-04-15'), e3: ev('旧', '2026-11-01', '2026-11-05') },
      milestones: { m1: ms('レビュー', '2026-12-10') },
    }),
    proj('Q', { name: '新製品B', events: { f1: ev('調査', '2026-11-04', '2026-12-04') } }),
  ]);
  const all = compareSchedules(before(), after);

  it('後ろ倒しになった項目だけを、遅れの大きい順に並べる', () => {
    expect(delayedItems(all).map((c) => `${c.id}:${c.shiftDays}`)).toEqual(['e2:15', 'e1:14', 'f1:3']);
  });
  it('プロジェクトで絞り込める', () => {
    expect(filterChanges(all, { projectId: 'Q' }).map((c) => c.id)).toEqual(['f1']);
  });
  it('期間で絞り込める（変更前か変更後の日付が期間に重なる項目）', () => {
    const ids = (from: string, to: string) => filterChanges(all, { from, to }).map((c) => c.id).sort();
    expect(ids('2027-04-01', '2027-04-30')).toEqual(['e2']);
    expect(ids('2026-12-25', '2026-12-31')).toEqual(['e1']); // 変更後の終了 12/29 が重なる
    expect(ids('2030-01-01', '2030-12-31')).toEqual([]);
  });
});
