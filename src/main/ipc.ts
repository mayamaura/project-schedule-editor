import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ipcSchemas, type IpcChannel, type IpcInput, type IpcOutput } from '@shared/ipc';
import { loadFiles, recover } from './fileRepository';

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
    recover(root); // 更新の途中で終わっていたら完了させる（F-211 の基礎）
    return { path: root, files: loadFiles(root) };
  });
}
