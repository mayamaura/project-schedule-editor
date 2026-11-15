// @req F-212, F-501, F-101, F-206, F-208, F-210, F-211
import { useEffect, useRef, useState } from 'react';
import { History, defaultCalendar, diffSchedule, exportRows, newIssues, parseAiPrompts, parseViews, serializeView, generateSample, parseCalendar, parseSchedule, parseTemplates, serializeCalendar, serializeSchedule, serializeTemplate, summarizeChange, type Calendar, type Command, type PromptTemplate, type SavedView, type Id, type Schedule, type ParseIssue, type Template } from '@domain/index';
import { t } from './i18n';
import { AiPanel } from './AiPanel';
import { CalendarDialog } from './CalendarDialog';
import { TypesDialog } from './TypesDialog';
import { CsvImportDialog } from './CsvDialog';
import { ExportDialog, type TimelineApi } from './ExportDialog';
import { ExpandDialog, SaveAsTemplateDialog, TemplateManager, type ExpandPreset } from './Templates';
import { TimelineView } from './timeline/TimelineView';
import { VersionControls, type VersionApi, type VersionInfo } from './VersionControls';
import { MenuButton } from './Menu';
import { CommandPalette } from './CommandPalette';
import { findByKey, type Cmd } from './shortcuts';

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
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try {
      const v = localStorage.getItem('theme');
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    void window.api.invoke('app:setTheme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* 保存できなくても動作する */
    }
  }, [theme]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problems, setProblems] = useState<readonly ParseIssue[]>([]);
  const [message, setMessage] = useState('');
  const [editError, setEditError] = useState('');
  const [editWarn, setEditWarn] = useState('');
  // 新たな指摘の知らせは、しばらくしたら消す（画面のレイアウトは動かさない）
  useEffect(() => {
    if (!editWarn) return;
    const id = window.setTimeout(() => setEditWarn(''), 12000);
    return () => window.clearTimeout(id);
  }, [editWarn]);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [edits, bump] = useState(0);
  const [ver, setVer] = useState<VersionInfo>({ branch: null, hasHistory: false, isRepo: false });
  const [mainOk, setMainOk] = useState(false);
  const [directPending, setDirectPending] = useState<Command | null>(null);
  const [worksSignal, setWorksSignal] = useState(0);
  const [opened, setOpened] = useState(0); // フォルダを開き直すたびに増える（版の表示を作り直す）
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState('');
  const [templates, setTemplates] = useState<Readonly<Record<Id, Template>>>({});
  const [tplOpen, setTplOpen] = useState(false);
  const [calendar, setCalendar] = useState<Calendar>(defaultCalendar());
  const [calOpen, setCalOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [saveAs, setSaveAs] = useState<Id | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const pendingAiNote = useRef<string | null>(null); // 確認（F-520）を挟んで適用される AI 提案の要約
  const [sharedPrompts, setSharedPrompts] = useState<PromptTemplate[]>([]);
  const [sharedViews, setSharedViews] = useState<SavedView[]>([]);
  const [personalViews, setPersonalViews] = useState<SavedView[]>([]);
  // 個人用のビューは、この PC（ブラウザ領域）にだけ保存する。フォルダごとに分ける（F-403）
  const personalKey = loaded?.path ? `pse.views:${loaded.path}` : null;
  useEffect(() => {
    if (!personalKey) return setPersonalViews([]);
    try {
      const raw = JSON.parse(localStorage.getItem(personalKey) ?? '[]') as SavedView[];
      setPersonalViews(Array.isArray(raw) ? raw.map((v) => ({ ...v, shared: false })) : []);
    } catch {
      setPersonalViews([]);
    }
  }, [personalKey]);
  const storePersonal = (list: SavedView[]): void => {
    setPersonalViews(list);
    if (!personalKey) return;
    try {
      localStorage.setItem(personalKey, JSON.stringify(list));
    } catch {
      /* 保存できなくても、画面の操作は続けられる */
    }
  };
  const saveView = async (v: SavedView): Promise<string | null> => {
    if (!v.shared) {
      storePersonal([...personalViews, v]);
      return null;
    }
    try {
      await window.api.invoke('view:save', { id: v.id, text: serializeView(v) });
      setSharedViews((l) => [...l.filter((x) => x.id !== v.id), v]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const deleteView = (v: SavedView): void => {
    if (!v.shared) return storePersonal(personalViews.filter((x) => x.id !== v.id));
    void window.api.invoke('view:delete', { id: v.id }).then(() => setSharedViews((l) => l.filter((x) => x.id !== v.id)));
  };
  const timelineApi = useRef<TimelineApi | null>(null);
  const verApi = useRef<VersionApi | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [csv, setCsv] = useState<{ fileName: string; rows: string[][] } | null>(null);
  const [expand, setExpand] = useState<ExpandPreset | null>(null);

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
      setEditWarn('');
      setTemplates(loadTemplates(r.files));
      setCalendar(loadCalendar(r.files));
      setSharedPrompts(parseAiPrompts(r.files).prompts);
      setSharedViews(parseViews(r.files).views);
      setAiNotes([]);
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

  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    void window.api.invoke('repo:recent').then(setRecent);
  }, [loaded?.path]);
  const openFolder = async (): Promise<void> => {
    const r = await window.api.invoke('repo:open');
    if (r) applyOpened(r);
  };
  const openRecent = async (path: string): Promise<void> => {
    const r = await window.api.invoke('repo:openRecent', { path });
    if (r) applyOpened(r);
    else setMessage(t('app.recentMissing'));
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
    setCloneError('');
    setCloneBusy(true);
    try {
      const r = await window.api.invoke('repo:clone', { url: cloneUrl.trim() });
      if (r.status === 'ok') {
        setCloneOpen(false);
        setProblems([]);
        applyOpened(r);
      } else if (r.status === 'not-empty') setCloneError(t('clone.notEmpty'));
      else if (r.status === 'failed') setCloneError(t('clone.failed', { message: r.message }));
    } catch (e) {
      setCloneError(t('clone.failed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCloneBusy(false);
    }
  };

  const h = loaded?.history;

  // 標準日程（F-801）: 画面上の操作の確定ごとに 1 件ずつ書く（日程の自動保存とは別）
  const loadTemplates = (files: Record<string, string>): Readonly<Record<Id, Template>> => {
    const r = parseTemplates(files);
    if (r.errors.length > 0) setMessage(t('tpl.readError', { count: String(r.errors.length), detail: r.errors.map((e) => `${e.path}: ${e.message}`).join(' / ') }));
    return r.templates;
  };
  const loadCalendar = (files: Record<string, string>): Calendar => {
    const text = files['calendar.json'];
    if (text === undefined) return defaultCalendar();
    const r = parseCalendar(text);
    if (!r.ok) {
      setMessage(t('cal.readError', { detail: r.message }));
      return defaultCalendar();
    }
    return r.calendar;
  };
  const saveCalendar = async (c: Calendar): Promise<string | null> => {
    try {
      await window.api.invoke('calendar:save', { text: serializeCalendar(c) });
      setCalendar(c);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  // CSV の取り込み・書き出し（F-602）
  const importCsv = async (): Promise<void> => {
    const r = await window.api.invoke('csv:import');
    if (r.status === 'ok') setCsv({ fileName: r.fileName, rows: r.rows });
    else if (r.status === 'failed') setMessage(t('csv.failed', { message: r.message }));
  };
  const exportCsv = async (): Promise<void> => {
    if (!h) return;
    const r = await window.api.invoke('csv:export', { rows: exportRows(h.present) });
    if (r.status === 'ok') setMessage(t('csv.exported', { path: r.path }));
    else if (r.status === 'failed') setMessage(t('csv.failed', { message: r.message }));
  };
  const saveTemplate = async (tp: Template): Promise<string | null> => {
    try {
      await window.api.invoke('template:save', { id: tp.id, text: serializeTemplate(tp) });
      setTemplates((m) => ({ ...m, [tp.id]: tp }));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const deleteTemplate = async (id: Id): Promise<void> => {
    await window.api.invoke('template:delete', { id });
    setTemplates((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)));
  };

  // 版の切り替え・取り込みの後に、作業ツリーの日程データを読み直す（履歴は新しく始める）
  const reloadFromDisk = async (): Promise<void> => {
    const r = await window.api.invoke('repo:reload');
    const parsed = parseSchedule(r.files);
    if (parsed.status !== 'ok' || !loaded) {
      setMessage(t('app.readError', { count: String(parsed.status === 'error' ? parsed.errors.length : 1) }));
      return;
    }
    setLoaded({ ...loaded, history: new History(parsed.schedule) });
    setTemplates(loadTemplates(r.files));
    setCalendar(loadCalendar(r.files));
    setSharedPrompts(parseAiPrompts(r.files).prompts);
    setSharedViews(parseViews(r.files).views);
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
    const before = h?.present;
    const r = h?.execute(c);
    if (r?.ok) {
      setEditError('');
      // この変更で新たに生じた指摘（依存違反など。編集は止めず、知らせる。F-512）
      if (pendingAiNote.current) {
        const note = pendingAiNote.current;
        pendingAiNote.current = null;
        setAiNotes((n) => [...n, note]);
      }
      const fresh = before && h ? newIssues(before, h.present) : [];
      setEditWarn(fresh.length === 0 ? '' : t('edit.newIssues', { count: String(fresh.length), detail: fresh.slice(0, 3).map((i) => i.message).join(' / ') }));
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
      setEditWarn('');
      bump((n) => n + 1);
    }
  };
  const redo = (): void => {
    if (h?.redo()) {
      setEditError('');
      setEditWarn('');
      bump((n) => n + 1);
    }
  };
  // 操作の一覧（メニュー・コマンドパレット・ショートカットはすべてここから作る。NF-009）
  const hasData = !!loaded?.path;
  const g = { data: t('menu.file'), share: t('menu.share'), settings: t('menu.settings'), ver: t('menu.ver'), view: t('menu.grpView'), edit: t('menu.grpEdit'), ai: t('menu.grpAi'), diag: t('menu.grpDiag') };
  const repo = hasData && ver.isRepo;
  const cmd = (c: Cmd): Cmd => c;
  const recentCmds = recent.map((p) => cmd({ id: `recent:${p}`, label: t('cmd.recent', { path: p }), group: g.data, testid: 'recent-item', run: () => void openRecent(p) }));
  const dataCmds: Cmd[] = [
    cmd({ id: 'open', label: t('app.open'), group: g.data, shortcut: 'Ctrl+O', inputOk: true, testid: 'open', run: () => void openFolder() }),
    cmd({ id: 'create', label: t('app.create'), group: g.data, shortcut: 'Ctrl+N', inputOk: true, testid: 'create', run: () => void createFolder() }),
    cmd({ id: 'clone', label: t('app.clone'), group: g.data, testid: 'clone', run: () => { setCloneError(''); setCloneOpen(true); } }),
    cmd({ id: 'sample', label: t('app.sample'), group: g.data, testid: 'sample', run: showSample }),
    cmd({ id: 'tpl-add', label: t('tpl.addProject'), group: g.data, enabled: hasData, testid: 'tpl-add-project', run: () => setExpand({}) }),
  ];
  const shareCmds: Cmd[] = [
    cmd({ id: 'export', label: t('exp.open'), group: g.share, enabled: hasData, testid: 'export-open', run: () => setExportOpen(true) }),
    cmd({ id: 'csv-in', label: t('csv.import'), group: g.share, enabled: hasData, testid: 'csv-import', run: () => void importCsv() }),
    cmd({ id: 'csv-out', label: t('csv.export'), group: g.share, enabled: hasData, testid: 'csv-export', run: () => void exportCsv() }),
  ];
  const themes = [['system', 'app.themeSystem'], ['light', 'app.themeLight'], ['dark', 'app.themeDark']] as const;
  const themeCmds: Cmd[] = themes.map(([v, key]) => cmd({ id: `theme-${v}`, label: `${theme === v ? '✓ ' : ''}${t('app.theme')}: ${t(key)}`, group: g.settings, testid: `theme-${v}`, run: () => setTheme(v) }));
  const settingsCmds: Cmd[] = [
    cmd({ id: 'tpl', label: t('tpl.open'), group: g.settings, enabled: hasData, testid: 'tpl-open', run: () => setTplOpen(true) }),
    cmd({ id: 'types', label: t('types.open'), group: g.settings, enabled: hasData, testid: 'types-open', run: () => setTypesOpen(true) }),
    cmd({ id: 'cal', label: t('cal.open'), group: g.settings, enabled: hasData, testid: 'cal-open', run: () => setCalOpen(true) }),
  ];
  const verCmds: Cmd[] = [
    cmd({ id: 'v-save', label: t('ver.save'), group: g.ver, shortcut: 'Ctrl+S', inputOk: true, enabled: repo, run: () => verApi.current?.openSave() }),
    cmd({ id: 'v-history', label: t('ver.history'), group: g.ver, enabled: repo, run: () => verApi.current?.openHistory() }),
    cmd({ id: 'v-works', label: t('menu.works'), group: g.ver, enabled: repo, run: () => verApi.current?.openWorks() }),
    cmd({ id: 'v-compare', label: t('cmp.open'), group: g.ver, enabled: repo && ver.hasHistory, run: () => verApi.current?.openCompare() }),
    cmd({ id: 'v-sync', label: t(ver.branch === 'main' ? 'sync.share' : 'sync.reflect'), group: g.ver, enabled: repo && ver.hasHistory, run: () => verApi.current?.openSync() }),
    cmd({ id: 'v-diag', label: t('ver.diagnose'), group: g.diag, enabled: repo, run: () => verApi.current?.openDiagnose() }),
  ];
  const viewCmds: Cmd[] = [
    cmd({ id: 'today', label: t('cmd.today'), group: g.view, shortcut: 'T', enabled: !!loaded, run: () => timelineApi.current?.goToday() }),
    cmd({ id: 'zoom-in', label: t('cmd.zoomIn'), group: g.view, shortcut: '+', enabled: !!loaded, run: () => timelineApi.current?.zoomBy(1.5) }),
    cmd({ id: 'zoom-out', label: t('cmd.zoomOut'), group: g.view, shortcut: '-', enabled: !!loaded, run: () => timelineApi.current?.zoomBy(1 / 1.5) }),
    cmd({ id: 'filter', label: t('cmd.filter'), group: g.view, shortcut: 'Ctrl+F', inputOk: true, enabled: !!loaded, run: () => timelineApi.current?.toggleFilter() }),
    cmd({ id: 'palette', label: t('cmd.palette'), group: g.view, shortcut: 'Ctrl+K', inputOk: true, run: () => setPaletteOpen(true) }),
    cmd({ id: 'shortcuts', label: t('cmd.shortcuts'), group: g.view, shortcut: '?', run: () => setPaletteOpen(true) }),
  ];
  const editCmds: Cmd[] = [
    cmd({ id: 'undo', label: t('app.undo'), group: g.edit, shortcut: 'Ctrl+Z', enabled: !!h?.canUndo, run: undo }),
    cmd({ id: 'redo', label: t('app.redo'), group: g.edit, shortcut: 'Ctrl+Y', also: 'Ctrl+Shift+Z', enabled: !!h?.canRedo, run: redo }),
    cmd({ id: 'ai', label: t('cmd.ai'), group: g.ai, shortcut: 'Ctrl+J', inputOk: true, enabled: hasData, run: () => setAiOpen((v) => !v) }),
  ];
  const allCmds = [...dataCmds, ...recentCmds, ...shareCmds, ...settingsCmds, ...themeCmds, ...verCmds, ...viewCmds, ...editCmds];
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (paletteOpen || document.querySelector('.modal-back')) return; // ダイアログ・パレットが開いている間は、画面の操作を奪わない
      const t0 = e.target as HTMLElement;
      const c = findByKey(allCmds, e, !!t0.closest('input,textarea,select,[contenteditable="true"]'));
      if (!c) return;
      e.preventDefault();
      c.run();
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
        <MenuButton id="file" align="right" label={t('menu.file')} entries={[...dataCmds.slice(0, 4), ...(recent.length > 0 ? [t('menu.recentHead'), ...recentCmds] : []), t('menu.projectHead'), dataCmds[4]!]} />
        <MenuButton id="share" align="right" className="wide-only" label={t('menu.share')} entries={shareCmds} />
        <MenuButton id="settings" align="right" className="wide-only" label={t('menu.settings')} entries={[...settingsCmds, t('menu.themeHead'), ...themeCmds]} />
        <MenuButton id="more" className="narrow-only" label="…" ariaLabel={t('menu.more')} align="right" entries={[t('menu.share'), ...shareCmds, t('menu.settings'), ...settingsCmds, t('menu.themeHead'), ...themeCmds]} />
        <button type="button" className="palette-btn" data-testid="palette-open" onClick={() => setPaletteOpen(true)}>
          {t('menu.search')} <kbd>Ctrl+K</kbd>
        </button>
        {hasData ? (
          <button type="button" className="ai-btn" data-testid="ai-open" aria-pressed={aiOpen} onClick={() => setAiOpen((v) => !v)}>
            ✦ {t('ai.open')}
          </button>
        ) : null}
        {repo ? (
          <button type="button" className="diag-btn" data-testid="ver-diagnose" onClick={() => verApi.current?.openDiagnose()}>
            {t('ver.diagnose')}
          </button>
        ) : null}
      </header>
      {paletteOpen ? <CommandPalette cmds={allCmds} onClose={() => setPaletteOpen(false)} /> : null}
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
            {cloneBusy ? <p role="status" data-testid="clone-busy">{t('clone.busy')}</p> : null}
            {cloneError ? <p role="alert" data-testid="clone-error">{cloneError}</p> : null}
            <div className="actions">
              <button type="button" data-testid="clone-go" disabled={cloneUrl.trim() === '' || cloneBusy} onClick={() => void cloneFolder()}>
                {t('clone.go')}
              </button>
              <button type="button" disabled={cloneBusy} onClick={() => setCloneOpen(false)}>
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
                    if (pendingAiNote.current) {
                      const note = pendingAiNote.current;
                      pendingAiNote.current = null;
                      setAiNotes((n) => [...n, note]);
                    }
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
      {editWarn && !editError ? (
        <section className="notice warn" role="status" data-testid="edit-warn">
          <p>{editWarn}</p>
        </section>
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
                templates={templates}
                calendar={calendar}
                sharedPrompts={sharedPrompts}
                sharedViews={sharedViews}
                aiNotes={aiNotes}
                onSaved={() => setAiNotes([])}
                edits={edits}
                flush={flush}
                onReload={reloadFromDisk}
                onInfo={setVer}
                openWorksSignal={worksSignal}
                apiRef={verApi}
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
          <TimelineView schedule={loaded.history.present} docKey={loaded.history} commit={commit} calendar={calendar} apiRef={timelineApi} views={[...sharedViews, ...personalViews]} onSaveView={saveView} onDeleteView={deleteView} canShareViews={!!loaded.path} {...(loaded.path ? { onExpand: setExpand, onSaveAsTemplate: setSaveAs } : {})} />
          {aiOpen && loaded.path ? (
            <AiPanel
              schedule={loaded.history.present}
              sharedPrompts={sharedPrompts}
              api={timelineApi.current}
              flush={flush}
              onClose={() => setAiOpen(false)}
              onApply={(command, summary) => {
                // 正式版の直接編集の確認（F-520）が出たときは、確認後に適用される（その時点で記録する）。承認の記録は、確認を待つ間も「適用」として扱う
                pendingAiNote.current = summary;
                const err = commit(command as Command);
                if (err !== null && err !== t('direct.title')) pendingAiNote.current = null;
                return err === t('direct.title') ? null : err;
              }}
              onReloadShared={() => void window.api.invoke('repo:reload').then((r) => setSharedPrompts(parseAiPrompts(r.files).prompts))}
            />
          ) : null}
          {exportOpen ? <ExportDialog schedule={loaded.history.present} calendar={calendar} versionLabel={ver.branch === 'main' || ver.branch === null ? t('exp.main') : t('exp.work')} api={timelineApi.current} onDone={setMessage} onClose={() => setExportOpen(false)} /> : null}
          {saveAs ? <SaveAsTemplateDialog schedule={loaded.history.present} projectId={saveAs} onSave={saveTemplate} onClose={() => setSaveAs(null)} /> : null}
          {csv ? (
            <CsvImportDialog
              fileName={csv.fileName}
              rows={csv.rows}
              schedule={loaded.history.present}
              onApply={(c) => {
                commit(c);
                setCsv(null);
              }}
              onClose={() => setCsv(null)}
            />
          ) : null}
          {typesOpen && loaded ? <TypesDialog schedule={loaded.history.present} commit={commit} onClose={() => setTypesOpen(false)} /> : null}
          {calOpen ? <CalendarDialog calendar={calendar} onSave={saveCalendar} onClose={() => setCalOpen(false)} /> : null}
          {tplOpen ? <TemplateManager templates={templates} typeNames={Object.keys(loaded.history.present.types)} onSave={saveTemplate} onDelete={deleteTemplate} onClose={() => setTplOpen(false)} /> : null}
          {expand ? (
            <ExpandDialog
              schedule={loaded.history.present}
              templates={templates}
              calendar={calendar}
              preset={expand}
              onApply={(c) => {
                commit(c);
                setExpand(null);
              }}
              onClose={() => setExpand(null)}
            />
          ) : null}
        </>
      ) : (
        <p className="empty" data-testid="empty">
          {t('app.empty')}
        </p>
      )}
    </main>
  );
}
