// @req F-506, F-518
import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../../src/domain/commands';
import { conflictTarget, mergeSchedules } from '../../src/domain/merge';
import type { Schedule } from '../../src/domain/model';
import { validateSchedule } from '../../src/domain/validate';
import { basic, ev } from './fixtures';

const apply = (s: Schedule, ...cs: Command[]): Schedule => {
  let cur = s;
  for (const c of cs) {
    const r = applyCommand(cur, c);
    if (!r.ok) throw new Error(r.error.message);
    cur = r.schedule;
  }
  return cur;
};
const base = basic();
const event = (s: Schedule, id: string) => Object.values(s.projects).flatMap((p) => (p.events[id] ? [p.events[id]!] : []))[0]!;

describe('mergeSchedules: 重ならない変更は自動で取り込む', () => {
  it('同じイベントの別フィールド（Git の行単位マージでは競合する場合）', () => {
    const ours = apply(base, { type: 'updateEvent', id: 'e1', patch: { name: '設計（改）' } });
    const theirs = apply(base, { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } });
    const r = mergeSchedules(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(event(r.schedule, 'e1')).toMatchObject({ name: '設計（改）', end: '2026-12-20' });
  });
  it('別々のイベントの追加・別プロジェクトの変更・自分だけの削除が全て残る', () => {
    const ours = apply(base, { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('自分の追加', '2027-05-01', '2027-05-10') }, { type: 'deleteEvent', id: 'e3' });
    const theirs = apply(base, { type: 'addEvent', projectId: 'A', id: 'n2', event: ev('相手の追加', '2027-06-01', '2027-06-10') }, { type: 'updateProject', id: 'A1', patch: { assignee: '山田' } });
    const r = mergeSchedules(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    const s = r.schedule;
    expect(Object.keys(s.projects['A']!.events).sort()).toEqual(['e1', 'e2', 'n1', 'n2']);
    expect(s.projects['A1']!.events['e3']).toBeUndefined();
    expect(s.projects['A1']!.assignee).toBe('山田');
  });
  it('依存の追加と、別の依存の削除', () => {
    const ours = apply(base, { type: 'deleteDependency', id: 'd1' });
    const theirs = apply(base, { type: 'addDependency', dependency: { id: 'd2', from: { kind: 'event', id: 'e2' }, to: { kind: 'milestone', id: 'm1' }, type: 'FS', lagDays: 0 } });
    const r = mergeSchedules(base, ours, theirs);
    expect(Object.keys(r.schedule.dependencies)).toEqual(['d2']);
  });
  it('両方が同じ変更をしていれば競合ではない。変更が無ければ元のまま', () => {
    const same = apply(base, { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } });
    expect(mergeSchedules(base, same, same).conflicts).toEqual([]);
    expect(mergeSchedules(base, base, base).schedule).toEqual(base);
  });
  it('片側だけの変更はそのまま取り込む（merge(base, x, base) = x）', () => {
    const x = apply(base, { type: 'updateEvent', id: 'e2', patch: { start: '2026-12-18' } });
    expect(mergeSchedules(base, x, base).schedule).toEqual(x);
    expect(mergeSchedules(base, base, x).schedule).toEqual(x);
  });
});

describe('mergeSchedules: 競合', () => {
  const ours = apply(base, { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } });
  const theirs = apply(base, { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-25' } });

  it('同じフィールドを別の値にすると競合。未解決の間は自分の値を使う', () => {
    const r = mergeSchedules(base, ours, theirs);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ key: 'projects/A/events/e1/end', base: '2026-12-15', ours: '2026-12-20', theirs: '2026-12-25' });
    expect(conflictTarget(r.conflicts[0]!.path)).toEqual({ kind: 'event', id: 'e1', projectId: 'A', field: 'end' });
    expect(event(r.schedule, 'e1').end).toBe('2026-12-20');
  });
  it('解決（自分 / 相手 / 手入力）を指定すると競合が消えて反映される', () => {
    const key = 'projects/A/events/e1/end';
    expect(event(mergeSchedules(base, ours, theirs, { [key]: 'theirs' }).schedule, 'e1').end).toBe('2026-12-25');
    expect(event(mergeSchedules(base, ours, theirs, { [key]: 'ours' }).schedule, 'e1').end).toBe('2026-12-20');
    const manual = mergeSchedules(base, ours, theirs, { [key]: { manual: '2026-12-22' } });
    expect(manual.conflicts).toEqual([]);
    expect(event(manual.schedule, 'e1').end).toBe('2026-12-22');
  });
  it('片方が削除・片方が編集は競合（削除を選ぶと消える）', () => {
    const del = apply(base, { type: 'deleteEvent', id: 'e2' });
    const edit = apply(base, { type: 'updateEvent', id: 'e2', patch: { name: '試作（改）' } });
    const r = mergeSchedules(base, del, edit);
    expect(r.conflicts.map((c) => c.key)).toEqual(['projects/A/events/e2']);
    expect(r.conflicts[0]).toMatchObject({ ours: undefined });
    expect(mergeSchedules(base, del, edit, { 'projects/A/events/e2': 'theirs' }).schedule.projects['A']!.events['e2']?.name).toBe('試作（改）');
    expect(mergeSchedules(base, del, edit, { 'projects/A/events/e2': 'ours' }).schedule.projects['A']!.events['e2']).toBeUndefined();
  });
  it('削除と無変更は削除が勝つ', () => {
    const del = apply(base, { type: 'deleteEvent', id: 'e2' });
    expect(mergeSchedules(base, del, base).schedule.projects['A']!.events['e2']).toBeUndefined();
    expect(mergeSchedules(base, base, del).schedule.projects['A']!.events['e2']).toBeUndefined();
  });
  it('同じ ID を両方が別の内容で追加したら、違うフィールドだけが競合', () => {
    const a = apply(base, { type: 'addEvent', projectId: 'A', id: 'dup', event: ev('X', '2027-01-01', '2027-01-05') });
    const b = apply(base, { type: 'addEvent', projectId: 'A', id: 'dup', event: ev('X', '2027-01-01', '2027-01-09') });
    const r = mergeSchedules(base, a, b);
    expect(r.conflicts.map((c) => c.key)).toEqual(['projects/A/events/dup/end']);
  });
  it('依存の端点は 1 つの値として扱う（食い違えば競合）', () => {
    const o = apply(base, { type: 'updateDependency', id: 'd1', patch: { to: { kind: 'event', id: 'e3' } } });
    const t = apply(base, { type: 'updateDependency', id: 'd1', patch: { to: { kind: 'milestone', id: 'm1' } } });
    const r = mergeSchedules(base, o, t);
    expect(r.conflicts.map((c) => c.key)).toEqual(['dependencies/d1/to']);
    expect(conflictTarget(r.conflicts[0]!.path)).toMatchObject({ kind: 'dependency', id: 'd1', field: 'to' });
  });
  it('プロジェクトの属性・並び・親の競合', () => {
    const o = apply(base, { type: 'updateProject', id: 'A', patch: { name: '新製品A-1' } });
    const t = apply(base, { type: 'updateProject', id: 'A', patch: { name: '新製品A-2' } });
    expect(mergeSchedules(base, o, t).conflicts.map((c) => c.key)).toEqual(['projects/A/name']);
  });
  it('競合の並びは決まった順（キー昇順）', () => {
    const o = apply(base, { type: 'updateEvent', id: 'e2', patch: { name: 'o' } }, { type: 'updateEvent', id: 'e1', patch: { name: 'o' } });
    const t = apply(base, { type: 'updateEvent', id: 'e2', patch: { name: 't' } }, { type: 'updateEvent', id: 'e1', patch: { name: 't' } });
    expect(mergeSchedules(base, o, t).conflicts.map((c) => c.key)).toEqual(['projects/A/events/e1/name', 'projects/A/events/e2/name']);
  });
});

describe('マージ結果の整合性', () => {
  it('自動マージの結果は検証にかけられる（両方が変えた結果、終了＜開始になるのは検証が拾う）', () => {
    const o = apply(base, { type: 'updateEvent', id: 'e1', patch: { start: '2026-12-10' } });
    const t = apply(base, { type: 'updateEvent', id: 'e1', patch: { end: '2026-11-05' } });
    const r = mergeSchedules(base, o, t);
    expect(r.conflicts).toEqual([]);
    expect(validateSchedule(r.schedule).some((i) => i.rule === 'end-before-start')).toBe(true);
  });
  it('スキーマの版は新しい方', () => {
    expect(mergeSchedules(base, { ...base, schemaVersion: 2 }, base).schedule.schemaVersion).toBe(2);
  });
});
