// @req F-501, F-210
// 新規作成: 空のフォルダを選ぶと、空の日程データと保存の履歴が用意され、すぐ編集・自動保存できる。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
test.describe.configure({ mode: 'serial' });

const pick = (d: string): Promise<void> =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as never;
  }, d);

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'create-e2e-'));
  ({ app, page } = await launch());
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('中身のあるフォルダには作らず、理由を出す', async () => {
  writeFileSync(join(dir, 'memo.txt'), 'x');
  await pick(dir);
  await page.getByTestId('create').click();
  await expect(page.getByTestId('notice')).toContainText('空ではない');
  expect(existsSync(join(dir, 'schedule.json'))).toBe(false);
  rmSync(join(dir, 'memo.txt'));
});

test('空のフォルダを選ぶと新規作成され、プロジェクトを追加すると自動保存される', async () => {
  await pick(dir);
  await page.getByTestId('create').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
  await expect(page.getByTestId('notice')).toBeHidden();
  expect(existsSync(join(dir, 'schedule.json'))).toBe(true);
  expect(existsSync(join(dir, '.git'))).toBe(true);
  await expect(page.getByTestId('unsaved')).toHaveText('最初の保存がまだです');

  await page.getByTestId('add-project').click();
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  expect(readdirSync(join(dir, 'projects')).length).toBe(1);
  expect(readFileSync(join(dir, 'projects', readdirSync(join(dir, 'projects'))[0]!), 'utf8')).toContain('新しいプロジェクト');
});
