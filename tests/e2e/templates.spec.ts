// @req F-801, F-802, F-803, F-805, F-807, F-809
// 標準日程: 作成 → ファイルに保存 → 展開（プレビューを見て追加）→ 既存プロジェクトにも展開。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tpl-e2e-'));
  ({ app, page } = await launch());
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as never;
  }, dir);
  await page.getByTestId('create').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

test('標準日程を作ると、templates/ に 1 ファイルで保存され、一覧に出る', async () => {
  await page.getByTestId('tpl-open').click();
  await page.getByTestId('tpl-new').click();
  await page.getByTestId('tpl-name').fill('標準リリース日程');
  await page.getByTestId('tpl-add-milestone').click();
  await page.getByTestId('tpl-milestone-name-0').fill('リリース');
  await page.getByTestId('tpl-add-event').click();
  await page.getByTestId('tpl-event-name-0').fill('試作');
  await page.getByTestId('tpl-event-start-0-months').fill('2');
  await page.getByTestId('tpl-event-start-0-dir').selectOption('before');
  await page.getByTestId('tpl-event-end-0-days').fill('0');
  await page.getByTestId('tpl-event-end-0-months').fill('1');
  await page.getByTestId('tpl-event-end-0-dir').selectOption('before');
  await page.getByTestId('tpl-save').click();
  await expect(page.getByTestId('tpl-item')).toHaveCount(1);
  await expect(page.getByTestId('tpl-item')).toContainText('標準リリース日程');
  await page.getByTestId('tpl-close').click();

  const files = readdirSync(join(dir, 'templates'));
  expect(files).toHaveLength(1);
  const text = readFileSync(join(dir, 'templates', files[0]!), 'utf8');
  expect(text).toContain('"months": -2');
  expect(text.endsWith('\n')).toBe(true);
});

test('展開前にプレビューで日付を確認し、追加すると新しいプロジェクトができて自動保存される', async () => {
  await page.getByTestId('tpl-add-project').click();
  await page.getByTestId('expand-name').fill('新製品C');
  await page.getByTestId('expand-date').fill('2027-06-30');
  const prev = page.getByTestId('expand-preview');
  await expect(prev).toContainText('試作: 2027-04-30 ～ 2027-05-30');
  await expect(prev).toContainText('リリース: 2027-06-30');
  await page.getByTestId('expand-go').click();
  await expect(page.getByTestId('dialog-expand')).toBeHidden();
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  const p = readdirSync(join(dir, 'projects'));
  expect(p).toHaveLength(1);
  const body = readFileSync(join(dir, 'projects', p[0]!), 'utf8');
  expect(body).toContain('新製品C');
  expect(body).toContain('2027-04-30');

  // Undo 1 回で全て取り消される（1 コマンド）
  await page.getByTestId('undo').click();
  await expect(page.locator('.tree-row')).toHaveCount(0);
});

test('標準日程を削除しても、展開済みのプロジェクトには影響しない', async () => {
  await page.getByTestId('redo').click();
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await page.getByTestId('tpl-open').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('tpl-delete').click();
  await expect(page.getByTestId('tpl-item')).toHaveCount(0);
  await page.getByTestId('tpl-close').click();
  expect(existsSync(join(dir, 'templates')) ? readdirSync(join(dir, 'templates')) : []).toHaveLength(0);
  await expect(page.locator('.tree-row')).toHaveCount(1);
});
