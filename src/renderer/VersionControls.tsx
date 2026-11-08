// @req F-502, F-504, F-513, F-514, F-515, F-517, F-520, F-523, NF-019
// 履歴に残す・履歴・戻す・診断、作業版（現在地の常時表示・切替・作成）、正式版への反映 / 共有。
// UI に Git 用語を出さない（docs/git-ux.html）。「未記録の変更」は、最後に履歴に残した版と今の日程の diffSchedule（F-509）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { diffSchedule, parseSchedule, parseTemplates, serializeTemplate, summarizeChange, type Id, type Schedule, type Template } from '@domain/index';
import { t } from './i18n';
import { SyncWizard } from './SyncWizard';

type GitState = Awaited<ReturnType<typeof window.api.invoke<'git:state'>>>;
type LogEntry = Awaited<ReturnType<typeof window.api.invoke<'git:log'>>>[number];
type Diag = Awaited<ReturnType<typeof window.api.invoke<'git:diagnose'>>>[number];
type Works = Awaited<ReturnType<typeof window.api.invoke<'work:list'>>>;

type Dialog = 'save' | 'history' | 'diagnose' | 'works' | 'sync' | null;

/** 画面の他の部分が知っておくべき版の状態（正式版の直接編集の確認に使う）。 */
export interface VersionInfo {
  readonly branch: string | null;
  /** 履歴が 1 件以上ある。 */
  readonly hasHistory: boolean;
}

export function VersionControls({
  schedule,
  templates,
  edits,
  flush,
  onRestore,
  onReload,
  onInfo,
  openWorksSignal,
}: {
  schedule: Schedule;
  /** 標準日程（履歴に残す変更の一覧と件数に含める）。 */
  templates: Readonly<Record<Id, Template>>;
  /** 編集のたびに増える（未記録の変更を数え直す合図）。 */
  edits: number;
  /** 自動保存の書き出しを完了させる（履歴に残す直前などに呼ぶ）。 */
  flush: () => Promise<void>;
  onRestore: (s: Schedule) => void;
  /** 版の切り替え・取り込みの後に、日程データを読み直す。 */
  onReload: () => Promise<void>;
  onInfo: (v: VersionInfo) => void;
  /** 増えると「版の切り替え」を開く（正式版の直接編集の確認から）。 */
  openWorksSignal: number;
}) {
  const [git, setGit] = useState<GitState | null>(null);
  const [works, setWorks] = useState<Works | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [memo, setMemo] = useState('');
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [diag, setDiag] = useState<Diag[]>([]);
  const [newName, setNewName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');

  const refresh = async (): Promise<void> => {
    const g = await window.api.invoke('git:state');
    setGit(g);
    if (g.available && g.isRepo) setWorks(await window.api.invoke('work:list'));
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (git) onInfo({ branch: git.branch, hasHistory: git.head !== null });
  }, [git]);
  // 合図が「増えたとき」だけ開く（作り直されたときに、過去の合図で勝手に開かない）
  const seenSignal = useRef(openWorksSignal);
  useEffect(() => {
    if (openWorksSignal !== seenSignal.current) {
      seenSignal.current = openWorksSignal;
      setNote('');
      setDialog('works');
    }
  }, [openWorksSignal]);

  const head = useMemo(() => {
    if (!git?.head) return null;
    const p = parseSchedule(git.head);
    return p.status === 'ok' ? p.schedule : null;
  }, [git]);
  const lines = useMemo(() => {
    if (!head || !git?.head) return [];
    const before = parseTemplates(git.head).templates;
    const tplLines: string[] = [];
    for (const [id, tp] of Object.entries(templates)) {
      const old = before[id];
      if (!old) tplLines.push(t('tpl.chgAdd', { name: tp.name }));
      else if (serializeTemplate(old) !== serializeTemplate(tp)) tplLines.push(t('tpl.chgEdit', { name: tp.name }));
    }
    for (const [id, tp] of Object.entries(before)) if (!templates[id]) tplLines.push(t('tpl.chgDelete', { name: tp.name }));
    return [...diffSchedule(head, schedule).map(summarizeChange), ...tplLines];
  }, [head, git, templates, schedule, edits]);

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

  const onMain = git.branch === 'main';
  const currentWork = works?.items.find((w) => w.name === git.branch) ?? null;
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
  const openWorks = async (): Promise<void> => {
    await flush();
    await refresh();
    setNote('');
    setDialog('works');
  };
  // 版の切り替え・作成: 自動保存を済ませてから行い、終わったら日程データを読み直す
  const changeVersion = async (run: () => Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    await flush();
    const r = await run();
    if (!r.ok) {
      setNote(t('work.failed', { message: r.message ?? '' }));
      return;
    }
    setDialog(null);
    setNewName('');
    await onReload();
    await refresh();
  };
  const setRemote = async (): Promise<void> => {
    const r = await window.api.invoke('git:setRemote', { url: remoteUrl.trim() });
    setNote(r.ok ? '' : t('sync.remoteFailed', { message: r.message ?? '' }));
    if (r.ok) {
      setRemoteUrl('');
      setDiag(await window.api.invoke('git:diagnose'));
      await refresh();
    }
  };

  const bandText = onMain ? t('work.main') : t('work.band', { name: currentWork?.display ?? git.branch ?? '' });

  return (
    <>
      <button type="button" className={`band ${onMain ? 'main' : 'work'}`} data-testid="branch-band" onClick={() => void openWorks()}>
        {bandText} ▾
      </button>
      <span data-testid="unsaved">{unsaved === null ? t('ver.first') : unsaved > 0 ? t('ver.unsaved', { count: String(unsaved) }) : t('ver.clean')}</span>
      <button type="button" data-testid="ver-save" onClick={() => void openSave()}>
        {t('ver.save')}
      </button>
      <button type="button" data-testid="ver-history" onClick={() => void openHistory()}>
        {t('ver.history')}
      </button>
      {git.head !== null ? (
        <button type="button" data-testid="ver-sync" onClick={() => void flush().then(() => setDialog('sync'))}>
          {t(onMain ? 'sync.share' : 'sync.reflect')}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="ver-diagnose"
        onClick={() => {
          setDiag([]);
          setNote('');
          setDialog('diagnose');
          void window.api.invoke('git:diagnose').then(setDiag);
        }}
      >
        {t('ver.diagnose')}
      </button>
      {dialog === 'sync' ? (
        <SyncWizard
          mode={onMain ? 'main' : 'work'}
          display={currentWork?.display ?? ''}
          schedule={schedule}
          flush={flush}
          onClose={(reload) => {
            setDialog(null);
            void (reload ? onReload() : Promise.resolve()).then(refresh);
          }}
        />
      ) : null}
      {dialog && dialog !== 'sync' ? (
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
            {dialog === 'works' ? (
              <>
                <h2>{t('work.listTitle')}</h2>
                <ul className="history" data-testid="works-list">
                  <li data-testid="work-item">
                    <strong className="band-text main">{t('work.main')}</strong> {onMain ? t('work.current') : ''}
                    {!onMain ? (
                      <div>
                        <button type="button" data-testid="switch-main" onClick={() => void changeVersion(() => window.api.invoke('work:switch', { name: 'main' }))}>
                          {t('work.switch')}
                        </button>
                      </div>
                    ) : null}
                  </li>
                  {(works?.items ?? []).map((w) => (
                    <li key={w.name} data-testid="work-item">
                      <strong className="band-text work">{w.display}</strong> {w.name === git.branch ? t('work.current') : ''}
                      <div className="mut">
                        {t('work.ahead', { n: String(w.ahead) })}　{new Date(w.date).toLocaleString('ja-JP')}
                      </div>
                      {w.name !== git.branch ? (
                        <button type="button" data-testid="switch-work" onClick={() => void changeVersion(() => window.api.invoke('work:switch', { name: w.name }))}>
                          {t('work.switch')}
                        </button>
                      ) : null}
                    </li>
                  ))}
                  {works && works.items.length === 0 ? <li className="mut">{t('work.none')}</li> : null}
                </ul>
                <h3>{t('work.create')}</h3>
                <p className="mut">{t('work.createHint')}</p>
                <label className="field">
                  <span>{t('work.createLabel')}</span>
                  <input data-testid="work-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                </label>
                {note ? <p role="alert" data-testid="work-note">{note}</p> : null}
                <div className="actions">
                  <button type="button" data-testid="work-create" disabled={newName.trim() === ''} onClick={() => void changeVersion(() => window.api.invoke('work:create', { display: newName.trim() }))}>
                    {t('work.create')}
                  </button>
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
                {diag.some((d) => d.key === 'remote' && !d.ok) ? (
                  <>
                    <label className="field">
                      <span>{t('sync.remoteLabel')}</span>
                      <input data-testid="remote-url" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
                    </label>
                    {note ? <p role="alert">{note}</p> : null}
                    <button type="button" data-testid="remote-set" disabled={remoteUrl.trim() === ''} onClick={() => void setRemote()}>
                      {t('ver.setRemote')}
                    </button>
                  </>
                ) : null}
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
