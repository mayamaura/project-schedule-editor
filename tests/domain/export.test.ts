// @req F-607, F-608, F-601, F-606, NF-020
import { describe, expect, it } from 'vitest';
import { defaultCalendar } from '../../src/domain/calendar';
import { buildViewerHtml, escapeJsonForScript, escapeScriptBody } from '../../src/domain/export/html';
import { buildSnapshot, defaultSnapshotOptions, scheduleFromSnapshot, withDescendants } from '../../src/domain/export/snapshot';
import { drawListToSvg, SvgCanvas } from '../../src/domain/export/svg';
import { toDays } from '../../src/domain/date';
import { buildDrawList } from '../../src/domain/timeline/drawlist';
import { buildLayout } from '../../src/domain/timeline/layout';
import { basic, dep, ev, ms, proj, schedule } from './fixtures';

const meta = { generatedAt: '2026-11-08T10:00:00+09:00', label: '正式版', title: 'テスト' };
const sample = () =>
  schedule(
    [
      proj('P', { name: '新製品A', assignee: '山田', note: 'プロジェクトのメモ', order: 'a', events: { e1: ev('設計', '2026-11-01', '2026-12-15', { note: '秘密のメモ' }), e2: ev('試作', '2027-01-05', '2027-03-31') }, milestones: { m1: ms('レビュー', '2026-12-20') } }),
      proj('C', { name: '筐体', parentId: 'P', order: 'a', events: { e3: ev('金型', '2026-12-01', '2027-02-01') } }),
      proj('Q', { name: '新製品B', order: 'b', events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
    ],
    [dep('d1', ['event', 'e1'], ['event', 'e2']), dep('d2', ['event', 'f1'], ['event', 'e1'])],
  );

describe('スナップショット（F-608）', () => {
  it('既定ではメモ・担当者を含めない。データ自体から除く（隠すだけではない）', () => {
    const snap = buildSnapshot(sample(), defaultCalendar(), {}, defaultSnapshotOptions(), meta);
    const text = JSON.stringify(snap);
    expect(text).not.toContain('秘密のメモ');
    expect(text).not.toContain('プロジェクトのメモ');
    expect(text).not.toContain('山田');
    expect(snap.options).toMatchObject({ includeNotes: false, includeAssignee: false });
    expect(snap.source.label).toBe('正式版');
    expect(snap.generatedAt).toBe(meta.generatedAt);
  });
  it('選べば含める', () => {
    const snap = buildSnapshot(sample(), defaultCalendar(), {}, { ...defaultSnapshotOptions(), includeNotes: true, includeAssignee: true }, meta);
    const text = JSON.stringify(snap);
    expect(text).toContain('秘密のメモ');
    expect(text).toContain('山田');
  });
  it('選択プロジェクト（子孫を含む）に絞ると、選択の根は親を切って根にし、範囲外の依存は含めない', () => {
    const snap = buildSnapshot(sample(), defaultCalendar(), { projectIds: ['C'] }, defaultSnapshotOptions(), meta);
    expect(snap.projects.map((p) => p.id)).toEqual(['C']);
    expect(snap.projects[0]!.parentId).toBeNull();
    expect(Object.keys(snap.dependencies)).toEqual([]);
    expect([...withDescendants(sample(), ['P'])].sort()).toEqual(['C', 'P']);
  });
  it('期間に重なる項目だけを出し、範囲を求める。依存線を含めない選択もできる', () => {
    const snap = buildSnapshot(sample(), defaultCalendar(), { from: '2026-12-10', to: '2026-12-31' }, { ...defaultSnapshotOptions(), dependencies: false }, meta);
    const ids = snap.projects.flatMap((p) => [...Object.keys(p.events), ...Object.keys(p.milestones)]).sort();
    expect(ids).toEqual(['e1', 'e3', 'm1']);
    expect(snap.range).toEqual({ from: '2026-11-01', to: '2027-02-01' });
    expect(snap.dependencies).toEqual({});
  });
  it('読み戻して日程にできる。壊れたものは null', () => {
    const snap = buildSnapshot(sample(), defaultCalendar(), {}, defaultSnapshotOptions(), meta);
    const r = scheduleFromSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(r?.schedule.projects['P']?.name).toBe('新製品A');
    expect(Object.keys(r!.schedule.dependencies)).toHaveLength(2);
    expect(scheduleFromSnapshot(null)).toBeNull();
    expect(scheduleFromSnapshot({ snapshotVersion: 2 })).toBeNull();
    expect(scheduleFromSnapshot({ snapshotVersion: 1, projects: [{ id: 1 }] })).toBeNull();
  });
});

describe('HTML の組み立て（NF-020）', () => {
  const js = '(function(){var s="</script><script>alert(1)</script>";})();';
  it('名称に </script> を含むデータでも、script が途中で閉じない', () => {
    const evil = JSON.stringify({ name: '</script><img src=x onerror=alert(1)>' });
    const html = buildViewerHtml({ title: '<b>題名</b>', js, payload: evil, encoding: 'json' });
    // データの script と本体の script の 2 つだけ（途中で閉じられて増えない）
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;b&gt;題名&lt;/b&gt;');
    // 埋め込んだ JSON は元に戻せる
    const body = /<script id="snapshot"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(body)).toEqual(JSON.parse(evil));
  });
  it('外部通信を禁止する CSP（default-src none）があり、外部の URL を読み込む要素が無い', () => {
    const html = buildViewerHtml({ title: 't', js: '', payload: '{}', encoding: 'json' });
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(link|img|iframe)\b/i);
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
  });
  it('エスケープ関数', () => {
    expect(escapeJsonForScript('{"a":"< >"}')).toBe('{"a":"\\u003c\\u2028>"}');
    expect(escapeScriptBody('a</Script>b<!--c')).toBe('a<\\/Script>b<\\!--c');
  });
});

describe('SVG 出力（F-601, F-606）', () => {
  const list = () => {
    const s = basic();
    const layout = buildLayout(s);
    return buildDrawList(s, layout, { viewport: { leftDay: toDays('2026-10-25'), pxPerDay: 6, width: 600, height: layout.totalHeight, scrollY: 0 }, headerMode: 'weekMonth' });
  };
  it('DrawList から SVG を作る。文字は <text> のまま（検索・選択できる）', () => {
    const dl = list();
    const svg = drawListToSvg(dl);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${dl.width}"`);
    expect(svg).toContain('<text');
    expect(svg).toContain('設計'); // イベント名
    expect(svg).toContain('<rect');
    expect(svg).toContain('clip-path'); // ヘッダ・本体のクリップ
    expect((svg.match(/<g /g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length); // 入れ子が閉じている
  });
  it('名称の特殊文字はエスケープされ、タグとして解釈されない', () => {
    const s = schedule([proj('A', { events: { e: ev('<b>&"x"', '2026-11-01', '2026-11-20') } })]);
    const layout = buildLayout(s);
    const svg = drawListToSvg(buildDrawList(s, layout, { viewport: { leftDay: toDays('2026-10-25'), pxPerDay: 12, width: 600, height: layout.totalHeight, scrollY: 0 }, headerMode: 'month' }));
    expect(svg).toContain('&lt;b&gt;&amp;&quot;x&quot;');
    expect(svg).not.toContain('<b>');
  });
  it('丸角・円・破線・透明度が SVG の属性になる', () => {
    const c = new SvgCanvas();
    c.fillStyle = '#123456';
    c.globalAlpha = 0.5;
    c.beginPath();
    c.moveTo(5, 0);
    c.arcTo(10, 0, 10, 10, 5);
    c.arcTo(10, 10, 0, 10, 5);
    c.closePath();
    c.fill();
    c.beginPath();
    c.arc(20, 20, 4);
    c.strokeStyle = '#ff0000';
    c.setLineDash([3, 3]);
    c.stroke();
    const svg = c.toSvg(30, 30);
    expect(svg).toContain('A5 5 0 0 1'); // 時計回りの丸角
    expect(svg).toContain('fill-opacity="0.5"');
    expect(svg).toContain('stroke-dasharray="3 3"');
    expect(svg).toContain('stroke="#ff0000"');
  });
});
