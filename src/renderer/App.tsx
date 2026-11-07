// @req F-501, F-101, F-206, F-208, F-210, F-211
import { useEffect, useRef, useState } from 'react';
import { History, diffSchedule, generateSample, parseSchedule, serializeSchedule, summarizeChange, type Command, type Schedule, type ParseIssue } from '@domain/index';
import { t } from './i18n';
import { TimelineView } from './timeline/TimelineView';
import { VersionControls, type VersionInfo } from './VersionControls';

interface Loaded {
  readonly history: History;
  /** 開いたフォルダ。サンプルは null（自動保存しない）。 */
  readonly path: string | null;
  readonly label: string;
  readonly errors: number;
  readonly warnings: number;
}

interface Recovery {
  readonly lines: readonly string[];
  readonly base: Record<string, string>;
  readonly baseSchedule: Schedule;
}

type SaveState = { readonly kind: 'idle' | 'saving' | 'saved' } | { readonly kind: 'failed'; readonly message: string };

const counts = (s: Schedule): { projects: string; events: string; milestones: string } => {
  const ps = Object.values(s.projects);
  return {
    projects: String(ps.length),
    events: String(ps.reduce((n, p) => n + Object.keys(p.events).length, 0)),
    milestones: String(ps.reduce((n, p) => n + Object.keys(p.milestones).length, 0)),
  };
};

const AUTOSAVE_DELAY_MS = 300;

export function App() {
  const [version, setVersion] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problems, setProblems] = useState<readonly ParseIssue[]>([]);
  const [message, setMessage] = useState('');
  const [editError, setEditError] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [edits, bump] = useState(0);
  const [ver, setVer] = useState<VersionInfo>({ branch: null, hasHistory: false });
  const [mainOk, setMainOk] = useState(false);
  const [directPending, setDirectPending] = useState<Command | null>(null);
  const [worksSignal, setWorksSignal] = useState(0);
  const [opened, setOpened] = useState(0); // フォルダを開き直すたびに増える（版の表示を作り直す）
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');

  useEffect(() => {
    void window.api.invoke('app:getVersion').then(setVersion);
  }, []);

  const showSample = (): void => {
    const schedule = generateSample();
    setProblems([]);
    setMessage('');
    setEditError('');
    setRecovery(null);
    setLoaded({ history: new History(schedule), path: null, label: t('app.sampleLoaded', counts(schedule)), errors: 0, warnings: 0 });
  };

  type Opened = { path: string; files: Record<string, string>; crashed: boolean; base: Record<string, string> | null };
  const applyOpened = (r: Opened): void => {
    const parsed = parseSchedule(r.files);
    if (parsed.status === 'ok') {
      setOpened((n) => n + 1);
      setProblems([]);
      setMessage('');
      setEditError('');
      setSave({ kind: 'idle' });
      setLoaded({
        history: new History(parsed.schedule),
        path: r.path,
        label: t('app.loaded', { path: r.path, ...counts(parsed.schedule) }),
        errors: parsed.issues.filter((i) => i.severity === 'error').length,
        warnings: parsed.issues.filter((i) => i.severity === 'warning').length,
      });
      // 前回が異常終了なら、自動保存されていた変更を知らせる（F-211）
      const base = r.crashed && r.base ? parseSchedule(r.base) : null;
      const lines = base?.status === 'ok' ? diffSchedule(base.schedule, parsed.schedule).map(summarizeChange) : [];
      setRecovery(base?.status === 'ok' && lines.length > 0 ? { lines, base: r.base!, baseSchedule: base.schedule } : null);
    } else if (parsed.status === 'tooNew') {
      setProblems([]);
      setMessage(t('app.tooNew', { version: String(parsed.fileVersion) }));
    } else {
      // 読み込めなかった理由を全て表示する（データを黙って捨てない）
      setProblems(parsed.errors);
      setMessage(t('app.readError', { count: String(parsed.errors.length) }));
    }
  };

  const openFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:open');
    if (r) applyOpened(r);
  };

  // 新規作成（F-501）: 空のフォルダに空の日程データを作って開く
  const createFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:create');
    if (r.status === 'ok') applyOpened(r);
    else if (r.status === 'not-empty') {
      setProblems([]);
      setMessage(t('app.createNotEmpty'));
    }
  };

  // 共有先から取得（F-501 の (a)）
  const cloneFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:clone', { url: cloneUrl.trim() });
    if (r.status === 'ok') {
      setCloneOpen(false);
      applyOpened(r);
    } else if (r.status === 'not-empty') setMessage(t('app.createNotEmpty'));
    else if (r.status === 'failed') setMessage(t('clone.failed', { message: r.message }));
    setProblems([]);
  };

  const h = loaded?.history;

  // 版の切り替え・取り込みの後に、作業ツリーの日程データを読み直す（履歴は新しく始める）
  const reloadFromDisk = async (): Promise<void> => {
    const r = await window.api.invoke('repo:reload');
    const parsed = parseSchedule(r.files);
    if (parsed.status !== 'ok' || !loaded) {
      setMessage(t('app.readError', { count: String(parsed.status === 'error' ? parsed.errors.length : 1) }));
      return;
    }
    setLoaded({ ...loaded, history: new History(parsed.schedule) });
    setEditError('');
    setMainOk(false);
  };

  // コマンドの適用。成功なら null、拒否されたら理由を返し、画面上部にも出す（F-208）
  const commit = (c: Command): string | null => {
    // 正式版を直接編集するときは確認する（作業版の利用を促す。F-520）
    if (ver.branch === 'main' && ver.hasHistory && !mainOk && loaded?.path) {
      setDirectPending(c);
      return t('direct.title');
    }
    const r = h?.execute(c);
    if (r?.ok) {
      setEditError('');
      bump((n) => n + 1);
      return null;
    }
    const msg = r && !r.ok ? r.error.message : '';
    setEditError(msg);
    return msg || 'error';
  };
  const undo = (): void => {
    if (h?.undo()) {
      setEditError('');
      bump((n) => n + 1);
    }
  };
  const redo = (): void => {
    if (h?.redo()) {
      setEditError('');
      bump((n) => n + 1);
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('input,textarea,select')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) undo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  // ---- 自動保存（F-210）: 編集のたびに約0.3秒で束ねて書き出す。終了時は即時に書く ----
  const latest = useRef({ h, path: loaded?.path ?? null });
  latest.current = { h, path: loaded?.path ?? null };
  const dirty = useRef(false);
  const flush = (): Promise<void> => {
    const { h: hist, path } = latest.current;
    if (!dirty.current || !hist || !path) return Promise.resolve();
    dirty.current = false;
    setSave({ kind: 'saving' });
    return window.api
      .invoke('repo:save', { files: serializeSchedule(hist.present) })
      .then(() => setSave({ kind: 'saved' }))
      .catch((e: unknown) => setSave({ kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(() => {
    if (edits === 0 || !latest.current.path) return;
    dirty.current = true;
    setSave({ kind: 'saving' }); // 書き出しが済むまでは「保存済み」と出さない
    const timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // flush は ref だけを読むので依存に入れない
  }, [edits]);
  useEffect(() => {
    const onHide = (): void => void flush();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const discardRecovered = async (): Promise<void> => {
    if (!recovery || !loaded?.path || !window.confirm(t('recover.confirm', { count: String(recovery.lines.length) }))) return;
    await window.api.invoke('repo:save', { files: recovery.base });
    setLoaded({ ...loaded, history: new History(recovery.baseSchedule) });
    setRecovery(null);
    setSave({ kind: 'saved' });
  };

  const saveText = !loaded?.path
    ? t('save.none')
    : save.kind === 'saving'
      ? t('save.saving')
      : save.kind === 'failed'
        ? t('save.failed', { message: save.message })
        : save.kind === 'saved'
          ? t('save.saved')
          : '';

  return (
    <main className="app">
      <header className="appbar">
        <h1 data-testid="title">{t('app.title')}</h1>
        <span className="version" data-testid="version">
          {t('app.version', { version })}
        </span>
        <span className="spacer" />
        <button type="button" data-testid="create" onClick={() => void createFolder()}>
          {t('app.create')}
        </button>
        <button type="button" data-testid="clone" onClick={() => setCloneOpen(true)}>
          {t('app.clone')}
        </button>
        <button type="button" data-testid="open" onClick={() => void openFolder()}>
          {t('app.open')}
        </button>
        <button type="button" data-testid="sample" onClick={showSample}>
          {t('app.sample')}
        </button>
      </header>
      {message ? (
        <section className="notice" role="alert" data-testid="notice">
          <p>{message}</p>
          {problems.length > 0 ? (
            <ul>
              {problems.map((p, i) => (
                <li key={`${p.path}-${i}`}>
                  <code>{p.path}</code> {p.message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {recovery ? (
        <section className="notice" role="alert" data-testid="recovery">
          <p>{t('recover.title', { count: String(recovery.lines.length) })}</p>
          <p className="plain">{t('recover.body')}</p>
          <ul>
            {recovery.lines.slice(0, 50).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <button type="button" data-testid="recover-keep" onClick={() => setRecovery(null)}>
            {t('recover.keep')}
          </button>{' '}
          <button type="button" data-testid="recover-discard" onClick={() => void discardRecovered()}>
            {t('recover.discard')}
          </button>
        </section>
      ) : null}
      {cloneOpen ? (
        <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && setCloneOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" data-testid="dialog-clone">
            <h2>{t('clone.title')}</h2>
            <p>{t('clone.body')}</p>
            <label className="field">
              <span>{t('sync.remoteLabel')}</span>
              <input data-testid="clone-url" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} />
            </label>
            <div className="actions">
              <button type="button" data-testid="clone-go" disabled={cloneUrl.trim() === ''} onClick={() => void cloneFolder()}>
                {t('clone.go')}
              </button>
              <button type="button" onClick={() => setCloneOpen(false)}>
                {t('sync.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {directPending ? (
        <div className="modal-back">
          <div className="modal" role="dialog" aria-modal="true" data-testid="dialog-direct">
            <h2>{t('direct.title')}</h2>
            <p>{t('direct.body')}</p>
            <div className="actions">
              <button
                type="button"
                data-testid="direct-make-work"
                onClick={() => {
                  setDirectPending(null);
                  setWorksSignal((n) => n + 1);
                }}
              >
                {t('direct.makeWork')}
              </button>
              <button
                type="button"
                data-testid="direct-go"
                onClick={() => {
                  const c = directPending;
                  setDirectPending(null);
                  setMainOk(true);
                  // 確認前に行おうとした編集をそのまま適用する
                  if (h?.execute(c).ok) {
                    setEditError('');
                    bump((n) => n + 1);
                  }
                }}
              >
                {t('direct.go')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {editError ? (
        <section className="notice" role="alert" data-testid="edit-error">
          <p>{editError}</p>
        </section>
      ) : null}
      {loaded ? (
        <>
          <div className="infobar" data-testid="info">
            <span>{loaded.label}</span>
            {loaded.errors + loaded.warnings > 0 ? <span className="issues">{t('app.issues', { errors: String(loaded.errors), warnings: String(loaded.warnings) })}</span> : null}
            <span className="spacer" />
            {loaded.path ? (
              <VersionControls
                key={opened}
                schedule={loaded.history.present}
                edits={edits}
                flush={flush}
                onReload={reloadFromDisk}
                onInfo={setVer}
                openWorksSignal={worksSignal}
                onRestore={(sc) => {
                  setLoaded({ ...loaded, history: new History(sc) });
                  setEditError('');
                  bump((n) => n + 1);
                }}
              />
            ) : null}
            <span data-testid="save-state" className={save.kind === 'failed' ? 'issues' : undefined}>
              {saveText}
            </span>
            <button type="button" data-testid="undo" disabled={!h?.canUndo} onClick={undo}>
              {t('app.undo')}
            </button>
            <button type="button" data-testid="redo" disabled={!h?.canRedo} onClick={redo}>
              {t('app.redo')}
            </button>
          </div>
          <TimelineView schedule={loaded.history.present} docKey={loaded.history} commit={commit} />
        </>
      ) : (
        <p className="empty" data-testid="empty">
          {t('app.empty')}
        </p>
      )}
    </main>
  );
}
