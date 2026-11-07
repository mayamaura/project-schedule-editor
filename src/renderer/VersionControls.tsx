// @req F-502, F-504, F-523, NF-019
// 保存・履歴・戻す・診断（版管理の画面）。UI に Git 用語を出さない（docs/git-ux.html）。
// 「未保存の変更」は、最後に保存した版（HEAD）と今の日程の diffSchedule を日本語にしたもの（F-509）。
import { useEffect, useMemo, useState } from 'react';
import { diffSchedule, parseSchedule, summarizeChange, type Schedule } from '@domain/index';
import { t } from './i18n';

type GitState = Awaited<ReturnType<typeof window.api.invoke<'git:state'>>>;
type LogEntry = Awaited<ReturnType<typeof window.api.invoke<'git:log'>>>[number];
type Diag = Awaited<ReturnType<typeof window.api.invoke<'git:diagnose'>>>[number];

type Dialog = 'save' | 'history' | 'diagnose' | null;

export function VersionControls({
  schedule,
  edits,
  flush,
  onRestore,
}: {
  schedule: Schedule;
  /** 編集のたびに増える（未保存の変更を数え直す合図）。 */
  edits: number;
  /** 自動保存の書き出しを完了させる（保存の直前に呼ぶ）。 */
  flush: () => Promise<void>;
  onRestore: (s: Schedule) => void;
}) {
  const [git, setGit] = useState<GitState | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [memo, setMemo] = useState('');
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [diag, setDiag] = useState<Diag[]>([]);

  const refresh = async (): Promise<void> => setGit(await window.api.invoke('git:state'));
  useEffect(() => {
    void refresh();
  }, []);

  const head = useMemo(() => {
    if (!git?.head) return null;
    const p = parseSchedule(git.head);
    return p.status === 'ok' ? p.schedule : null;
  }, [git]);
  const lines = useMemo(() => (head ? diffSchedule(head, schedule).map(summarizeChange) : []), [head, schedule, edits]);

  if (!git) return null;
  if (!git.available) return <span className="issues">{t('ver.noGit')}</span>;
  if (!git.isRepo) {
    return (
      <>
        <span>{t('ver.notRepo')}</span>
        <button type="button" data-testid="ver-init" onClick={() => void window.api.invoke('git:init').then(refresh)}>
          {t('ver.create')}
        </button>
      </>
    );
  }

  const unsaved = git.head === null ? null : lines.length;
  const openSave = async (): Promise<void> => {
    await flush();
    await refresh();
    setNote('');
    setIdentity(null);
    setMemo(lines.length === 0 ? '' : lines.length === 1 ? lines[0]! : t('ver.defaultMemo', { first: lines[0]!, rest: String(lines.length - 1) }));
    setDialog('save');
  };
  const doSave = async (): Promise<void> => {
    const r = await window.api.invoke('git:save', { message: memo.trim() || t('ver.saved'), ...(identity ? { identity } : {}) });
    if (r.status === 'identity-required') {
      setIdentity((cur) => cur ?? { name: '', email: '' });
      setNote(t('ver.identity'));
    } else if (r.status === 'ok') {
      setNote('');
      setDialog(null);
      await refresh();
    } else if (r.status === 'nothing') setNote(t('ver.nothing'));
    else setNote(t('ver.saveFailed', { message: r.message }));
  };
  const openHistory = async (): Promise<void> => {
    setLog(await window.api.invoke('git:log', { limit: 100 }));
    setNote('');
    setDialog('history');
  };
  const restore = async (hash: string): Promise<void> => {
    if (!window.confirm(t('ver.restoreConfirm'))) return;
    const p = parseSchedule(await window.api.invoke('git:filesAt', { hash }));
    if (p.status !== 'ok') {
      setNote(t('ver.restoreFailed'));
      return;
    }
    onRestore(p.schedule);
    setDialog(null);
  };

  return (
    <>
      {git.branch ? <span>{t('ver.branch', { name: git.branch === 'main' ? '正式版' : git.branch })}</span> : null}
      <span data-testid="unsaved">{unsaved === null ? t('ver.first') : unsaved > 0 ? t('ver.unsaved', { count: String(unsaved) }) : t('ver.clean')}</span>
      <button type="button" data-testid="ver-save" onClick={() => void openSave()}>
        {t('ver.save')}
      </button>
      <button type="button" data-testid="ver-history" onClick={() => void openHistory()}>
        {t('ver.history')}
      </button>
      <button
        type="button"
        data-testid="ver-diagnose"
        onClick={() => {
          setDiag([]);
          setDialog('diagnose');
          void window.api.invoke('git:diagnose').then(setDiag);
        }}
      >
        {t('ver.diagnose')}
      </button>
      {dialog ? (
        <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" data-testid={`dialog-${dialog}`}>
            {dialog === 'save' ? (
              <>
                <h2>{t('ver.saveTitle')}</h2>
                <p>{t('ver.saveBody')}</p>
                <h3>{t('ver.changes')}</h3>
                <ul className="changes">
                  {(lines.length === 0 ? [t('ver.first')] : lines.slice(0, 50)).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                <label className="field">
                  <span>{t('ver.memo')}</span>
                  <input data-testid="ver-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
                </label>
                {identity ? (
                  <>
                    <label className="field">
                      <span>{t('ver.name')}</span>
                      <input data-testid="ver-name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>{t('ver.email')}</span>
                      <input data-testid="ver-email" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} />
                    </label>
                  </>
                ) : null}
                {note ? <p role="status" data-testid="ver-note">{note}</p> : null}
                <div className="actions">
                  <button type="button" data-testid="ver-do-save" onClick={() => void doSave()}>
                    {t('ver.doSave')}
                  </button>
                  <button type="button" onClick={() => setDialog(null)}>
                    {t('ver.cancel')}
                  </button>
                </div>
              </>
            ) : null}
            {dialog === 'history' ? (
              <>
                <h2>{t('ver.historyTitle')}</h2>
                {log.length === 0 ? <p>{t('ver.historyEmpty')}</p> : null}
                <ul className="history">
                  {log.map((e) => (
                    <li key={e.hash} data-testid="history-item">
                      <div>
                        <strong>{e.message}</strong>
                      </div>
                      <div className="mut">
                        {new Date(e.date).toLocaleString('ja-JP')}　{e.author}
                      </div>
                      <button type="button" onClick={() => void restore(e.hash)}>
                        {t('ver.restore')}
                      </button>
                    </li>
                  ))}
                </ul>
                {note ? <p role="status">{note}</p> : null}
                <div className="actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    {t('ver.cancel')}
                  </button>
                </div>
              </>
            ) : null}
            {dialog === 'diagnose' ? (
              <>
                <h2>{t('ver.diagTitle')}</h2>
                <ul className="history" data-testid="diag-list">
                  {diag.map((d) => (
                    <li key={d.key}>
                      <strong>{d.ok ? '✓' : '！'} {d.label}</strong>
                      <div className="mut">{d.detail}</div>
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  <button type="button" onClick={() => setDialog(null)}>
                    {t('ver.cancel')}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
