// @req F-101, F-102, F-201, F-202, F-209
import { describe, expect, it } from 'vitest';
import { toDays } from '../../../src/domain/date';
import { FONT_FAMILY, draw, type Canvas2D } from '../../../src/domain/timeline/draw';
import { HEADER_HEIGHT, buildDrawList, lightTheme, type DrawItem, type DrawList, type DrawOptions } from '../../../src/domain/timeline/drawlist';
import { EDGE_GRAB_PX, hitTest } from '../../../src/domain/timeline/hittest';
import { buildLayout } from '../../../src/domain/timeline/layout';
import { basic, ev, ms, proj, schedule } from '../fixtures';

const opts = (o: Partial<DrawOptions> = {}): DrawOptions => ({ headerMode: 'weekMonth', viewport: { leftDay: toDays('2026-10-25'), pxPerDay: 10, width: 800, height: 300, scrollY: 0 }, ...o });
const setup = (s = basic(), o = opts()) => {
  const layout = buildLayout(s);
  const dl = buildDrawList(s, layout, o);
  return { layout, dl, vp: o.viewport, at: (x: number, y: number) => hitTest(dl, layout, o.viewport, x, y + HEADER_HEIGHT) };
};

describe('hitTest', () => {
  // e1: x 70〜520, y 7〜25（本体座標）。e2: 520〜（12/16〜）
  it('バーの本体 / 開始側・終了側のつまみ', () => {
    const { at } = setup();
    expect(at(300, 15)).toEqual({ kind: 'event', id: 'e1', projectId: 'A', part: 'body' });
    expect(at(70 + EDGE_GRAB_PX, 15)).toMatchObject({ id: 'e1', part: 'start' });
    expect(at(72, 15)).toMatchObject({ part: 'start' });
    expect(at(520 - 1, 15)).toMatchObject({ id: 'e1', part: 'end' });
    expect(at(70 + EDGE_GRAB_PX + 1, 15)).toMatchObject({ part: 'body' });
  });
  it('狭いバーはつまみを設けず全体が本体', () => {
    const s = schedule([proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-01') } })]); // 1日 = 10px
    expect(setup(s).at(75, 15)).toMatchObject({ id: 'a', part: 'body' });
  });
  it('マイルストーン', () => {
    const s = schedule([proj('P', { milestones: { m: ms('m', '2026-11-10') } })]);
    const { at } = setup(s);
    const cx = (toDays('2026-11-10') - toDays('2026-10-25') + 0.5) * 10;
    expect(at(cx, 16)).toEqual({ kind: 'milestone', id: 'm', projectId: 'P', part: 'body' });
    expect(at(cx + 30, 16)).toMatchObject({ kind: 'row' });
  });
  it('空白は行と日付を返す（作成・右クリックの文脈。F-202）', () => {
    const { at } = setup();
    const h = at(30, 15); // e1 の開始（x=70）より左の空白
    expect(h).toMatchObject({ kind: 'row', projectId: 'A' });
    expect((h as { day: number }).day).toBe(Math.floor(toDays('2026-10-25') + 30 / 10));
    expect(at(30, 45)).toMatchObject({ kind: 'row', projectId: 'A1' }); // 2行目
    expect(at(300, 15)).toMatchObject({ kind: 'event' }); // バーの上は項目
  });
  it('スクロールしている場合も、行と項目を正しく引く', () => {
    const s = basic();
    const layout = buildLayout(s);
    const o = opts({ viewport: { leftDay: toDays('2026-10-25'), pxPerDay: 10, width: 800, height: 300, scrollY: layout.rows[1]!.y } });
    const dl = buildDrawList(s, layout, o);
    expect(hitTest(dl, layout, o.viewport, 500, HEADER_HEIGHT + 15)).toMatchObject({ kind: 'event', id: 'e3' }); // e3 は x=370〜
    expect(hitTest(dl, layout, o.viewport, 30, HEADER_HEIGHT + 15)).toMatchObject({ kind: 'row', projectId: 'A1' });
  });
  it('ヘッダ / 行の無い領域（データの下）', () => {
    const { at, dl, layout, vp } = setup();
    expect(hitTest(dl, layout, vp, 100, 10)).toEqual({ kind: 'header' });
    expect(at(100, 290)).toEqual({ kind: 'none' });
  });
  it('重なっている場合は手前（後に描いたもの）を優先する', () => {
    const s = schedule([proj('P', { events: { a: ev('a', '2026-11-01', '2026-12-01') }, milestones: {} })]);
    const layout = buildLayout(s);
    const dl = buildDrawList(s, layout, opts());
    const fake: DrawList = { ...dl, hitBoxes: [...dl.hitBoxes, { ...dl.hitBoxes[0]!, id: 'top', kind: 'milestone' }] };
    expect(hitTest(fake, layout, opts().viewport, 200, HEADER_HEIGHT + 15)).toMatchObject({ id: 'top' });
  });
});

// --- draw: 記録用の偽の Canvas ---
function recorder(): { ctx: Canvas2D; calls: string[] } {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => void calls.push(`${k}(${a.map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : String(x))).join(',')})`)),
    set: (t, k: string, v) => {
      t[k] = v;
      calls.push(`${k}=${String(v)}`);
      return true;
    },
  }) as unknown as Canvas2D;
  return { ctx, calls };
}

const listWith = (...body: DrawItem[]): DrawList => ({ width: 200, height: 100 + HEADER_HEIGHT, headerHeight: HEADER_HEIGHT, background: '#fff', header: [], body, hitBoxes: [], stats: { rows: 0, items: 0, deps: 0 } });

describe('draw（描画命令を Canvas の呼び出しにする）', () => {
  it('背景 → ヘッダ（クリップ）→ 本体（ヘッダの下へ移動してクリップ）の順', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith());
    expect(calls).toEqual([
      'fillStyle=#fff', 'fillRect(0,0,200,144)',
      'save()', 'beginPath()', 'rect(0,0,200,44)', 'clip()', 'restore()',
      'save()', 'translate(0,44)', 'beginPath()', 'rect(0,0,200,100)', 'clip()', 'restore()',
    ]);
  });
  it('矩形: 塗り / 枠 / 角丸（arcTo）/ 透明度は描いたあとに戻す', () => {
    const run = (i: DrawItem) => {
      const { ctx, calls } = recorder();
      draw(ctx, listWith(i));
      return calls.slice(calls.indexOf('clip()', calls.indexOf('translate(0,44)')) + 1);
    };
    expect(run({ t: 'rect', x: 1, y: 2, w: 30, h: 10, fill: '#f00' })).toContain('fill()');
    expect(run({ t: 'rect', x: 1, y: 2, w: 30, h: 10, stroke: '#00f', lineWidth: 2 })).toEqual(expect.arrayContaining(['strokeStyle=#00f', 'lineWidth=2', 'stroke()']));
    expect(run({ t: 'rect', x: 1, y: 2, w: 30, h: 10, fill: '#f00', radius: 5 }).filter((c) => c.startsWith('arcTo')).length).toBe(4);
    const a = run({ t: 'rect', x: 1, y: 2, w: 30, h: 10, fill: '#f00', alpha: 0.4 });
    expect(a.indexOf('globalAlpha=0.4')).toBeLessThan(a.indexOf('fill()'));
    expect(a.indexOf('globalAlpha=1')).toBeGreaterThan(a.indexOf('fill()')); // 塗ったあとに戻す
  });
  it('ストライプは矩形でクリップして斜線を引く', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith({ t: 'rect', x: 0, y: 0, w: 30, h: 12, fill: '#f00', pattern: 'striped' }));
    const body = calls.slice(calls.indexOf('translate(0,44)'));
    expect(body.filter((c) => c.startsWith('moveTo')).length).toBeGreaterThanOrEqual(5);
    expect(body.filter((c) => c === 'clip()').length).toBeGreaterThanOrEqual(2); // 本体のクリップ + 斜線のクリップ
  });
  it('折れ線 + 矢印（終点に三角形を塗る）。点が足りなければ何も描かない', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith({ t: 'poly', points: [0, 0, 20, 0, 20, 10, 40, 10], color: '#555', width: 1, arrow: true }));
    expect(calls.filter((c) => c === 'stroke()')).toHaveLength(1);
    expect(calls.filter((c) => c === 'fill()')).toHaveLength(1); // 矢印
    const r2 = recorder();
    draw(r2.ctx, listWith({ t: 'poly', points: [0, 0], color: '#555', width: 1 }));
    expect(r2.calls.some((c) => c === 'stroke()')).toBe(false);
  });
  it('矢印の向き: 最後の線分が右向きなら、先端は終点で後ろ側に広がる', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith({ t: 'poly', points: [0, 20, 40, 20], color: '#555', width: 1, arrow: true }));
    const tip = calls.filter((c) => c.startsWith('moveTo'))[1]; // 矢印の moveTo
    expect(tip).toBe('moveTo(40,20)');
    const wings = calls.filter((c) => c.startsWith('lineTo')).slice(1).map((c) => Number(c.slice(7, -1).split(',')[0]));
    expect(wings.every((x) => x < 40)).toBe(true);
  });
  it('マーカー: 6つの形がそれぞれ描ける', () => {
    for (const shape of ['diamond', 'circle', 'triangle', 'square', 'star', 'flag'] as const) {
      const { ctx, calls } = recorder();
      draw(ctx, listWith({ t: 'marker', shape, cx: 50, cy: 50, size: 14, fill: '#f00', stroke: '#000' }));
      expect(calls.filter((c) => c === 'fill()'), shape).toHaveLength(1);
      expect(calls.filter((c) => c === 'stroke()'), shape).toHaveLength(1);
    }
    const star = recorder();
    draw(star.ctx, listWith({ t: 'marker', shape: 'star', cx: 50, cy: 50, size: 14, fill: '#f00' }));
    expect(star.calls.filter((c) => c.startsWith('lineTo')).length).toBe(9); // 10 頂点
  });
  it('文字: フォント・位置揃え・クリップ幅', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith({ t: 'text', x: 5, y: 10, text: '設計', color: '#111', size: 11, align: 'left', clipW: 40 }, { t: 'text', x: 5, y: 30, text: 'x', color: '#111', size: 11, align: 'right' }));
    expect(calls).toContain(`font=11px ${FONT_FAMILY}`);
    expect(calls).toContain('textBaseline=middle');
    expect(calls).toContain('rect(5,-1,40,22)'); // クリップ矩形（x=5, y=10-11, 幅40, 高さ22）
    expect(calls).toContain('fillText(設計,5,10)');
    expect(calls).toContain('textAlign=right');
  });
  it('線（破線を使ったら元に戻す）', () => {
    const { ctx, calls } = recorder();
    draw(ctx, listWith({ t: 'line', x1: 0, y1: 0, x2: 10, y2: 10, color: '#000', width: 1, dash: 4 }));
    expect(calls).toContain('setLineDash(4,4)');
    expect(calls.lastIndexOf('setLineDash()')).toBeGreaterThan(calls.indexOf('stroke()')); // 描いたあとに破線を解除
  });
  it('実際の DrawList（25,000件の一部）を描いても、全ての命令を処理できる', () => {
    const { dl } = setup();
    const { ctx, calls } = recorder();
    draw(ctx, dl);
    expect(calls.length).toBeGreaterThan(50);
    expect(dl.background).toBe(lightTheme.bg);
  });
});
