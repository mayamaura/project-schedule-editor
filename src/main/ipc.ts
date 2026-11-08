import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ipcSchemas, type IpcChannel, type IpcInput, type IpcOutput } from '@shared/ipc';
import { GitService, resolveGit } from './git/gitService';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { emptySchedule } from '../domain/model';
import { serializeSchedule } from '../domain/serialize';
import { parseCalendar } from '../domain/calendar';
import { parseCsv, toCsv } from '../domain/csv';
import { parseTemplate } from '../domain/template';
import { beginSession, createEmpty, deleteTemplate, endSession, loadFiles, recover, saveCalendar, saveFiles, saveTemplate } from './fileRepository';

// 開いているフォルダ（Renderer からパスは受け取らない。NF-007）
let currentRoot: string | null = null;
let gitService: GitService | null = null;

// ponytail: 同梱 Git（dugite）は未導入。導入したら bundledPath に渡す（architecture 3.5）
function gitFor(root: string): GitService | null {
  const info = resolveGit({});
  return info ? new GitService(info, root) : null;
}
const needGit = (): GitService => {
  if (!gitService) throw new Error('Git を使えません');
  return gitService;
};

// アプリ自身の画面（packaged は file://、開発時は dev サーバ）からの呼び出しだけを受け付ける。
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return url.startsWith('file://') || (dev !== undefined && url.startsWith(dev));
}

/**
 * 型付き IPC ハンドラの登録。入力・出力を zod で検証する。
 * @req NF-007
 */
export function handle<C extends IpcChannel>(
  channel: C,
  fn: (input: IpcInput<C>, event: IpcMainInvokeEvent) => IpcOutput<C> | Promise<IpcOutput<C>>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!isTrustedSender(event)) throw new Error('untrusted sender');
    const spec = ipcSchemas[channel];
    const input = spec.input.parse(raw) as IpcInput<C>;
    return spec.output.parse(await fn(input, event));
  });
}

export function registerIpc(): void {
  handle('app:getVersion', () => app.getVersion());
  /** フォルダを開いた状態にする（異常終了の検出・Git の解決を含む）。 */
  function activate(root: string): { path: string; files: Record<string, string>; crashed: boolean; base: Record<string, string> | null } {
    if (currentRoot) endSession(currentRoot);
    recover(root); // 更新の途中で終わっていたら完了させる（F-211 の基礎）
    const session = beginSession(root);
    currentRoot = root;
    gitService = gitFor(root);
    return { path: root, files: loadFiles(root), ...session };
  }
  async function pickFolder(event: IpcMainInvokeEvent, title: string, create: boolean): Promise<string | null> {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title, properties: create ? (['openDirectory', 'createDirectory'] as const).slice() : (['openDirectory'] as const).slice() };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  }
  handle('repo:open', async (_input, event) => {
    const root = await pickFolder(event, '日程データのフォルダを開く', false);
    return root ? activate(root) : null;
  });
  handle('repo:create', async (_input, event) => {
    const root = await pickFolder(event, '新しい日程データを作るフォルダを選ぶ（空のフォルダ）', true);
    if (!root) return { status: 'cancelled' as const };
    if (!createEmpty(root, serializeSchedule(emptySchedule())).ok) return { status: 'not-empty' as const };
    const opened = activate(root);
    // 保存の履歴も始める（Git が使えなければ編集だけできる）
    await gitService?.init().catch(() => undefined);
    return { status: 'ok' as const, ...opened };
  });
  handle('repo:save', ({ files }) => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    return { written: saveFiles(currentRoot, files).written.length };
  });
  handle('git:state', async () => {
    if (!gitService) return { available: false, isRepo: false, branch: null, dirty: false, head: null, hasRemote: false };
    return { available: true, ...(await gitService.state()) };
  });
  handle('git:init', async () => {
    try {
      await needGit().init();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('git:save', ({ message, identity }) => needGit().save(message, identity));
  handle('git:log', ({ limit }) => needGit().log(limit));
  handle('git:commitChange', ({ hash }) => needGit().commitChange(hash));
  handle('git:filesAt', ({ hash }) => needGit().filesAt(hash));
  handle('work:list', async () => {
    const g = needGit();
    return { current: (await g.state()).branch, hasRemote: await g.hasRemote(), items: await g.workVersions() };
  });
  handle('work:create', async ({ display }) => {
    const r = await needGit().createWork(display);
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  });
  handle('work:switch', async ({ name }) => {
    const r = await needGit().switchTo(name);
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  });
  // CSV の読み書き（F-602）。ファイルの選択は OS のダイアログ。Excel の CSV は Shift_JIS のことがあるので、UTF-8 で読めなければ Shift_JIS で読む。
  handle('csv:import', async (_input, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'CSV ファイルを選ぶ', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile' as const] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return { status: 'cancelled' as const };
    try {
      const buf = readFileSync(file);
      if (buf.length > 50 * 1024 * 1024) return { status: 'failed' as const, message: 'ファイルが大きすぎます（50MB まで）' };
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('\uFFFD')) text = new TextDecoder('shift_jis').decode(buf);
      return { status: 'ok' as const, fileName: basename(file), rows: parseCsv(text) };
    } catch (e) {
      return { status: 'failed' as const, message: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('csv:export', async ({ rows }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'CSV ファイルに書き出す', defaultPath: '日程.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { status: 'cancelled' as const };
    try {
      writeFileSync(r.filePath, `\uFEFF${toCsv(rows)}`, 'utf8'); // BOM つき UTF-8（Excel で文字化けしない）
      return { status: 'ok' as const, path: r.filePath };
    } catch (e) {
      return { status: 'failed' as const, message: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('template:save', ({ id, text }) => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    const p = parseTemplate(text);
    if (!p.ok) throw new Error(`標準日程の内容が正しくありません: ${p.message}`);
    if (p.template.id !== id) throw new Error('標準日程の id とファイル名が一致しません');
    saveTemplate(currentRoot, id, text);
    return undefined;
  });
  handle('calendar:save', ({ text }) => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    const p = parseCalendar(text);
    if (!p.ok) throw new Error(`カレンダーの内容が正しくありません: ${p.message}`);
    saveCalendar(currentRoot, text);
    return undefined;
  });
  handle('template:delete', ({ id }) => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    deleteTemplate(currentRoot, id);
    return undefined;
  });
  handle('repo:reload', () => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    return { files: loadFiles(currentRoot) };
  });
  handle('sync:prepare', async () => {
    const g = needGit();
    const f = await g.fetch();
    if (!f.ok) return { status: 'fetch-failed' as const, message: f.message };
    const m = await g.mergeInputs();
    if (m.status === 'dirty') return { status: 'dirty' as const };
    if (m.status === 'up-to-date') {
      const mode = (await g.state()).branch === 'main' ? ('main' as const) : ('work' as const);
      return { status: 'up-to-date' as const, mode, main: mode === 'work' ? await g.mainFiles() : null };
    }
    return m;
  });
  handle('sync:complete', ({ files, theirsRef, message, identity }) => needGit().completeMerge(files, theirsRef, message, identity));
  handle('sync:reflect', ({ display, identity }) => needGit().finishReflect(display, identity));
  handle('sync:push', () => needGit().push());
  handle('git:setRemote', async ({ url }) => {
    const r = await needGit().setRemote(url);
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  });
  handle('repo:clone', async ({ url }, event) => {
    const root = await pickFolder(event, '共有先から取得するフォルダを選ぶ（空のフォルダ）', true);
    if (!root) return { status: 'cancelled' as const };
    if (readdirSync(root).length > 0) return { status: 'not-empty' as const };
    const info = resolveGit({});
    if (!info) return { status: 'failed' as const, message: 'Git が見つかりません。Git をインストールしてください' };
    const r = await GitService.clone(info, url, root);
    if (!r.ok) return { status: 'failed' as const, message: r.message };
    // 作ったばかりの空の共有先: 日程データがまだ無いので、新規作成と同じく空の日程データを用意する（F-501）
    if (!('schedule.json' in loadFiles(root))) {
      if (!createEmpty(root, serializeSchedule(emptySchedule())).ok) return { status: 'failed' as const, message: '取得したフォルダに日程データが見つかりません。日程データのある共有先を指定してください' };
      await new GitService(info, root).ensureMainBranch();
    }
    return { status: 'ok' as const, ...activate(root) };
  });
  handle('git:diagnose', () => needGit().diagnose());
  app.on('before-quit', () => {
    if (currentRoot) endSession(currentRoot);
  });
}
