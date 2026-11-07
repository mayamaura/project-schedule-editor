// @req NF-007, NF-011
// 起動の smoke と、Electron のセキュリティ設定の確認（NF-007）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const root = resolve(__dirname, '../..');
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // VS Code など Electron 製ホストから起動すると ELECTRON_RUN_AS_NODE=1 が引き継がれ、
  // Electron が Node として動いて起動に失敗する。テストでは引き継がない。
  const env = { ...process.env } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  app = await electron.launch({ args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="title"]');
});

test.afterAll(async () => {
  await app.close();
});

test('ウィンドウが起動し、タイトルとバージョンが表示される（IPC 経由）', async () => {
  await expect(page.getByTestId('title')).toHaveText('プロジェクトスケジュールエディタ');
  await expect(page.getByTestId('version')).toHaveText(`バージョン ${version}`);
  expect(await page.title()).toBe('プロジェクトスケジュールエディタ');
});

test('Renderer から Node.js に触れない（nodeIntegration 無効・contextIsolation 有効）', async () => {
  const result = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    apiKeys: Object.keys(window.api),
  }));
  expect(result.require).toBe('undefined');
  expect(result.process).toBe('undefined');
  expect(result.apiKeys).toEqual(['invoke']);
});

test('定義されていない IPC チャネルは拒否される', async () => {
  const message = await page.evaluate(async () => {
    try {
      await (window.api.invoke as (channel: string) => Promise<unknown>)('fs:readFile');
      return 'resolved';
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toContain('unknown channel');
});

test('CSP により外部への通信が遮断される', async () => {
  // ネットワークの有無に左右されないよう、CSP 違反イベントの発生で判定する。
  const violated = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        document.addEventListener('securitypolicyviolation', () => resolve(true), { once: true });
        fetch('https://example.com/').catch(() => setTimeout(() => resolve(false), 1000));
      }),
  );
  expect(violated).toBe(true);
});

test('インラインスクリプトは実行されない（CSP）', async () => {
  const executed = await page.evaluate(() => {
    (window as unknown as { __x?: boolean }).__x = false;
    const s = document.createElement('script');
    s.textContent = 'window.__x = true';
    document.body.appendChild(s);
    return (window as unknown as { __x?: boolean }).__x;
  });
  expect(executed).toBe(false);
});

test('新しいウィンドウを開けない', async () => {
  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => window.open('https://example.com/'));
  await page.waitForTimeout(500);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(count);
});
