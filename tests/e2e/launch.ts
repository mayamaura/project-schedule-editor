import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const root = resolve(__dirname, '../..');

/**
 * アプリを起動する。VS Code など Electron 製ホストから起動すると ELECTRON_RUN_AS_NODE=1 が引き継がれ、
 * Electron が Node として動いて起動に失敗するため、引き継がない。
 */
export async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ...extraEnv } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  // アプリのデータ領域（AI の設定・ログなど）は、起動ごとに空の場所にする（テスト同士・利用者の環境と混ざらないように）
  const userData = mkdtempSync(join(tmpdir(), 'pse-userdata-'));
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="title"]');
  return { app, page };
}
