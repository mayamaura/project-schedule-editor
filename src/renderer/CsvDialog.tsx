// @req F-602
// CSV の取り込み（プレビューつき）。表の読み取りは domain/csv.ts（Excel のファイルを足す場合も、表にしてここへ渡す）。
import { useMemo } from 'react';
import { importRows, type Command, type Schedule } from '@domain/index';
import { t } from './i18n';

export function CsvImportDialog({ fileName, rows, schedule, onApply, onClose }: { fileName: string; rows: readonly (readonly string[])[]; schedule: Schedule; onApply: (c: Command) => void; onClose: () => void }) {
  const r = useMemo(() => importRows(rows, schedule), [rows, schedule]);
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-csv">
        <h2>{t('csv.title', { name: fileName })}</h2>
        <p data-testid="csv-summary">{r.command ? t('csv.summary', { projects: String(r.counts.projects), events: String(r.counts.events), milestones: String(r.counts.milestones) }) : t('csv.nothing')}</p>
        <p className="hint">{t('csv.help')}</p>
        {r.errors.length > 0 ? (
          <>
            <h3>{t('csv.skipped', { count: String(r.errors.length) })}</h3>
            <ul className="changes" data-testid="csv-errors">
              {r.errors.slice(0, 50).map((e, i) => (
                <li key={i}>{t('csv.rowError', { row: String(e.row), message: e.message })}</li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="actions">
          <button
            type="button"
            data-testid="csv-go"
            disabled={!r.command}
            onClick={() => {
              if (r.command) onApply(r.command);
            }}
          >
            {t('csv.go')}
          </button>
          <button type="button" data-testid="csv-cancel" onClick={onClose}>
            {t('sync.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
