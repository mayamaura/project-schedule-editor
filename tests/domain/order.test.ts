// @req F-205
import { describe, expect, it } from 'vitest';
import { isValidOrder, orderBetween } from '../../src/domain/order';

describe('orderBetween（fractional index）', () => {
  it('両端なしで初期値を返す', () => {
    const o = orderBetween(null, null);
    expect(isValidOrder(o)).toBe(true);
  });

  it('a < 結果 < b を満たす', () => {
    const cases: [string | null, string | null][] = [
      ['i', 'j'],
      ['i', 'ii'],
      ['a', 'b'],
      ['1', '2'],
      ['i', null],
      [null, 'i'],
      [null, '1'],
      ['zz', null],
      ['i', 'iz'],
      ['abc', 'abd'],
    ];
    for (const [a, b] of cases) {
      const r = orderBetween(a, b);
      expect(isValidOrder(r), `${a}/${b} → ${r}`).toBe(true);
      if (a !== null) expect(a < r, `${a} < ${r}`).toBe(true);
      if (b !== null) expect(r < b, `${r} < ${b}`).toBe(true);
    }
  });

  it('同じ位置に200回挿入し続けても順序が保たれる（先頭・末尾・中間）', () => {
    for (const mode of ['head', 'tail', 'middle'] as const) {
      let list: string[] = [orderBetween(null, null)];
      for (let i = 0; i < 200; i++) {
        const idx = mode === 'head' ? 0 : mode === 'tail' ? list.length : Math.floor(list.length / 2);
        const prev = idx === 0 ? null : (list[idx - 1] ?? null);
        const next = idx >= list.length ? null : (list[idx] ?? null);
        const o = orderBetween(prev, next);
        list = [...list.slice(0, idx), o, ...list.slice(idx)];
      }
      const sorted = [...list].sort();
      expect(list, mode).toEqual(sorted);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('ランダムな挿入で常に昇順・一意', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const list: string[] = [];
    for (let i = 0; i < 500; i++) {
      const idx = Math.floor(rnd() * (list.length + 1));
      const o = orderBetween(idx === 0 ? null : (list[idx - 1] ?? null), idx >= list.length ? null : (list[idx] ?? null));
      list.splice(idx, 0, o);
    }
    expect(list).toEqual([...list].sort());
    expect(new Set(list).size).toBe(list.length);
  });

  it('a >= b や不正な値は例外', () => {
    expect(() => orderBetween('b', 'a')).toThrow();
    expect(() => orderBetween('a', 'a')).toThrow();
    expect(() => orderBetween('a0', null)).toThrow(); // 末尾が 0
    expect(() => orderBetween('A', null)).toThrow(); // 大文字
  });
});

describe('isValidOrder', () => {
  it.each([
    ['i', true],
    ['a1', true],
    ['', false],
    ['a0', false],
    ['A', false],
    ['a-', false],
  ])('%s → %s', (s, ok) => {
    expect(isValidOrder(s)).toBe(ok);
  });
});
