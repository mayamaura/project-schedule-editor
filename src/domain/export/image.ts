// @req F-601, F-606
// 画像・PDF 出力用の DrawList（純関数）。画面のタイムライン本体（buildDrawList）の左に、プロジェクト名の列を足す。
// 範囲・期間・倍率は、ここで DrawList の生成条件として決める。docs/architecture.html 10.1。
import { toDays, type DateStr } from '../date';
import type { Schedule } from '../model';
import type { Calendar } from '../calendar';
import { nonWorkingDayFn } from '../calendar';
import { estimateTextWidth, type HeaderMode } from '../timeline/axis';
import { buildDrawList, HEADER_HEIGHT, lightTheme, type DrawItem, type DrawList, type Theme } from '../timeline/drawlist';
import { buildLayout } from '../timeline/layout';

export interface ImageOptions {
  /** 出力する期間（この日を含む）。 */
  readonly from: DateStr;
  readonly to: DateStr;
  /** 1 日の幅（px）。大きいほど細かく、画像が大きくなる。 */
  readonly pxPerDay: number;
  readonly headerMode: HeaderMode;
  readonly dependencies: boolean;
  readonly calendar?: Calendar;
  readonly theme?: Theme;
}

const NAME_FONT = 12;
const INDENT = 14;
const PAD = 8;
const MAX_NAME_W = 280;
const MIN_NAME_W = 100;

/** 出力の長辺の上限（px。Canvas の限界に収める）。 */
export const MAX_IMAGE_SIDE = 16000;

function shift(i: DrawItem, dx: number): DrawItem {
  switch (i.t) {
    case 'rect':
      return { ...i, x: i.x + dx };
    case 'line':
      return { ...i, x1: i.x1 + dx, x2: i.x2 + dx };
    case 'poly':
      return { ...i, points: i.points.map((v, k) => (k % 2 === 0 ? v + dx : v)) };
    case 'marker':
      return { ...i, cx: i.cx + dx };
    case 'text':
      return { ...i, x: i.x + dx };
  }
}

/** 期間と 1 日の幅から、画像の大きさが上限を超えないように 1 日の幅を縮める。 */
export function fitPxPerDay(days: number, pxPerDay: number, otherWidth: number, scale = 1): number {
  const max = (MAX_IMAGE_SIDE / scale - otherWidth) / Math.max(1, days);
  return Math.max(0.2, Math.min(pxPerDay, max));
}

export function buildImageDrawList(s: Schedule, o: ImageOptions): DrawList {
  const theme = o.theme ?? lightTheme;
  const layout = buildLayout(s);
  const nameW = Math.min(
    MAX_NAME_W,
    Math.max(MIN_NAME_W, ...layout.rows.map((r) => Math.ceil(estimateTextWidth(r.name, NAME_FONT)) + r.depth * INDENT + PAD * 2)),
  );
  const first = toDays(o.from);
  const last = toDays(o.to);
  const days = Math.max(1, last - first + 1);
  const px = o.pxPerDay;
  const chartW = Math.max(1, Math.ceil(days * px));
  const bodyH = Math.max(layout.totalHeight, 1);
  const chart = buildDrawList(s, layout, {
    viewport: { leftDay: first, pxPerDay: px, width: chartW, height: bodyH, scrollY: 0 },
    headerMode: o.headerMode,
    dependencies: o.dependencies ? 'all' : 'none',
    theme,
    ...(o.calendar ? { nonWorkingDay: nonWorkingDayFn(o.calendar) } : {}),
  });

  const width = nameW + chartW;
  const height = HEADER_HEIGHT + bodyH;
  const header: DrawItem[] = [{ t: 'rect', x: 0, y: 0, w: nameW, h: HEADER_HEIGHT, fill: theme.headerBg }, ...chart.header.map((i) => shift(i, nameW))];
  header.push({ t: 'line', x1: nameW - 0.5, y1: 0, x2: nameW - 0.5, y2: HEADER_HEIGHT, color: theme.gridStrong, width: 1 });
  const names: DrawItem[] = [{ t: 'rect', x: 0, y: 0, w: nameW, h: bodyH, fill: theme.bg }];
  for (const r of layout.rows) {
    names.push({ t: 'line', x1: 0, y1: r.y + r.height - 0.5, x2: nameW, y2: r.y + r.height - 0.5, color: theme.rowLine, width: 1 });
    names.push({ t: 'text', x: PAD + r.depth * INDENT, y: r.y + Math.min(r.height, 32) / 2, text: r.name, color: theme.text, size: NAME_FONT, align: 'left', clipW: nameW - PAD * 2 - r.depth * INDENT });
  }
  names.push({ t: 'line', x1: nameW - 0.5, y1: 0, x2: nameW - 0.5, y2: bodyH, color: theme.gridStrong, width: 1 });
  return { ...chart, width, height, headerHeight: HEADER_HEIGHT, header, body: [...chart.body.map((i) => shift(i, nameW)), ...names], hitBoxes: [] };
}
