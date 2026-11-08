// @req F-208, F-305, F-704, F-301
import { describe, expect, it } from 'vitest';
import { dependenciesInCycles, dependencyShortfall, newIssues, validateSchedule, type Rule } from '../../src/domain/validate';
import { basic, dep, ev, ms, proj, schedule } from './fixtures';

const rules = (s: ReturnType<typeof schedule>): Rule[] => validateSchedule(s).map((i) => i.rule);

describe('validateSchedule', () => {
  it('正常なデータは指摘なし', () => {
    expect(validateSchedule(basic())).toEqual([]);
  });

  it('終了日が開始日より前', () => {
    const s = schedule([proj('A', { events: { e1: ev('x', '2026-12-15', '2026-12-01') } })]);
    const [i] = validateSchedule(s);
    expect(i).toMatchObject({ rule: 'end-before-start', severity: 'error', target: { kind: 'event', id: 'e1' } });
  });

  it('開始日と終了日が同じ日は正常（1日のイベント）', () => {
    expect(rules(schedule([proj('A', { events: { e1: ev('x', '2026-12-01', '2026-12-01') } })]))).toEqual([]);
  });

  it('不正な日付', () => {
    const s = schedule([proj('A', { events: { e1: ev('x', '2026-02-30', '2026-03-01') }, milestones: { m1: ms('y', '2026-13-01') } })]);
    expect(rules(s).sort()).toEqual(['date-invalid', 'date-invalid']);
  });

  it('存在しない親', () => {
    expect(rules(schedule([proj('A', { parentId: 'ZZ' })]))).toEqual(['dangling-reference']);
  });

  it('親子の循環（自己参照・2者・3者）', () => {
    expect(rules(schedule([proj('A', { parentId: 'A' })]))).toEqual(['parent-cycle']);
    expect(rules(schedule([proj('A', { parentId: 'B' }), proj('B', { parentId: 'A' })]))).toEqual(['parent-cycle', 'parent-cycle']);
    const three = schedule([proj('A', { parentId: 'C' }), proj('B', { parentId: 'A' }), proj('C', { parentId: 'B' }), proj('D', { parentId: 'A' })]);
    expect(validateSchedule(three).map((i) => i.target.id)).toEqual(['A', 'B', 'C']); // D は循環の外
  });

  it('IDの重複（種類をまたぐ）とキー不一致', () => {
    const dup = schedule([proj('A', { events: { x: ev('e', '2026-01-01', '2026-01-02') } }), proj('B', { milestones: { x: ms('m', '2026-01-01') } })]);
    expect(rules(dup)).toEqual(['duplicate-id']);
    const mismatch = { ...schedule([proj('A')]), projects: { A: proj('B') } };
    expect(rules(mismatch)).toContain('id-mismatch');
  });

  it('依存の端点が存在しない / 種類が違う', () => {
    const s = schedule([proj('A', { events: { e1: ev('x', '2026-01-01', '2026-01-02') } })], [dep('d1', ['event', 'e1'], ['event', 'none']), dep('d2', ['milestone', 'e1'], ['event', 'e1'])]);
    expect(rules(s)).toEqual(['dangling-reference', 'dangling-reference']);
  });

  it('依存の循環（自己・2者・3者）。循環に含まれない依存は対象外', () => {
    const items = { e1: ev('a', '2026-01-01', '2026-01-02'), e2: ev('b', '2026-02-01', '2026-02-02'), e3: ev('c', '2026-03-01', '2026-03-02'), e4: ev('d', '2026-04-01', '2026-04-02') };
    const s = schedule(
      [proj('A', { events: items })],
      [dep('d1', ['event', 'e1'], ['event', 'e2']), dep('d2', ['event', 'e2'], ['event', 'e3']), dep('d3', ['event', 'e3'], ['event', 'e1']), dep('d4', ['event', 'e3'], ['event', 'e4']), dep('d5', ['event', 'e4'], ['event', 'e4'])],
    );
    const cyc = validateSchedule(s).filter((i) => i.rule === 'dependency-cycle').map((i) => i.target.id);
    expect(cyc).toEqual(['d1', 'd2', 'd3', 'd5']); // d4 は循環の外へ出る辺
  });

  it('依存違反は警告（FS: 後続の開始が先行の終了の翌日より前）', () => {
    const s = schedule(
      [proj('A', { events: { e1: ev('設計', '2026-11-01', '2026-12-15'), e2: ev('試作', '2026-12-10', '2027-01-31') } })],
      [dep('d1', ['event', 'e1'], ['event', 'e2'])],
    );
    const [i] = validateSchedule(s);
    expect(i).toMatchObject({ rule: 'dependency-violation', severity: 'warning', target: { id: 'd1' } });
    expect(i?.message).toContain('6日不足'); // 先行の終了 12/15 の翌日 12/16 が必要。実際は 12/10 なので 6日不足
  });

  it('child-outside-parent: 子が親の期間をはみ出すと警告', () => {
    const s = schedule([
      proj('A', { events: { e1: ev('親', '2026-01-01', '2026-06-30') } }),
      proj('B', { parentId: 'A', events: { e2: ev('子', '2026-03-01', '2026-07-15') } }),
      proj('C', { parentId: 'A', events: { e3: ev('子2', '2026-02-01', '2026-05-01') } }),
      proj('D', { parentId: 'A' }), // 項目なし（対象外）
    ]);
    expect(validateSchedule(s).map((i) => [i.rule, i.target.id])).toEqual([['child-outside-parent', 'B']]);
  });

  it('指摘は決定的な順序（rule → id）', () => {
    const s = schedule([proj('B', { parentId: 'X' }), proj('A', { parentId: 'X' })]);
    expect(validateSchedule(s).map((i) => i.target.id)).toEqual(['A', 'B']);
  });
});

describe('dependencyShortfall（終了日を含む前提の判定式）', () => {
  const item = (start: string, end: string) => ({ kind: 'event' as const, id: 'x', projectId: 'p', start, end });
  it.each([
    // [type, lag, from(start,end), to(start,end), 不足日数]
    ['FS', 0, ['2026-12-01', '2026-12-15'], ['2026-12-16', '2026-12-20'], 0],
    ['FS', 0, ['2026-12-01', '2026-12-15'], ['2026-12-15', '2026-12-20'], 1],
    ['FS', 3, ['2026-12-01', '2026-12-15'], ['2026-12-18', '2026-12-25'], 1],
    ['FS', 3, ['2026-12-01', '2026-12-15'], ['2026-12-19', '2026-12-25'], 0],
    ['FS', -2, ['2026-12-01', '2026-12-15'], ['2026-12-14', '2026-12-25'], 0], // 負のラグ（重ねてよい）
    ['SS', 0, ['2026-12-01', '2026-12-15'], ['2026-12-01', '2026-12-05'], 0],
    ['SS', 2, ['2026-12-01', '2026-12-15'], ['2026-12-01', '2026-12-05'], 2],
    ['FF', 0, ['2026-12-01', '2026-12-15'], ['2026-12-10', '2026-12-15'], 0],
    ['FF', 0, ['2026-12-01', '2026-12-15'], ['2026-12-10', '2026-12-14'], 1],
    ['SF', 0, ['2026-12-10', '2026-12-15'], ['2026-12-01', '2026-12-10'], 0],
    ['SF', 5, ['2026-12-10', '2026-12-15'], ['2026-12-01', '2026-12-10'], 5],
  ] as const)('%s lag=%i from=%j to=%j → 不足 %i', (type, lag, f, t, expected) => {
    expect(dependencyShortfall(type, lag, item(f[0], f[1]), item(t[0], t[1]))).toBe(expected);
  });
  it('マイルストーン（開始=終了）: FS で同日は違反（先行の終了日の翌日以降が必要）', () => {
    expect(dependencyShortfall('FS', 0, item('2026-12-15', '2026-12-15'), item('2026-12-15', '2026-12-15'))).toBe(1);
  });
});

describe('dependenciesInCycles（大きなグラフでも動く）', () => {
  it('10,000件の鎖＋末尾から先頭への辺で全体が1つの循環（再帰オーバーフローしない）', () => {
    const deps = Array.from({ length: 10000 }, (_, i) => dep(`d${i}`, ['event', `n${i}`], ['event', `n${(i + 1) % 10000}`]));
    expect(dependenciesInCycles(deps).size).toBe(10000);
  });
  it('鎖だけなら循環なし', () => {
    const deps = Array.from({ length: 10000 }, (_, i) => dep(`d${i}`, ['event', `n${i}`], ['event', `n${i + 1}`]));
    expect(dependenciesInCycles(deps).size).toBe(0);
  });
});

describe('同一項目の重複（F-704）', () => {
  it('同じプロジェクトに、名称・日付・種別が同じイベント / 名称・日付が同じマイルストーンがあれば警告', () => {
    const s = schedule([
      proj('A', {
        events: { e1: ev('設計', '2026-11-01', '2026-11-30'), e2: ev('設計', '2026-11-01', '2026-11-30'), e3: ev('設計', '2026-11-01', '2026-12-01') },
        milestones: { m1: ms('レビュー', '2026-12-01'), m2: ms('レビュー', '2026-12-01'), m3: ms('レビュー', '2026-12-02') },
      }),
    ]);
    const dups = validateSchedule(s).filter((i) => i.rule === 'duplicate-item');
    expect(dups.map((i) => `${i.target.kind}:${i.target.id}`)).toEqual(['event:e2', 'milestone:m2']); // 後のほうに付ける
    expect(dups.every((i) => i.severity === 'warning')).toBe(true);
  });
  it('別のプロジェクトなら重複とみなさない', () => {
    const s = schedule([proj('A', { events: { e1: ev('設計', '2026-11-01', '2026-11-30') } }), proj('B', { events: { e2: ev('設計', '2026-11-01', '2026-11-30') } })]);
    expect(validateSchedule(s).filter((i) => i.rule === 'duplicate-item')).toEqual([]);
  });
});

describe('変更で新たに生じた指摘（F-512）', () => {
  const two = (endB: string) => schedule([proj('A', { events: { a: ev('a', '2026-11-01', '2026-11-10'), b: ev('b', '2026-11-11', endB) } })], [dep('d1', ['event', 'a'], ['event', 'b'])]);
  it('以前から有った指摘は含めず、新しく発生したものだけを返す', () => {
    const ok = two('2026-11-20');
    const moved = schedule([proj('A', { events: { a: ev('a', '2026-11-01', '2026-11-15'), b: ev('b', '2026-11-11', '2026-11-20') } })], [dep('d1', ['event', 'a'], ['event', 'b'])]);
    expect(newIssues(ok, moved).map((i) => i.rule)).toEqual(['dependency-violation']);
    expect(newIssues(moved, moved)).toEqual([]);
    expect(newIssues(moved, ok)).toEqual([]); // 解消されたものは新規ではない
  });
});
