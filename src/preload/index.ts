import { contextBridge, ipcRenderer } from 'electron';
import { ipcSchemas, type Api, type IpcChannel } from '@shared/ipc';

// Renderer に公開するのは invoke だけ。定義済みのチャネルのみ通す（NF-007）。
// @req NF-007
const api: Api = {
  invoke: (channel: IpcChannel, input?: unknown) => {
    if (!(channel in ipcSchemas)) return Promise.reject(new Error(`unknown channel: ${String(channel)}`));
    return ipcRenderer.invoke(channel, input) as never;
  },
};

contextBridge.exposeInMainWorld('api', api);
