// @req F-505, F-510
// 2 つの版の比較（どの日程がどう動いたか）。前後の位置をタイムライン上に重ねて見せ、後ろ倒しの一覧（遅れの大きい順）と
// プロジェクト・期間での絞り込みを持つ。計算は domain/compare.ts。履歴の変更要約（F-510）にも同じ画面を使う。
import { useEffect, useMemo, useState } from 'react';
import { addMonths, compareSchedules, delayedItems, filterChanges, fromDays, parseSchedule, toDays, type DateStr, type Id, type ItemChange, type Schedule } from '@domain/index';
import { t } from './i18n';

export interface CompareLogEntry {
  readonly hash: string;
  readonly date: string;
  readonly author: string;
  readonly message: string;
}

/** 比べる 2 つの版の指定: 履歴の版 / 現在の作業 / 履歴の版とその 1 つ前（履歴の変更要約）。 */
export type CompareTarget = { readonly kind: 'pair'; readonly beforeHash: string | null; readonly afterHash: string | 'current' } | { readonly kind: 'commit'; readonly hash: string };

const CURRENT = 'current';
const LABEL_W = 150;
const ROW_H = 22;
const HEAD_H = 22;
const CHART_W = 760;

function loadSchedule(files: Record<string, string> | null): Schedule | null {
  if (!files) return null;
  const p = parseSchedule(files);
  return p.status === 'ok' ? p.schedule : null;
}

const CHANGE_LABEL = { added: 'cmp.added', removed: 'cmp.removed', moved: 'cmp.moved', edited: 'cmp.edited' } as const;

function describeShift(c: ItemChange): string {
  if (c.change !== 'moved') return '';
  return c.shiftDays > 0 ? t('cmp.later', { n: String(c.shiftDays) }) : t('cmp.earlier', { n: String(-c.shiftDays) });
}

function CompareChart({ changes }: { changes: readonly ItemChange[] }) {
  const rows = changes.slice(0, 40);
  const days = rows.flatMap((c) => [c.old, c.new].flatMap((s) => (s ? [toDays(s.start), toDays(s.end)] : [])));
  if (days.length === 0) return null;
  const min = Math.min(...days) - 7;
  const max = Math.max(...days) + 8;
  const x = (d: number): number => LABEL_W + ((d - min) / (max - min)) * (CHART_W - LABEL_W);
  const ticks: DateStr[] = [];
  let m = `${fromDays(min).slice(0, 7)}-01`;
  while (toDays(m) <= max && ticks.length < 120) {
    if (toDays(m) >= min) ticks.push(m);
    m = addMonths(m, 1);
  }
  const bar = (s: { start: string; end: string }, y: number, cls: string, key: string, milestone: boolean) =>
    milestone ? (
      <polygon key={key} className={cls} points={`${x(toDays(s.start)) + 0.5},${y + 3} ${x(toDays(s.start)) + 6},${y + ROW_H / 2} ${x(toDays(s.start)) + 0.5},${y + ROW_H - 3} ${x(toDays(s.start)) - 5},${y + ROW_H / 2}`} />
    ) : (
      <rect key={key} className={cls} x={x(toDays(s.start))} y={y + 5} width={Math.max(3, x(toDays(s.end) + 1) - x(toDays(s.start)))} height={ROW_H - 10} rx={2} />
    );
  return (
    <svg className="cmp-chart" viewBox={`0 0 ${CHART_W} ${HEAD_H + rows.length * ROW_H}`} width="100%" role="img" aria-label={t('cmp.chartLabel')} data-testid="cmp-chart">
      <rect x={0} y={0} width={CHART_W} height={HEAD_H} className="cmp-head" />
      {ticks.map((d) => (
        <g key={d}>
          <line x1={x(toDays(d))} x2={x(toDays(d))} y1={HEAD_H - 6} y2={HEAD_H + rows.length * ROW_H} className="cmp-grid" />
          <text x={x(toDays(d)) + 2} y={HEAD_H - 8} className="cmp-tick">
            {d.slice(0, 7)}
          </text>
        </g>
      ))}
      {rows.map((c, i) => {
        const y = HEAD_H + i * ROW_H;
        const ms = c.kind === 'milestone';
        const cls = c.change === 'added' ? 'cmp-new add' : c.change === 'removed' ? 'cmp-old removed' : c.change === 'moved' ? (c.shiftDays > 0 ? 'cmp-new later' : 'cmp-new earlier') : 'cmp-new edit';
        return (
          <g key={c.id} data-testid="cmp-row">
            <text x={4} y={y + ROW_H / 2 + 4} className="cmp-label">
              {c.name.length > 14 ? `${c.name.slice(0, 13)}…` : c.name}
            </text>
            {c.old && c.change !== 'removed' ? bar(c.old, y, 'cmp-old', 'o', ms) : null}
            {c.old && c.change === 'removed' ? bar(c.old, y, cls, 'r', ms) : null}
            {c.new ? bar(c.new, y, cls, 'n', ms) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function CompareDialog({ target, log, current, onClose }: { target: CompareTarget; log: readonly CompareLogEntry[]; current: Schedule; onClose: () => void }) {
  const [beforeHash, setBeforeHash] = useState<string>(target.kind === 'pair' ? (target.beforeHash ?? log[0]?.hash ?? '') : '');
  const [afterHash, setAfterHash] = useState<string>(target.kind === 'pair' ? target.afterHash : target.hash);
  const [pair, setPair] = useState<{ before: Schedule | null; after: Schedule | null } | null>(null);
  const [project, setProject] = useState<Id | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [onlyDelayed, setOnlyDelayed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (target.kind === 'commit') {
        const r = await window.api.invoke('git:commitChange', { hash: target.hash });
        if (alive) setPair({ before: loadSchedule(r.before), after: loadSchedule(r.after) });
        return;
      }
      const get = async (h: string): Promise<Schedule | null> => (h === CURRENT ? current : h === '' ? null : loadSchedule(await window.api.invoke('git:filesAt', { hash: h })));
      const [b, a] = [await get(beforeHash), await get(afterHash)];
      if (alive) setPair({ before: b, after: a });
    })();
    return () => {
      alive = false;
    };
  }, [target, beforeHash, afterHash, current]);

  const all = useMemo(() => (pair?.after ? compareSchedules(pair.before ?? { ...pair.after, projects: {}, dependencies: {} }, pair.after) : []), [pair]);
  const projects = useMemo(() => [...new Map(all.map((c) => [c.projectId, c.projectName])).entries()], [all]);
  const filtered = useMemo(() => {
    const f = filterChanges(all, { ...(project ? { projectId: project } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    return onlyDelayed ? delayedItems(f) : f;
  }, [all, project, from, to, onlyDelayed]);
  const count = (k: ItemChange['change']): number => all.filter((c) => c.change === k).length;
  const label = (e: CompareLogEntry): string => `${new Date(e.date).toLocaleString('ja-JP')}　${e.message}`;
  const sel = (value: string, set: (v: string) => void, testId: string, withCurrent: boolean) => (
    <select data-testid={testId} value={value} onChange={(e) => set(e.target.value)}>
      {withCurrent ? <option value={CURRENT}>{t('cmp.current')}</option> : null}
      {log.map((e) => (
        <option key={e.hash} value={e.hash}>
          {label(e)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-compare">
        <h2>{target.kind === 'commit' ? t('cmp.titleCommit') : t('cmp.title')}</h2>
        {target.kind === 'pair' ? (
          <div className="cmp-pick">
            <label>
              {t('cmp.before')} {sel(beforeHash, setBeforeHash, 'cmp-before', false)}
            </label>
            <label>
              {t('cmp.after')} {sel(afterHash, setAfterHash, 'cmp-after', true)}
            </label>
          </div>
        ) : null}
        {pair && !pair.after ? <p role="alert">{t('cmp.unreadable')}</p> : null}
        <p data-testid="cmp-summary">{t('cmp.summary', { moved: String(count('moved')), added: String(count('added')), removed: String(count('removed')), edited: String(count('edited')) })}</p>
        <div className="cmp-filter">
          <label>
            {t('cmp.project')}{' '}
            <select data-testid="cmp-project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">{t('cmp.all')}</option>
              {projects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('cmp.period')} <input type="date" aria-label={t('cmp.from')} data-testid="cmp-from" value={from} onChange={(e) => setFrom(e.target.value)} /> ～{' '}
            <input type="date" aria-label={t('cmp.to')} data-testid="cmp-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <input type="checkbox" data-testid="cmp-delayed" checked={onlyDelayed} onChange={(e) => setOnlyDelayed(e.target.checked)} /> {t('cmp.onlyDelayed')}
          </label>
        </div>
        {filtered.length === 0 ? <p data-testid="cmp-none">{t('cmp.none')}</p> : null}
        <CompareChart changes={filtered} />
        <table className="cmp-table" data-testid="cmp-table">
          <thead>
            <tr>
              <th>{t('cmp.colProject')}</th>
              <th>{t('cmp.colItem')}</th>
              <th>{t('cmp.colChange')}</th>
              <th>{t('cmp.before')}</th>
              <th>{t('cmp.after')}</th>
              <th>{t('cmp.colShift')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} data-testid="cmp-item">
                <td>{c.projectName}</td>
                <td>
                  {c.kind === 'event' ? '▬' : '◆'} {c.name}
                </td>
                <td>{t(CHANGE_LABEL[c.change])}</td>
                <td>{c.old ? (c.old.start === c.old.end ? c.old.start : `${c.old.start}～${c.old.end}`) : ''}</td>
                <td>{c.new ? (c.new.start === c.new.end ? c.new.start : `${c.new.start}～${c.new.end}`) : ''}</td>
                <td className={c.shiftDays > 0 ? 'later' : 'earlier'}>{describeShift(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button type="button" data-testid="cmp-close" onClick={onClose}>
            {t('sync.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
