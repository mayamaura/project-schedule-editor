// @req F-101, F-102, F-103, F-104, F-106, F-107, F-302, F-304
// DrawList: 表示範囲（行 × 日付）の描画命令と当たり判定の箱を作る純関数。docs/architecture.html 12.5。
// 座標はビューポート内のピクセル（スクロール適用済み）。ヘッダは (0, 0) 起点、本体はヘッダの下を (0, 0) 起点とする。
// DOM に依存しないので、アプリの Canvas・出力（SVG/PDF/HTML ビューア）・テストが同じ命令列を共有できる。
import { isDateStr, toDays, weekdayOfDay } from '../date';
import type { Dependency, Id, Schedule } from '../model';
import { shortfallDays } from '../validate';
import { HEADER_FONT_SIZE, buildHeader, dayToX, estimateTextWidth, xToDay, type HeaderMode, type Viewport } from './axis';
import { assignLanes, itemDays, visibleRowRange, type Layout } from './layout';

export type Shape = 'diamond' | 'circle' | 'triangle' | 'square' | 'star' | 'flag';

export type DrawItem =
  | { readonly t: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly fill?: string; readonly stroke?: string; readonly lineWidth?: number; readonly radius?: number; readonly alpha?: number; readonly pattern?: 'striped' }
  | { readonly t: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly color: string; readonly width: number; readonly dash?: number }
  | { readonly t: 'poly'; readonly points: readonly number[]; readonly color: string; readonly width: number; readonly arrow?: boolean }
  | { readonly t: 'marker'; readonly shape: Shape; readonly cx: number; readonly cy: number; readonly size: number; readonly fill: string; readonly stroke?: string }
  | { readonly t: 'text'; readonly x: number; readonly y: number; readonly text: string; readonly color: string; readonly size: number; readonly align: 'left' | 'center' | 'right'; readonly clipW?: number };

export interface HitBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly kind: 'event' | 'milestone';
  readonly id: Id;
  readonly projectId: Id;
}

export interface DrawList {
  readonly width: number;
  /** ヘッダを含む全体の高さ。 */
  readonly height: number;
  readonly headerHeight: number;
  readonly background: string;
  readonly header: readonly DrawItem[];
  readonly body: readonly DrawItem[];
  readonly hitBoxes: readonly HitBox[];
  readonly stats: { readonly rows: number; readonly items: number; readonly deps: number };
}

export interface Theme {
  readonly bg: string;
  readonly headerBg: string;
  readonly text: string;
  readonly onColor: string;
  readonly grid: string;
  readonly gridStrong: string;
  readonly weekend: string;
  readonly today: string;
  readonly rowLine: string;
  readonly selection: string;
  readonly hover: string;
  readonly dep: string;
  readonly depViolation: string;
  readonly palette: readonly string[];
}

export const lightTheme: Theme = {
  bg: '#ffffff', headerBg: '#f5f7fa', text: '#1f2933', onColor: '#ffffff', grid: '#eef1f5', gridStrong: '#cbd2d9', weekend: '#f3f4f6', today: '#e03131',
  rowLine: '#d9e2ec', selection: '#f08c00', hover: '#74c0fc', dep: '#5f6b7a', depViolation: '#e03131',
  palette: ['#2364aa', '#2d7d46', '#c0392b', '#8e44ad', '#d68910', '#16a085', '#7f8c8d', '#b03a6e'],
};

export const darkTheme: Theme = {
  bg: '#161b22', headerBg: '#1f252d', text: '#e4e7eb', onColor: '#0b0f14', grid: '#222a33', gridStrong: '#3a4552', weekend: '#1b222b', today: '#ff6b6b',
  rowLine: '#30363d', selection: '#ffa94d', hover: '#4dabf7', dep: '#9aa5b1', depViolation: '#ff6b6b',
  palette: ['#6cb2ff', '#51cf66', '#ff8787', '#b197fc', '#ffa94d', '#38d9a9', '#adb5bd', '#f783ac'],
};

export const HEADER_ROW_HEIGHT = 22;
export const HEADER_HEIGHT = HEADER_ROW_HEIGHT * 2;

export interface TimelineViewport extends Viewport {
  /** 本体（ヘッダを除く）の高さ。 */
  readonly height: number;
  readonly scrollY: number;
}

export interface DrawOptions {
  readonly viewport: TimelineViewport;
  readonly headerMode: HeaderMode;
  /** 今日（YYYY-MM-DD）。指定すると今日線を引く。 */
  readonly today?: string;
  readonly selection?: ReadonlySet<Id>;
  readonly hover?: Id | null;
  /** 依存線の表示（F-304）。既定は全て。 */
  readonly dependencies?: 'all' | 'selected' | 'none';
  readonly theme?: Theme;
  /** 稼働日でない日か（通算日数。祝日・会社の休日・休みの曜日。F-603）。指定すると、週末の代わりにこの日を塗る。 */
  readonly nonWorkingDay?: (day: number) => boolean;
}

/** 種別の色。種別マスタに無ければ、種別名から決めた既定のパレット色（同じ名前は常に同じ色）。 */
export function colorForType(type: string, types: Schedule['types'], theme: Theme = lightTheme): string {
  const def = types[type]?.color;
  if (def) return def;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return theme.palette[h % theme.palette.length] ?? theme.palette[0]!;
}

interface Analysis {
  readonly deps: readonly Dependency[];
  readonly dates: ReadonlyMap<Id, { readonly s: number; readonly e: number; readonly milestone: boolean }>;
  readonly violations: ReadonlySet<Id>;
}

const analysisCache = new WeakMap<Schedule, Analysis>();

/** スケジュールが変わらない限り再利用する（フレームごとに25,000件を走査しない）。 */
function analyze(s: Schedule): Analysis {
  const hit = analysisCache.get(s);
  if (hit) return hit;
  const dates = new Map<Id, { s: number; e: number; milestone: boolean }>();
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) if (isDateStr(e.start) && isDateStr(e.end)) dates.set(id, { s: toDays(e.start), e: toDays(e.end), milestone: false });
    for (const [id, m] of Object.entries(p.milestones)) if (isDateStr(m.date)) dates.set(id, { s: toDays(m.date), e: toDays(m.date), milestone: true });
  }
  const deps = Object.values(s.dependencies);
  const violations = new Set<Id>();
  for (const d of deps) {
    const f = dates.get(d.from.id);
    const t = dates.get(d.to.id);
    if (f && t && shortfallDays(d.type, d.lagDays, f.s, f.e, t.s, t.e) > 0) violations.add(d.id);
  }
  const a = { deps, dates, violations };
  analysisCache.set(s, a);
  return a;
}

const LABEL_SIZE = 11;
const ARROW_GAP = 8;

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** 依存線の直交する経路。a = 先行側の点、b = 後続側の点。fromEnd = 先行の右端から出る / toStart = 後続の左端へ入る。 */
function routeDependency(a: Pt, fromEnd: boolean, b: Pt, toStart: boolean, laneH: number): number[] {
  const dirA = fromEnd ? 1 : -1;
  const a1x = a.x + dirA * ARROW_GAP;
  const bpre = toStart ? b.x - ARROW_GAP : b.x + ARROW_GAP;
  let simpleX: number | null = null;
  if (fromEnd && toStart) simpleX = bpre >= a1x ? a1x : null; // FS
  else if (fromEnd && !toStart) simpleX = Math.max(a1x, bpre); // FF
  else if (!fromEnd && toStart) simpleX = Math.min(a1x, bpre); // SS
  else simpleX = a1x >= bpre ? a1x : null; // SF
  if (simpleX !== null) return [a.x, a.y, simpleX, a.y, simpleX, b.y, b.x, b.y];
  const ymid = a.y !== b.y ? (a.y + b.y) / 2 : a.y + laneH * 0.75; // 行・レーンをまたいで迂回する
  return [a.x, a.y, a1x, a.y, a1x, ymid, bpre, ymid, bpre, b.y, b.x, b.y];
}

export function buildDrawList(s: Schedule, layout: Layout, o: DrawOptions): DrawList {
  const theme = o.theme ?? lightTheme;
  const vp = o.viewport;
  const { width, height, scrollY, pxPerDay } = vp;
  const laneH = layout.laneHeight;
  const pad = layout.rowPad;
  const header: DrawItem[] = [];
  const bg: DrawItem[] = [];
  const items: DrawItem[] = [];
  const deps: DrawItem[] = [];
  const overlay: DrawItem[] = [];
  const hitBoxes: HitBox[] = [];
  const types = s.types;

  // --- ヘッダ ---
  const h = buildHeader(o.headerMode, vp);
  header.push({ t: 'rect', x: 0, y: 0, w: width, h: HEADER_HEIGHT, fill: theme.headerBg });
  const addHeaderLabel = (c: { x0: number; showLabel: boolean; label: string }, y: number): void => {
    if (c.showLabel) header.push({ t: 'text', x: Math.max(c.x0, 0) + 4, y, text: c.label, color: theme.text, size: HEADER_FONT_SIZE, align: 'left' });
  };
  for (const c of h.top) {
    header.push({ t: 'line', x1: c.x1, y1: 0, x2: c.x1, y2: HEADER_HEIGHT, color: theme.gridStrong, width: 1 });
    addHeaderLabel(c, HEADER_ROW_HEIGHT / 2);
  }
  for (const c of h.bottom) {
    header.push({ t: 'line', x1: c.x1, y1: HEADER_ROW_HEIGHT, x2: c.x1, y2: HEADER_HEIGHT, color: theme.gridStrong, width: 1 });
    addHeaderLabel(c, HEADER_ROW_HEIGHT * 1.5);
  }
  header.push({ t: 'line', x1: 0, y1: HEADER_HEIGHT - 0.5, x2: width, y2: HEADER_HEIGHT - 0.5, color: theme.gridStrong, width: 1 });
  if (h.bottom.length > 0) header.push({ t: 'line', x1: 0, y1: HEADER_ROW_HEIGHT, x2: width, y2: HEADER_ROW_HEIGHT, color: theme.gridStrong, width: 1 });

  // --- 背景: 週末・列の罫線・今日線 ---
  const d0 = Math.floor(xToDay(0, vp)) - 1;
  const d1 = Math.ceil(xToDay(width, vp));
  if (pxPerDay >= 3 && o.nonWorkingDay) {
    // 休みの日が続く間は 1 枚にまとめる
    let from = -1;
    for (let d = d0; d <= d1 + 1; d++) {
      const off = d <= d1 && o.nonWorkingDay(d);
      if (off && from < 0) from = d;
      else if (!off && from >= 0) {
        bg.push({ t: 'rect', x: dayToX(from, vp), y: 0, w: (d - from) * pxPerDay, h: height, fill: theme.weekend });
        from = -1;
      }
    }
  } else if (pxPerDay >= 3) {
    for (let d = d0 + ((6 - weekdayOfDay(d0) + 7) % 7); d <= d1; d += 7) {
      const x = dayToX(d, vp);
      if (x + 2 * pxPerDay > 0 && x < width) bg.push({ t: 'rect', x, y: 0, w: 2 * pxPerDay, h: height, fill: theme.weekend });
    }
  }
  const strong = new Set<number>();
  for (const c of h.top) strong.add(c.x1);
  for (const c of h.bottom) if (pxPerDay >= 1 && !strong.has(c.x1)) bg.push({ t: 'line', x1: c.x1, y1: 0, x2: c.x1, y2: height, color: theme.grid, width: 1 });
  for (const x of strong) if (x > 0 && x < width) bg.push({ t: 'line', x1: x, y1: 0, x2: x, y2: height, color: theme.gridStrong, width: 1 });
  if (o.today !== undefined && isDateStr(o.today)) {
    const x = dayToX(toDays(o.today) + 0.5, vp);
    if (x >= 0 && x <= width) bg.push({ t: 'line', x1: x, y1: 0, x2: x, y2: height, color: theme.today, width: 1.5 });
  }

  // --- 項目 ---
  const [first, last] = visibleRowRange(layout, scrollY, height);
  let itemCount = 0;
  for (let ri = first; ri < last; ri++) {
    const row = layout.rows[ri]!;
    const rowTop = row.y - scrollY;
    bg.push({ t: 'line', x1: 0, y1: rowTop + row.height, x2: width, y2: rowTop + row.height, color: theme.rowLine, width: 1 });
    const p = s.projects[row.projectId];
    if (!p) continue;
    const laneOf = assignLanes(p).laneOf;
    const days = itemDays(p);

    for (const [id, e] of Object.entries(p.events)) {
      const d = days.get(id);
      if (!d) continue;
      const x0 = dayToX(d.s, vp);
      const x1 = dayToX(d.e + 1, vp); // 終了日を含む: 右端は終了日の翌日
      if (x1 < 0 || x0 > width) continue;
      const laneTop = rowTop + pad + (laneOf.get(id) ?? 0) * laneH;
      const barY = laneTop + 2;
      const barH = laneH - 4;
      const w = Math.max(x1 - x0, 2);
      const color = e.color ?? colorForType(e.type, types, theme);
      const style = e.style ?? types[e.type]?.eventStyle ?? 'bar';
      itemCount++;
      hitBoxes.push({ x: x0, y: barY, w, h: barH, kind: 'event', id, projectId: p.id });
      let labelColor = theme.onColor;
      switch (style) {
        case 'bar':
          items.push({ t: 'rect', x: x0, y: barY, w, h: barH, fill: color });
          break;
        case 'roundBar':
          items.push({ t: 'rect', x: x0, y: barY, w, h: barH, fill: color, radius: barH / 2 });
          break;
        case 'striped':
          items.push({ t: 'rect', x: x0, y: barY, w, h: barH, fill: color, pattern: 'striped' });
          break;
        case 'outline':
          items.push({ t: 'rect', x: x0, y: barY, w, h: barH, stroke: color, lineWidth: 1.5 });
          labelColor = theme.text;
          break;
        case 'band':
          items.push({ t: 'rect', x: x0, y: laneTop + 1, w, h: laneH - 2, fill: color, alpha: 0.35 });
          labelColor = theme.text;
          break;
        case 'line': {
          const cy = barY + barH / 2;
          items.push({ t: 'line', x1: x0, y1: cy, x2: x0 + w, y2: cy, color, width: 2 });
          items.push({ t: 'rect', x: x0, y: barY + 2, w: 3, h: barH - 4, fill: color });
          items.push({ t: 'rect', x: x0 + w - 3, y: barY + 2, w: 3, h: barH - 4, fill: color });
          labelColor = theme.text;
          break;
        }
      }
      const textW = estimateTextWidth(e.name, LABEL_SIZE);
      if (w >= textW + 8) items.push({ t: 'text', x: x0 + 4, y: barY + barH / 2, text: e.name, color: labelColor, size: LABEL_SIZE, align: 'left', clipW: w - 8 });
      else if (pxPerDay >= 2 && x0 + w + 4 < width) items.push({ t: 'text', x: x0 + w + 4, y: barY + barH / 2, text: e.name, color: theme.text, size: LABEL_SIZE, align: 'left' });
    }

    for (const [id, m] of Object.entries(p.milestones)) {
      const d = days.get(id);
      if (!d) continue;
      const cx = dayToX(d.s + 0.5, vp);
      const size = laneH - 8;
      if (cx + size / 2 < 0 || cx - size / 2 > width) continue;
      const cy = rowTop + pad + (laneOf.get(id) ?? 0) * laneH + laneH / 2;
      const color = colorForType(m.type, types, theme);
      const style = m.style ?? types[m.type]?.milestoneStyle ?? 'diamond';
      itemCount++;
      if (style === 'labelOnly') {
        hitBoxes.push({ x: cx - size / 2, y: cy - size / 2, w: size + estimateTextWidth(m.name, LABEL_SIZE) + 3, h: size, kind: 'milestone', id, projectId: p.id });
        items.push({ t: 'text', x: cx - size / 2, y: cy, text: m.name, color, size: LABEL_SIZE, align: 'left' });
        continue;
      }
      hitBoxes.push({ x: cx - size / 2, y: cy - size / 2, w: size, h: size, kind: 'milestone', id, projectId: p.id });
      items.push({ t: 'marker', shape: style, cx, cy, size, fill: color, stroke: theme.text });
      if (pxPerDay >= 3) items.push({ t: 'text', x: cx + size / 2 + 3, y: cy, text: m.name, color: theme.text, size: LABEL_SIZE, align: 'left' });
    }
  }

  // --- 依存線 ---
  let depCount = 0;
  const mode = o.dependencies ?? 'all';
  if (mode !== 'none' && Object.keys(s.dependencies).length > 0) {
    const a = analyze(s);
    const margin = 24;
    const sel = o.selection;
    const geom = (id: Id): { cy: number; x0: number; x1: number } | null => {
      const pos = layout.itemPos.get(id);
      const dt = a.dates.get(id);
      if (!pos || !dt) return null;
      const row = layout.rows[pos.row]!;
      const cy = row.y - scrollY + pad + pos.lane * laneH + laneH / 2;
      if (dt.milestone) {
        const cx = dayToX(dt.s + 0.5, vp);
        return { cy, x0: cx - (laneH - 8) / 2, x1: cx + (laneH - 8) / 2 };
      }
      return { cy, x0: dayToX(dt.s, vp), x1: dayToX(dt.e + 1, vp) };
    };
    for (const d of a.deps) {
      if (mode === 'selected' && !(sel?.has(d.from.id) || sel?.has(d.to.id))) continue;
      const f = geom(d.from.id);
      const t = geom(d.to.id);
      if (!f || !t) continue;
      if ((f.cy < -margin && t.cy < -margin) || (f.cy > height + margin && t.cy > height + margin)) continue;
      const fromEnd = d.type === 'FS' || d.type === 'FF';
      const toStart = d.type === 'FS' || d.type === 'SS';
      const A = { x: fromEnd ? f.x1 : f.x0, y: f.cy };
      const B = { x: toStart ? t.x0 : t.x1, y: t.cy };
      if (Math.max(A.x, B.x) < -margin || Math.min(A.x, B.x) > width + margin) continue;
      const violated = a.violations.has(d.id);
      const emphasized = mode === 'selected' || (sel?.has(d.from.id) ?? false) || (sel?.has(d.to.id) ?? false);
      deps.push({ t: 'poly', points: routeDependency(A, fromEnd, B, toStart, laneH), color: violated ? theme.depViolation : theme.dep, width: violated || emphasized ? 1.75 : 1, arrow: true });
      depCount++;
    }
  }

  // --- 選択・ホバー（最前面）---
  if (o.selection && o.selection.size > 0) {
    for (const b of hitBoxes) if (o.selection.has(b.id)) overlay.push({ t: 'rect', x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4, stroke: theme.selection, lineWidth: 2, radius: 3 });
  }
  if (o.hover) {
    for (const b of hitBoxes) if (b.id === o.hover) overlay.push({ t: 'rect', x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2, stroke: theme.hover, lineWidth: 1.5, radius: 3 });
  }

  return {
    width,
    height: HEADER_HEIGHT + height,
    headerHeight: HEADER_HEIGHT,
    background: theme.bg,
    header,
    body: [...bg, ...items, ...deps, ...overlay],
    hitBoxes,
    stats: { rows: last - first, items: itemCount, deps: depCount },
  };
}
