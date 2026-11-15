// @req F-106
import { describe, expect, it } from 'vitest';
import { typeUsage } from '../../src/domain/itemTypes';
import { basic } from './fixtures';

describe('typeUsage', () => {
  it('マスタと使用中の値を合わせ、使用数を数える', () => {
    const s = basic();
    const u = typeUsage({ ...s, types: { unused: { name: 'unused', color: '' } } });
    expect(u.get('unused')).toBe(0);
    const total = [...u.entries()].filter(([k]) => k !== 'unused').reduce((a, [, n]) => a + n, 0);
    const items = Object.values(s.projects).reduce((a, p) => a + Object.keys(p.events).length + Object.keys(p.milestones).length, 0);
    expect(total).toBe(items);
  });
});
