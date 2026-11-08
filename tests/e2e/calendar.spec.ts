// @req F-603, F-804
// カレンダー設定: 祝日の確認・会社の休日の追加 → calendar.json に保存され、開き直しても残る。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cal-e2e-'));
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

test('日本の祝日が確認でき、会社の休日を足して「この内容にする」と calendar.json に残る', async () => {
  await page.getByTestId('cal-open').click();
  await page.locator('summary').click();
  await expect(page.getByTestId('cal-preview')).toContainText('元日');
  await expect(page.getByTestId('cal-preview')).toContainText('春分の日');
  await page.getByTestId('cal-holidays-date').fill('2026-12-29');
  await page.getByTestId('cal-holidays-name').fill('年末休業');
  await page.getByTestId('cal-holidays-add').click();
  await expect(page.getByTestId('cal-holidays-item')).toHaveCount(1);
  await page.getByTestId('cal-workdays-date').fill('2027-01-02');
  await page.getByTestId('cal-workdays-add').click();
  await page.getByTestId('cal-weekend-6').uncheck(); // 土曜は休みにしない
  await page.getByTestId('cal-save').click();
  await expect(page.getByTestId('dialog-calendar')).toBeHidden();

  expect(existsSync(join(dir, 'calendar.json'))).toBe(true);
  const c = JSON.parse(readFileSync(join(dir, 'calendar.json'), 'utf8')) as { holidays: Record<string, string>; workdays: Record<string, string>; weekend: number[]; japaneseHolidays: boolean };
  expect(c.holidays['2026-12-29']).toBe('年末休業');
  expect(c.weekend).toEqual([0]);
  expect(c.japaneseHolidays).toBe(true);
  expect(Object.keys(c.workdays)).toEqual(['2027-01-02']);

  // 開き直すと保存した内容が出る
  await page.getByTestId('cal-open').click();
  await expect(page.getByTestId('cal-holidays-item')).toHaveCount(1);
  await expect(page.getByTestId('cal-weekend-6')).not.toBeChecked();
  await page.getByTestId('cal-cancel').click();
});
