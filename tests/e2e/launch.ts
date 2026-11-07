import { resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const root = resolve(__dirname, '../..');

/**
 * アプリを起動する。VS Code など Electron 製ホストから起動すると ELECTRON_RUN_AS_NODE=1 が引き継がれ、
 * Electron が Node として動いて起動に失敗するため、引き継がない。
 */
export async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  const app = await electron.launch({ args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="title"]');
  return { app, page };
}
