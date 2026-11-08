// @req F-801, F-802, F-803, F-804, F-805, F-808, F-809
// 標準日程の管理画面と、展開ダイアログ（ui-design 6）。ロジックは domain/template.ts。ここは入力と表示だけ。
import { useMemo, useState } from 'react';
import {
  duplicateTemplate,
  expandTemplate,
  makeOffset,
  splitOffset,
  validateTemplate,
  type Command,
  type Id,
  type Offset,
  type OffsetDir,
  type Schedule,
  type Template,
} from '@domain/index';
import { t } from './i18n';

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const randomId = (prefix: string): string => prefix + Array.from({ length: 6 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('');

function todayString(): string {
  const d = new Date();
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const sortKey = (o: Offset): number => (o.months ?? 0) * 31 + (o.days ?? 0);

function OffsetEditor({ value, onChange, label, testId }: { value: Offset; onChange: (o: Offset) => void; label: string; testId: string }) {
  const sp = splitOffset(value);
  const set = (patch: Partial<typeof sp>): void => {
    const n = { ...sp, ...patch };
    onChange(makeOffset(n.dir, n));
  };
  const num = (k: 'months' | 'weeks' | 'days', unit: string) => (
    <label className="off-num">
      <input type="number" min={0} aria-label={`${label} ${unit}`} data-testid={`${testId}-${k}`} value={sp[k]} onChange={(e) => set({ [k]: Math.max(0, Number(e.target.value) || 0) })} />
      {unit}
    </label>
  );
  return (
    <span className="offset" data-testid={testId}>
      <span>{label}</span> {t('tpl.anchor0')} {num('months', t('tpl.unitMonth'))} {num('weeks', t('tpl.unitWeek'))} {num('days', t('tpl.unitDay'))}
      <select aria-label={`${label} ${t('tpl.dir')}`} data-testid={`${testId}-dir`} value={sp.dir} onChange={(e) => set({ dir: e.target.value as OffsetDir })}>
        <option value="before">{t('tpl.before')}</option>
        <option value="after">{t('tpl.after')}</option>
      </select>
    </span>
  );
}

function TemplateEditor({ draft, onChange, onSave, onCancel, typeNames, error }: { draft: Template; onChange: (t: Template) => void; onSave: () => void; onCancel: () => void; typeNames: readonly string[]; error: string }) {
  const evs = Object.entries(draft.events).sort(([, a], [, b]) => sortKey(a.start) - sortKey(b.start));
  const mss = Object.entries(draft.milestones).sort(([, a], [, b]) => sortKey(a.date) - sortKey(b.date));
  const deps = Object.entries(draft.dependencies);
  const items = [
    ...Object.entries(draft.events).map(([id, e]) => ({ kind: 'event' as const, id, name: e.name })),
    ...Object.entries(draft.milestones).map(([id, m]) => ({ kind: 'milestone' as const, id, name: m.name })),
  ];
  const without = <T,>(rec: Readonly<Record<string, T>>, k: string): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([id]) => id !== k));
  const defType = typeNames[0] ?? 'task';
  return (
    <div data-testid="tpl-editor">
      <h2>{t('tpl.edit')}</h2>
      <label className="field">
        <span>{t('tpl.name')}</span>
        <input data-testid="tpl-name" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </label>
      <label className="field">
        <span>{t('tpl.dayMode')}</span>
        <select data-testid="tpl-daymode" value={draft.dayMode} onChange={(e) => onChange({ ...draft, dayMode: e.target.value as Template['dayMode'] })}>
          <option value="calendar">{t('tpl.calendar')}</option>
          <option value="working">{t('tpl.working')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('tpl.adjust')}</span>
        <select data-testid="tpl-adjust" value={draft.adjust} onChange={(e) => onChange({ ...draft, adjust: e.target.value as Template['adjust'] })}>
          <option value="none">{t('tpl.adjustNone')}</option>
          <option value="earlier">{t('tpl.adjustEarlier')}</option>
          <option value="later">{t('tpl.adjustLater')}</option>
        </select>
      </label>
      <p className="hint">{t('tpl.workdayNote')}</p>
      <label className="field">
        <span>{t('tpl.defaultAnchor')}</span>
        <select data-testid="tpl-default-anchor" value={draft.defaultAnchor ?? ''} onChange={(e) => onChange({ ...draft, ...(e.target.value ? { defaultAnchor: e.target.value } : { defaultAnchor: undefined }) })}>
          <option value="">{t('tpl.none')}</option>
          {mss.map(([id, m]) => (
            <option key={id} value={id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <h3>{t('tpl.events')}</h3>
      {evs.map(([id, e], i) => (
        <div className="tpl-row" key={id} data-testid="tpl-event-row">
          <input aria-label={t('tpl.itemName')} data-testid={`tpl-event-name-${i}`} value={e.name} onChange={(ev) => onChange({ ...draft, events: { ...draft.events, [id]: { ...e, name: ev.target.value } } })} />
          <input aria-label={t('tpl.itemType')} list="tpl-types" value={e.type} onChange={(ev) => onChange({ ...draft, events: { ...draft.events, [id]: { ...e, type: ev.target.value } } })} />
          <OffsetEditor label={t('tpl.start')} testId={`tpl-event-start-${i}`} value={e.start} onChange={(o) => onChange({ ...draft, events: { ...draft.events, [id]: { ...e, start: o } } })} />
          <OffsetEditor label={t('tpl.end')} testId={`tpl-event-end-${i}`} value={e.end} onChange={(o) => onChange({ ...draft, events: { ...draft.events, [id]: { ...e, end: o } } })} />
          <button type="button" onClick={() => onChange({ ...draft, events: without(draft.events, id), dependencies: Object.fromEntries(deps.filter(([, d]) => !((d.from.kind === 'event' && d.from.id === id) || (d.to.kind === 'event' && d.to.id === id)))) })}>
            {t('tpl.remove')}
          </button>
        </div>
      ))}
      <button type="button" data-testid="tpl-add-event" onClick={() => onChange({ ...draft, events: { ...draft.events, [randomId('e')]: { name: t('edit.newEvent'), type: defType, start: {}, end: { days: 6 } } } })}>
        {t('tpl.addEvent')}
      </button>

      <h3>{t('tpl.milestones')}</h3>
      {mss.map(([id, m], i) => (
        <div className="tpl-row" key={id} data-testid="tpl-milestone-row">
          <input aria-label={t('tpl.itemName')} data-testid={`tpl-milestone-name-${i}`} value={m.name} onChange={(ev) => onChange({ ...draft, milestones: { ...draft.milestones, [id]: { ...m, name: ev.target.value } } })} />
          <input aria-label={t('tpl.itemType')} list="tpl-types" value={m.type} onChange={(ev) => onChange({ ...draft, milestones: { ...draft.milestones, [id]: { ...m, type: ev.target.value } } })} />
          <OffsetEditor label={t('tpl.date')} testId={`tpl-milestone-date-${i}`} value={m.date} onChange={(o) => onChange({ ...draft, milestones: { ...draft.milestones, [id]: { ...m, date: o } } })} />
          <button
            type="button"
            onClick={() =>
              onChange({
                ...draft,
                milestones: without(draft.milestones, id),
                ...(draft.defaultAnchor === id ? { defaultAnchor: undefined } : {}),
                dependencies: Object.fromEntries(deps.filter(([, d]) => !((d.from.kind === 'milestone' && d.from.id === id) || (d.to.kind === 'milestone' && d.to.id === id)))),
              })
            }
          >
            {t('tpl.remove')}
          </button>
        </div>
      ))}
      <button type="button" data-testid="tpl-add-milestone" onClick={() => onChange({ ...draft, milestones: { ...draft.milestones, [randomId('m')]: { name: t('edit.newMilestone'), type: typeNames[0] ?? 'milestone', date: {} } } })}>
        {t('tpl.addMilestone')}
      </button>

      <h3>{t('tpl.dependencies')}</h3>
      {deps.map(([id, d]) => {
        const key = (e: { kind: string; id: string }): string => `${e.kind}:${e.id}`;
        const parse = (v: string): { kind: 'event' | 'milestone'; id: string } => ({ kind: v.startsWith('event:') ? 'event' : 'milestone', id: v.slice(v.indexOf(':') + 1) });
        const sel = (which: 'from' | 'to', label: string) => (
          <select aria-label={label} value={key(d[which])} onChange={(e) => onChange({ ...draft, dependencies: { ...draft.dependencies, [id]: { ...d, [which]: parse(e.target.value) } } })}>
            {items.map((it) => (
              <option key={key(it)} value={key(it)}>
                {it.name}
              </option>
            ))}
          </select>
        );
        return (
          <div className="tpl-row" key={id} data-testid="tpl-dep-row">
            {sel('from', t('tpl.depFrom'))} → {sel('to', t('tpl.depTo'))}
            <select aria-label={t('tpl.depType')} value={d.type} onChange={(e) => onChange({ ...draft, dependencies: { ...draft.dependencies, [id]: { ...d, type: e.target.value as typeof d.type } } })}>
              {['FS', 'SS', 'FF', 'SF'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label className="off-num">
              <input type="number" aria-label={t('tpl.depLag')} value={d.lagDays} onChange={(e) => onChange({ ...draft, dependencies: { ...draft.dependencies, [id]: { ...d, lagDays: Math.trunc(Number(e.target.value) || 0) } } })} />
              {t('tpl.unitDay')}
            </label>
            <button type="button" onClick={() => onChange({ ...draft, dependencies: without(draft.dependencies, id) })}>
              {t('tpl.remove')}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        data-testid="tpl-add-dep"
        disabled={items.length < 2}
        onClick={() => onChange({ ...draft, dependencies: { ...draft.dependencies, [randomId('d')]: { from: { kind: items[0]!.kind, id: items[0]!.id }, to: { kind: items[1]!.kind, id: items[1]!.id }, type: 'FS', lagDays: 0 } } })}
      >
        {t('tpl.addDep')}
      </button>
      <datalist id="tpl-types">
        {typeNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {error ? (
        <p role="alert" className="issues" data-testid="tpl-error">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button type="button" data-testid="tpl-save" disabled={draft.name.trim() === ''} onClick={onSave}>
          {t('tpl.save')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('sync.cancel')}
        </button>
      </div>
    </div>
  );
}

/** 標準日程の一覧と編集（ui-design 6.2）。保存・削除は呼び出し側（IPC）に任せ、失敗したら理由を返してもらう。 */
export function TemplateManager({
  templates,
  typeNames,
  onSave,
  onDelete,
  onClose,
}: {
  templates: Readonly<Record<Id, Template>>;
  typeNames: readonly string[];
  onSave: (t: Template) => Promise<string | null>;
  onDelete: (id: Id) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Template | null>(null);
  const [error, setError] = useState('');
  const list = Object.values(templates).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const save = async (): Promise<void> => {
    if (!draft) return;
    const issues = validateTemplate(draft);
    if (issues.length > 0) {
      setError(issues.join(' / '));
      return;
    }
    const e = await onSave({ ...draft, name: draft.name.trim() });
    if (e) setError(e);
    else {
      setError('');
      setDraft(null);
    }
  };
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && !draft && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-templates">
        {draft ? (
          <TemplateEditor draft={draft} onChange={setDraft} onSave={() => void save()} onCancel={() => { setDraft(null); setError(''); }} typeNames={typeNames} error={error} />
        ) : (
          <>
            <h2>{t('tpl.title')}</h2>
            {list.length === 0 ? <p>{t('tpl.empty')}</p> : null}
            <ul className="tpl-list">
              {list.map((tp) => (
                <li key={tp.id} data-testid="tpl-item">
                  <span className="tpl-name">{tp.name}</span>
                  <span>{t('tpl.count', { count: String(Object.keys(tp.events).length + Object.keys(tp.milestones).length) })}</span>
                  <button type="button" data-testid="tpl-edit" onClick={() => setDraft(tp)}>
                    {t('tpl.editBtn')}
                  </button>
                  <button type="button" data-testid="tpl-dup" onClick={() => void onSave(duplicateTemplate(tp, randomId('tpl-'), t('tpl.copyName', { name: tp.name })))}>
                    {t('tpl.duplicate')}
                  </button>
                  <button type="button" data-testid="tpl-delete" onClick={() => window.confirm(t('tpl.confirmDelete', { name: tp.name })) && void onDelete(tp.id)}>
                    {t('tpl.delete')}
                  </button>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button
                type="button"
                data-testid="tpl-new"
                onClick={() => setDraft({ id: randomId('tpl-'), name: t('tpl.newName'), dayMode: 'calendar', adjust: 'none', events: {}, milestones: {}, dependencies: {} })}
              >
                {t('tpl.new')}
              </button>
              <button type="button" data-testid="tpl-close" onClick={onClose}>
                {t('sync.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export interface ExpandPreset {
  /** 展開先の既存プロジェクト（無ければ新しいプロジェクトを作る）。 */
  readonly projectId?: Id;
  /** 起点の日付の初期値（クリックした日・マイルストーンの日付）。 */
  readonly date?: string;
}

/** 標準日程を展開する（新規プロジェクト / 既存プロジェクト。プレビューつき。ui-design 6.1）。 */
export function ExpandDialog({
  schedule,
  templates,
  preset,
  onApply,
  onClose,
}: {
  schedule: Schedule;
  templates: Readonly<Record<Id, Template>>;
  preset: ExpandPreset;
  onApply: (c: Command) => void;
  onClose: () => void;
}) {
  const list = Object.values(templates).sort((a, b) => (a.name < b.name ? -1 : 1));
  const [tplId, setTplId] = useState(list[0]?.id ?? '');
  const tpl = templates[tplId];
  const [anchorKind, setAnchorKind] = useState<'date' | 'milestone'>('date');
  const [milestoneId, setMilestoneId] = useState('');
  const [date, setDate] = useState(preset.date ?? todayString());
  const [name, setName] = useState(tpl?.name ?? '');
  const [parentId, setParentId] = useState<Id | ''>('');
  const ms = tpl ? Object.entries(tpl.milestones) : [];
  const effMilestone = tpl?.milestones[milestoneId] ? milestoneId : tpl?.defaultAnchor && tpl.milestones[tpl.defaultAnchor] ? tpl.defaultAnchor : (ms[0]?.[0] ?? '');

  const result = useMemo(() => {
    if (!tpl) return null;
    return expandTemplate(schedule, tpl, {
      anchor: anchorKind === 'milestone' ? { kind: 'milestone', milestoneId: effMilestone, date } : { kind: 'date', date },
      target: preset.projectId ? { kind: 'existing', projectId: preset.projectId } : { kind: 'newProject', name: name.trim(), parentId: parentId === '' ? null : parentId },
    });
  }, [schedule, tpl, anchorKind, effMilestone, date, name, parentId, preset.projectId]);

  const projects = Object.values(schedule.projects).sort((a, b) => (a.name < b.name ? -1 : 1));
  const targetName = preset.projectId ? schedule.projects[preset.projectId]?.name : null;
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" data-testid="dialog-expand">
        <h2>{targetName ? t('tpl.expandInto', { name: targetName }) : t('tpl.expandNew')}</h2>
        {list.length === 0 ? (
          <p data-testid="expand-none">{t('tpl.noneYet')}</p>
        ) : (
          <>
            <label className="field">
              <span>{t('tpl.pick')}</span>
              <select
                data-testid="expand-template"
                value={tplId}
                onChange={(e) => {
                  setTplId(e.target.value);
                  setMilestoneId('');
                  if (!preset.projectId) setName(templates[e.target.value]?.name ?? '');
                }}
              >
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            {!preset.projectId ? (
              <>
                <label className="field">
                  <span>{t('tpl.projectName')}</span>
                  <input data-testid="expand-name" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span>{t('tpl.parent')}</span>
                  <select data-testid="expand-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    <option value="">{t('tpl.none')}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <fieldset className="field">
              <legend>{t('tpl.anchor')}</legend>
              <label>
                <input type="radio" name="anchor" data-testid="expand-anchor-date" checked={anchorKind === 'date'} onChange={() => setAnchorKind('date')} /> {t('tpl.anchorDate')}
              </label>
              <label>
                <input type="radio" name="anchor" data-testid="expand-anchor-ms" checked={anchorKind === 'milestone'} disabled={ms.length === 0} onChange={() => setAnchorKind('milestone')} /> {t('tpl.anchorMilestone')}
                <select data-testid="expand-milestone" disabled={anchorKind !== 'milestone'} value={effMilestone} onChange={(e) => setMilestoneId(e.target.value)}>
                  {ms.map(([id, m]) => (
                    <option key={id} value={id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('tpl.date')} <input type="date" data-testid="expand-date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            </fieldset>
            <h3>{t('tpl.preview')}</h3>
            {result && !result.ok ? (
              <p role="alert" className="issues" data-testid="expand-error">
                {result.message}
              </p>
            ) : null}
            {result?.ok ? (
              <ul className="changes" data-testid="expand-preview">
                {result.items.map((it, i) => (
                  <li key={i}>
                    {it.kind === 'event' ? '▬' : '◆'} {it.name}: {it.start === it.end ? it.start : `${it.start} ～ ${it.end}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        <div className="actions">
          <button
            type="button"
            data-testid="expand-go"
            disabled={!result?.ok}
            onClick={() => {
              if (result?.ok) onApply(result.command);
            }}
          >
            {t('tpl.apply')}
          </button>
          <button type="button" data-testid="expand-cancel" onClick={onClose}>
            {t('sync.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
