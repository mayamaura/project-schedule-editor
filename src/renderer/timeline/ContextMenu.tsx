// @req F-209
// 右クリックメニュー（自前描画。OS 間で挙動を揃える。ui-design 2.5）。↑↓/Enter/Esc のキー操作に対応。
import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly run: () => void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: readonly MenuItem[]; onClose: () => void }) {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const away = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a + items.length - 1) % items.length);
    else if (e.key === 'Enter') {
      onClose();
      items[active]?.run();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div ref={ref} className="ctxmenu" role="menu" tabIndex={-1} style={{ left: x, top: y }} onKeyDown={onKeyDown} data-testid="ctxmenu">
      {items.map((it, i) => (
        <div
          key={it.label}
          role="menuitem"
          className={i === active ? 'on' : ''}
          onPointerEnter={() => setActive(i)}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
