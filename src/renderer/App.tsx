// @req F-501, F-101, F-211, F-206
import { useEffect, useState } from 'react';
import { History, generateSample, parseSchedule, type Command, type Schedule, type ParseIssue } from '@domain/index';
import { t } from './i18n';
import { TimelineView } from './timeline/TimelineView';

interface Loaded {
  readonly history: History;
  readonly label: string;
  readonly errors: number;
  readonly warnings: number;
}

const counts = (s: Schedule): { projects: string; events: string; milestones: string } => {
  const ps = Object.values(s.projects);
  return {
    projects: String(ps.length),
    events: String(ps.reduce((n, p) => n + Object.keys(p.events).length, 0)),
    milestones: String(ps.reduce((n, p) => n + Object.keys(p.milestones).length, 0)),
  };
};

export function App() {
  const [version, setVersion] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problems, setProblems] = useState<readonly ParseIssue[]>([]);
  const [message, setMessage] = useState('');
  const [, bump] = useState(0);

  useEffect(() => {
    void window.api.invoke('app:getVersion').then(setVersion);
  }, []);

  const showSample = (): void => {
    const schedule = generateSample();
    setProblems([]);
    setMessage('');
    setLoaded({ history: new History(schedule), label: t('app.sampleLoaded', counts(schedule)), errors: 0, warnings: 0 });
  };

  const openFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:open');
    if (!r) return;
    const parsed = parseSchedule(r.files);
    if (parsed.status === 'ok') {
      setProblems([]);
      setMessage('');
      setLoaded({
        history: new History(parsed.schedule),
        label: t('app.loaded', { path: r.path, ...counts(parsed.schedule) }),
        errors: parsed.issues.filter((i) => i.severity === 'error').length,
        warnings: parsed.issues.filter((i) => i.severity === 'warning').length,
      });
    } else if (parsed.status === 'tooNew') {
      setProblems([]);
      setMessage(t('app.tooNew', { version: String(parsed.fileVersion) }));
    } else {
      // 読み込めなかった理由を全て表示する（データを黙って捨てない）
      setProblems(parsed.errors);
      setMessage(t('app.readError', { count: String(parsed.errors.length) }));
    }
  };

  const h = loaded?.history;
  const commit = (c: Command): void => {
    if (h?.execute(c).ok) bump((n) => n + 1);
  };
  const undo = (): void => {
    if (h?.undo()) bump((n) => n + 1);
  };
  const redo = (): void => {
    if (h?.redo()) bump((n) => n + 1);
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

  return (
    <main className="app">
      <header className="appbar">
        <h1 data-testid="title">{t('app.title')}</h1>
        <span className="version" data-testid="version">
          {t('app.version', { version })}
        </span>
        <span className="spacer" />
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
      {loaded ? (
        <>
          <div className="infobar" data-testid="info">
            <span>{loaded.label}</span>
            {loaded.errors + loaded.warnings > 0 ? <span className="issues">{t('app.issues', { errors: String(loaded.errors), warnings: String(loaded.warnings) })}</span> : null}
            <span className="spacer" />
            <button type="button" data-testid="undo" disabled={!h?.canUndo} onClick={undo}>
              {t('app.undo')}
            </button>
            <button type="button" data-testid="redo" disabled={!h?.canRedo} onClick={redo}>
              {t('app.redo')}
            </button>
          </div>
          <TimelineView schedule={loaded.history.present} docKey={loaded.history} onCommit={commit} />
        </>
      ) : (
        <p className="empty" data-testid="empty">
          {t('app.empty')}
        </p>
      )}
    </main>
  );
}
