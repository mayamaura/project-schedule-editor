// @req F-211
import { describe, expect, it } from 'vitest';
import { diffSchedule } from '../../src/domain/diff';
import { applyCommand } from '../../src/domain/commands';
import { summarizeChange } from '../../src/domain/summary';
import { basic } from './fixtures';

describe('summarizeChange', () => {
  it('日付変更・追加・削除が日本語になる', () => {
    const s = basic();
    const cmds = [
      { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20', name: '設計改' } },
      { type: 'deleteDependency', id: 'd1' },
      { type: 'addMilestone', projectId: 'A', id: 'mx', milestone: { name: '中間', date: '2026-12-01', type: 'm' } },
      { type: 'updateProject', id: 'A', patch: { assignee: '山田' } },
      { type: 'moveEvent', id: 'e1', projectId: 'A1' },
    ] as const;
    let cur = s;
    for (const c of cmds) {
      const r = applyCommand(cur, c);
      if (!r.ok) throw new Error(r.error.message);
      cur = r.schedule;
    }
    const lines = diffSchedule(s, cur).map(summarizeChange);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('\n')).toMatch(/2026-12-15 → 2026-12-20|2026-11-01〜2026-12-15 → 2026-11-01〜2026-12-20/);
    expect(lines.every((l) => l.length > 0 && !/undefined/.test(l))).toBe(true);
  });
});
