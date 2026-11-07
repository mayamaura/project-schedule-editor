import { z } from 'zod';

// IPC チャネルの定義（唯一の正）。入出力は zod で検証する。
// 新しいチャネルは必ずここに追加し、Main 側は handle() で実装する（architecture 2）。
export const ipcSchemas = {
  'app:getVersion': { input: z.undefined(), output: z.string() },
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['output']>;

/** Renderer に公開する API（preload が contextBridge で window.api として公開する）。 */
export interface Api {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>>;
}
