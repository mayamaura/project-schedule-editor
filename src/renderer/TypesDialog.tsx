// @req F-106
// 種別の管理（設定）。種別マスタの追加・名前の変更・色・削除。項目の種別は詳細パネルでここの候補から 1 つ選ぶ。
import { useState } from 'react';
import { colorForType, typeUsage, type Command, type Schedule } from '@domain/index';
import { t } from './i18n';

type Commit = (c: Command) => string | null;
const HEX = /^#[0-9a-f]{6}$/i;

export function TypesDialog({ schedule, commit, onClose }: { schedule: Schedule; commit: Commit; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const rows = [...typeUsage(schedule)];
  const run = (c: Command): void => setError(commit(c) ?? '');

  const rename = (from: string, to: string): void => {
    to = to.trim();
    if (to === '' || to === from) return;
    const cmds: Command[] = [];
    for (const p of Object.values(schedule.projects)) {
      for (const [id, x] of Object.entries(p.events)) if (x.type === from) cmds.push({ type: 'updateEvent', id, patch: { type: to } });
      for (const [id, x] of Object.entries(p.milestones)) if (x.type === from) cmds.push({ type: 'updateMilestone', id, patch: { type: to } });
    }
    const def = schedule.types[from];
    if (def) {
      if (!schedule.types[to]) cmds.push({ type: 'setType', id: to, def: { ...def, name: to } });
      cmds.push({ type: 'deleteType', id: from });
    }
    run({ type: 'batch', commands: cmds, label: t('types.rename') });
  };

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-types">
        <h2>{t('types.title')}</h2>
        <p className="hint">{t('types.help')}</p>
        <ul className="cal-list">
          {rows.map(([id, n]) => {
            const color = colorForType(id, schedule.types);
            return (
              <li key={id} data-testid="types-item">
                <input
                  type="color"
                  aria-label={t('types.color')}
                  value={HEX.test(color) ? color : '#2364aa'}
                  onChange={(e) => run({ type: 'setType', id, def: { ...(schedule.types[id] ?? { name: id }), name: id, color: e.target.value } })}
                />
                <input aria-label={t('types.name')} defaultValue={id} onBlur={(e) => rename(id, e.target.value)} />
                <span className="mut">{t('types.used', { n: String(n) })}</span>
                <button type="button" disabled={n > 0 || !schedule.types[id]} title={n > 0 ? t('types.inUse') : ''} onClick={() => run({ type: 'deleteType', id })}>
                  {t('tpl.remove')}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="cal-add">
          <input aria-label={t('types.name')} placeholder={t('types.name')} data-testid="types-new" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            data-testid="types-add"
            disabled={name.trim() === '' || rows.some(([k]) => k === name.trim())}
            onClick={() => {
              const id = name.trim();
              run({ type: 'setType', id, def: { name: id, color: colorForType(id, schedule.types) } });
              setName('');
            }}
          >
            {t('cal.add')}
          </button>
        </div>
        {error ? (
          <p role="alert" className="issues">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" data-testid="types-close" onClick={onClose}>
            {t('types.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
