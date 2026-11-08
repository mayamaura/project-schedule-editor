// @req F-402, F-403
// 表示フィルタ（名称検索・状態・担当・タグ・期間）と、ビューの保存・切替。計算は domain/filter.ts・view.ts。
import { useState } from 'react';
import { isFilterActive, type SavedView, type ViewFilter } from '@domain/index';
import { t } from './i18n';

type Status = NonNullable<ViewFilter['statuses']>[number];
const STATUS: readonly [Status, 'panel.statusNotStarted' | 'panel.statusInProgress' | 'panel.statusDone' | 'panel.statusOnHold'][] = [
  ['notStarted', 'panel.statusNotStarted'],
  ['inProgress', 'panel.statusInProgress'],
  ['done', 'panel.statusDone'],
  ['onHold', 'panel.statusOnHold'],
];

function Multi({ label, values, selected, onChange, testId }: { label: string; values: readonly { value: string; label: string }[]; selected: readonly string[]; onChange: (v: string[]) => void; testId: string }) {
  return (
    <fieldset className="flt-group" data-testid={testId}>
      <legend>{label}</legend>
      {values.length === 0 ? <span className="hint">{t('flt.none')}</span> : null}
      {values.map((v) => (
        <label key={v.value}>
          <input type="checkbox" data-testid={`${testId}-${v.value}`} checked={selected.includes(v.value)} onChange={(e) => onChange(e.target.checked ? [...selected, v.value] : selected.filter((x) => x !== v.value))} /> {v.label}
        </label>
      ))}
    </fieldset>
  );
}

export function FilterBar({
  filter,
  onFilter,
  options,
  views,
  onApplyView,
  onSaveView,
  onDeleteView,
  canShare,
}: {
  filter: ViewFilter;
  onFilter: (f: ViewFilter) => void;
  options: { assignees: string[]; tags: string[] };
  views: readonly SavedView[];
  onApplyView: (v: SavedView) => void;
  onSaveView: (name: string, shared: boolean) => Promise<string | null>;
  onDeleteView: (v: SavedView) => void;
  canShare: boolean;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<ViewFilter>): void => onFilter({ ...filter, ...patch });
  return (
    <div className="filterbar" data-testid="filterbar">
      <label>
        {t('flt.text')} <input type="search" data-testid="flt-text" value={filter.text ?? ''} placeholder={t('flt.textHint')} onChange={(e) => set({ text: e.target.value })} />
      </label>
      <Multi label={t('flt.status')} testId="flt-status" values={STATUS.map(([v, k]) => ({ value: v, label: t(k) }))} selected={filter.statuses ?? []} onChange={(v) => set({ statuses: v as Status[] })} />
      <Multi label={t('flt.assignee')} testId="flt-assignee" values={options.assignees.map((a) => ({ value: a, label: a }))} selected={filter.assignees ?? []} onChange={(v) => set({ assignees: v })} />
      <Multi label={t('flt.tag')} testId="flt-tag" values={options.tags.map((a) => ({ value: a, label: a }))} selected={filter.tags ?? []} onChange={(v) => set({ tags: v })} />
      <label>
        {t('cmp.period')} <input type="date" aria-label={t('cmp.from')} data-testid="flt-from" value={filter.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /> ～{' '}
        <input type="date" aria-label={t('cmp.to')} data-testid="flt-to" value={filter.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
      </label>
      <button type="button" data-testid="flt-clear" disabled={!isFilterActive(filter)} onClick={() => onFilter({})}>
        {t('flt.clear')}
      </button>
      <span className="flt-views">
        <label>
          {t('flt.views')}{' '}
          <select
            data-testid="flt-view-select"
            value=""
            onChange={(e) => {
              const v = views.find((x) => x.id === e.target.value);
              if (v) onApplyView(v);
            }}
          >
            <option value="">{t('flt.viewPick')}</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.shared ? ` ${t('ai.shared')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <input aria-label={t('flt.viewName')} data-testid="flt-view-name" placeholder={t('flt.viewName')} value={name} onChange={(e) => setName(e.target.value)} />
        <label>
          <input type="checkbox" data-testid="flt-view-shared" checked={shared} disabled={!canShare} onChange={(e) => setShared(e.target.checked)} /> {t('flt.viewShare')}
        </label>
        <button
          type="button"
          data-testid="flt-view-save"
          disabled={name.trim() === ''}
          onClick={() =>
            void onSaveView(name.trim(), shared && canShare).then((e) => {
              setError(e ?? '');
              if (!e) setName('');
            })
          }
        >
          {t('flt.viewSave')}
        </button>
        {views.length > 0 ? (
          <details>
            <summary>{t('flt.viewManage')}</summary>
            <ul className="ai-list" data-testid="flt-view-list">
              {views.map((v) => (
                <li key={v.id}>
                  <span>
                    {v.name}
                    {v.shared ? ` ${t('ai.shared')}` : ''}
                  </span>
                  <button type="button" data-testid="flt-view-delete" onClick={() => window.confirm(t('flt.viewDeleteConfirm', { name: v.name })) && onDeleteView(v)}>
                    {t('tpl.delete')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {error ? (
          <span role="alert" className="issues">
            {error}
          </span>
        ) : null}
      </span>
    </div>
  );
}
