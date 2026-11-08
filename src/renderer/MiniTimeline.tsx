// @req F-803
// 標準日程を展開する前の仮表示（タイムライン上のプレビュー）。本体と同じ DrawList・Canvas 描画（draw）を、
// 展開される項目だけを入れた小さな日程に使う。日付の範囲に合わせて自動で拡大縮小する。
import { useEffect, useRef } from 'react';
import { buildDrawList, buildLayout, darkTheme, draw, emptySchedule, HEADER_HEIGHT, lightTheme, toDays, type Canvas2D, type PreviewItem, type Project, type Schedule } from '@domain/index';

const W = 720;

/** プレビューの項目から、1 つのプロジェクトだけの日程を作る（ID は連番。種別は既定の色になる）。 */
export function previewSchedule(items: readonly PreviewItem[]): Schedule {
  const events: Project['events'] = {};
  const milestones: Project['milestones'] = {};
  items.forEach((it, i) => {
    if (it.kind === 'event') events[`e${i}`] = { name: it.name, start: it.start, end: it.end, type: 'preview' };
    else milestones[`m${i}`] = { name: it.name, date: it.start, type: 'preview' };
  });
  return { ...emptySchedule(), projects: { p: { id: 'p', name: '', parentId: null, order: 'a', events, milestones } } };
}

export function MiniTimeline({ items }: { items: readonly PreviewItem[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || items.length === 0) return;
    const s = previewSchedule(items);
    const layout = buildLayout(s);
    const first = Math.min(...items.map((i) => toDays(i.start))) - 7;
    const last = Math.max(...items.map((i) => toDays(i.end))) + 8;
    const bodyH = Math.max(layout.totalHeight, 40);
    const H = bodyH + HEADER_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = '100%';
    canvas.style.aspectRatio = `${W} / ${H}`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const list = buildDrawList(s, layout, {
      viewport: { leftDay: first, pxPerDay: W / (last - first), width: W, height: bodyH, scrollY: 0 },
      headerMode: 'month',
      dependencies: 'none',
      theme: dark ? darkTheme : lightTheme,
    });
    draw(ctx as unknown as Canvas2D, list);
  }, [items]);
  if (items.length === 0) return null;
  return <canvas ref={ref} data-testid="expand-timeline" aria-label="展開される日程の仮表示" role="img" style={{ border: '1px solid var(--line)', borderRadius: 6 }} />;
}
