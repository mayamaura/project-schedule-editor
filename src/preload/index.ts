import { contextBridge, ipcRenderer } from 'electron';
import { ipcSchemas, type Api, type IpcChannel } from '@shared/ipc';

// Renderer に公開するのは invoke だけ。定義済みのチャネルのみ通す（NF-007）。
// @req NF-007
const api: Pick<Api, 'invoke'> = {
  invoke: (channel: IpcChannel, input?: unknown) => {
    if (!(channel in ipcSchemas)) return Promise.reject(new Error(`unknown channel: ${String(channel)}`));
    return ipcRenderer.invoke(channel, input) as never;
  },
};

const EVENT_CHANNELS = ['ai:event'] as const;
const withEvents: Api = {
  ...api,
  on: (channel, listener) => {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) throw new Error(`unknown event channel: ${String(channel)}`);
    const handler = (_e: unknown, message: unknown): void => listener(message);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('api', withEvents);
