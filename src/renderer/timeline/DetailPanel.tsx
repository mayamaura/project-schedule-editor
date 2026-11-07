// @req F-204, F-305, F-208
// 詳細パネル: 選択中の項目を入力欄で編集する。確定（Enter / フォーカスを外す / 日付・選択の変更）で 1 コマンドにする。
// 拒否された場合（終了＜開始・循環など）は理由が画面上部に出るので、入力欄は元の値に戻す。
import { useEffect, useState } from 'react';
import type { Command, Dependency, Id, Schedule } from '@domain/index';
import { t } from '../i18n';

export type Sel = { readonly kind: 'event' | 'milestone' | 'project'; readonly id: Id };
type Commit = (c: Command) => string | null;

function Field({ label, value, type = 'text', multiline, onCommit }: { label: string; value: string; type?: 'text' | 'date' | 'number'; multiline?: boolean; onCommit: (v: string) => string | null }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (v: string): void => {
    if (v !== value && onCommit(v) !== null) setDraft(value); // 拒否されたら元に戻す
  };
  const common = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      if (type === 'date' && e.target.value) commit(e.target.value);
    },
    onBlur: () => {
      if (type !== 'date') commit(draft);
    },
  };
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? <textarea rows={3} {...common} /> : <input type={type} {...common} onKeyDown={(e) => e.key === 'Enter' && commit(draft)} />}
    </label>
  );
}

function DepRow({ d, otherName, outgoing, commit }: { d: Dependency; otherName: string; outgoing: boolean; commit: Commit }) {
  return (
    <div className="dep" data-testid="dep-row">
      <div>{t(outgoing ? 'panel.depTo' : 'panel.depFrom', { name: otherName })}</div>
      <select aria-label={t('panel.depType')} value={d.type} onChange={(e) => commit({ type: 'updateDependency', id: d.id, patch: { type: e.target.value as Dependency['type'] } })}>
        {(['FS', 'SS', 'FF', 'SF'] as const).map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <Field label={t('panel.depLag')} type="number" value={String(d.lagDays)} onCommit={(v) => commit({ type: 'updateDependency', id: d.id, patch: { lagDays: Number(v) } })} />
      <button type="button" onClick={() => commit({ type: 'deleteDependency', id: d.id })}>
        {t('panel.depDelete')}
      </button>
    </div>
  );
}

const STATUS = [
  ['', 'panel.statusNone'],
  ['notStarted', 'panel.statusNotStarted'],
  ['inProgress', 'panel.statusInProgress'],
  ['done', 'panel.statusDone'],
  ['onHold', 'panel.statusOnHold'],
] as const;

export function DetailPanel({ schedule, sel, commit }: { schedule: Schedule; sel: Sel | null; commit: Commit }) {
  let body: React.ReactNode = <p className="mut">{t('panel.none')}</p>;
  if (sel?.kind === 'project') {
    const p = schedule.projects[sel.id];
    if (p) {
      const upd = (patch: object): string | null => commit({ type: 'updateProject', id: p.id, patch });
      body = (
        <>
          <Field label={t('panel.name')} value={p.name} onCommit={(v) => upd({ name: v })} />
          <label className="field">
            <span>{t('panel.status')}</span>
            <select value={p.status ?? ''} onChange={(e) => upd({ status: e.target.value || undefined })}>
              {STATUS.map(([v, k]) => (
                <option key={v} value={v}>
                  {t(k)}
                </option>
              ))}
            </select>
          </label>
          <Field label={t('panel.assignee')} value={p.assignee ?? ''} onCommit={(v) => upd({ assignee: v || undefined })} />
          <Field label={t('panel.note')} multiline value={p.note ?? ''} onCommit={(v) => upd({ note: v || undefined })} />
        </>
      );
    }
  } else if (sel) {
    const owner = Object.values(schedule.projects).find((p) => (sel.kind === 'event' ? p.events[sel.id] : p.milestones[sel.id]));
    const e = sel.kind === 'event' ? owner?.events[sel.id] : undefined;
    const m = sel.kind === 'milestone' ? owner?.milestones[sel.id] : undefined;
    const data = e ?? m;
    if (data) {
      const upd = (patch: object): string | null => commit(sel.kind === 'event' ? { type: 'updateEvent', id: sel.id, patch } : { type: 'updateMilestone', id: sel.id, patch });
      const nameOf = (id: Id): string => {
        for (const p of Object.values(schedule.projects)) {
          const x = p.events[id] ?? p.milestones[id];
          if (x) return x.name;
        }
        return id;
      };
      const deps = Object.values(schedule.dependencies).filter((d) => d.from.id === sel.id || d.to.id === sel.id);
      body = (
        <>
          <Field label={t('panel.name')} value={data.name} onCommit={(v) => upd({ name: v })} />
          {e ? (
            <>
              <Field label={t('panel.start')} type="date" value={e.start} onCommit={(v) => upd({ start: v })} />
              <Field label={t('panel.end')} type="date" value={e.end} onCommit={(v) => upd({ end: v })} />
            </>
          ) : (
            <Field label={t('panel.date')} type="date" value={m!.date} onCommit={(v) => upd({ date: v })} />
          )}
          <Field label={t('panel.type')} value={data.type} onCommit={(v) => upd({ type: v })} />
          <Field label={t('panel.note')} multiline value={data.note ?? ''} onCommit={(v) => upd({ note: v || undefined })} />
          <h3>{t('panel.deps')}</h3>
          {deps.length === 0 ? <p className="mut">{t('panel.depNone')}</p> : null}
          {deps.map((d) => (
            <DepRow key={d.id} d={d} outgoing={d.from.id === sel.id} otherName={nameOf(d.from.id === sel.id ? d.to.id : d.from.id)} commit={commit} />
          ))}
        </>
      );
    }
  }
  return (
    <aside className="panel" aria-label={t('panel.title')} data-testid="detail-panel">
      <h2>{t('panel.title')}</h2>
      {body}
    </aside>
  );
}
