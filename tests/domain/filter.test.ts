// @req F-402, F-403
import { describe, expect, it } from 'vitest';
import { filterSchedule, filterOptions, isFilterActive } from '../../src/domain/filter';
import { parseView, parseViews, serializeView, viewPath, type SavedView } from '../../src/domain/view';
import { dep, ev, ms, proj, schedule } from './fixtures';

const s = () =>
  schedule(
    [
      proj('A', { name: '新製品A', order: 'a', status: 'inProgress', assignee: '山田', tags: ['社外', '重要'], note: '外注あり', events: { e1: ev('設計', '2026-11-01', '2026-12-15'), e2: ev('試作', '2027-01-05', '2027-03-31') }, milestones: { m1: ms('レビュー', '2026-12-20') } }),
      proj('C', { name: '筐体', parentId: 'A', order: 'a', status: 'notStarted', assignee: '鈴木', events: { e3: ev('金型', '2026-12-01', '2027-02-01') } }),
      proj('B', { name: '新製品B', order: 'b', status: 'done', assignee: '山田', tags: ['社内'], events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
    ],
    [dep('d1', ['event', 'e1'], ['event', 'e2']), dep('d2', ['event', 'f1'], ['event', 'e1'])],
  );
const ids = (x: ReturnType<typeof s>): string[] => Object.values(x.projects).map((p) => p.id).sort();
const items = (x: ReturnType<typeof s>): string[] => Object.values(x.projects).flatMap((p) => [...Object.keys(p.events), ...Object.keys(p.milestones)]).sort();

describe('フィルタ（F-402）', () => {
  it('条件が無ければ何も絞らない（isFilterActive も false）', () => {
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ text: '  ', statuses: [] })).toBe(false);
    expect(filterSchedule(s(), {})).toEqual(s());
  });
  it('名称検索: 項目名・メモ・プロジェクト名に一致するものだけ。プロジェクト名に一致すれば、そのプロジェクトの項目は全て出す', () => {
    expect(items(filterSchedule(s(), { text: '試作' }))).toEqual(['e2']);
    expect(items(filterSchedule(s(), { text: '金型' }))).toEqual(['e3']);
    expect(items(filterSchedule(s(), { text: '新製品b' }))).toEqual(['f1']); // 大文字小文字を区別しない
    expect(items(filterSchedule(s(), { text: '外注' }))).toEqual(['e1', 'e2', 'm1']); // プロジェクトのメモに一致
    expect(items(filterSchedule(s(), { text: 'zzz' }))).toEqual([]);
  });
  it('一致した子のプロジェクトは、親を文脈として残す（親の項目は出さない）', () => {
    const r = filterSchedule(s(), { text: '金型' });
    expect(ids(r)).toEqual(['A', 'C']);
    expect(items({ ...r })).toEqual(['e3']);
  });
  it('状態・担当・タグで絞る（項目ごとに OR、条件どうしは AND）', () => {
    expect(ids(filterSchedule(s(), { statuses: ['done'] }))).toEqual(['B']);
    expect(ids(filterSchedule(s(), { assignees: ['山田'] }))).toEqual(['A', 'B']);
    expect(ids(filterSchedule(s(), { tags: ['社内', '重要'] }))).toEqual(['A', 'B']);
    expect(ids(filterSchedule(s(), { assignees: ['山田'], statuses: ['inProgress'] }))).toEqual(['A']);
    expect(ids(filterSchedule(s(), { statuses: ['onHold'] }))).toEqual([]);
  });
  it('期間: その期間に重なる項目だけ。項目が無くなったプロジェクトは出さない', () => {
    const r = filterSchedule(s(), { from: '2027-02-15', to: '2027-04-30' });
    expect(items(r)).toEqual(['e2']);
    expect(ids(r)).toEqual(['A']);
    expect(items(filterSchedule(s(), { from: '2026-12-20', to: '2026-12-20' }))).toEqual(['e3', 'm1']);
  });
  it('依存は、両端の項目が残るものだけ', () => {
    expect(Object.keys(filterSchedule(s(), { text: '設計' }).dependencies)).toEqual([]);
    expect(Object.keys(filterSchedule(s(), { from: '2026-11-01', to: '2026-12-31' }).dependencies).sort()).toEqual(['d2']);
    expect(Object.keys(filterSchedule(s(), { assignees: ['山田'] }).dependencies).sort()).toEqual(['d1', 'd2']);
  });
  it('選べる値の一覧（担当・タグ）を返す', () => {
    expect(filterOptions(s())).toEqual({ assignees: ['山田', '鈴木'], tags: ['社内', '社外', '重要'] });
  });
});

describe('保存したビュー（F-403）', () => {
  const v = (): SavedView => ({ id: 'v-risk', name: '山田さんの進行中', shared: true, filter: { assignees: ['山田'], statuses: ['inProgress'] }, headerMode: 'month', dependencies: 'selected', collapsed: ['A'] });
  it('整形出力を読み戻すと同じ。共有ビューは views/<id>.json', () => {
    expect(viewPath('v-risk')).toBe('views/v-risk.json');
    const text = serializeView(v());
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseView(text)).toEqual({ ok: true, view: v() });
  });
  it('壊れた内容は理由を返し、他のビューは読む。ファイル名と id が違うものはエラー', () => {
    expect(parseView('{').ok).toBe(false);
    expect(parseView('{"id":"a"}').ok).toBe(false);
    const r = parseViews({ 'views/v-risk.json': serializeView(v()), 'views/other.json': serializeView(v()), 'views/bad.json': '{', 'projects/a.json': '{}' });
    expect(r.views.map((x) => x.id)).toEqual(['v-risk']);
    expect(r.errors.map((e) => e.path).sort()).toEqual(['views/bad.json', 'views/other.json']);
    expect(r.views[0]!.shared).toBe(true);
  });
});
