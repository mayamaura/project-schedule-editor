// @req F-601, F-606
import { describe, expect, it } from 'vitest';
import { defaultCalendar } from '../../src/domain/calendar';
import { buildImageDrawList, fitPxPerDay, MAX_IMAGE_SIDE } from '../../src/domain/export/image';
import { drawListToSvg } from '../../src/domain/export/svg';
import { HEADER_HEIGHT } from '../../src/domain/timeline/drawlist';
import { ev, ms, proj, schedule } from './fixtures';

const s = () =>
  schedule([
    proj('P', { name: '新製品A', order: 'a', events: { e1: ev('設計', '2026-11-01', '2026-12-15') }, milestones: { m1: ms('レビュー', '2026-12-20') } }),
    proj('C', { name: '筐体', parentId: 'P', order: 'a', events: { e2: ev('金型', '2026-12-01', '2027-02-01') } }),
  ]);
const opts = { from: '2026-10-25', to: '2027-02-28', pxPerDay: 6, headerMode: 'weekMonth', dependencies: true } as const;

describe('画像出力用の DrawList（F-601）', () => {
  it('期間 × 1 日の幅 ＋ プロジェクト名の列の大きさになり、本体と名前の列が含まれる', () => {
    const dl = buildImageDrawList(s(), opts);
    const days = 127; // 10/25〜2/28
    expect(dl.width).toBeGreaterThan(days * 6);
    expect(dl.width).toBeLessThan(days * 6 + 300);
    expect(dl.height).toBeGreaterThan(HEADER_HEIGHT);
    const texts = dl.body.filter((i) => i.t === 'text').map((i) => (i.t === 'text' ? i.text : ''));
    expect(texts).toContain('新製品A');
    expect(texts).toContain('筐体');
    expect(texts).toContain('設計'); // 項目名
  });
  it('タイムライン本体は名前の列の右へずれる（日付の位置が合う）', () => {
    const dl = buildImageDrawList(s(), opts);
    const nameW = dl.width - Math.ceil(127 * 6);
    const bar = dl.body.find((i) => i.t === 'rect' && i.h > 10 && i.w > 200 && i.x >= nameW);
    expect(bar).toBeDefined();
  });
  it('SVG にできる。祝日カレンダーを渡しても作れる', () => {
    const dl = buildImageDrawList(s(), { ...opts, calendar: defaultCalendar() });
    const svg = drawListToSvg(dl);
    expect(svg).toContain('新製品A');
    expect(svg).toContain(`width="${dl.width}"`);
  });
  it('大きすぎる出力は 1 日の幅を縮めて上限に収める', () => {
    expect(fitPxPerDay(3000, 12, 200)).toBeLessThan(12);
    const px = fitPxPerDay(3000, 12, 200, 2);
    expect(3000 * px * 2 + 200 * 2).toBeLessThanOrEqual(MAX_IMAGE_SIDE + 1);
    expect(fitPxPerDay(100, 6, 200)).toBe(6); // 収まるならそのまま
  });
});
