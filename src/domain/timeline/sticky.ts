// @req F-108
// 付箋の幅（日数）と折り返し。レーン割り当てがズームに依存しないよう、行数は基準のズーム（STICKY_REF_PX_PER_DAY）で見積もる。
// 実際の描画は、そのときの幅で折り返し、確保した行数に収まらない分は末尾を省略する。
import type { StickyData } from '../model';
import { estimateTextWidth } from './axis';

/** 幅（span）を指定しない付箋の既定の幅（日数）。 */
export const STICKY_SPAN_DAYS = 14;
export const STICKY_MAX_SPAN = 366;
export const STICKY_FONT_SIZE = 11;
export const STICKY_PAD_X = 5;
/** 行数を見積もるときの 1 日の幅（px）。初期ズームと同じ。 */
export const STICKY_REF_PX_PER_DAY = 8;
/** 描画する付箋の最小の幅（px）。日数が小さくても文字が潰れないように。 */
export const STICKY_MIN_W = 40;
/** 付箋が占めるレーンの最大数（これを超える本文は省略して表示し、全文は詳細パネルで見る）。 */
export const STICKY_MAX_LINES = 8;

export const stickySpan = (n: Pick<StickyData, 'span'>): number => n.span ?? STICKY_SPAN_DAYS;

/** 改行を守り、幅に収まるよう文字単位で折り返す（日本語は単語の区切りが無いため）。 */
export function wrapText(text: string, maxW: number, size: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    let w = 0;
    for (const ch of para) {
      const cw = estimateTextWidth(ch, size);
      if (w + cw > maxW && line !== '') {
        out.push(line);
        line = '';
        w = 0;
      }
      line += ch;
      w += cw;
    }
    out.push(line);
  }
  return out;
}

/** 基準のズームでの行数（= 占めるレーン数。1〜STICKY_MAX_LINES）。 */
export function stickyLanes(n: Pick<StickyData, 'text' | 'span'>): number {
  const w = Math.max(stickySpan(n) * STICKY_REF_PX_PER_DAY, STICKY_MIN_W) - STICKY_PAD_X * 2;
  return Math.min(STICKY_MAX_LINES, Math.max(1, wrapText(n.text, w, STICKY_FONT_SIZE).length));
}

/** 確保した行数に収まるように行を切り詰め、あふれたら最後の行を「…」で終える。 */
export function fitLines(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines];
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1] ?? ''}…`;
  return kept;
}
