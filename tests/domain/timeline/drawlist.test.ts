// @req F-101, F-102, F-103, F-104, F-106, F-107, F-302, F-304
import { describe, expect, it } from 'vitest';
import { toDays } from '../../../src/domain/date';
import type { Schedule } from '../../../src/domain/model';
import { colorForType, darkTheme, lightTheme, HEADER_HEIGHT, buildDrawList, type DrawItem, type DrawOptions } from '../../../src/domain/timeline/drawlist';
import { buildLayout } from '../../../src/domain/timeline/layout';
import { basic, dep, ev, ms, proj, schedule } from '../fixtures';

const base = (over: Partial<DrawOptions['viewport']> = {}, o: Partial<DrawOptions> = {}): DrawOptions => ({
  headerMode: 'weekMonth',
  viewport: { leftDay: toDays('2026-10-25'), pxPerDay: 10, width: 800, height: 300, scrollY: 0, ...over },
  ...o,
});
const draw = (s: Schedule, o: DrawOptions = base(), layoutOpts = {}) => buildDrawList(s, buildLayout(s, layoutOpts), o);
const body = (dl: ReturnType<typeof draw>, t: DrawItem['t']): DrawItem[] => dl.body.filter((i) => i.t === t);
const hit = (dl: ReturnType<typeof draw>, id: string) => dl.hitBoxes.find((h) => h.id === id);
const withEvent = (patch: object): Schedule => {
  const s = basic();
  return { ...s, projects: { ...s.projects, A: { ...s.projects['A']!, events: { ...s.projects['A']!.events, e1: { ...s.projects['A']!.events['e1']!, ...patch } } } } };
};

describe('イベントの配置（終了日を含む）', () => {
  it('左端 = 開始日、右端 = 終了日の翌日（12/1〜12/15 は15日分の幅）', () => {
    const dl = draw(basic());
    // e1: 2026-11-01〜12-15。左端は 10/25 なので 7日目 = 70px、幅は 45日 = 450px
    expect(hit(dl, 'e1')).toMatchObject({ kind: 'event', projectId: 'A', x: 70, w: 450 });
  });
  it('行と、行内のレーンで y が決まる。重なるイベントは別レーン', () => {
    const s = schedule([proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-30'), b: ev('b', '2026-11-10', '2026-11-20') } })]);
    const dl = draw(s);
    const a = hit(dl, 'a')!;
    const b = hit(dl, 'b')!;
    expect(b.y - a.y).toBe(22); // レーン高さ
    expect(a.h).toBe(18);
  });
  it('スクロールすると y がずれ、画面外の行は出さない（行の仮想化）', () => {
    const s = basic();
    const l = buildLayout(s);
    const second = l.rows[1]!;
    const dl = buildDrawList(s, l, base({ scrollY: second.y }));
    expect(hit(dl, 'e1')).toBeUndefined(); // 1行目（A）は画面外
    expect(hit(dl, 'e3')?.y).toBe(5 + 2); // 2行目の先頭（余白5 + 枠2）
    expect(dl.stats.rows).toBe(1);
  });
  it('左右に画面外の項目は出さない（日付の仮想化）', () => {
    const dl = draw(basic()); // 幅 800px = 80日。2027-04-01 のマイルストーンは範囲外
    expect(hit(dl, 'm1')).toBeUndefined();
    expect(hit(dl, 'e1')).toBeDefined();
    const later = draw(basic(), base({ leftDay: toDays('2027-03-20') }));
    expect(hit(later, 'm1')).toBeDefined();
    expect(hit(later, 'e1')).toBeUndefined();
  });
  it('一部だけ画面にかかる項目は出す（左にはみ出す）', () => {
    const dl = draw(basic(), base({ leftDay: toDays('2026-12-01') }));
    expect(hit(dl, 'e1')!.x).toBeLessThan(0);
    expect(hit(dl, 'e1')!.x + hit(dl, 'e1')!.w).toBeGreaterThan(0);
  });
});

describe('表示スタイル（F-102）と色（F-106, NF-010）', () => {
  const rectOf = (dl: ReturnType<typeof draw>) => body(dl, 'rect').find((r) => r.t === 'rect' && r.x === 70 && r.w === 450) as Extract<DrawItem, { t: 'rect' }>;
  it('既定はバー（塗りつぶし）。色は種別の色、無ければ種別名から決めた既定色', () => {
    const r = rectOf(draw(basic()));
    expect(r).toMatchObject({ fill: colorForType('phase', {}), h: 18 });
    const typed = { ...basic(), types: { phase: { name: 'フェーズ', color: '#123456' } } };
    expect(rectOf(draw(typed)).fill).toBe('#123456');
  });
  it('同じ種別名は常に同じ色（決定的）で、種別が違えば色が変わる場合がある', () => {
    expect(colorForType('phase', {})).toBe(colorForType('phase', {}));
    expect(new Set(['phase', 'review', 'release', 'x', 'y', 'z'].map((t) => colorForType(t, {}))).size).toBeGreaterThan(2);
  });
  it('角丸バー / 枠線 / 背景帯 / ストライプ', () => {
    expect(rectOf(draw(withEvent({ style: 'roundBar' }))).radius).toBe(9);
    const outline = rectOf(draw(withEvent({ style: 'outline' })));
    expect(outline.stroke).toBeDefined();
    expect(outline.fill).toBeUndefined();
    const band = rectOf(draw(withEvent({ style: 'band' })));
    expect(band.alpha).toBeLessThan(1);
    expect(rectOf(draw(withEvent({ style: 'striped' }))).pattern).toBe('striped');
  });
  it('細線＋端点: 線と両端の小さな矩形', () => {
    const dl = draw(withEvent({ style: 'line' }));
    expect(body(dl, 'line').some((l) => l.t === 'line' && l.x1 === 70 && l.x2 === 520 && l.width >= 2)).toBe(true);
    expect(body(dl, 'rect').filter((r) => r.t === 'rect' && r.w <= 4 && (r.x <= 72 || r.x >= 516) && r.h > 6).length).toBe(2);
  });
  it('種別マスタの既定のスタイルを、項目の style が上書きする', () => {
    const s = { ...basic(), types: { phase: { name: 'フェーズ', color: '#111111', eventStyle: 'roundBar' as const } } };
    expect(rectOf(draw(s)).radius).toBe(9);
    const s2 = { ...s, projects: { ...s.projects, A: { ...s.projects['A']!, events: { ...s.projects['A']!.events, e1: { ...s.projects['A']!.events['e1']!, style: 'bar' as const } } } } };
    expect(rectOf(draw(s2)).radius).toBeUndefined();
  });
  it('マイルストーンの形（◆●▲■★旗）とラベルのみ', () => {
    const at = (style?: string) => {
      const s = schedule([proj('P', { milestones: { m: ms('節目', '2026-11-10', style ? { style: style as never } : {}) } })]);
      return draw(s, base({}));
    };
    expect(body(at(), 'marker')[0]).toMatchObject({ t: 'marker', shape: 'diamond', cx: (toDays('2026-11-10') - toDays('2026-10-25') + 0.5) * 10 });
    for (const shape of ['circle', 'triangle', 'square', 'star', 'flag']) expect(body(at(shape), 'marker')[0]).toMatchObject({ shape });
    const labelOnly = at('labelOnly');
    expect(body(labelOnly, 'marker')).toEqual([]);
    expect(body(labelOnly, 'text').some((t) => t.t === 'text' && t.text === '節目')).toBe(true);
    expect(hit(labelOnly, 'm')).toBeDefined(); // ラベルのみでも選べる
  });
});

describe('ラベル', () => {
  const texts = (dl: ReturnType<typeof draw>): Extract<DrawItem, { t: 'text' }>[] => body(dl, 'text') as never;
  it('バーに収まれば内側（バー幅でクリップ）、収まらなければ右の外側', () => {
    const s = schedule([proj('P', { events: { a: ev('設計レビュー', '2026-11-01', '2026-12-15'), b: ev('設計レビュー', '2026-11-01', '2026-11-02') } })]);
    const t = texts(draw(s)).filter((x) => x.text === '設計レビュー');
    const inside = t.find((x) => x.clipW !== undefined)!;
    expect(inside.x).toBeGreaterThanOrEqual(70);
    expect(inside.x).toBeLessThan(70 + 450);
    expect(t.length).toBe(2); // もう1つは外側
    expect(t.find((x) => x.clipW === undefined)!.x).toBeGreaterThanOrEqual(70 + 20); // 20px のバーの右
  });
  it('縮小表示（1日 < 2px）では外側のラベルを出さない（大量の文字を描かない）', () => {
    const s = schedule([proj('P', { events: { b: ev('設計レビュー', '2026-11-01', '2026-11-02') } })]);
    expect(texts(draw(s, base({ pxPerDay: 1 }))).filter((x) => x.text === '設計レビュー')).toEqual([]);
  });
  it('マイルストーンのラベルは 1日 ≥ 3px のときだけ', () => {
    const s = schedule([proj('P', { milestones: { m: ms('節目', '2026-11-10') } })]);
    expect(texts(draw(s, base({ pxPerDay: 3 }))).some((x) => x.text === '節目')).toBe(true);
    expect(texts(draw(s, base({ pxPerDay: 2 }))).some((x) => x.text === '節目')).toBe(false);
  });
});

describe('依存線（F-302, F-304）', () => {
  const polys = (dl: ReturnType<typeof draw>): Extract<DrawItem, { t: 'poly' }>[] => body(dl, 'poly') as never;
  const two = (e2start = '2026-12-16'): Schedule =>
    schedule(
      [proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-20'), b: ev('b', e2start, '2027-01-10') }, milestones: { m: ms('m', '2026-12-30') } }), proj('Q', { order: 'j', events: { c: ev('c', '2026-11-01', '2026-11-05') } })],
      [dep('d1', ['event', 'a'], ['event', 'b']), dep('d2', ['event', 'a'], ['event', 'c'])],
    );

  it('既定は全ての依存を矢印付きの直交する折れ線で描く', () => {
    const p = polys(draw(two()));
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.arrow && x.points.length >= 8)).toBe(true);
    // 直交: 隣り合う点は x か y のどちらかが等しい
    for (const x of p) for (let i = 2; i < x.points.length; i += 2) expect(x.points[i] === x.points[i - 2] || x.points[i + 1] === x.points[i - 1]).toBe(true);
  });
  it('FS の始点は先行の右端、終点は後続の左端', () => {
    const [d1] = polys(draw(two()));
    expect(d1!.points.slice(0, 2)).toEqual([(toDays('2026-11-21') - toDays('2026-10-25')) * 10, 16]); // 先行 a の終了日の翌日 = 右端
    expect(d1!.points.slice(-2)).toEqual([(toDays('2026-12-16') - toDays('2026-10-25')) * 10, 16]); // 後続 b の左端
  });
  it('違反している依存（後続が先行より前）は違反色、満たしていれば通常色', () => {
    expect(polys(draw(two()))[0]!.color).toBe(lightTheme.dep);
    expect(polys(draw(two('2026-11-10')))[0]!.color).toBe(lightTheme.depViolation); // 先行の終了（11/20）より前に後続が始まる
  });
  it('表示切替: 非表示 / 選択項目に関係するものだけ（F-304）', () => {
    expect(polys(draw(two(), base({}, { dependencies: 'none' })))).toEqual([]);
    expect(polys(draw(two(), base({}, { dependencies: 'selected', selection: new Set() })))).toEqual([]);
    expect(polys(draw(two(), base({}, { dependencies: 'selected', selection: new Set(['b']) })))).toHaveLength(1);
    expect(polys(draw(two(), base({}, { dependencies: 'selected', selection: new Set(['a']) })))).toHaveLength(2);
  });
  it('片方の端点が画面外（縦）でも、見えている側があれば描く。両方が画面外なら描かない', () => {
    const l = buildLayout(two());
    const dl = buildDrawList(two(), l, base({ scrollY: l.rows[1]!.y })); // 行 P は画面外、行 Q（c）だけが見える
    expect(polys(dl)).toHaveLength(1); // d2（a → c）。a は画面外だが c は見える
    const none = buildDrawList(two(), l, base({ scrollY: l.totalHeight + 100 }));
    expect(polys(none)).toEqual([]);
  });
  it('折りたたまれて見えない端点への依存は描かない', () => {
    const s = schedule(
      [proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-05') } }), proj('Q', { parentId: 'P', events: { c: ev('c', '2026-11-10', '2026-11-12') } })],
      [dep('d', ['event', 'a'], ['event', 'c'])],
    );
    expect(polys(draw(s, base(), { collapsed: new Set(['P']) }))).toEqual([]);
    expect(polys(draw(s, base()))).toHaveLength(1);
  });
  it('SS / FF / SF でも直交する折れ線になる', () => {
    for (const type of ['SS', 'FF', 'SF'] as const) {
      const s = schedule([proj('P', { events: { a: ev('a', '2026-11-01', '2026-11-20'), b: ev('b', '2026-12-16', '2027-01-10') } })], [dep('d', ['event', 'a'], ['event', 'b'], { type })]);
      const [p] = polys(draw(s));
      expect(p, type).toBeDefined();
      for (let i = 2; i < p!.points.length; i += 2) expect(p!.points[i] === p!.points[i - 2] || p!.points[i + 1] === p!.points[i - 1]).toBe(true);
    }
  });
});

describe('背景・ヘッダ・選択', () => {
  it('週末の塗りは 1日 ≥ 3px のときだけ。土日をまとめて1枚', () => {
    const weekendRects = (px: number) => body(draw(basic(), base({ pxPerDay: px })), 'rect').filter((r) => r.t === 'rect' && r.fill === lightTheme.weekend);
    expect(weekendRects(2)).toEqual([]);
    const w = weekendRects(10);
    expect(w.length).toBe(12); // 800px = 80日 ≒ 11〜12週
    expect(w[0]).toMatchObject({ w: 20 }); // 2日分
  });
  it('休みの日（祝日・会社休日）を指定すると、週末の代わりにその日を連続でまとめて塗る（F-603）', () => {
    const d = toDays('2026-11-03'); // 文化の日（火）
    const off = (day: number): boolean => day === d || day === d + 1 || day === d + 5; // 火水・日
    const rects = (px: number) => body(draw(basic(), base({ pxPerDay: px }, { nonWorkingDay: off })), 'rect').filter((r) => r.t === 'rect' && r.fill === lightTheme.weekend);
    const r = rects(10);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ x: (d - toDays('2026-10-25')) * 10, w: 20 }); // 連続 2 日は 1 枚
    expect(r[1]).toMatchObject({ w: 10 });
    expect(rects(2)).toEqual([]); // 1日 < 3px では塗らない
  });
  it('今日線', () => {
    const lines = (today?: string) => body(draw(basic(), base({}, today ? { today } : {})), 'line').filter((l) => l.t === 'line' && l.color === lightTheme.today);
    expect(lines('2026-11-07')).toHaveLength(1);
    expect((lines('2026-11-07')[0] as { x1: number }).x1).toBe((toDays('2026-11-07') - toDays('2026-10-25') + 0.5) * 10);
    expect(lines()).toEqual([]);
    expect(lines('2030-01-01')).toEqual([]); // 範囲外
  });
  it('日付ヘッダ: 年月週ではラベルが2段、年月では上段のみ。ヘッダの高さは固定（切替で本体がずれない）', () => {
    const w = draw(basic());
    const m = draw(basic(), { ...base(), headerMode: 'month' });
    expect(w.headerHeight).toBe(HEADER_HEIGHT);
    expect(m.headerHeight).toBe(HEADER_HEIGHT);
    const labels = (dl: typeof w) => dl.header.filter((i) => i.t === 'text').map((i) => (i as { text: string }).text);
    expect(labels(w)).toContain("'26/10");
    expect(labels(w)).toContain('26'); // 10/26（月曜日）
    expect(labels(m)).toContain("'26/10");
    expect(labels(m).some((t) => /^\d+$/.test(t) && Number(t) > 12)).toBe(false); // 週の日は出ない
  });
  it('選択・ホバーは項目を囲む枠として最前面に描く', () => {
    const dl = draw(basic(), base({}, { selection: new Set(['e1']), hover: 'e2' }));
    const strokes = body(dl, 'rect').filter((r) => r.t === 'rect' && (r.stroke === lightTheme.selection || r.stroke === lightTheme.hover));
    expect(strokes).toHaveLength(2);
    expect(dl.body[dl.body.length - 1]).toBe(strokes[strokes.length - 1]); // 最後 = 最前面
  });
  it('ダークテーマ', () => {
    expect(draw(basic(), base({}, { theme: darkTheme })).background).toBe(darkTheme.bg);
    expect(draw(basic()).background).toBe(lightTheme.bg);
  });
  it('行の区切り線', () => {
    const lines = body(draw(basic()), 'line').filter((l) => l.t === 'line' && l.color === lightTheme.rowLine);
    expect(lines.length).toBe(2);
  });
});

describe('決定性・統計', () => {
  it('同じ入力から同じ DrawList（出力が安定）', () => {
    const o = base({}, { selection: new Set(['e1']) });
    expect(JSON.stringify(draw(basic(), o))).toBe(JSON.stringify(draw(basic(), o)));
  });
  it('入力（Schedule・Layout）を書き換えない', async () => {
    const { deepFreeze } = await import('../fixtures');
    const s = deepFreeze(basic());
    const l = deepFreeze(buildLayout(s));
    expect(() => buildDrawList(s, l, base())).not.toThrow();
  });
  it('統計: 行数・項目数・依存数・当たり判定の数', () => {
    const dl = draw(basic());
    expect(dl.stats).toMatchObject({ rows: 2, items: 3, deps: 1 }); // e1, e2, e3（m1 は範囲外）
    expect(dl.hitBoxes).toHaveLength(3);
  });
  it('空のデータ・表示サイズ 0 でも例外にならない', () => {
    expect(draw(schedule()).hitBoxes).toEqual([]);
    expect(() => draw(basic(), base({ width: 0, height: 0 }))).not.toThrow();
  });
});
