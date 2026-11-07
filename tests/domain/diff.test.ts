// @req F-509, F-510, F-512
import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../../src/domain/commands';
import { diffSchedule } from '../../src/domain/diff';
import type { Schedule } from '../../src/domain/model';
import { basic, dep, ev, ms, proj } from './fixtures';

const apply = (s: Schedule, ...cmds: Command[]): Schedule => {
  let cur = s;
  for (const c of cmds) {
    const r = applyCommand(cur, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    cur = r.schedule;
  }
  return cur;
};
const kinds = (a: Schedule, b: Schedule): string[] => diffSchedule(a, b).map((c) => c.kind);

describe('diffSchedule', () => {
  it('同じデータなら変更なし', () => {
    expect(diffSchedule(basic(), basic())).toEqual([]);
  });

  it('マイルストーンの日付変更: 変動日数（後ろ倒しが正）', () => {
    const b = apply(basic(), { type: 'updateMilestone', id: 'm1', patch: { date: '2027-04-15' } });
    expect(diffSchedule(basic(), b)).toEqual([
      {
        kind: 'item-dates', itemKind: 'milestone', id: 'm1', projectId: 'A', name: 'リリース',
        from: { start: '2027-04-01', end: '2027-04-01' }, to: { start: '2027-04-15', end: '2027-04-15' }, startShiftDays: 14, endShiftDays: 14,
      },
    ]);
  });

  it('イベントの期間変更: 開始・終了それぞれの変動日数（伸縮・前倒しを区別できる）', () => {
    const b = apply(basic(), { type: 'updateEvent', id: 'e1', patch: { start: '2026-10-25', end: '2026-12-22' } });
    const [c] = diffSchedule(basic(), b);
    expect(c).toMatchObject({ kind: 'item-dates', startShiftDays: -7, endShiftDays: 7 }); // 前に7日伸ばし、後ろに7日伸ばした
  });

  it('改名・属性の変更（日付は変わらない）', () => {
    const b = apply(basic(), { type: 'updateEvent', id: 'e1', patch: { name: '基本設計', color: '#ff0000' } });
    expect(diffSchedule(basic(), b)).toEqual([
      { kind: 'item-attr', itemKind: 'event', id: 'e1', projectId: 'A', name: '基本設計', field: 'color', from: null, to: '#ff0000' },
      { kind: 'item-attr', itemKind: 'event', id: 'e1', projectId: 'A', name: '基本設計', field: 'name', from: '設計', to: '基本設計' },
    ]);
  });

  it('項目の追加・削除（既存のプロジェクト内）', () => {
    const b = apply(basic(), { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('検証', '2027-05-01', '2027-05-31') }, { type: 'deleteMilestone', id: 'm1' });
    expect(diffSchedule(basic(), b)).toEqual([
      { kind: 'item-added', itemKind: 'event', id: 'n1', projectId: 'A', name: '検証', start: '2027-05-01', end: '2027-05-31' },
      { kind: 'item-removed', itemKind: 'milestone', id: 'm1', projectId: 'A', name: 'リリース', start: '2027-04-01', end: '2027-04-01' },
    ]);
  });

  it('プロジェクトの追加・削除は、中の項目を個別に列挙せず件数で表す', () => {
    const added = apply(basic(), { type: 'addProject', project: proj('B', { name: '新B', order: 'j', events: { b1: ev('x', '2027-01-01', '2027-01-02') }, milestones: { b2: ms('y', '2027-01-03') } }) });
    expect(diffSchedule(basic(), added)).toEqual([{ kind: 'project-added', projectId: 'B', name: '新B', eventCount: 1, milestoneCount: 1 }]);
    const removed = apply(basic(), { type: 'deleteProject', id: 'A1' });
    expect(diffSchedule(basic(), removed)).toEqual([
      { kind: 'project-removed', projectId: 'A1', name: '筐体', eventCount: 1, milestoneCount: 0 },
    ]);
  });

  it('プロジェクトの削除で消える依存は、依存の削除として現れる', () => {
    const s0 = apply(basic(), { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['event', 'e3']) });
    const b = apply(s0, { type: 'deleteProject', id: 'A1' });
    expect(kinds(s0, b)).toEqual(['project-removed', 'dependency-removed']);
  });

  it('プロジェクト間の移動を、削除＋追加ではなく「移動」として追跡する（ID で対応付け）', () => {
    const b = apply(basic(), { type: 'moveEvent', id: 'e1', projectId: 'A1' });
    expect(diffSchedule(basic(), b)).toEqual([{ kind: 'item-moved', itemKind: 'event', id: 'e1', name: '設計', fromProjectId: 'A', toProjectId: 'A1' }]);
  });

  it('移動しながら日付も変えた場合は両方を報告する', () => {
    const b = apply(basic(), { type: 'moveEvent', id: 'e1', projectId: 'A1' }, { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } });
    expect(kinds(basic(), b)).toEqual(['item-moved', 'item-dates']);
  });

  it('親の付け替え・並べ替え・属性の変更', () => {
    const b = apply(
      basic(),
      { type: 'moveProject', id: 'A1', parentId: null, order: 'k' },
      { type: 'updateProject', id: 'A', patch: { assignee: '山田', tags: ['重要'], note: 'メモ' } },
    );
    expect(diffSchedule(basic(), b)).toEqual([
      { kind: 'project-moved', projectId: 'A1', name: '筐体', fromParentId: 'A', toParentId: null },
      { kind: 'project-reordered', projectId: 'A1', name: '筐体' },
      { kind: 'project-attr', projectId: 'A', name: '新製品A', field: 'assignee', from: null, to: '山田' },
      { kind: 'project-attr', projectId: 'A', name: '新製品A', field: 'note', from: null, to: 'メモ' },
      { kind: 'project-attr', projectId: 'A', name: '新製品A', field: 'tags', from: null, to: ['重要'] },
    ]);
  });

  it('依存の追加・削除・変更（種類・ラグ・端点）', () => {
    const b = apply(
      basic(),
      { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['milestone', 'm1']) },
      { type: 'updateDependency', id: 'd1', patch: { type: 'SS', lagDays: 3, to: { kind: 'event', id: 'e3' } } },
    );
    const cs = diffSchedule(basic(), b);
    expect(cs.map((c) => c.kind)).toEqual(['dependency-added', 'dependency-changed', 'dependency-changed', 'dependency-changed']);
    expect(cs.slice(1).map((c) => (c.kind === 'dependency-changed' ? [c.field, c.from, c.to] : null))).toEqual([
      ['lagDays', 0, 3],
      ['to', 'event:e2', 'event:e3'],
      ['type', 'FS', 'SS'],
    ]);
    expect(kinds(b, basic())).toContain('dependency-removed');
  });

  it('同じ ID で種類が変わった（イベント→マイルストーン）場合は、削除＋追加として扱う', () => {
    const a = basic();
    const b = apply(a, { type: 'deleteEvent', id: 'e3' }, { type: 'addMilestone', projectId: 'A1', id: 'e3', milestone: ms('金型完了', '2027-02-28') });
    expect(kinds(a, b)).toEqual(['item-added', 'item-removed']);
  });

  it('出力は決定的な順序（プロジェクト→項目→依存、ID 昇順）で、入力の順序に依存しない', () => {
    const b = apply(
      basic(),
      { type: 'updateEvent', id: 'e2', patch: { name: 'Z' } },
      { type: 'updateEvent', id: 'e1', patch: { name: 'Y' } },
      { type: 'updateProject', id: 'A', patch: { note: 'n' } },
    );
    const ids = diffSchedule(basic(), b).map((c) => ('id' in c ? c.id : c.projectId));
    expect(ids).toEqual(['A', 'e1', 'e2']);
  });

  it('逆方向の差分は追加と削除が入れ替わる（対称性）', () => {
    const b = apply(basic(), { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('検証', '2027-05-01', '2027-05-31') });
    expect(kinds(basic(), b)).toEqual(['item-added']);
    expect(kinds(b, basic())).toEqual(['item-removed']);
  });
});
