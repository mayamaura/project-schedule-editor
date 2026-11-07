// @req F-501, F-101, F-211
import { useEffect, useState } from 'react';
import { generateSample, parseSchedule, type Schedule, type ParseIssue } from '@domain/index';
import { t } from './i18n';
import { TimelineView } from './timeline/TimelineView';

interface Loaded {
  readonly schedule: Schedule;
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

  useEffect(() => {
    void window.api.invoke('app:getVersion').then(setVersion);
  }, []);

  const showSample = (): void => {
    const schedule = generateSample();
    setProblems([]);
    setMessage('');
    setLoaded({ schedule, label: t('app.sampleLoaded', counts(schedule)), errors: 0, warnings: 0 });
  };

  const openFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:open');
    if (!r) return;
    const parsed = parseSchedule(r.files);
    if (parsed.status === 'ok') {
      setProblems([]);
      setMessage('');
      setLoaded({
        schedule: parsed.schedule,
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
            <span>{t('app.readOnly')}</span>
          </div>
          <TimelineView schedule={loaded.schedule} />
        </>
      ) : (
        <p className="empty" data-testid="empty">
          {t('app.empty')}
        </p>
      )}
    </main>
  );
}
