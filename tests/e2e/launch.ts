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

/** メニューの中の項目の、親メニュー（ボタンを押すと開くメニュー）。 */
const MENU_OF: Record<string, string> = {
  open: 'file', create: 'file', clone: 'file', sample: 'file', 'tpl-add-project': 'file',
  'export-open': 'share', 'csv-import': 'share', 'csv-export': 'share',
  'tpl-open': 'settings', 'cal-open': 'settings',
  'ver-history': 'ver', 'ver-compare': 'ver', 'ver-sync': 'ver', 'ver-works': 'ver',
};

/** メニューを開いて、項目を押す。 */
export async function clickMenu(page: Page, id: string): Promise<void> {
  const menu = MENU_OF[id];
  if (!menu) throw new Error(`メニューに無い項目: ${id}`);
  await page.getByTestId(`menu-${menu}`).click();
  await page.getByTestId(id).click();
}
