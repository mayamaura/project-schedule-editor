// @req F-104, F-107
import { describe, expect, it } from 'vitest';
import { toDays } from '../../../src/domain/date';
import { MAX_PX_PER_DAY, MIN_PX_PER_DAY, buildHeader, clampPxPerDay, dayToX, estimateTextWidth, panX, xToDay, zoomAt, type Viewport } from '../../../src/domain/timeline/axis';

const D = toDays;
const vp = (left: string, px = 10, width = 770): Viewport => ({ leftDay: D(left), pxPerDay: px, width });

describe('日付 ⇔ x 座標', () => {
  it('x = (日 − 左端) × 1日の幅。往復して元に戻る', () => {
    const v = vp('2026-11-02');
    expect(dayToX(D('2026-11-02'), v)).toBe(0);
    expect(dayToX(D('2026-11-09'), v)).toBe(70);
    expect(dayToX(D('2026-10-31'), v)).toBe(-20);
    expect(xToDay(dayToX(D('2026-12-25') + 0.5, v), v)).toBeCloseTo(D('2026-12-25') + 0.5, 9);
  });
});

describe('ズームとパン', () => {
  it('ズームは範囲内に収まる', () => {
    expect(clampPxPerDay(0.01)).toBe(MIN_PX_PER_DAY);
    expect(clampPxPerDay(1000)).toBe(MAX_PX_PER_DAY);
    expect(clampPxPerDay(7)).toBe(7);
  });
  it('カーソル下の日付が動かない（不動点）', () => {
    const v = vp('2026-11-02', 10, 800);
    for (const [factor, anchor] of [[2, 400], [0.5, 123], [1.3, 0], [0.7, 799]] as const) {
      const before = xToDay(anchor, v);
      const z = zoomAt(v, factor, anchor);
      expect(xToDay(anchor, z)).toBeCloseTo(before, 9);
      expect(z.pxPerDay).toBeCloseTo(clampPxPerDay(10 * factor), 9);
    }
  });
  it('上限・下限では倍率が止まり、不動点も保たれる', () => {
    const v = vp('2026-11-02', MAX_PX_PER_DAY, 800);
    const z = zoomAt(v, 10, 300);
    expect(z.pxPerDay).toBe(MAX_PX_PER_DAY);
    expect(z.leftDay).toBeCloseTo(v.leftDay, 9);
  });
  it('パン: 右へ 100px ドラッグすると左端の日付が 100/pxPerDay 日戻る', () => {
    expect(panX(vp('2026-11-02', 10), 100).leftDay).toBeCloseTo(D('2026-11-02') - 10, 9);
    expect(panX(vp('2026-11-02', 10), -50).leftDay).toBeCloseTo(D('2026-11-02') + 5, 9);
  });
});

describe('estimateTextWidth', () => {
  it('全角は 1em、半角は 0.55em', () => {
    expect(estimateTextWidth('設計', 10)).toBe(20);
    expect(estimateTextWidth('ab', 10)).toBeCloseTo(11, 9);
    expect(estimateTextWidth('', 10)).toBe(0);
  });
});

describe('日付ヘッダ: 年月週（図の例: 週は月曜日の日付、月は月曜日の属する月）', () => {
  const h = buildHeader('weekMonth', vp('2026-11-02'));

  it('下段は月曜日の「日」: 2 9 16 23 30 | 7 14 21 28 | 4 11', () => {
    expect(h.bottom.map((c) => c.label)).toEqual(['2', '9', '16', '23', '30', '7', '14', '21', '28', '4', '11']);
    expect(h.bottom.map((c) => c.x0)).toEqual([0, 70, 140, 210, 280, 350, 420, 490, 560, 630, 700]);
    expect(h.bottom.every((c) => c.x1 - c.x0 === 70)).toBe(true);
  });
  it("上段は '26/11 | 12 | '27/1（最初の列と1月だけ年付き）。月の境界は週の列境界（12/1 ではなく 12/7）", () => {
    expect(h.top.map((c) => c.label)).toEqual(["'26/11", '12', "'27/1"]);
    expect(h.top[0]).toMatchObject({ x0: 0, x1: 350 }); // 11月 = 5週（11/2〜11/30）
    expect(h.top[1]).toMatchObject({ x0: 350, x1: 630 }); // 12月 = 4週（12/7〜12/28）。12/1 ではなく 12/7 から
    expect(h.top[2]).toMatchObject({ x0: 630 }); // 1月は 1/4 から
  });
  it('月の幅は所属する週の本数分（月の最終セルは、画面外でも本来の終端まで伸びる）', () => {
    expect(h.top[2]?.x1).toBe((D('2027-02-01') - D('2026-11-02')) * 10); // 2/1 は月曜日 = 2月の最初の列
  });
  it('2番目以降の列で年が変わらなければ「M」だけ。途中から表示すると、その最初の列に年が付く', () => {
    const h2 = buildHeader('weekMonth', vp('2026-12-08', 10, 400));
    expect(h2.top.map((c) => c.label)).toEqual(["'26/12", "'27/1"]); // 先頭に年。1月は常に年付き
    const h3 = buildHeader('weekMonth', vp('2027-02-08', 10, 600));
    expect(h3.top.map((c) => c.label)).toEqual(["'27/2", '3', '4']); // 4月の最初の月曜日 4/5 の列が、右端（2/8 から60日後）の手前にかかる
  });
  it('左端が週の途中でも、その週の列が左にはみ出して含まれる（下段）', () => {
    const h4 = buildHeader('weekMonth', vp('2026-11-04', 10, 200)); // 水曜日が左端
    expect(h4.bottom[0]).toMatchObject({ label: '2', x0: -20, x1: 50 });
  });
  it('年跨ぎ・11/30(月)は11月に属する', () => {
    const h5 = buildHeader('weekMonth', vp('2026-11-30', 10, 100));
    expect(h5.bottom[0]?.label).toBe('30');
    expect(h5.top[0]?.label).toBe("'26/11");
    expect(h5.top[0]?.x1).toBe((D('2026-12-07') - D('2026-11-30')) * 10);
  });
  it('幅が足りないセルはラベルを出さない（ズームアウト時に文字が潰れない）', () => {
    const far = buildHeader('weekMonth', vp('2026-01-05', 0.5, 800));
    expect(far.bottom.every((c) => !c.showLabel)).toBe(true); // 1週 = 3.5px
    expect(far.top.some((c) => c.showLabel)).toBe(true); // 月は 約15px
    const near = buildHeader('weekMonth', vp('2026-11-02', 10, 770));
    expect(near.bottom.every((c) => c.showLabel)).toBe(true);
  });
});

describe('日付ヘッダ: 年月（月の境界は実際の月初。下段なし）', () => {
  it('上段のみ。月の幅は日数に比例', () => {
    const h = buildHeader('month', vp('2026-11-01', 10, 900));
    expect(h.bottom).toEqual([]);
    expect(h.top.map((c) => c.label)).toEqual(["'26/11", '12', "'27/1"]);
    expect(h.top.map((c) => [c.x0, c.x1])).toEqual([[0, 300], [300, 610], [610, 920]]); // 30日・31日・31日
  });
  it('2月の幅（閏年を含む）', () => {
    const h = buildHeader('month', vp('2028-02-01', 10, 400));
    expect(h.top[0]).toMatchObject({ x0: 0, x1: 290 }); // 2028 は閏年で 29日
    const h2 = buildHeader('month', vp('2027-02-01', 10, 400));
    expect(h2.top[0]).toMatchObject({ x0: 0, x1: 280 });
  });
  it('切替しても左端の日付とズームは変わらない（ヘッダは見せ方だけ）', () => {
    const v = vp('2026-11-15', 7, 800);
    const w = buildHeader('weekMonth', v);
    const m = buildHeader('month', v);
    expect(w.top.length).toBeGreaterThan(0);
    expect(m.top.length).toBeGreaterThan(0);
    expect(v).toEqual({ leftDay: D('2026-11-15'), pxPerDay: 7, width: 800 });
  });
  it('8年分を縮小表示しても動く（0.5px/日）', () => {
    const h = buildHeader('month', vp('2026-01-01', 0.5, 1500));
    expect(h.top.length).toBeGreaterThanOrEqual(96);
    expect(h.top.filter((c) => c.label.startsWith("'")).length).toBeGreaterThanOrEqual(8); // 各年の1月
  });
});
