import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { registerIpc } from './ipc';

// Electron のセキュリティ設定（NF-007）: contextIsolation 有効・nodeIntegration 無効・sandbox 有効、
// 外部への遷移・新規ウィンドウ・webview・権限要求を拒否する。
// @req NF-007
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'プロジェクトスケジュールエディタ',
    // 配布版は exe に埋め込んだアイコンを使う。開発中だけ build/icon.png を指定する。
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

hardenWebContents();

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
