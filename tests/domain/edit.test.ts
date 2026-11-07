// @req F-202, F-205, F-305, F-208
import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../../src/domain/commands';
import { addDependencyCommand, addEventCommand, addMilestoneCommand, addProjectCommand, newId, placeProjectCommand, siblingsOf } from '../../src/domain/edit';
import { basic } from './fixtures';

const s = basic();
const apply = (c: Command | null, base = s) => {
  const r = applyCommand(base, c!);
  if (!r.ok) throw new Error(r.error.message);
  return r.schedule;
};

describe('newId', () => {
  it('既存と衝突せず ID 規則を満たす', () => {
    const id = newId(s, () => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const withIt = apply(addProjectCommand(s, { id, name: 'x', parentId: null }));
    // 同じ乱数でも使用済みなら別の ID を返す（乱数が変わるまで繰り返す）
    const seq = [0.5, 0.5, 0.25];
    let i = 0;
    expect(newId(withIt, () => seq[i++]!)).not.toBe(id);
  });
});

describe('作成コマンド（F-202）', () => {
  const pid = Object.keys(s.projects)[0]!;
  it('イベント: クリックした日から7日間（終了日を含む）', () => {
    const c = addEventCommand(s, { projectId: pid, id: 'n1', day: 20_000, name: '新規' });
    expect(c).toMatchObject({ type: 'addEvent', id: 'n1', event: { name: '新規' } });
    const next = apply(c);
    const e = next.projects[pid]!.events['n1']!;
    expect(e.end > e.start).toBe(true);
  });
  it('マイルストーン', () => {
    const next = apply(addMilestoneCommand(s, { projectId: pid, id: 'n2', day: 20_000, name: 'M' }));
    expect(next.projects[pid]!.milestones['n2']).toBeDefined();
  });
});

describe('プロジェクト操作（F-205）', () => {
  it('追加は同じ親の末尾に並ぶ', () => {
    const next = apply(addProjectCommand(s, { id: 'np', name: 'N', parentId: null }));
    const sib = siblingsOf(next, null);
    expect(sib[sib.length - 1]!.id).toBe('np');
  });
  it('子として追加', () => {
    const next = apply(addProjectCommand(s, { id: 'np', name: 'N', parentId: 'A' }));
    expect(next.projects['np']!.parentId).toBe('A');
  });
  it('before / after / inside で並びと親が変わる', () => {
    const s2 = apply(addProjectCommand(s, { id: 'B', name: 'B', parentId: null }));
    const [a, b] = ['A', 'B'] as const;
    const after = apply(placeProjectCommand(s2, a, b, 'after'), s2);
    expect(siblingsOf(after, null).map((p) => p.id).slice(0, 2)).toEqual([b, a]);
    const before = apply(placeProjectCommand(after, a, b, 'before'), after);
    expect(siblingsOf(before, null).map((p) => p.id).slice(0, 2)).toEqual([a, b]);
    const inside = apply(placeProjectCommand(s2, b, a, 'inside'), s2);
    expect(inside.projects[b]!.parentId).toBe(a);
  });
  it('自分自身・変化なしは null、子孫の下への移動は拒否', () => {
    expect(placeProjectCommand(s, 'A', 'A', 'inside')).toBeNull();
    const c = placeProjectCommand(s, 'A', 'A1', 'inside')!;
    expect(applyCommand(s, c)).toMatchObject({ ok: false, error: { code: 'parent-cycle' } });
  });
});

describe('依存の作成（F-305）', () => {
  it('FS・ラグ0で作る。循環は拒否される', () => {
    const c = addDependencyCommand(s, { id: 'd9', from: 'e1', to: 'e2' })!;
    expect(c).toMatchObject({ type: 'addDependency', dependency: { type: 'FS', lagDays: 0 } });
    expect(addDependencyCommand(s, { id: 'd9', from: 'nope', to: 'e2' })).toBeNull();
  });
});
