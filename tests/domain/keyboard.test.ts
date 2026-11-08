// @req F-203, F-207
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/domain/commands';
import { copyItems, pasteCommand, shiftCommand, deleteItemsCommand, neighborItem } from '../../src/domain/multi';
import { buildLayout } from '../../src/domain/timeline/layout';
import { ev, ms, proj, schedule } from './fixtures';

const s = () =>
  schedule([
    proj('P', { name: 'P', order: 'a', events: { a: ev('a', '2026-11-01', '2026-11-10'), b: ev('b', '2026-11-12', '2026-11-20'), c: ev('c', '2026-12-01', '2026-12-05') }, milestones: { m: ms('m', '2026-11-25') } }),
    proj('C', { name: 'C', parentId: 'P', order: 'a', events: { d: ev('d', '2026-11-03', '2026-11-30') } }),
    proj('Q', { name: 'Q', order: 'b', events: { e: ev('e', '2026-11-13', '2026-11-14'), f: ev('f', '2026-11-26', '2026-11-27') } }),
  ]);
const apply = (sc: ReturnType<typeof s>, c: ReturnType<typeof shiftCommand>) => {
  const r = applyCommand(sc, c!);
  if (!r.ok) throw new Error(r.error.message);
  return r.schedule;
};

describe('矢印キーでの選択移動（F-203）', () => {
  const nav = (id: string, dir: Parameters<typeof neighborItem>[3]) => neighborItem(s(), buildLayout(s()), id, dir);
  it('左右: 同じプロジェクトの中で、開始日の順に前後の項目へ。端では null', () => {
    expect(nav('a', 'right')).toBe('b');
    expect(nav('b', 'right')).toBe('m');
    expect(nav('m', 'right')).toBe('c');
    expect(nav('c', 'right')).toBeNull();
    expect(nav('b', 'left')).toBe('a');
    expect(nav('a', 'left')).toBeNull();
  });
  it('上下: 隣の表示行の、開始日が近い項目へ', () => {
    // 行の並び: P → C（P の子）→ Q
    expect(nav('a', 'down')).toBe('d'); // a の開始 11/1 に近いのは d（11/3）
    expect(nav('d', 'down')).toBe('e');
    expect(nav('e', 'up')).toBe('d');
    expect(nav('d', 'up')).toBe('a');
    expect(nav('a', 'up')).toBeNull();
    expect(nav('f', 'down')).toBeNull();
  });
  it('存在しない項目は null', () => {
    expect(nav('zzz', 'right')).toBeNull();
  });
});

describe('複数選択の一括移動（F-207）', () => {
  it('選んだイベント・マイルストーンを、日数ぶんずらす（負なら前倒し）。1 つの batch コマンド', () => {
    const c = shiftCommand(s(), ['a', 'm'], 7);
    expect(c?.type).toBe('batch');
    const r = apply(s(), c);
    expect(r.projects['P']!.events['a']).toMatchObject({ start: '2026-11-08', end: '2026-11-17' });
    expect(r.projects['P']!.milestones['m']!.date).toBe('2026-12-02');
    expect(r.projects['P']!.events['b']).toMatchObject({ start: '2026-11-12' }); // 選んでいないものは動かない
    const back = apply(r, shiftCommand(r, ['a'], -7));
    expect(back.projects['P']!.events['a']!.start).toBe('2026-11-01');
  });
  it('プロジェクトを選ぶと、その項目を全て動かす。子孫ごと動かすかを選べる', () => {
    const own = apply(s(), shiftCommand(s(), ['P'], 1));
    expect(own.projects['P']!.events['c']!.start).toBe('2026-12-02');
    expect(own.projects['C']!.events['d']!.start).toBe('2026-11-03'); // 子は動かさない
    const withKids = apply(s(), shiftCommand(s(), ['P'], 1, { descendants: true }));
    expect(withKids.projects['C']!.events['d']!.start).toBe('2026-11-04');
    expect(withKids.projects['Q']!.events['e']!.start).toBe('2026-11-13'); // 無関係
  });
  it('重複（項目とそれを含むプロジェクトの両方を選ぶ）でも、二重には動かさない。0 日・空の選択は null', () => {
    const r = apply(s(), shiftCommand(s(), ['P', 'a'], 2));
    expect(r.projects['P']!.events['a']!.start).toBe('2026-11-03');
    expect(shiftCommand(s(), ['a'], 0)).toBeNull();
    expect(shiftCommand(s(), [], 3)).toBeNull();
    expect(shiftCommand(s(), ['zzz'], 3)).toBeNull();
  });
});

describe('コピー & 貼り付け・削除（F-203）', () => {
  it('選んだ項目をコピーし、プロジェクトへ貼り付ける。新しい ID で、日付・種別・メモを引き継ぐ', () => {
    const clip = copyItems(s(), ['a', 'm']);
    expect(clip).toHaveLength(2);
    const c = pasteCommand(s(), clip, 'Q');
    expect(c).not.toBeNull();
    const r = apply(s(), c!.command);
    const q = r.projects['Q']!;
    expect(Object.keys(q.events)).toHaveLength(3);
    expect(Object.values(q.events).some((e) => e.name === 'a' && e.start === '2026-11-01' && e.end === '2026-11-10')).toBe(true);
    expect(Object.values(q.milestones).some((m) => m.name === 'm' && m.date === '2026-11-25')).toBe(true);
    expect(c!.ids).toHaveLength(2);
    expect(Object.keys(r.projects['P']!.events)).toHaveLength(3); // 元は残る
  });
  it('貼り付け先が無い・コピーが空なら null。同じ操作を 2 回貼っても ID は衝突しない', () => {
    expect(pasteCommand(s(), [], 'Q')).toBeNull();
    expect(pasteCommand(s(), copyItems(s(), ['a']), 'nope')).toBeNull();
    const clip = copyItems(s(), ['a']);
    const once = apply(s(), pasteCommand(s(), clip, 'Q')!.command);
    expect(applyCommand(once, pasteCommand(once, clip, 'Q')!.command).ok).toBe(true);
  });
  it('複数の項目をまとめて削除する（1 つの batch）', () => {
    const r = apply(s(), deleteItemsCommand(s(), ['a', 'm', 'zzz'])!);
    expect(Object.keys(r.projects['P']!.events).sort()).toEqual(['b', 'c']);
    expect(Object.keys(r.projects['P']!.milestones)).toEqual([]);
    expect(deleteItemsCommand(s(), ['zzz'])).toBeNull();
  });
});
