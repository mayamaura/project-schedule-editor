import { z } from 'zod';

// IPC チャネルの定義（唯一の正）。入出力は zod で検証する。
// 新しいチャネルは必ずここに追加し、Main 側は handle() で実装する（architecture 2）。
export const ipcSchemas = {
  'app:getVersion': { input: z.undefined(), output: z.string() },
  /** フォルダ選択ダイアログ → 日程データを読み込む。キャンセルなら null（F-501 の「開く」）。 */
  'repo:open': {
    input: z.undefined(),
    output: z
      .object({
        path: z.string(),
        files: z.record(z.string(), z.string()),
        /** 前回が正常終了しなかった（F-211）。 */
        crashed: z.boolean(),
        /** crashed のとき、前回の正常な開始時点の内容（変更一覧・破棄の基準）。 */
        base: z.record(z.string(), z.string()).nullable(),
      })
      .nullable(),
  },
  /** 開いているフォルダへ自動保存する（F-210）。パスは Main が保持するものを使い、Renderer からは受け取らない。 */
  'repo:save': { input: z.object({ files: z.record(z.string(), z.string()) }), output: z.object({ written: z.number() }) },
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['output']>;

/** Renderer に公開する API（preload が contextBridge で window.api として公開する）。 */
export interface Api {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>>;
}
