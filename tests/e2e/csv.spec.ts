// @req F-602, F-806, F-803
// CSV の取り込み（プレビュー・飛ばす行の理由）と書き出し、既存プロジェクトを標準日程として保存、展開前のタイムライン仮表示。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
let work: string;
test.describe.configure({ mode: 'serial' });

const pickOpen = (p: string): Promise<void> =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [f] })) as never;
  }, p);

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'csv-e2e-'));
  work = mkdtempSync(join(tmpdir(), 'csv-files-'));
  ({ app, page } = await launch());
  await pickOpen(dir);
  await page.getByTestId('create').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  for (const d of [dir, work]) {
    for (let i = 0; i < 30; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
});

test('CSV を取り込むと、プレビューに件数と飛ばす行の理由が出て、取り込むとプロジェクトができる（F-602）', async () => {
  const file = join(work, 'in.csv');
  writeFileSync(
    file,
    ['プロジェクト,区分,名称,開始,終了,種別,メモ', '新製品C,イベント,設計,2026/11/1,2026/12/15,phase,メモ', '新製品C / 筐体,マイルストーン,試作完了,2027-01-31,,,', '新製品C,イベント,日付なし,あした,,,', ''].join('\r\n'),
    'utf8',
  );
  await pickOpen(file);
  await page.getByTestId('csv-import').click();
  await expect(page.getByTestId('dialog-csv')).toBeVisible();
  await expect(page.getByTestId('csv-summary')).toContainText('プロジェクト 2 件');
  await expect(page.getByTestId('csv-summary')).toContainText('イベント 1 件');
  await expect(page.getByTestId('csv-summary')).toContainText('マイルストーン 1 件');
  await expect(page.getByTestId('csv-errors')).toContainText('4 行目');
  await page.getByTestId('csv-go').click();
  await expect(page.getByTestId('dialog-csv')).toBeHidden();
  await expect(page.locator('.tree-row')).toHaveCount(2);
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  expect(readdirSync(join(dir, 'projects'))).toHaveLength(2);

  // Undo 1 回で全て取り消される
  await page.getByTestId('undo').click();
  await expect(page.locator('.tree-row')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(page.locator('.tree-row')).toHaveCount(2);
});

test('CSV に書き出せる（BOM つき UTF-8）。書き出した表はそのまま取り込める（F-602）', async () => {
  const out = join(work, 'out.csv');
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath: f })) as never;
  }, out);
  await page.getByTestId('csv-export').click();
  await expect(page.getByTestId('notice')).toContainText('書き出しました');
  expect(existsSync(out)).toBe(true);
  const text = readFileSync(out, 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain('プロジェクト,区分,名称,開始,終了,種別,メモ');
  expect(text).toContain('新製品C,イベント,設計,2026-11-01,2026-12-15,phase,メモ');
  expect(text).toContain('新製品C / 筐体,マイルストーン,試作完了,2027-01-31,2027-01-31');
});

test('既存プロジェクトを標準日程として保存でき、展開前にタイムライン上で仮表示される（F-806, F-803）', async () => {
  await page.locator('.tree-row', { hasText: '筐体' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '標準日程として保存' }).click();
  await expect(page.getByTestId('dialog-save-template')).toBeVisible();
  await page.getByTestId('saveas-date').check();
  await page.getByTestId('saveas-go').click();
  await expect(page.getByTestId('dialog-save-template')).toBeHidden();
  expect(readdirSync(join(dir, 'templates'))).toHaveLength(1);

  await page.getByTestId('tpl-add-project').click();
  await page.getByTestId('expand-name').fill('コピー');
  await expect(page.getByTestId('expand-timeline')).toBeVisible();
  await expect(page.getByTestId('expand-preview')).toContainText('試作完了');
  await page.getByTestId('expand-cancel').click();
});
