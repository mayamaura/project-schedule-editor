// @req F-104, F-107
// 日付軸・ズーム・日付ヘッダ（年月週 / 年月）。docs/architecture.html 12.2, 12.3 / ui-design 1.5。
// x = (日 − leftDay) × pxPerDay。日は 1970-01-01 からの通算日数（小数可）。DOM 非依存の純関数。
import { civilFromDays, daysFromCivil, firstMondayOnOrAfter, mondayOfDay } from '../date';

/** 横方向の表示範囲。leftDay = 左端の日付、pxPerDay = 1日の幅（px）、width = 表示幅（px）。 */
export interface Viewport {
  readonly leftDay: number;
  readonly pxPerDay: number;
  readonly width: number;
}

/** ズームの上限（仮定）: 48 なら約1週間が336px。下限（MIN_PX_PER_DAY）は日付ヘッダの値が消えない幅で、下で定義する。 */
export const MAX_PX_PER_DAY = 48;

export const dayToX = (day: number, v: Viewport): number => (day - v.leftDay) * v.pxPerDay;
export const xToDay = (x: number, v: Viewport): number => x / v.pxPerDay + v.leftDay;

export const clampPxPerDay = (px: number): number => Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, px));

/** anchorX（px）の下にある日付を動かさずに、factor 倍に拡縮する。 */
export function zoomAt(v: Viewport, factor: number, anchorX: number): Viewport {
  const pxPerDay = clampPxPerDay(v.pxPerDay * factor);
  const anchorDay = xToDay(anchorX, v);
  return { ...v, pxPerDay, leftDay: anchorDay - anchorX / pxPerDay };
}

/** dxPx だけ右へドラッグしたとき（正 = 過去へ戻る）。 */
export function panX(v: Viewport, dxPx: number): Viewport {
  return { ...v, leftDay: v.leftDay - dxPx / v.pxPerDay };
}

/** 文字幅の推定（全角 = 1em、半角 = 0.55em）。描画時は幅でクリップするので厳密でなくてよい。 */
export function estimateTextWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0xff ? size : size * 0.55;
  return w;
}

export type HeaderMode = 'weekMonth' | 'month';

export interface HeaderCell {
  readonly x0: number;
  readonly x1: number;
  readonly label: string;
  /** セルの幅にラベルが収まるか（収まらなければ文字を出さない）。 */
  readonly showLabel: boolean;
}

export interface Header {
  /** 上段（年月）。 */
  readonly top: readonly HeaderCell[];
  /** 下段（週。月曜日の「日」）。年月表示では空。 */
  readonly bottom: readonly HeaderCell[];
}

export const HEADER_FONT_SIZE = 11;

/**
 * 縮小の下限: 年月表示の月の値（最も長い 'YY/M 形式）が、最も短い月（28日）の列に収まる幅。
 * これより縮小できないので、ヘッダの日付の値は消えない。
 */
export const MIN_PX_PER_DAY = Math.ceil(((estimateTextWidth("'99/12", HEADER_FONT_SIZE) + 6) / 28) * 100) / 100;
/** 年月週表示で、週の値（日。2桁）が全ての週の列に収まる最小の幅。これ未満では年月表示に切り替える。 */
export const WEEK_MODE_MIN_PX_PER_DAY = Math.ceil(((estimateTextWidth('30', HEADER_FONT_SIZE) + 6) / 7) * 100) / 100;

/** 選んだ表示方法と現在のズームから、実際に使う表示方法を決める（年月週を選んでいても、週の値が消える縮小では年月）。 */
export function effectiveHeaderMode(chosen: HeaderMode, pxPerDay: number): HeaderMode {
  return chosen === 'weekMonth' && pxPerDay >= WEEK_MODE_MIN_PX_PER_DAY ? 'weekMonth' : 'month';
}

const cell = (x0: number, x1: number, label: string): HeaderCell => ({ x0, x1, label, showLabel: x1 - x0 >= estimateTextWidth(label, HEADER_FONT_SIZE) + 6 });

const yy = (y: number): string => String(y % 100).padStart(2, '0');
const nextMonth = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1]);

/** 上段のラベル: 表示中の最初の列と1月だけ 'YY/M、他は M。 */
function monthLabel(y: number, m: number, first: boolean): string {
  return first || m === 1 ? `'${yy(y)}/${m}` : String(m);
}

export function buildHeader(mode: HeaderMode, v: Viewport): Header {
  const leftDay = Math.floor(xToDay(0, v));
  const rightDay = Math.ceil(xToDay(v.width, v));
  const top: HeaderCell[] = [];
  const bottom: HeaderCell[] = [];

  if (mode === 'weekMonth') {
    // 下段: 表示範囲にかかる週（月曜日の「日」）
    for (let mon = mondayOfDay(leftDay); mon <= rightDay; mon += 7) {
      const x0 = dayToX(mon, v);
      if (x0 >= v.width) break;
      bottom.push(cell(x0, dayToX(mon + 7, v), String(civilFromDays(mon)[2])));
    }
    // 上段: 月曜日の属する月でまとめる。境界は週の列（その月の最初の月曜日〜次の月の最初の月曜日）
    let [y, m] = civilFromDays(mondayOfDay(leftDay));
    for (;;) {
      const start = firstMondayOnOrAfter(daysFromCivil(y, m, 1));
      const [ny, nm] = nextMonth(y, m);
      const end = firstMondayOnOrAfter(daysFromCivil(ny, nm, 1));
      if (dayToX(start, v) >= v.width) break;
      if (dayToX(end, v) > 0) top.push(cell(dayToX(start, v), dayToX(end, v), monthLabel(y, m, top.length === 0)));
      [y, m] = [ny, nm];
    }
  } else {
    // 年月: 月の境界は実際の月初。幅は日数に比例
    let [y, m] = civilFromDays(leftDay);
    for (;;) {
      const start = daysFromCivil(y, m, 1);
      const [ny, nm] = nextMonth(y, m);
      const end = daysFromCivil(ny, nm, 1);
      if (dayToX(start, v) >= v.width) break;
      if (dayToX(end, v) > 0) top.push(cell(dayToX(start, v), dayToX(end, v), monthLabel(y, m, top.length === 0)));
      [y, m] = [ny, nm];
    }
  }
  return { top, bottom };
}
