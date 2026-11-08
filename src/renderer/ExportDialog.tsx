// @req F-601, F-606, F-607, F-608
// 出力（HTML ビューア・PNG・SVG・PDF）。範囲・期間・オプションを選んで保存する。組み立ては domain/export/、保存は Main。
import { useMemo, useState } from 'react';
import {
  buildImageDrawList,
  buildSnapshot,
  defaultSnapshotOptions,
  draw,
  drawListToSvg,
  fitPxPerDay,
  scheduleFromSnapshot,
  toDays,
  type Calendar,
  type Canvas2D,
  type DateStr,
  type HeaderMode,
  type Id,
  type Schedule,
} from '@domain/index';
import { t } from './i18n';

/** タイムライン側が出力ダイアログへ渡す、表示中の状態。 */
export interface TimelineApi {
  visibleRange(): { from: DateStr; to: DateStr };
  selectedProjectId(): Id | null;
  headerMode(): HeaderMode;
  /** 項目（またはプロジェクト）を選択して、その位置へ移動する（AI の提案・指摘のリンク。F-706）。 */
  jumpTo(id: Id): void;
}

type Format = 'html' | 'png' | 'svg' | 'pdf';
type Scope = 'all' | 'project' | 'view';

const NAME_COLUMN_ALLOWANCE = 300;

async function pngBase64(dl: Parameters<typeof draw>[1], scale: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(dl.width * scale);
  canvas.height = Math.ceil(dl.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を作れませんでした');
  ctx.scale(scale, scale);
  draw(ctx as unknown as Canvas2D, dl);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('画像を作れませんでした（大きすぎる可能性があります。倍率や期間を小さくしてください）');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function ExportDialog({ schedule, calendar, versionLabel, api, onDone, onClose }: { schedule: Schedule; calendar: Calendar; versionLabel: string; api: TimelineApi | null; onDone: (message: string) => void; onClose: () => void }) {
  const selectedProject = api?.selectedProjectId() ?? null;
  const [format, setFormat] = useState<Format>('html');
  const [scope, setScope] = useState<Scope>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState(defaultSnapshotOptions().includeNotes);
  const [assignee, setAssignee] = useState(defaultSnapshotOptions().includeAssignee);
  const [deps, setDeps] = useState(true);
  const [headerMode, setHeaderMode] = useState<HeaderMode>(api?.headerMode() ?? 'weekMonth');
  const [density, setDensity] = useState(6);
  const [scale, setScale] = useState(2);
  const [paper, setPaper] = useState<'A4' | 'A3'>('A3');
  const [landscape, setLandscape] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const scopeArg = useMemo(() => {
    const view = scope === 'view' ? api?.visibleRange() : undefined;
    return {
      ...(scope === 'project' && selectedProject ? { projectIds: [selectedProject] } : {}),
      ...(view ? { from: view.from, to: view.to } : from || to ? { ...(from ? { from } : {}), ...(to ? { to } : {}) } : {}),
    };
  }, [scope, api, selectedProject, from, to]);

  const go = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      const meta = { generatedAt: new Date().toISOString(), label: versionLabel, title: t('exp.docTitle') };
      const snap = buildSnapshot(schedule, calendar, scopeArg, { includeNotes: notes, includeAssignee: assignee, dependencies: deps, headerMode }, meta);
      if (!snap.range) {
        setError(t('exp.empty'));
        return;
      }
      let r;
      if (format === 'html') r = await window.api.invoke('export:html', { payload: JSON.stringify(snap), title: meta.title });
      else {
        const parsed = scheduleFromSnapshot(JSON.parse(JSON.stringify(snap)));
        if (!parsed) throw new Error('出力するデータを作れませんでした');
        const rangeFrom = scopeArg.from ?? snap.range.from;
        const rangeTo = scopeArg.to ?? snap.range.to;
        const days = toDays(rangeTo) - toDays(rangeFrom) + 1;
        const px = fitPxPerDay(days, density, NAME_COLUMN_ALLOWANCE, format === 'png' ? scale : 1);
        const dl = buildImageDrawList(parsed.schedule, { from: rangeFrom, to: rangeTo, pxPerDay: px, headerMode, dependencies: deps, calendar });
        if (format === 'svg') r = await window.api.invoke('export:file', { kind: 'svg', data: drawListToSvg(dl) });
        else if (format === 'pdf') r = await window.api.invoke('export:pdf', { svg: drawListToSvg(dl), paper, landscape });
        else r = await window.api.invoke('export:file', { kind: 'png', data: await pngBase64(dl, scale) });
      }
      if (r.status === 'ok') {
        onDone(t('exp.done', { path: r.path }));
        onClose();
      } else if (r.status === 'failed') setError(t('exp.failed', { message: r.message }));
    } catch (e) {
      setError(t('exp.failed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const radio = (name: string, value: string, current: string, set: (v: never) => void, label: string, disabled = false) => (
    <label key={value}>
      <input type="radio" name={name} data-testid={`exp-${name}-${value}`} checked={current === value} disabled={disabled} onChange={() => set(value as never)} /> {label}
    </label>
  );

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-export">
        <h2>{t('exp.title')}</h2>
        <fieldset className="field">
          <legend>{t('exp.format')}</legend>
          {radio('format', 'html', format, setFormat, t('exp.fmtHtml'))}
          {radio('format', 'pdf', format, setFormat, t('exp.fmtPdf'))}
          {radio('format', 'png', format, setFormat, t('exp.fmtPng'))}
          {radio('format', 'svg', format, setFormat, t('exp.fmtSvg'))}
        </fieldset>
        <fieldset className="field">
          <legend>{t('exp.scope')}</legend>
          {radio('scope', 'all', scope, setScope, t('exp.scopeAll'))}
          {radio('scope', 'project', scope, setScope, t('exp.scopeProject'), !selectedProject)}
          {radio('scope', 'view', scope, setScope, t('exp.scopeView'), !api)}
          <label>
            {t('cmp.period')} <input type="date" data-testid="exp-from" aria-label={t('cmp.from')} value={from} disabled={scope === 'view'} onChange={(e) => setFrom(e.target.value)} /> ～{' '}
            <input type="date" data-testid="exp-to" aria-label={t('cmp.to')} value={to} disabled={scope === 'view'} onChange={(e) => setTo(e.target.value)} />
          </label>
        </fieldset>
        <fieldset className="field">
          <legend>{t('exp.options')}</legend>
          <label>
            <input type="checkbox" data-testid="exp-deps" checked={deps} onChange={(e) => setDeps(e.target.checked)} /> {t('exp.deps')}
          </label>
          <label>
            {t('exp.header')}{' '}
            <select data-testid="exp-header" value={headerMode} onChange={(e) => setHeaderMode(e.target.value as HeaderMode)}>
              <option value="weekMonth">{t('exp.headerWeek')}</option>
              <option value="month">{t('exp.headerMonth')}</option>
            </select>
          </label>
          {format === 'html' ? (
            <>
              <label>
                <input type="checkbox" data-testid="exp-notes" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> {t('exp.notes')}
              </label>
              <label>
                <input type="checkbox" data-testid="exp-assignee" checked={assignee} onChange={(e) => setAssignee(e.target.checked)} /> {t('exp.assignee')}
              </label>
            </>
          ) : (
            <label>
              {t('exp.density')}{' '}
              <select data-testid="exp-density" value={density} onChange={(e) => setDensity(Number(e.target.value))}>
                <option value={2}>{t('exp.densityLow')}</option>
                <option value={6}>{t('exp.densityMid')}</option>
                <option value={12}>{t('exp.densityHigh')}</option>
              </select>
            </label>
          )}
          {format === 'png' ? (
            <label>
              {t('exp.scale')}{' '}
              <select data-testid="exp-scale" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={3}>3x</option>
              </select>
            </label>
          ) : null}
          {format === 'pdf' ? (
            <>
              <label>
                {t('exp.paper')}{' '}
                <select data-testid="exp-paper" value={paper} onChange={(e) => setPaper(e.target.value as 'A4' | 'A3')}>
                  <option>A3</option>
                  <option>A4</option>
                </select>
              </label>
              <label>
                <input type="checkbox" data-testid="exp-landscape" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} /> {t('exp.landscape')}
              </label>
              <p className="hint">{t('exp.pdfHint')}</p>
            </>
          ) : null}
        </fieldset>
        {format === 'html' ? (
          <p className="notice-plain" role="note" data-testid="exp-warning">
            {t('exp.htmlWarning')}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="issues" data-testid="exp-error">
            {error}
          </p>
        ) : null}
        {busy ? <p role="status">{t('exp.busy')}</p> : null}
        <div className="actions">
          <button type="button" data-testid="exp-go" disabled={busy} onClick={() => void go()}>
            {t('exp.go')}
          </button>
          <button type="button" data-testid="exp-cancel" disabled={busy} onClick={onClose}>
            {t('sync.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
