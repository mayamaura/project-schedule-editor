// @req F-212, NF-009
// コマンドパレット（Ctrl+K）。全操作を名前で検索して実行する。ショートカットの一覧も兼ねる。
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { filterCmds, type Cmd } from './shortcuts';

export function CommandPalette({ cmds, onClose }: { cmds: readonly Cmd[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = filterCmds(cmds, query);
  const box = useRef<HTMLUListElement>(null);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    box.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runAt = (c: Cmd | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) onClose();
    else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, list.length - 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
    else if (e.key === 'Enter') runAt(list[active]);
    else return;
    e.preventDefault();
  };

  return (
    <div className="modal-back palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label={t('palette.title')} data-testid="palette" onKeyDown={onKeyDown}>
        <input autoFocus data-testid="palette-input" placeholder={t('palette.placeholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul ref={box} role="listbox" data-testid="palette-list">
          {list.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} data-testid="palette-item" onMouseMove={() => setActive(i)} onClick={() => runAt(c)}>
              <span className="grp">{c.group}</span>
              <span className="lbl">{c.label}</span>
              {c.shortcut ? <kbd>{c.shortcut}</kbd> : null}
            </li>
          ))}
          {list.length === 0 ? <li className="mut">{t('palette.empty')}</li> : null}
        </ul>
        <p className="mut palette-hint">{t('palette.hint')}</p>
      </div>
    </div>
  );
}
