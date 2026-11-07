// @req NF-001, F-107
import { describe, expect, it } from 'vitest';
import { generateSample } from '../../src/domain/sample';
import { validateSchedule } from '../../src/domain/validate';

const count = (s: ReturnType<typeof generateSample>): { projects: number; events: number; milestones: number; deps: number } => ({
  projects: Object.keys(s.projects).length,
  events: Object.values(s.projects).reduce((n, p) => n + Object.keys(p.events).length, 0),
  milestones: Object.values(s.projects).reduce((n, p) => n + Object.keys(p.milestones).length, 0),
  deps: Object.keys(s.dependencies).length,
});

describe('generateSample（仕様上限のサンプル）', () => {
  it('既定は 500プロジェクト × 50イベント（25,000イベント）', () => {
    expect(count(generateSample())).toMatchObject({ projects: 500, events: 25000, milestones: 2500 });
  });
  it('決定的（同じ引数なら同じ結果、seed が違えば違う結果）', () => {
    expect(generateSample({ projects: 30, seed: 5 })).toEqual(generateSample({ projects: 30, seed: 5 }));
    expect(generateSample({ projects: 30, seed: 5 })).not.toEqual(generateSample({ projects: 30, seed: 6 }));
  });
  it('構造エラーがない（ID一意・循環なし・日付が正しい）。親子は木で、最大8年に収まる', () => {
    const s = generateSample();
    expect(validateSchedule(s).filter((i) => i.severity === 'error')).toEqual([]);
    const dates = Object.values(s.projects).flatMap((p) => Object.values(p.events).flatMap((e) => [e.start, e.end]));
    expect(dates.reduce((a, b) => (a < b ? a : b)) >= '2026-01-01').toBe(true);
    expect(dates.reduce((a, b) => (a > b ? a : b)) < '2034-06-01').toBe(true);
    expect(Object.values(s.projects).filter((p) => p.parentId === null)).toHaveLength(20);
  });
  it('小さな指定・projects が少ない場合も動く', () => {
    expect(count(generateSample({ projects: 3, eventsPerProject: 2, years: 1 }))).toMatchObject({ projects: 3, events: 6 });
    expect(count(generateSample({ projects: 0 })).projects).toBe(0);
  });
});
