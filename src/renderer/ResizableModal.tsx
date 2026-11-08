// @req F-801
// 端・角をドラッグして大きさを変えられるダイアログ。初期状態は通常のダイアログと同じ大きさ（中央寄せのまま、ドラッグした分の 2 倍が幅・高さの変化になる）。
import { useRef, useState } from 'react';

type Side = 'l' | 'r' | 't' | 'b';
const HANDLES: readonly { readonly cls: string; readonly sides: readonly Side[] }[] = [
  { cls: 'r', sides: ['r'] },
  { cls: 'l', sides: ['l'] },
  { cls: 't', sides: ['t'] },
  { cls: 'b', sides: ['b'] },
  { cls: 'tl', sides: ['t', 'l'] },
  { cls: 'tr', sides: ['t', 'r'] },
  { cls: 'bl', sides: ['b', 'l'] },
  { cls: 'br', sides: ['b', 'r'] },
];
const MIN_W = 420;
const MIN_H = 320;

export function ResizableModal({ testId, children }: { testId: string; children: React.ReactNode }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; w: number; h: number; sides: readonly Side[] } | null>(null);

  const down = (e: React.PointerEvent, sides: readonly Side[]): void => {
    const el = frame.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight, sides };
  };
  const move = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const w = d.w + 2 * dx * (d.sides.includes('r') ? 1 : d.sides.includes('l') ? -1 : 0);
    const h = d.h + 2 * dy * (d.sides.includes('b') ? 1 : d.sides.includes('t') ? -1 : 0);
    setSize({ w: Math.round(Math.min(Math.max(w, MIN_W), window.innerWidth - 16)), h: Math.round(Math.min(Math.max(h, MIN_H), window.innerHeight - 16)) });
  };
  const up = (): void => {
    drag.current = null;
  };

  return (
    <div ref={frame} className={`modal-frame${size ? ' sized' : ''}`} style={size ? { width: size.w, height: size.h } : undefined}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid={testId}>
        {children}
      </div>
      {HANDLES.map((h) => (
        <div key={h.cls} className={`rz rz-${h.cls}`} data-testid={`rz-${h.cls}`} aria-hidden="true" onPointerDown={(e) => down(e, h.sides)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      ))}
    </div>
  );
}
