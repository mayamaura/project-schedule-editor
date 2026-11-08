// @req F-801, F-802, F-803, F-804, F-805, F-807, F-808, F-809
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/domain/commands';
import { weekday } from '../../src/domain/date';
import {
  applyOffset,
  duplicateTemplate,
  expandTemplate,
  makeOffset,
  parseTemplate,
  parseTemplates,
  serializeTemplate,
  splitOffset,
  validateTemplate,
  weekendWorkday,
  type Template,
} from '../../src/domain/template';
import { basic, schedule } from './fixtures';

const std = (): Template => ({
  id: 'tpl-release-std',
  name: '標準リリース日程',
  defaultAnchor: 'm-release',
  dayMode: 'calendar',
  adjust: 'none',
  events: {
    t1: { name: '設計', type: 'phase', start: { months: -4 }, end: { months: -2, days: -15 } },
    t2: { name: '試作', type: 'phase', start: { months: -2, days: -10 }, end: { months: -1 } },
    t3: { name: '保守', type: 'phase', start: { months: 1 }, end: { months: 6 } },
  },
  milestones: {
    'm-review': { name: '設計レビュー', type: 'review', date: { months: -2, days: -14 } },
    'm-release': { name: 'リリース', type: 'release', date: {} },
  },
  dependencies: { d1: { from: { kind: 'event', id: 't1' }, to: { kind: 'event', id: 't2' }, type: 'FS', lagDays: 4 } },
});

describe('applyOffset（F-809）', () => {
  const cal = { dayMode: 'calendar', adjust: 'none', isWorkday: weekendWorkday } as const;
  it('ヶ月は暦月で加減算し、存在しない日付は月末に丸める', () => {
    expect(applyOffset('2027-03-31', { months: -1 }, cal)).toBe('2027-02-28');
    expect(applyOffset('2028-03-31', { months: -1 }, cal)).toBe('2028-02-29'); // 閏年
    expect(applyOffset('2026-12-15', { months: 2 }, cal)).toBe('2027-02-15'); // 年またぎ
  });
  it('ヶ月と日は併用でき、ヶ月 → 日の順に適用する', () => {
    expect(applyOffset('2027-03-31', { months: -2, days: -14 }, cal)).toBe('2027-01-17');
    expect(applyOffset('2027-03-31', { months: -1, days: 1 }, cal)).toBe('2027-03-01'); // 2/28 の翌日
  });
  it('空のオフセットは起点そのもの', () => {
    expect(applyOffset('2027-03-31', {}, cal)).toBe('2027-03-31');
  });
  it('稼働日で数えるとき、日の部分は稼働日数（土日を飛ばす）', () => {
    const w = { dayMode: 'working', adjust: 'none', isWorkday: weekendWorkday } as const;
    expect(applyOffset('2027-03-05', { days: 1 }, w)).toBe('2027-03-08'); // 金 +1 稼働日 = 月
    expect(applyOffset('2027-03-08', { days: -1 }, w)).toBe('2027-03-05'); // 月 −1 稼働日 = 金
    expect(applyOffset('2027-03-05', { days: 5 }, w)).toBe('2027-03-12');
  });
  it('非稼働日に当たったら補正（前倒し / 後ろ倒し / そのまま）', () => {
    // 2027-03-06 は土曜
    expect(weekday('2027-03-06')).toBe(6);
    const o = { days: 1 };
    expect(applyOffset('2027-03-05', o, { dayMode: 'calendar', adjust: 'none', isWorkday: weekendWorkday })).toBe('2027-03-06');
    expect(applyOffset('2027-03-05', o, { dayMode: 'calendar', adjust: 'earlier', isWorkday: weekendWorkday })).toBe('2027-03-05');
    expect(applyOffset('2027-03-05', o, { dayMode: 'calendar', adjust: 'later', isWorkday: weekendWorkday })).toBe('2027-03-08');
  });
  it('稼働日が 1 日も無い設定でも止まらない', () => {
    expect(applyOffset('2027-03-05', { days: 3 }, { dayMode: 'working', adjust: 'later', isWorkday: () => false })).toBe('2027-03-05');
  });
});

describe('オフセットの単位変換（F-801）', () => {
  it('週は日（×7）に換算して保存し、前は負にする', () => {
    expect(makeOffset('before', { months: 2, weeks: 2, days: 0 })).toEqual({ months: -2, days: -14 });
    expect(makeOffset('after', { months: 0, weeks: 5, days: 3 })).toEqual({ days: 38 });
    expect(makeOffset('after', { months: 0, weeks: 0, days: 0 })).toEqual({});
  });
  it('画面用に分解し、組み立てると元に戻る', () => {
    for (const o of [{ months: -2, days: -14 }, { days: 38 }, {}, { months: 1 }]) {
      const sp = splitOffset(o);
      expect(makeOffset(sp.dir, sp)).toEqual(o);
    }
    expect(splitOffset({ months: -2, days: -15 })).toEqual({ dir: 'before', months: 2, weeks: 2, days: 1 });
  });
});

describe('展開（F-802, F-803, F-805, F-808）', () => {
  const base = basic();

  it('起点の日付を直接指定して展開できる。依存も新しい ID で複製される', () => {
    const r = expandTemplate(base, std(), { anchor: { kind: 'date', date: '2027-06-30' }, target: { kind: 'newProject', name: '新製品C', parentId: null } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.schedule.projects[r.projectId]!;
    expect(p.name).toBe('新製品C');
    const ev = Object.values(p.events).find((e) => e.name === '設計')!;
    expect(ev).toMatchObject({ start: '2027-02-28', end: '2027-04-15' }); // 6/30 の4ヶ月前 = 2/28（月末丸め）、2ヶ月前=4/30 の15日前
    const rel = Object.values(p.milestones).find((m) => m.name === 'リリース')!;
    expect(rel.date).toBe('2027-06-30');
    // 依存: 設計 → 試作 が新しい ID で、ラグも保つ
    const deps = Object.values(r.schedule.dependencies).filter((d) => !base.dependencies[d.id]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ type: 'FS', lagDays: 4 });
    expect(p.events[deps[0]!.from.id]?.name).toBe('設計');
    expect(p.events[deps[0]!.to.id]?.name).toBe('試作');
    // 標準日程の ID は引き継がれない（独立。F-807）
    expect(Object.keys(p.events)).not.toContain('t1');
    expect(deps[0]!.id).not.toBe('d1');
  });

  it('マイルストーン起点: そのマイルストーンが指定日に一致する', () => {
    const r = expandTemplate(base, std(), { anchor: { kind: 'milestone', milestoneId: 'm-review', date: '2027-03-01' }, target: { kind: 'newProject', name: 'X', parentId: null } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.schedule.projects[r.projectId]!;
    expect(Object.values(p.milestones).find((m) => m.name === '設計レビュー')!.date).toBe('2027-03-01');
    // 起点(0)は設計レビューの 2ヶ月14日 後 → リリースは 2027-03-01 の逆算
    expect(Object.values(p.milestones).find((m) => m.name === 'リリース')!.date).toBe('2027-05-15');
  });

  it('展開は 1 つの batch コマンドで、Undo 1 単位として適用できる', () => {
    const r = expandTemplate(base, std(), { anchor: { kind: 'date', date: '2027-06-30' }, target: { kind: 'newProject', name: 'X', parentId: null } });
    if (!r.ok) throw new Error('x');
    expect(r.command.type).toBe('batch');
    const again = applyCommand(base, r.command);
    expect(again.ok).toBe(true);
  });

  it('既存プロジェクトに展開できる。親や並びは変わらない', () => {
    const pid = Object.keys(base.projects)[0]!;
    const before = base.projects[pid]!;
    const r = expandTemplate(base, std(), { anchor: { kind: 'date', date: '2027-06-30' }, target: { kind: 'existing', projectId: pid } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.schedule.projects[pid]!;
    expect(p.parentId).toBe(before.parentId);
    expect(Object.keys(p.events).length).toBe(Object.keys(before.events).length + 3);
    expect(r.items).toHaveLength(5);
  });

  it('プレビュー用の一覧を返す（日付順）', () => {
    const r = expandTemplate(base, std(), { anchor: { kind: 'date', date: '2027-06-30' }, target: { kind: 'newProject', name: 'X', parentId: null } });
    if (!r.ok) throw new Error('x');
    const starts = r.items.map((i) => i.start);
    expect([...starts].sort()).toEqual(starts);
    expect(r.items.find((i) => i.name === '設計')).toMatchObject({ kind: 'event', start: '2027-02-28' });
  });

  it('補正で終了が開始より前になっても、終了は開始に揃えて適用できる', () => {
    const t: Template = { ...std(), dayMode: 'working', adjust: 'later', events: { a: { name: 'a', type: 'phase', start: { days: 0 }, end: { days: 0 } } }, milestones: {}, dependencies: {} };
    const r = expandTemplate(base, t, { anchor: { kind: 'date', date: '2027-03-06' }, target: { kind: 'newProject', name: 'X', parentId: null } }); // 土曜
    expect(r.ok).toBe(true);
  });

  it('存在しない起点のマイルストーン・プロジェクトは失敗として返す', () => {
    const a = expandTemplate(base, std(), { anchor: { kind: 'milestone', milestoneId: 'nope', date: '2027-03-01' }, target: { kind: 'newProject', name: 'X', parentId: null } });
    expect(a.ok).toBe(false);
    const b = expandTemplate(base, std(), { anchor: { kind: 'date', date: '2027-03-01' }, target: { kind: 'existing', projectId: 'nope' } });
    expect(b.ok).toBe(false);
    const c = expandTemplate(schedule(), std(), { anchor: { kind: 'date', date: '2027-03-01' }, target: { kind: 'newProject', name: '', parentId: null } });
    expect(c.ok).toBe(false);
  });

  it('同じ標準日程を 2 回展開しても ID が衝突しない', () => {
    const o = { anchor: { kind: 'date', date: '2027-06-30' }, target: { kind: 'newProject', name: 'X', parentId: null } } as const;
    const r1 = expandTemplate(base, std(), o);
    if (!r1.ok) throw new Error('x');
    const r2 = expandTemplate(r1.schedule, std(), o);
    expect(r2.ok).toBe(true);
  });
});

describe('検証（F-801）', () => {
  it('正しい標準日程は指摘なし', () => {
    expect(validateTemplate(std())).toEqual([]);
  });
  it('存在しない端点・循環・自己依存・既定の起点が無いものを指摘する', () => {
    const t = std();
    const bad: Template = {
      ...t,
      defaultAnchor: 'zzz',
      dependencies: {
        d1: { from: { kind: 'event', id: 'nope' }, to: { kind: 'event', id: 't2' }, type: 'FS', lagDays: 0 },
        d2: { from: { kind: 'event', id: 't1' }, to: { kind: 'event', id: 't1' }, type: 'FS', lagDays: 0 },
        d3: { from: { kind: 'event', id: 't1' }, to: { kind: 'event', id: 't2' }, type: 'FS', lagDays: 0 },
        d4: { from: { kind: 'event', id: 't2' }, to: { kind: 'event', id: 't1' }, type: 'FS', lagDays: 0 },
      },
    };
    const msgs = validateTemplate(bad).join('\n');
    expect(msgs).toContain('起点');
    expect(msgs).toContain('d1');
    expect(msgs).toContain('d2');
    expect(msgs).toContain('循環');
  });
});

describe('保存形式（F-807）', () => {
  it('整形出力を読み戻すと同じ。キーは昇順・末尾改行', () => {
    const text = serializeTemplate(std());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"adjust"')).toBeLessThan(text.indexOf('"dayMode"'));
    const r = parseTemplate(text);
    expect(r).toEqual({ ok: true, template: std() });
  });
  it('壊れた JSON・形式違いは理由を返す。ヶ月と日で向きが逆のものは拒否', () => {
    expect(parseTemplate('{').ok).toBe(false);
    expect(parseTemplate('{"id":"a"}').ok).toBe(false);
    const t = std();
    const mixed = serializeTemplate({ ...t, milestones: { m: { name: 'm', type: 'x', date: { months: -1, days: 3 } } } });
    expect(parseTemplate(mixed).ok).toBe(false);
  });
  it('ファイル名と id が一致しないものは読み込みエラーにし、他は読む', () => {
    const r = parseTemplates({ 'templates/tpl-release-std.json': serializeTemplate(std()), 'templates/other.json': serializeTemplate(std()), 'projects/a.json': '{}' });
    expect(Object.keys(r.templates)).toEqual(['tpl-release-std']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.path).toBe('templates/other.json');
  });
  it('複製は新しい ID と名前を持ち、内容は同じ', () => {
    const d = duplicateTemplate(std(), 'tpl-copy', '標準リリース日程（コピー）');
    expect(d.id).toBe('tpl-copy');
    expect(d.name).toBe('標準リリース日程（コピー）');
    expect(d.events).toEqual(std().events);
  });
});
