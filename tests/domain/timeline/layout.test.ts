// @req F-101, F-103, F-105, F-401, F-107
import { describe, expect, it } from 'vitest';
import { toDays } from '../../../src/domain/date';
import { assignLanes, buildLayout, rowAtY, spanOf, visibleRowRange } from '../../../src/domain/timeline/layout';
import { basic, ev, ms, proj, schedule } from '../fixtures';

const names = (s: ReturnType<typeof schedule>, o = {}): string[] => buildLayout(s, o).rows.map((r) => `${'-'.repeat(r.depth)}${r.projectId}`);

describe('行の平坦化（ツリー → 表示行）', () => {
  const tree = schedule([
    proj('R2', { order: 'k' }),
    proj('R1', { order: 'i' }),
    proj('C2', { parentId: 'R1', order: 'k' }),
    proj('C1', { parentId: 'R1', order: 'i' }),
    proj('G1', { parentId: 'C1', order: 'i' }),
  ]);

  it('親の直後に子が並ぶ。兄弟は order → id の順。深さ（インデント）を持つ', () => {
    expect(names(tree)).toEqual(['R1', '-C1', '--G1', '-C2', 'R2']);
  });
  it('order が同じなら id で決まる（決定的）', () => {
    expect(names(schedule([proj('b', { order: 'i' }), proj('a', { order: 'i' })]))).toEqual(['a', 'b']);
  });
  it('折りたたんだ親の子孫は出さない（F-105）。hasChildren / collapsed が分かる', () => {
    const l = buildLayout(tree, { collapsed: new Set(['R1']) });
    expect(l.rows.map((r) => r.projectId)).toEqual(['R1', 'R2']);
    expect(l.rows[0]).toMatchObject({ hasChildren: true, collapsed: true });
    expect(l.rows[1]).toMatchObject({ hasChildren: false, collapsed: false });
    expect(names(tree, { collapsed: new Set(['C1']) })).toEqual(['R1', '-C1', '-C2', 'R2']);
  });
  it('表示するプロジェクトの選択（F-401）: 外した行は出ないが、その子は出る（子は個別に選べる）', () => {
    expect(names(tree, { visible: new Set(['R1', 'G1', 'R2']) })).toEqual(['R1', '--G1', 'R2']);
  });
  it('親が存在しないプロジェクトは根として扱い、親子の循環に入ったものも消えない（データを黙って隠さない）', () => {
    expect(names(schedule([proj('A', { parentId: 'none' })]))).toEqual(['A']);
    const cyc = schedule([proj('X', { parentId: 'Y' }), proj('Y', { parentId: 'X' }), proj('Z')]);
    expect(buildLayout(cyc, {}).rows.map((r) => r.projectId).sort()).toEqual(['X', 'Y', 'Z']);
  });
  it('空のデータ', () => {
    expect(buildLayout(schedule(), {})).toMatchObject({ rows: [], totalHeight: 0 });
  });
});

describe('サブレーン（F-103）: 日付だけで決める貪欲法', () => {
  const lanes = (events: Record<string, ReturnType<typeof ev>>, milestones: Record<string, ReturnType<typeof ms>> = {}) => assignLanes(proj('P', { events, milestones }));

  it('重ならなければ1レーン', () => {
    const l = lanes({ a: ev('a', '2026-01-01', '2026-01-10'), b: ev('b', '2026-01-11', '2026-01-20') });
    expect(l.lanes).toBe(1);
    expect([...l.laneOf]).toEqual([['a', 0], ['b', 0]]);
  });
  it('終了日を含む: 前の終了日と同じ日に始まれば重なる（別レーン）。翌日なら同じレーン', () => {
    expect(lanes({ a: ev('a', '2026-01-01', '2026-01-10'), b: ev('b', '2026-01-10', '2026-01-20') }).lanes).toBe(2);
    expect(lanes({ a: ev('a', '2026-01-01', '2026-01-10'), b: ev('b', '2026-01-11', '2026-01-20') }).lanes).toBe(1);
  });
  it('重なるイベントは縦に並ぶ。空いた最初のレーンを再利用する', () => {
    const l = lanes({
      a: ev('a', '2026-01-01', '2026-01-31'),
      b: ev('b', '2026-01-05', '2026-01-10'),
      c: ev('c', '2026-01-12', '2026-01-20'), // b の終了後なので、レーン1を再利用
      d: ev('d', '2026-01-08', '2026-01-15'), // a, b と重なる → レーン2
    });
    expect(Object.fromEntries(l.laneOf)).toEqual({ a: 0, b: 1, d: 2, c: 1 });
    expect(l.lanes).toBe(3);
  });
  it('マイルストーンは1日分として扱う（イベントと同日なら別レーン）', () => {
    const l = lanes({ a: ev('a', '2026-01-01', '2026-01-10') }, { m: ms('m', '2026-01-10'), n: ms('n', '2026-01-11') });
    expect(Object.fromEntries(l.laneOf)).toEqual({ a: 0, m: 1, n: 0 });
  });
  it('項目が無ければ1レーン。不正な日付の項目があっても例外にならず（レーン0）、他の割り当てを壊さない', () => {
    expect(lanes({}).lanes).toBe(1);
    const l = lanes({ a: ev('a', '2026-02-30', '2026-03-01'), b: ev('b', '2026-01-01', '2026-01-02') });
    expect(l.laneOf.get('a')).toBe(0);
    expect(l.laneOf.get('b')).toBe(0);
  });
  it('入力の並びに依存しない（決定的）', () => {
    const a = lanes({ x: ev('x', '2026-01-01', '2026-01-10'), y: ev('y', '2026-01-05', '2026-01-15') });
    const b = lanes({ y: ev('y', '2026-01-05', '2026-01-15'), x: ev('x', '2026-01-01', '2026-01-10') });
    expect(Object.fromEntries(a.laneOf)).toEqual(Object.fromEntries(b.laneOf));
  });
  it('同じプロジェクト（参照）なら結果を再利用し、変更されたプロジェクトだけ再計算する（構造共有 × キャッシュ）', () => {
    const s = basic();
    const p = s.projects['A']!;
    expect(assignLanes(p)).toBe(assignLanes(p));
    expect(assignLanes({ ...p })).not.toBe(assignLanes(p));
  });
});

describe('行の高さと y 座標・仮想化', () => {
  const dense = schedule([
    proj('A', { order: 'i', events: { a: ev('a', '2026-01-01', '2026-01-31'), b: ev('b', '2026-01-10', '2026-01-20'), c: ev('c', '2026-01-12', '2026-01-25') } }), // 3レーン
    proj('B', { order: 'j' }), // 項目なし = 最小高さ
    proj('C', { order: 'k', events: { d: ev('d', '2026-02-01', '2026-02-10') } }), // 1レーン
  ]);
  const o = { laneHeight: 20, rowPad: 4, minRowHeight: 30 };

  it('高さ = 余白×2 + レーン数×レーン高さ（最小高さあり）。y は累積', () => {
    const l = buildLayout(dense, o);
    expect(l.rows.map((r) => [r.y, r.height, r.lanes])).toEqual([[0, 68, 3], [68, 30, 1], [98, 30, 1]]);
    expect(l.totalHeight).toBe(128);
  });
  it('項目の位置（行・レーン）を引ける', () => {
    const l = buildLayout(dense, o);
    expect(l.itemPos.get('c')).toEqual({ row: 0, lane: 2 });
    expect(l.itemPos.get('d')).toEqual({ row: 2, lane: 0 });
    expect(l.rowOfProject.get('C')).toBe(2);
  });
  it('表示範囲の行だけを返す（二分探索）', () => {
    const l = buildLayout(dense, o);
    expect(visibleRowRange(l, 0, 50)).toEqual([0, 1]);
    expect(visibleRowRange(l, 60, 20)).toEqual([0, 2]); // 行0 の下端〜行1
    expect(visibleRowRange(l, 68, 30)).toEqual([1, 2]);
    expect(visibleRowRange(l, 0, 1000)).toEqual([0, 3]);
    expect(visibleRowRange(l, 500, 100)).toEqual([3, 3]); // 範囲外
    expect(visibleRowRange(buildLayout(schedule(), {}), 0, 100)).toEqual([0, 0]);
  });
  it('y から行を引く（範囲外は -1）', () => {
    const l = buildLayout(dense, o);
    expect([rowAtY(l, 0), rowAtY(l, 67.9), rowAtY(l, 68), rowAtY(l, 127.9), rowAtY(l, 128), rowAtY(l, -1)]).toEqual([0, 0, 1, 2, -1, -1]);
  });
});

describe('spanOf（データ全体の日付範囲。初期表示用）', () => {
  it('全ての項目の最小・最大の日付', () => {
    expect(spanOf(basic())).toEqual({ minDay: toDays('2026-11-01'), maxDay: toDays('2027-04-01') });
  });
  it('項目が無ければ null。不正な日付は無視', () => {
    expect(spanOf(schedule([proj('A')]))).toBeNull();
    expect(spanOf(schedule([proj('A', { events: { a: ev('a', 'xx', 'yy') }, milestones: { m: ms('m', '2026-05-05') } })]))).toEqual({ minDay: toDays('2026-05-05'), maxDay: toDays('2026-05-05') });
  });
});
