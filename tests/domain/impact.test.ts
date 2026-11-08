// @req F-306
import { describe, expect, it } from 'vitest';
import { impactOf } from '../../src/domain/impact';
import { toDays } from '../../src/domain/date';
import { buildDrawList, lightTheme, type DrawItem } from '../../src/domain/timeline/drawlist';
import { buildLayout } from '../../src/domain/timeline/layout';
import { dep, ev, ms, proj, schedule } from './fixtures';

// a → b → c、a → d、x（無関係）、e → b（b の別の先行）
const s = () =>
  schedule(
    [proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-05'), b: ev('b', '2026-11-06', '2026-11-10'), c: ev('c', '2026-11-11', '2026-11-15'), d: ev('d', '2026-11-06', '2026-11-08'), e: ev('e', '2026-11-01', '2026-11-04'), x: ev('x', '2026-11-20', '2026-11-25') }, milestones: { m: ms('m', '2026-11-16') } })],
    [dep('d1', ['event', 'a'], ['event', 'b']), dep('d2', ['event', 'b'], ['event', 'c']), dep('d3', ['event', 'a'], ['event', 'd']), dep('d4', ['event', 'e'], ['event', 'b']), dep('d5', ['event', 'c'], ['milestone', 'm'])],
  );

describe('影響範囲（F-306）', () => {
  it('上流（先行の連鎖）と下流（後続の連鎖）を、推移的にたどって返す。自分自身は含まない', () => {
    const r = impactOf(s(), 'b');
    expect([...r.up].sort()).toEqual(['a', 'e']);
    expect([...r.down].sort()).toEqual(['c', 'm']);
  });
  it('起点（先頭）は上流なし、終点は下流なし。無関係な項目は空', () => {
    expect([...impactOf(s(), 'a').up]).toEqual([]);
    expect([...impactOf(s(), 'a').down].sort()).toEqual(['b', 'c', 'd', 'm']);
    expect([...impactOf(s(), 'm').down]).toEqual([]);
    expect(impactOf(s(), 'x')).toEqual({ up: new Set(), down: new Set() });
    expect(impactOf(s(), 'nope')).toEqual({ up: new Set(), down: new Set() });
  });
  it('循環があっても止まる', () => {
    const cyc = schedule([proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-02'), b: ev('b', '2026-11-03', '2026-11-04') } })], [dep('d1', ['event', 'a'], ['event', 'b']), dep('d2', ['event', 'b'], ['event', 'a'])]);
    const r = impactOf(cyc, 'a');
    expect([...r.up]).toEqual(['b']);
    expect([...r.down]).toEqual(['b']);
  });
});

describe('影響範囲の強調表示（DrawList。F-306）', () => {
  const list = (emphasis?: { up: ReadonlySet<string>; down: ReadonlySet<string> }, selection: string[] = ['b']) => {
    const sc = s();
    const layout = buildLayout(sc);
    return buildDrawList(sc, layout, {
      viewport: { leftDay: toDays('2026-10-28'), pxPerDay: 12, width: 800, height: layout.totalHeight, scrollY: 0 },
      headerMode: 'weekMonth',
      selection: new Set(selection),
      ...(emphasis ? { emphasis } : {}),
    });
  };
  const overlay = (dl: ReturnType<typeof list>): DrawItem[] => dl.body.filter((i) => i.t === 'rect' && (i.stroke === lightTheme.impactUp || i.stroke === lightTheme.impactDown));

  it('指定しなければ強調しない', () => {
    expect(overlay(list())).toEqual([]);
  });
  it('上流は上流の色、下流は下流の色で枠を付け、関係のない項目は薄くする', () => {
    const e = impactOf(s(), 'b');
    const dl = list(e);
    const strokes = overlay(dl);
    expect(strokes.filter((i) => i.t === 'rect' && i.stroke === lightTheme.impactUp)).toHaveLength(2); // a, e
    expect(strokes.filter((i) => i.t === 'rect' && i.stroke === lightTheme.impactDown)).toHaveLength(2); // c, m
    const dim = dl.body.filter((i) => i.t === 'rect' && i.fill === lightTheme.bg && i.alpha !== undefined && i.alpha < 1);
    expect(dim.length).toBe(2); // d, x（選択・上流・下流のどれでもない）
  });
  it('依存線は、選択・上流・下流の中でつながるものだけを描く', () => {
    const base = list(undefined).stats.deps;
    expect(base).toBe(5);
    expect(list(impactOf(s(), 'b')).stats.deps).toBe(4); // d3（a → d）は d が範囲外なので描かない
  });
});
