// @req F-212, NF-009
// ボタンを押すと開くメニュー（ポップオーバー）。OS 標準のメニューバーは使わない。
// 項目は Cmd の一覧から作る（コマンドパレット・ショートカットと同じ定義）。文字列は小見出し。
import { useEffect, useRef, useState } from 'react';
import type { Cmd } from './shortcuts';

export type MenuEntry = Cmd | string;

export function MenuButton({ id, label, entries, className = '', align = 'left', ariaLabel }: { id: string; label: string; entries: readonly MenuEntry[]; className?: string; align?: 'left' | 'right'; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const items = (): HTMLButtonElement[] => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    }
  };

  return (
    <span className={`menu ${className}`} ref={root} onKeyDown={onKeyDown}>
      <button type="button" ref={trigger} data-testid={`menu-${id}`} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((v) => !v)}>
        {label} {label === '…' ? '' : '▾'}
      </button>
      {open ? (
        <div className={`menu-pop ${align}`} role="menu">
          {entries.map((x, i) =>
            typeof x === 'string' ? (
              <div className="menu-head" key={`h${i}`} role="presentation">
                {x}
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                key={x.id}
                data-testid={x.testid}
                disabled={x.enabled === false}
                onClick={() => {
                  setOpen(false);
                  x.run();
                }}
              >
                <span>{x.label}</span>
                {x.shortcut ? <kbd>{x.shortcut}</kbd> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}
