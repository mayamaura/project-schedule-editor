// @req F-603
// カレンダー設定（祝日・稼働日）の画面。計算は domain/calendar.ts。
import { useState } from 'react';
import { japaneseHolidays, type Calendar } from '@domain/index';
import { t } from './i18n';

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function DateList({ title, hint, items, onChange, testId }: { title: string; hint: string; items: Readonly<Record<string, string>>; onChange: (v: Record<string, string>) => void; testId: string }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const rows = Object.entries(items).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <fieldset className="field" data-testid={testId}>
      <legend>{title}</legend>
      <p className="hint">{hint}</p>
      <ul className="cal-list">
        {rows.map(([d, n]) => (
          <li key={d} data-testid={`${testId}-item`}>
            <span>{d}</span> <span>{n}</span>
            <button type="button" onClick={() => onChange(Object.fromEntries(rows.filter(([k]) => k !== d)))}>
              {t('tpl.remove')}
            </button>
          </li>
        ))}
      </ul>
      <div className="cal-add">
        <input type="date" aria-label={t('cal.date')} data-testid={`${testId}-date`} value={date} onChange={(e) => setDate(e.target.value)} />
        <input aria-label={t('cal.label')} placeholder={t('cal.label')} data-testid={`${testId}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          data-testid={`${testId}-add`}
          disabled={date === ''}
          onClick={() => {
            onChange({ ...items, [date]: name.trim() });
            setDate('');
            setName('');
          }}
        >
          {t('cal.add')}
        </button>
      </div>
    </fieldset>
  );
}

export function CalendarDialog({ calendar, onSave, onClose }: { calendar: Calendar; onSave: (c: Calendar) => Promise<string | null>; onClose: () => void }) {
  const [draft, setDraft] = useState<Calendar>(calendar);
  const [error, setError] = useState('');
  const year = new Date().getFullYear();
  const upcoming = Object.entries({ ...japaneseHolidays(year), ...japaneseHolidays(year + 1) }).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-calendar">
        <h2>{t('cal.title')}</h2>
        <label>
          <input type="checkbox" data-testid="cal-jp" checked={draft.japaneseHolidays} onChange={(e) => setDraft({ ...draft, japaneseHolidays: e.target.checked })} /> {t('cal.japanese')}
        </label>
        <fieldset className="field">
          <legend>{t('cal.weekend')}</legend>
          {DAY_NAMES.map((n, i) => (
            <label key={n} className="cal-day">
              <input
                type="checkbox"
                data-testid={`cal-weekend-${i}`}
                checked={draft.weekend.includes(i)}
                onChange={(e) => setDraft({ ...draft, weekend: e.target.checked ? [...draft.weekend, i].sort() : draft.weekend.filter((x) => x !== i) })}
              />
              {n}
            </label>
          ))}
        </fieldset>
        <DateList title={t('cal.holidays')} hint={t('cal.holidaysHint')} items={draft.holidays} onChange={(holidays) => setDraft({ ...draft, holidays })} testId="cal-holidays" />
        <DateList title={t('cal.workdays')} hint={t('cal.workdaysHint')} items={draft.workdays} onChange={(workdays) => setDraft({ ...draft, workdays })} testId="cal-workdays" />
        <details>
          <summary>{t('cal.preview', { from: String(year), to: String(year + 1) })}</summary>
          <ul className="cal-list" data-testid="cal-preview">
            {upcoming.map(([d, n]) => (
              <li key={d}>
                {d} {n}
              </li>
            ))}
          </ul>
        </details>
        {error ? (
          <p role="alert" className="issues" data-testid="cal-error">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            data-testid="cal-save"
            onClick={() =>
              void onSave(draft).then((e) => {
                if (e) setError(e);
                else onClose();
              })
            }
          >
            {t('tpl.save')}
          </button>
          <button type="button" data-testid="cal-cancel" onClick={onClose}>
            {t('sync.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
