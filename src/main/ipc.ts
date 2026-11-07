import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ipcSchemas, type IpcChannel, type IpcInput, type IpcOutput } from '@shared/ipc';
import { GitService, resolveGit } from './git/gitService';
import { beginSession, endSession, loadFiles, recover, saveFiles } from './fileRepository';

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
  handle('repo:open', async (_input, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: '日程データのフォルダを開く', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const root = r.filePaths[0];
    if (r.canceled || !root) return null;
    if (currentRoot) endSession(currentRoot);
    recover(root); // 更新の途中で終わっていたら完了させる（F-211 の基礎）
    const session = beginSession(root);
    currentRoot = root;
    gitService = gitFor(root);
    return { path: root, files: loadFiles(root), ...session };
  });
  handle('repo:save', ({ files }) => {
    if (!currentRoot) throw new Error('フォルダが開かれていない');
    return { written: saveFiles(currentRoot, files).written.length };
  });
  handle('git:state', async () => {
    if (!gitService) return { available: false, isRepo: false, branch: null, dirty: false, head: null };
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
  handle('git:filesAt', ({ hash }) => needGit().filesAt(hash));
  handle('git:diagnose', () => needGit().diagnose());
  app.on('before-quit', () => {
    if (currentRoot) endSession(currentRoot);
  });
}
