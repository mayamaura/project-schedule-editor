// @req F-206, F-208, F-301, F-205, F-201, F-202, F-204
import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type CommandErrorCode } from '../../src/domain/commands';
import type { Schedule } from '../../src/domain/model';
import { validateSchedule } from '../../src/domain/validate';
import { basic, deepFreeze, dep, ev, ms, proj, schedule } from './fixtures';

const base = (): Schedule => deepFreeze(basic());
const run = (s: Schedule, c: Command): Schedule => {
  const r = applyCommand(s, c);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expect(validateSchedule(r.schedule).filter((i) => i.severity === 'error')).toEqual([]); // 成功した操作は構造を壊さない
  return r.schedule;
};
const code = (s: Schedule, c: Command): CommandErrorCode => {
  const r = applyCommand(s, c);
  if (r.ok) throw new Error('失敗するはずが成功した');
  return r.error.code;
};

describe('プロジェクト', () => {
  it('追加（子プロジェクト）', () => {
    const s = run(base(), { type: 'addProject', project: proj('B', { name: '新製品B', parentId: 'A', order: 'j' }) });
    expect(s.projects['B']?.parentId).toBe('A');
  });
  it('追加できない: ID重複 / 親が無い / 不正な名称 / イベントのID重複', () => {
    expect(code(base(), { type: 'addProject', project: proj('A') })).toBe('duplicate-id');
    expect(code(base(), { type: 'addProject', project: proj('e1') })).toBe('duplicate-id'); // 他の種類の ID と衝突
    expect(code(base(), { type: 'addProject', project: proj('B', { parentId: 'none' }) })).toBe('not-found');
    expect(code(base(), { type: 'addProject', project: proj('B', { name: '' }) })).toBe('invalid-value');
    expect(code(base(), { type: 'addProject', project: proj('B', { events: { e1: ev('x', '2026-01-01', '2026-01-02') } }) })).toBe('duplicate-id');
    expect(code(base(), { type: 'addProject', project: proj('B', { events: { z: ev('x', '2026-01-02', '2026-01-01') } }) })).toBe('end-before-start');
    expect(code(base(), { type: 'addProject', project: proj('B', { events: { z: ev('x', '2026-01-01', '2026-01-02') }, milestones: { z: ms('y', '2026-01-01') } }) })).toBe('duplicate-id');
  });
  it('属性の更新と、undefined による項目の削除', () => {
    let s = run(base(), { type: 'updateProject', id: 'A', patch: { name: '新製品A改', assignee: '山田', status: 'inProgress' } });
    expect(s.projects['A']).toMatchObject({ name: '新製品A改', assignee: '山田', status: 'inProgress' });
    s = run(s, { type: 'updateProject', id: 'A', patch: { assignee: undefined } });
    expect('assignee' in (s.projects['A'] ?? {})).toBe(false);
    expect(code(base(), { type: 'updateProject', id: 'A', patch: { name: '' } })).toBe('invalid-value');
    expect(code(base(), { type: 'updateProject', id: 'none', patch: { name: 'x' } })).toBe('not-found');
  });
  it('移動（親と並び順）。自分・子孫を親にはできない（F-301）', () => {
    let s = run(base(), { type: 'addProject', project: proj('B', { order: 'j' }) });
    s = run(s, { type: 'moveProject', id: 'A1', parentId: 'B', order: 'k' });
    expect(s.projects['A1']).toMatchObject({ parentId: 'B', order: 'k' });
    s = run(s, { type: 'moveProject', id: 'A1', parentId: null, order: 'k' }); // ルートへ
    expect(s.projects['A1']?.parentId).toBeNull();
    expect(code(base(), { type: 'moveProject', id: 'A', parentId: 'A', order: 'i' })).toBe('parent-cycle');
    expect(code(base(), { type: 'moveProject', id: 'A', parentId: 'A1', order: 'i' })).toBe('parent-cycle'); // 子を親にする
    expect(code(base(), { type: 'moveProject', id: 'A', parentId: 'none', order: 'i' })).toBe('not-found');
    expect(code(base(), { type: 'moveProject', id: 'A1', parentId: 'A', order: 'A!' })).toBe('invalid-value');
    expect(code(base(), { type: 'moveProject', id: 'none', parentId: null, order: 'i' })).toBe('not-found');
  });
  it('深い階層（50段）でも循環判定が動く', () => {
    let s: Schedule = schedule([proj('n0')]);
    for (let i = 1; i < 50; i++) s = run(s, { type: 'addProject', project: proj(`n${i}`, { parentId: `n${i - 1}` }) });
    expect(code(s, { type: 'moveProject', id: 'n0', parentId: 'n49', order: 'i' })).toBe('parent-cycle');
  });
  it('削除は子孫・その項目・それらを端点とする依存を連鎖して削除し、他は残す', () => {
    const s0 = run(base(), { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['event', 'e3']) }); // A → A1 への依存
    const s = run(s0, { type: 'deleteProject', id: 'A1' });
    expect(Object.keys(s.projects)).toEqual(['A']);
    expect(Object.keys(s.dependencies)).toEqual(['d1']); // d2（e3 を参照）は消え、d1 は残る
    const all = run(s0, { type: 'deleteProject', id: 'A' });
    expect(all.projects).toEqual({});
    expect(all.dependencies).toEqual({});
    expect(code(base(), { type: 'deleteProject', id: 'none' })).toBe('not-found');
  });
});

describe('イベント', () => {
  it('追加・更新・削除（F-201, F-202, F-204）', () => {
    let s = run(base(), { type: 'addEvent', projectId: 'A1', id: 'e9', event: ev('検証', '2027-03-01', '2027-03-31') });
    expect(s.projects['A1']?.events['e9']?.name).toBe('検証');
    s = run(s, { type: 'updateEvent', id: 'e9', patch: { start: '2027-03-05', note: 'メモ' } });
    expect(s.projects['A1']?.events['e9']).toMatchObject({ start: '2027-03-05', end: '2027-03-31', note: 'メモ' });
    s = run(s, { type: 'deleteEvent', id: 'e9' });
    expect(s.projects['A1']?.events['e9']).toBeUndefined();
  });
  it('開始と終了が同じ日は可（終了日を含む）。終了＜開始は拒否', () => {
    expect(run(base(), { type: 'updateEvent', id: 'e1', patch: { start: '2026-12-15' } }).projects['A']?.events['e1']?.start).toBe('2026-12-15');
    expect(code(base(), { type: 'updateEvent', id: 'e1', patch: { start: '2026-12-16' } })).toBe('end-before-start');
    expect(code(base(), { type: 'updateEvent', id: 'e1', patch: { end: '2026-10-31' } })).toBe('end-before-start');
    expect(code(base(), { type: 'addEvent', projectId: 'A', id: 'x', event: ev('n', '2026-02-01', '2026-01-01') })).toBe('end-before-start');
  });
  it('拒否: 不正な日付・不正なID・ID重複・存在しない対象・未知のキー', () => {
    expect(code(base(), { type: 'addEvent', projectId: 'A', id: 'x', event: ev('n', '2026-02-30', '2026-03-01') })).toBe('invalid-value');
    expect(code(base(), { type: 'addEvent', projectId: 'A', id: 'bad id!', event: ev('n', '2026-01-01', '2026-01-02') })).toBe('invalid-value');
    expect(code(base(), { type: 'addEvent', projectId: 'A', id: 'm1', event: ev('n', '2026-01-01', '2026-01-02') })).toBe('duplicate-id');
    expect(code(base(), { type: 'addEvent', projectId: 'none', id: 'x', event: ev('n', '2026-01-01', '2026-01-02') })).toBe('not-found');
    expect(code(base(), { type: 'updateEvent', id: 'none', patch: {} })).toBe('not-found');
    expect(code(base(), { type: 'updateEvent', id: 'm1', patch: { name: 'x' } })).toBe('not-found'); // マイルストーンはイベントではない
    expect(code(base(), { type: 'updateEvent', id: 'e1', patch: { bogus: 1 } as never })).toBe('invalid-value');
  });
  it('別プロジェクトへの移動（詳細パネルから）。同じプロジェクトなら何もしない', () => {
    const s = run(base(), { type: 'moveEvent', id: 'e1', projectId: 'A1' });
    expect(s.projects['A']?.events['e1']).toBeUndefined();
    expect(s.projects['A1']?.events['e1']?.name).toBe('設計');
    expect(Object.keys(s.dependencies)).toEqual(['d1']); // 依存は端点の ID で結ばれているので維持される
    const b = base();
    const r = applyCommand(b, { type: 'moveEvent', id: 'e1', projectId: 'A' });
    expect(r.ok && r.schedule === b).toBe(true);
    expect(code(base(), { type: 'moveEvent', id: 'e1', projectId: 'none' })).toBe('not-found');
    expect(code(base(), { type: 'moveEvent', id: 'none', projectId: 'A' })).toBe('not-found');
  });
  it('削除すると、そのイベントを端点とする依存も消える', () => {
    expect(run(base(), { type: 'deleteEvent', id: 'e1' }).dependencies).toEqual({});
    expect(code(base(), { type: 'deleteEvent', id: 'm1' })).toBe('not-found');
  });
});

describe('マイルストーン', () => {
  it('追加・更新・移動・削除', () => {
    let s = run(base(), { type: 'addMilestone', projectId: 'A', id: 'm9', milestone: ms('試作完了', '2027-03-31') });
    s = run(s, { type: 'updateMilestone', id: 'm9', patch: { date: '2027-04-10', style: 'flag' } });
    expect(s.projects['A']?.milestones['m9']).toMatchObject({ date: '2027-04-10', style: 'flag' });
    s = run(s, { type: 'moveMilestone', id: 'm9', projectId: 'A1' });
    expect(s.projects['A1']?.milestones['m9']).toBeDefined();
    const same = applyCommand(s, { type: 'moveMilestone', id: 'm9', projectId: 'A1' });
    expect(same.ok && same.schedule === s).toBe(true);
    s = run(s, { type: 'deleteMilestone', id: 'm9' });
    expect(s.projects['A1']?.milestones['m9']).toBeUndefined();
  });
  it('削除すると、そのマイルストーンを端点とする依存も消える', () => {
    const s = run(base(), { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['milestone', 'm1']) });
    expect(Object.keys(run(s, { type: 'deleteMilestone', id: 'm1' }).dependencies)).toEqual(['d1']);
  });
  it('拒否: 不正な日付・ID重複・存在しない対象', () => {
    expect(code(base(), { type: 'addMilestone', projectId: 'A', id: 'x', milestone: ms('n', '2026-13-01') })).toBe('invalid-value');
    expect(code(base(), { type: 'addMilestone', projectId: 'A', id: 'bad id', milestone: ms('n', '2026-01-01') })).toBe('invalid-value');
    expect(code(base(), { type: 'addMilestone', projectId: 'A', id: 'e1', milestone: ms('n', '2026-01-01') })).toBe('duplicate-id');
    expect(code(base(), { type: 'addMilestone', projectId: 'none', id: 'x', milestone: ms('n', '2026-01-01') })).toBe('not-found');
    expect(code(base(), { type: 'updateMilestone', id: 'e1', patch: { name: 'x' } })).toBe('not-found');
    expect(code(base(), { type: 'updateMilestone', id: 'm1', patch: { date: 'xx' } })).toBe('invalid-value');
    expect(code(base(), { type: 'moveMilestone', id: 'm1', projectId: 'none' })).toBe('not-found');
    expect(code(base(), { type: 'moveMilestone', id: 'e1', projectId: 'A1' })).toBe('not-found');
    expect(code(base(), { type: 'deleteMilestone', id: 'e1' })).toBe('not-found');
  });
});

describe('依存', () => {
  it('追加・更新・削除。依存違反になっても拒否しない（警告のみ。A2）', () => {
    let s = run(base(), { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['milestone', 'm1'], { type: 'FS', lagDays: 1 }) });
    s = run(s, { type: 'updateDependency', id: 'd2', patch: { type: 'SS', lagDays: -3 } });
    expect(s.dependencies['d2']).toMatchObject({ type: 'SS', lagDays: -3 });
    // 後続を先行より前に動かす（違反）→ 拒否されず、警告になる
    const moved = applyCommand(s, { type: 'updateEvent', id: 'e2', patch: { start: '2026-11-02' } });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(validateSchedule(moved.schedule).some((i) => i.rule === 'dependency-violation')).toBe(true);
    s = run(s, { type: 'deleteDependency', id: 'd2' });
    expect(s.dependencies['d2']).toBeUndefined();
  });
  it('拒否: 自己依存・重複・循環（2者・3者）・存在しない端点・種類違い・ID重複', () => {
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['event', 'e1'], ['event', 'e1']) })).toBe('self-dependency');
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['event', 'e1'], ['event', 'e2'], { type: 'SS' }) })).toBe('duplicate-dependency');
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['event', 'e2'], ['event', 'e1']) })).toBe('dependency-cycle');
    const chain = run(base(), { type: 'addDependency', dependency: dep('d2', ['event', 'e2'], ['milestone', 'm1']) });
    expect(code(chain, { type: 'addDependency', dependency: dep('x', ['milestone', 'm1'], ['event', 'e1']) })).toBe('dependency-cycle');
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['event', 'e1'], ['event', 'none']) })).toBe('not-found');
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['milestone', 'e1'], ['event', 'e2']) })).toBe('not-found');
    expect(code(base(), { type: 'addDependency', dependency: dep('d1', ['event', 'e1'], ['event', 'e3']) })).toBe('duplicate-id');
    expect(code(base(), { type: 'addDependency', dependency: dep('x', ['event', 'e1'], ['event', 'e3'], { lagDays: 1.5 }) })).toBe('invalid-value');
    expect(code(base(), { type: 'updateDependency', id: 'd1', patch: { to: { kind: 'event', id: 'e1' } } })).toBe('self-dependency');
    expect(code(base(), { type: 'updateDependency', id: 'none', patch: {} })).toBe('not-found');
    expect(code(base(), { type: 'deleteDependency', id: 'none' })).toBe('not-found');
  });
  it('自分自身を更新しても重複・循環と誤判定しない', () => {
    expect(run(base(), { type: 'updateDependency', id: 'd1', patch: { lagDays: 5 } }).dependencies['d1']?.lagDays).toBe(5);
  });
});

describe('batch（1つの操作として適用）', () => {
  it('全て成功すれば適用され、途中で失敗すれば何も適用されない（失敗位置を返す）', () => {
    const s = base();
    const done = run(s, {
      type: 'batch',
      commands: [
        { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('a', '2027-01-01', '2027-01-02') },
        { type: 'addEvent', projectId: 'A', id: 'n2', event: ev('b', '2027-01-03', '2027-01-04') },
      ],
    });
    expect(Object.keys(done.projects['A']?.events ?? {})).toEqual(['e1', 'e2', 'n1', 'n2']);
    const r = applyCommand(s, {
      type: 'batch',
      commands: [
        { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('a', '2027-01-01', '2027-01-02') },
        { type: 'deleteEvent', id: 'zzz' },
      ],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'not-found', index: 1 } });
    expect(s.projects['A']?.events['n1']).toBeUndefined();
  });
  it('batch 内の後続コマンドは前のコマンドの結果を参照できる', () => {
    const s = run(base(), {
      type: 'batch',
      commands: [
        { type: 'addEvent', projectId: 'A', id: 'n1', event: ev('a', '2027-05-01', '2027-05-02') },
        { type: 'addDependency', dependency: dep('d9', ['event', 'e2'], ['event', 'n1']) },
      ],
    });
    expect(s.dependencies['d9']).toBeDefined();
  });
  it('入れ子の batch の失敗位置は最も内側の位置になる / 空は拒否', () => {
    const r = applyCommand(base(), { type: 'batch', commands: [{ type: 'batch', commands: [{ type: 'deleteEvent', id: 'zzz' }] }] });
    expect(r).toMatchObject({ ok: false, error: { index: 0 } });
    expect(code(base(), { type: 'batch', commands: [] })).toBe('invalid-command');
  });
});

describe('入力を書き換えない・構造共有', () => {
  it('凍結したデータに全種類のコマンドを適用しても例外にならない（= 書き換えていない）', () => {
    let s = base();
    const cmds: Command[] = [
      { type: 'addProject', project: proj('B', { order: 'j' }) },
      { type: 'updateProject', id: 'B', patch: { note: 'x' } },
      { type: 'moveProject', id: 'B', parentId: 'A', order: 'k' },
      { type: 'addEvent', projectId: 'B', id: 'x1', event: ev('a', '2027-01-01', '2027-01-05') },
      { type: 'addMilestone', projectId: 'B', id: 'x2', milestone: ms('b', '2027-01-06') },
      { type: 'addDependency', dependency: dep('dx', ['event', 'x1'], ['milestone', 'x2']) },
      { type: 'updateEvent', id: 'x1', patch: { name: 'c' } },
      { type: 'updateMilestone', id: 'x2', patch: { name: 'd' } },
      { type: 'updateDependency', id: 'dx', patch: { lagDays: 1 } },
      { type: 'moveEvent', id: 'x1', projectId: 'A' },
      { type: 'moveMilestone', id: 'x2', projectId: 'A' },
      { type: 'deleteDependency', id: 'dx' },
      { type: 'deleteEvent', id: 'x1' },
      { type: 'deleteMilestone', id: 'x2' },
      { type: 'deleteProject', id: 'B' },
    ];
    for (const c of cmds) {
      const r = applyCommand(s, c);
      expect(r.ok, JSON.stringify(c)).toBe(true);
      if (r.ok) s = deepFreeze(r.schedule);
    }
  });
  it('変更していないプロジェクトは同じ参照のまま（構造共有）', () => {
    const s = base();
    const t = run(s, { type: 'updateEvent', id: 'e3', patch: { name: '金型2' } });
    expect(t.projects['A']).toBe(s.projects['A']);
    expect(t.projects['A1']).not.toBe(s.projects['A1']);
    expect(t.dependencies).toBe(s.dependencies);
  });
});
