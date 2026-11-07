// @req F-503, F-506, F-511, F-517, F-518, F-520, NF-019
// 「正式版に反映する」（作業版）/「共有する」（正式版の直接編集）のウィザード。UI に Git 用語を出さない。
// 流れ: 最新の確認と取り込みの一覧 → ぶつかった項目の解決（作業版の中で）→ 反映前の確認 → 反映して共有。
// マージはドメイン層の mergeSchedules（3 版をフィールド単位で比較）。重ならない変更は自動で取り込む。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  conflictTarget,
  diffSchedule,
  mergeSchedules,
  parseSchedule,
  serializeSchedule,
  summarizeChange,
  validateSchedule,
  type MergeConflict,
  type Resolution,
  type Schedule,
} from '@domain/index';
import { t, type MessageKey } from './i18n';

type Mode = 'work' | 'main';
type Prepared = Awaited<ReturnType<typeof window.api.invoke<'sync:prepare'>>>;
type MergeData = { theirsRef: string; fastForward: boolean; base: Schedule; ours: Schedule; theirs: Schedule };
type Phase = 'checking' | 'merging' | 'error' | 'dirty' | 'noRemote' | 'conflicts' | 'confirm' | 'working' | 'identity' | 'done';

const parse = (files: Record<string, string>): Schedule | null => {
  const p = parseSchedule(files);
  return p.status === 'ok' ? p.schedule : null;
};

const FIELD_KEYS: Record<string, MessageKey> = {
  name: 'cf.name', start: 'cf.start', end: 'cf.end', date: 'cf.date', type: 'cf.type', note: 'cf.note', status: 'cf.status', assignee: 'cf.assignee',
  parentId: 'cf.parentId', order: 'cf.order', tags: 'cf.tags', color: 'cf.color', style: 'cf.style', lagDays: 'cf.lagDays', from: 'cf.from', to: 'cf.to',
};

const show = (v: unknown): string => (v === undefined ? t('sync.deleted') : typeof v === 'string' ? v : JSON.stringify(v));

/** 競合の見出し（例: イベント「設計」の終了日）。名前は自分 → 相手 → 祖先の順に探す。 */
function conflictLabel(c: MergeConflict, schedules: readonly Schedule[]): string {
  const tg = conflictTarget(c.path);
  let name = tg.id;
  for (const s of schedules) {
    const found =
      tg.kind === 'project' ? s.projects[tg.id]?.name
      : tg.kind === 'event' ? s.projects[tg.projectId ?? '']?.events[tg.id]?.name
      : tg.kind === 'milestone' ? s.projects[tg.projectId ?? '']?.milestones[tg.id]?.name
      : undefined;
    if (found) {
      name = found;
      break;
    }
  }
  const kindKey = `cf.${tg.kind === 'type' ? 'project' : tg.kind}` as MessageKey;
  const field = tg.field === undefined ? t('cf.item') : t(FIELD_KEYS[tg.field] ?? 'cf.item');
  return t('cf.label', { kind: t(kindKey), name, field });
}

export function SyncWizard({ mode, display, schedule, flush, onClose }: { mode: Mode; display: string; schedule: Schedule; flush: () => Promise<void>; onClose: (reload: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [data, setData] = useState<MergeData | null>(null);
  const [mainSched, setMainSched] = useState<Schedule | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [manual, setManual] = useState<Record<string, string>>({});
  const [identity, setIdentity] = useState({ name: '', email: '' });
  const [remoteUrl, setRemoteUrl] = useState('');
  const [reload, setReload] = useState(false);
  const retried = useRef(0);

  const prepare = async (): Promise<void> => {
    setPhase('checking');
    setResolutions({});
    setManual({});
    await flush();
    if (mode === 'main' && !(await window.api.invoke('git:state')).hasRemote) {
      setPhase('noRemote');
      return;
    }
    const r: Prepared = await window.api.invoke('sync:prepare');
    if (r.status === 'fetch-failed') {
      setMessage(r.message);
      setPhase('error');
    } else if (r.status === 'dirty') setPhase('dirty');
    else if (r.status === 'up-to-date') {
      setData(null);
      setMainSched(r.main ? parse(r.main) : null);
      setPhase('confirm');
    } else {
      const base = parse(r.base);
      const ours = parse(r.ours);
      const theirs = parse(r.theirs);
      if (!base || !ours || !theirs) {
        setMessage('日程データを読み込めませんでした');
        setPhase('error');
        return;
      }
      setData({ theirsRef: r.theirsRef, fastForward: r.fastForward, base, ours, theirs });
      setMainSched(r.mode === 'work' ? theirs : null);
      setPhase('merging');
    }
  };
  useEffect(() => {
    void prepare();
  }, []);

  const merged = useMemo(() => (data ? mergeSchedules(data.base, data.ours, data.theirs, resolutions) : null), [data, resolutions]);
  // 取り込み結果が出たら、競合の有無で次の画面を決める
  useEffect(() => {
    if (phase === 'merging' && merged) setPhase(merged.conflicts.length > 0 ? 'conflicts' : 'confirm');
  }, [phase, merged]);

  const incoming = useMemo(() => (data ? diffSchedule(data.base, data.theirs).map(summarizeChange) : []), [data]);
  const result = merged?.schedule ?? schedule;
  const diffLines = useMemo(() => {
    const ref = data?.theirs ?? mainSched;
    return ref ? diffSchedule(ref, result).map(summarizeChange) : [];
  }, [data, mainSched, result]);
  const issues = useMemo(() => {
    const ref = data?.theirs ?? mainSched;
    const known = new Set((ref ? validateSchedule(ref) : []).map((i) => `${i.rule}:${i.target.id}`));
    return validateSchedule(result).filter((i) => !known.has(`${i.rule}:${i.target.id}`));
  }, [data, mainSched, result]);
  const blocked = issues.some((i) => i.severity === 'error');


  const apply = async (): Promise<void> => {
    setPhase('working');
    const ident = identity.name.trim() && identity.email.trim() ? { identity: { name: identity.name.trim(), email: identity.email.trim() } } : {};
    const fail = (m: string): void => {
      setMessage(m);
      setPhase('error');
    };
    const again = (): void => {
      if (retried.current++ >= 3) return fail(t('sync.retry'));
      setNotice(t('sync.retry'));
      void prepare();
    };
    if (data && merged) {
      const c = await window.api.invoke('sync:complete', { files: serializeSchedule(merged.schedule), theirsRef: data.theirsRef, message: t(mode === 'work' ? 'sync.merge.work' : 'sync.merge.main'), ...ident });
      setReload(true);
      if (c.status === 'identity-required') return setPhase('identity');
      if (c.status === 'error') return fail(c.message);
      if (c.status !== 'ok') return again();
    }
    const r = mode === 'work' ? await window.api.invoke('sync:reflect', { display, ...ident }) : await window.api.invoke('sync:push');
    if (r.status === 'ok') {
      setReload(true);
      setPhase('done');
    } else if (r.status === 'identity-required') setPhase('identity');
    else if (r.status === 'rejected' || r.status === 'outdated') again();
    else if (r.status === 'dirty') setPhase('dirty');
    else fail(r.message);
  };

  const setRemote = async (): Promise<void> => {
    const r = await window.api.invoke('git:setRemote', { url: remoteUrl.trim() });
    if (r.ok) void prepare();
    else setMessage(t('sync.remoteFailed', { message: r.message ?? '' }));
  };

  const schedulesForNames = data ? [data.ours, data.theirs, data.base] : [schedule];
  const title = t(mode === 'work' ? 'sync.title.work' : 'sync.title.main');

  return (
    <div className="modal-back">
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={title} data-testid="dialog-sync">
        <h2>{title}</h2>
        {notice ? <p role="status" data-testid="sync-notice">{notice}</p> : null}

        {phase === 'checking' || phase === 'merging' || phase === 'working' ? <p>{phase === 'working' ? t('sync.working') : t('sync.checking')}</p> : null}

        {phase === 'error' ? (
          <>
            <p role="alert" data-testid="sync-error">{message ? t('sync.failed', { message }) : t('sync.fetchFailed')}</p>
            <div className="actions">
              <button type="button" onClick={() => void prepare()}>再試行</button>
              <button type="button" onClick={() => onClose(reload)}>{t('sync.close')}</button>
            </div>
          </>
        ) : null}

        {phase === 'dirty' ? (
          <>
            <p role="alert" data-testid="sync-dirty">{t('sync.dirty')}</p>
            <div className="actions"><button type="button" onClick={() => onClose(reload)}>{t('sync.close')}</button></div>
          </>
        ) : null}

        {phase === 'noRemote' ? (
          <>
            <p>{t('sync.noRemote')}</p>
            <label className="field">
              <span>{t('sync.remoteLabel')}</span>
              <input data-testid="remote-url" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
            </label>
            {message ? <p role="alert">{message}</p> : null}
            <div className="actions">
              <button type="button" data-testid="remote-set" disabled={remoteUrl.trim() === ''} onClick={() => void setRemote()}>{t('sync.setRemote')}</button>
              <button type="button" onClick={() => onClose(reload)}>{t('sync.cancel')}</button>
            </div>
          </>
        ) : null}

        {phase === 'conflicts' && merged ? (
          <>
            <h3>{t('sync.conflictTitle', { count: String(merged.conflicts.length) })}</h3>
            <p>{t('sync.conflictHint')}</p>
            <ul className="conflicts" data-testid="conflict-list">
              {merged.conflicts.map((c) => (
                <li key={c.key} data-testid="conflict">
                  <strong>{conflictLabel(c, schedulesForNames)}</strong>
                  <div className="choices">
                    <button type="button" className="choice" aria-pressed={resolutions[c.key] === 'ours'} data-testid="choose-ours" onClick={() => setResolutions({ ...resolutions, [c.key]: 'ours' })}>
                      {t('sync.ours')}: {show(c.ours)}
                    </button>
                    <button type="button" className="choice" aria-pressed={resolutions[c.key] === 'theirs'} data-testid="choose-theirs" onClick={() => setResolutions({ ...resolutions, [c.key]: 'theirs' })}>
                      {t('sync.theirs')}: {show(c.theirs)}
                    </button>
                    {typeof c.ours === 'string' || typeof c.theirs === 'string' ? (
                      <span className="manual">
                        <input aria-label={t('sync.manual')} placeholder={t('sync.manual')} value={manual[c.key] ?? ''} onChange={(e) => setManual({ ...manual, [c.key]: e.target.value })} />
                        <button type="button" disabled={(manual[c.key] ?? '').trim() === ''} onClick={() => setResolutions({ ...resolutions, [c.key]: { manual: manual[c.key]!.trim() } })}>
                          {t('sync.manual')}
                        </button>
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" data-testid="conflicts-next" disabled={merged.conflicts.length > 0} onClick={() => setPhase('confirm')}>{t('sync.next')}</button>
              <button type="button" onClick={() => onClose(reload)}>{t('sync.cancel')}</button>
            </div>
          </>
        ) : null}

        {phase === 'confirm' || phase === 'identity' ? (
          <>
            {data ? (
              <>
                <h3>{t(mode === 'work' ? 'sync.incoming.work' : 'sync.incoming.main', { count: String(incoming.length) })}</h3>
                <ul className="changes" data-testid="incoming-list">
                  {incoming.slice(0, 50).map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </>
            ) : (
              <p>{t('sync.noIncoming')}</p>
            )}
            {mode === 'work' || diffLines.length > 0 ? (
              <>
                <h3>{t(mode === 'work' ? 'sync.confirm.work' : 'sync.confirm.main', { count: String(diffLines.length) })}</h3>
                {diffLines.length === 0 ? <p>{t('sync.noDiff')}</p> : null}
                <ul className="changes" data-testid="diff-list">
                  {diffLines.slice(0, 50).map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </>
            ) : null}
            {issues.length > 0 ? (
              <>
                <h3>{t('sync.newIssues')}</h3>
                <ul className="changes" data-testid="new-issues">
                  {issues.slice(0, 20).map((i, n) => <li key={n} className={i.severity === 'error' ? 'issues' : undefined}>{i.message}</li>)}
                </ul>
              </>
            ) : null}
            {blocked ? <p role="alert">{t('sync.errors')}</p> : null}
            {phase === 'identity' ? (
              <>
                <p>{t('ver.identity')}</p>
                <label className="field"><span>{t('ver.name')}</span><input data-testid="ver-name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} /></label>
                <label className="field"><span>{t('ver.email')}</span><input data-testid="ver-email" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} /></label>
              </>
            ) : null}
            <div className="actions">
              <button type="button" data-testid="sync-go" disabled={blocked} onClick={() => void apply()}>
                {t(mode === 'work' ? 'sync.go.work' : 'sync.go.main')}
              </button>
              <button type="button" onClick={() => onClose(reload)}>{t('sync.cancel')}</button>
            </div>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <p data-testid="sync-done">{t(mode === 'work' ? 'sync.done.work' : 'sync.done.main')}</p>
            <div className="actions">
              <button type="button" data-testid="sync-close" onClick={() => onClose(true)}>{t(mode === 'work' ? 'sync.continue' : 'sync.close')}</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
