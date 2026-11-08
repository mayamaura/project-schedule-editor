// @req F-601, F-606
// DrawList → SVG。画面と同じ描画関数 draw を、SVG の要素を記録する偽の Canvas に対して呼ぶので、
// 見た目が画面と食い違わない（新しい描画コードを書かない）。文字は <text> のままで、検索・選択できる。
import { draw, type Canvas2D } from '../timeline/draw';
import type { DrawList } from '../timeline/drawlist';

const num = (n: number): string => String(Math.round(n * 100) / 100);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface State {
  fill: string;
  stroke: string;
  lineWidth: number;
  alpha: number;
  font: string;
  align: string;
  dash: number[];
  tx: number;
  ty: number;
}

/** Canvas2D の呼び出しを SVG に変換して記録する。draw が使う範囲だけを実装する。 */
export class SvgCanvas implements Canvas2D {
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign = 'left';
  textBaseline = 'middle';

  private tx = 0;
  private ty = 0;
  private dash: number[] = [];
  private d: string[] = [];
  private cx = 0;
  private cy = 0;
  private readonly out: string[] = [];
  private readonly defs: string[] = [];
  private clipCount = 0;
  private readonly stack: { state: State; groups: number }[] = [];

  private snapshot(): State {
    return { fill: this.fillStyle, stroke: this.strokeStyle, lineWidth: this.lineWidth, alpha: this.globalAlpha, font: this.font, align: this.textAlign, dash: this.dash, tx: this.tx, ty: this.ty };
  }

  save(): void {
    this.stack.push({ state: this.snapshot(), groups: 0 });
  }
  restore(): void {
    const f = this.stack.pop();
    if (!f) return;
    for (let i = 0; i < f.groups; i++) this.out.push('</g>');
    const s = f.state;
    this.fillStyle = s.fill;
    this.strokeStyle = s.stroke;
    this.lineWidth = s.lineWidth;
    this.globalAlpha = s.alpha;
    this.font = s.font;
    this.textAlign = s.align;
    this.dash = s.dash;
    this.tx = s.tx;
    this.ty = s.ty;
  }
  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }
  setLineDash(segments: number[]): void {
    this.dash = segments;
  }

  private pt(x: number, y: number): [number, number] {
    return [x + this.tx, y + this.ty];
  }
  beginPath(): void {
    this.d = [];
  }
  closePath(): void {
    this.d.push('Z');
  }
  moveTo(x: number, y: number): void {
    const [a, b] = this.pt(x, y);
    this.d.push(`M${num(a)} ${num(b)}`);
    this.cx = a;
    this.cy = b;
  }
  lineTo(x: number, y: number): void {
    const [a, b] = this.pt(x, y);
    this.d.push(`L${num(a)} ${num(b)}`);
    this.cx = a;
    this.cy = b;
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    const [p1x, p1y] = this.pt(x1, y1);
    const [p2x, p2y] = this.pt(x2, y2);
    const v0x = this.cx - p1x;
    const v0y = this.cy - p1y;
    const v2x = p2x - p1x;
    const v2y = p2y - p1y;
    const l0 = Math.hypot(v0x, v0y);
    const l2 = Math.hypot(v2x, v2y);
    if (l0 === 0 || l2 === 0 || radius <= 0) {
      this.d.push(`L${num(p1x)} ${num(p1y)}`);
      this.cx = p1x;
      this.cy = p1y;
      return;
    }
    const n0x = v0x / l0;
    const n0y = v0y / l0;
    const n2x = v2x / l2;
    const n2y = v2y / l2;
    const cos = n0x * n2x + n0y * n2y;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (angle < 1e-6 || Math.abs(Math.PI - angle) < 1e-6) {
      this.d.push(`L${num(p1x)} ${num(p1y)}`);
      this.cx = p1x;
      this.cy = p1y;
      return;
    }
    const dist = radius / Math.tan(angle / 2);
    const t1x = p1x + n0x * dist;
    const t1y = p1y + n0y * dist;
    const t2x = p1x + n2x * dist;
    const t2y = p1y + n2y * dist;
    const cross = n0x * n2y - n0y * n2x;
    this.d.push(`L${num(t1x)} ${num(t1y)}`, `A${num(radius)} ${num(radius)} 0 0 ${cross < 0 ? 1 : 0} ${num(t2x)} ${num(t2y)}`);
    this.cx = t2x;
    this.cy = t2y;
  }
  /** 円のみ（draw が使うのは全周の円）。 */
  arc(x: number, y: number, radius: number): void {
    const [a, b] = this.pt(x, y);
    this.d.push(`M${num(a + radius)} ${num(b)}`, `A${num(radius)} ${num(radius)} 0 1 1 ${num(a - radius)} ${num(b)}`, `A${num(radius)} ${num(radius)} 0 1 1 ${num(a + radius)} ${num(b)}`, 'Z');
  }
  rect(x: number, y: number, w: number, h: number): void {
    const [a, b] = this.pt(x, y);
    this.d.push(`M${num(a)} ${num(b)}`, `L${num(a + w)} ${num(b)}`, `L${num(a + w)} ${num(b + h)}`, `L${num(a)} ${num(b + h)}`, 'Z');
  }

  private paintAttrs(kind: 'fill' | 'stroke'): string {
    const alpha = this.globalAlpha !== 1 ? ` ${kind}-opacity="${num(this.globalAlpha)}"` : '';
    if (kind === 'fill') return `fill="${esc(this.fillStyle)}"${alpha}`;
    const dash = this.dash.length > 0 ? ` stroke-dasharray="${this.dash.map(num).join(' ')}"` : '';
    return `fill="none" stroke="${esc(this.strokeStyle)}" stroke-width="${num(this.lineWidth)}"${dash}${alpha}`;
  }
  fill(): void {
    if (this.d.length > 0) this.out.push(`<path d="${this.d.join('')}" ${this.paintAttrs('fill')}/>`);
  }
  stroke(): void {
    if (this.d.length > 0) this.out.push(`<path d="${this.d.join('')}" ${this.paintAttrs('stroke')}/>`);
  }
  clip(): void {
    const id = `c${this.clipCount++}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this.d.join('')}"/></clipPath>`);
    this.out.push(`<g clip-path="url(#${id})">`);
    const f = this.stack[this.stack.length - 1];
    if (f) f.groups++;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const [a, b] = this.pt(x, y);
    this.out.push(`<rect x="${num(a)}" y="${num(b)}" width="${num(w)}" height="${num(h)}" ${this.paintAttrs('fill')}/>`);
  }
  fillText(text: string, x: number, y: number): void {
    const [a, b] = this.pt(x, y);
    const size = /(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10';
    const family = this.font.replace(/^.*?px\s*/, '');
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' ? 'end' : 'start';
    this.out.push(`<text x="${num(a)}" y="${num(b)}" font-size="${size}" font-family="${esc(family)}" text-anchor="${anchor}" dominant-baseline="central" ${this.paintAttrs('fill')}>${esc(text)}</text>`);
  }

  toSvg(width: number, height: number): string {
    const w = num(width);
    const h = num(height);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${this.defs.join('')}</defs>${this.out.join('')}</svg>`;
  }
}

/** DrawList を SVG 文字列にする。 */
export function drawListToSvg(dl: DrawList): string {
  const c = new SvgCanvas();
  draw(c, dl);
  return c.toSvg(dl.width, dl.height);
}
