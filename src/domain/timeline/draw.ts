// @req F-101, F-102
// draw: DrawList を Canvas に描く。DOM の型に依存しない最小のインターフェース（Canvas2D）だけを使う。
// CanvasRenderingContext2D はこのインターフェースを満たす。同じ描画コードを、アプリ・出力用 Canvas・
// 閲覧専用ビューア（src/viewer）で共有でき、記録用の偽の Canvas で呼び出しを検証できる。docs/architecture.html 12.1。
import type { DrawItem, DrawList } from './drawlist';

export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  translate(x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

export const FONT_FAMILY = '"Yu Gothic UI", "Meiryo", system-ui, sans-serif';

type Item<T extends DrawItem['t']> = Extract<DrawItem, { t: T }>;

function roundedRectPath(c: Canvas2D, x: number, y: number, w: number, h: number, r0: number): void {
  const r = Math.min(r0, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function rect(c: Canvas2D, i: Item<'rect'>): void {
  const alpha = i.alpha ?? 1;
  if (alpha !== 1) c.globalAlpha = alpha;
  if (i.radius) roundedRectPath(c, i.x, i.y, i.w, i.h, i.radius);
  else {
    c.beginPath();
    c.rect(i.x, i.y, i.w, i.h);
  }
  if (i.fill) {
    c.fillStyle = i.fill;
    c.fill();
  }
  if (i.pattern === 'striped') {
    // 斜線（色だけに依存しない区別。NF-010）
    c.save();
    c.clip();
    c.strokeStyle = '#ffffff';
    c.globalAlpha = 0.35;
    c.lineWidth = 2;
    c.beginPath();
    for (let k = -i.h; k < i.w; k += 6) {
      c.moveTo(i.x + k, i.y + i.h);
      c.lineTo(i.x + k + i.h, i.y);
    }
    c.stroke();
    c.restore();
  }
  if (i.stroke) {
    c.strokeStyle = i.stroke;
    c.lineWidth = i.lineWidth ?? 1;
    c.stroke();
  }
  if (alpha !== 1) c.globalAlpha = 1;
}

function line(c: Canvas2D, i: Item<'line'>): void {
  c.beginPath();
  c.moveTo(i.x1, i.y1);
  c.lineTo(i.x2, i.y2);
  c.strokeStyle = i.color;
  c.lineWidth = i.width;
  c.setLineDash(i.dash ? [i.dash, i.dash] : []);
  c.stroke();
  if (i.dash) c.setLineDash([]);
}

function poly(c: Canvas2D, i: Item<'poly'>): void {
  const p = i.points;
  if (p.length < 4) return;
  c.beginPath();
  c.moveTo(p[0]!, p[1]!);
  for (let k = 2; k < p.length; k += 2) c.lineTo(p[k]!, p[k + 1]!);
  c.strokeStyle = i.color;
  c.lineWidth = i.width;
  c.stroke();
  if (!i.arrow) return;
  // 終点の矢印: 最後に動いた向きに三角形
  const ex = p[p.length - 2]!;
  const ey = p[p.length - 1]!;
  let k = p.length - 4;
  while (k >= 2 && p[k] === ex && p[k + 1] === ey) k -= 2;
  const dx = Math.sign(ex - p[k]!);
  const dy = Math.sign(ey - p[k + 1]!);
  if (dx === 0 && dy === 0) return;
  const s = 4 + i.width;
  c.beginPath();
  c.moveTo(ex, ey);
  c.lineTo(ex - dx * s - dy * (s / 2), ey - dy * s + dx * (s / 2));
  c.lineTo(ex - dx * s + dy * (s / 2), ey - dy * s - dx * (s / 2));
  c.closePath();
  c.fillStyle = i.color;
  c.fill();
}

function marker(c: Canvas2D, i: Item<'marker'>): void {
  const r = i.size / 2;
  const { cx, cy } = i;
  c.beginPath();
  switch (i.shape) {
    case 'diamond':
      c.moveTo(cx, cy - r);
      c.lineTo(cx + r, cy);
      c.lineTo(cx, cy + r);
      c.lineTo(cx - r, cy);
      c.closePath();
      break;
    case 'circle':
      c.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'triangle':
      c.moveTo(cx, cy - r);
      c.lineTo(cx + r, cy + r);
      c.lineTo(cx - r, cy + r);
      c.closePath();
      break;
    case 'square':
      c.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
      break;
    case 'star':
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 === 0 ? r : r * 0.45;
        if (k === 0) c.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        else c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      c.closePath();
      break;
    case 'flag': {
      const px = cx - r * 0.6;
      c.moveTo(px, cy + r);
      c.lineTo(px, cy - r);
      c.lineTo(cx + r, cy - r * 0.4);
      c.lineTo(px, cy + r * 0.2);
      break;
    }
  }
  c.fillStyle = i.fill;
  c.fill();
  if (i.stroke) {
    c.strokeStyle = i.stroke;
    c.lineWidth = 1;
    c.stroke();
  }
}

function text(c: Canvas2D, i: Item<'text'>): void {
  c.font = `${i.size}px ${FONT_FAMILY}`;
  c.fillStyle = i.color;
  c.textAlign = i.align;
  c.textBaseline = 'middle';
  if (i.clipW === undefined) {
    c.fillText(i.text, i.x, i.y);
    return;
  }
  c.save();
  c.beginPath();
  c.rect(i.align === 'left' ? i.x : i.align === 'center' ? i.x - i.clipW / 2 : i.x - i.clipW, i.y - i.size, i.clipW, i.size * 2);
  c.clip();
  c.fillText(i.text, i.x, i.y);
  c.restore();
}

function drawItems(c: Canvas2D, items: readonly DrawItem[]): void {
  for (const i of items) {
    switch (i.t) {
      case 'rect':
        rect(c, i);
        break;
      case 'line':
        line(c, i);
        break;
      case 'poly':
        poly(c, i);
        break;
      case 'marker':
        marker(c, i);
        break;
      case 'text':
        text(c, i);
        break;
    }
  }
}

/** DrawList を描く。呼び出し側が devicePixelRatio の変換（scale）を済ませておくこと。 */
export function draw(c: Canvas2D, dl: DrawList): void {
  c.fillStyle = dl.background;
  c.fillRect(0, 0, dl.width, dl.height);

  c.save();
  c.beginPath();
  c.rect(0, 0, dl.width, dl.headerHeight);
  c.clip();
  drawItems(c, dl.header);
  c.restore();

  c.save();
  c.translate(0, dl.headerHeight);
  c.beginPath();
  c.rect(0, 0, dl.width, dl.height - dl.headerHeight);
  c.clip();
  drawItems(c, dl.body);
  c.restore();
}
