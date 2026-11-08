// @req F-402, F-403, F-306
// R5 運用の質: フィルタ（名称検索・担当・状態）、ビューの保存・切替（個人用・共有）、影響範囲の強調。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { serializeSchedule } from '../../src/domain/serialize';
import { dep, ev, proj, schedule } from '../domain/fixtures';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'r5-e2e-'));
  const s = schedule(
    [
      proj('A', { name: '新製品A', order: 'a', status: 'inProgress', assignee: '山田', events: { e1: ev('設計', '2026-11-01', '2026-12-15'), e2: ev('試作', '2027-01-05', '2027-03-31') } }),
      proj('B', { name: '新製品B', order: 'b', status: 'done', assignee: '鈴木', events: { f1: ev('調査', '2026-11-01', '2026-11-30') } }),
    ],
    [dep('d1', ['event', 'e1'], ['event', 'e2'])],
  );
  for (const [rel, text] of Object.entries(serializeSchedule(s))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  ({ app, page } = await launch());
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  await page.getByTestId('open').click();
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

test('名称・担当・状態で絞り込める。条件をクリアすると戻る（F-402）', async () => {
  await expect(page.locator('.tree-row')).toHaveCount(2);
  await page.getByTestId('filter-toggle').click();
  await page.getByTestId('flt-text').fill('調査');
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await expect(page.locator('.tree-row')).toContainText('新製品B');
  await expect(page.getByTestId('filter-toggle')).toContainText('フィルタ中');
  await page.getByTestId('flt-clear').click();
  await expect(page.locator('.tree-row')).toHaveCount(2);

  await page.getByTestId('flt-assignee-山田').check();
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await expect(page.locator('.tree-row')).toContainText('新製品A');
  await page.getByTestId('flt-status-done').check(); // 条件どうしは AND（山田 かつ 完了 → 該当なし）
  await expect(page.locator('.tree-row')).toHaveCount(0);
  await page.getByTestId('flt-clear').click();
  await expect(page.locator('.tree-row')).toHaveCount(2);
});

test('今の表示をビューとして保存し、切り替えられる。個人用はこの PC、共有は views/ に保存される（F-403）', async () => {
  await page.getByTestId('flt-text').fill('試作');
  await page.getByTestId('flt-view-name').fill('試作だけ');
  await page.getByTestId('flt-view-save').click();
  await page.getByTestId('flt-view-name').fill('チームの確認ビュー');
  await page.getByTestId('flt-view-shared').check();
  await page.getByTestId('flt-view-save').click();
  await expect(page.getByTestId('flt-view-select')).toContainText('試作だけ');
  await expect(page.getByTestId('flt-view-select')).toContainText('チームの確認ビュー');

  const files = readdirSync(join(dir, 'views'));
  expect(files).toHaveLength(1); // 共有だけが Git のデータに入る
  expect(readFileSync(join(dir, 'views', files[0]!), 'utf8')).toContain('チームの確認ビュー');

  await page.getByTestId('flt-clear').click();
  await expect(page.locator('.tree-row')).toHaveCount(2);
  await page.getByTestId('flt-view-select').selectOption({ label: '試作だけ' });
  await expect(page.getByTestId('flt-text')).toHaveValue('試作');
  await expect(page.locator('.tree-row')).toHaveCount(1);
  await page.getByTestId('flt-clear').click();
});

test('選択した項目の影響範囲（上流・下流）を強調できる（F-306）', async () => {
  const impact = page.getByTestId('impact');
  await expect(impact).toBeDisabled(); // 何も選んでいないとき
  const canvas = page.getByTestId('timeline-canvas');
  await expect.poll(() => canvas.getAttribute('data-probe')).toMatch(/\d+,\d+/);
  const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  await canvas.click({ position: { x, y } });
  await expect(impact).toBeEnabled();
  await impact.click();
  await expect(impact).toHaveAttribute('aria-pressed', 'true');
  await impact.click();
  await expect(impact).toHaveAttribute('aria-pressed', 'false');
});

test('矢印キーで選択を移す・Alt+矢印で日付をずらす・コピー & 貼り付け。1 回の Undo で戻る（F-203, F-207）', async () => {
  const canvas = page.getByTestId('timeline-canvas');
  const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  await canvas.click({ position: { x, y } });
  const status = page.getByTestId('selection-status');
  await expect(status).toContainText('設計');
  await page.keyboard.press('ArrowRight');
  await expect(status).toContainText('試作'); // 同じ行の次の項目
  await page.keyboard.press('ArrowLeft');
  await expect(status).toContainText('設計');

  const start = page.getByTestId('detail-panel').getByLabel('開始日');
  await expect(start).toHaveValue('2026-11-01');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(start).toHaveValue('2026-11-02');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(start).toHaveValue('2026-11-09');
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await expect(start).toHaveValue('2026-11-01');

  const items = async (): Promise<number> => Number(await canvas.getAttribute('data-items'));
  const before = await items();
  await canvas.click({ position: { x, y } });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(items).toBe(before + 1);
  await page.getByTestId('undo').click();
  await expect.poll(items).toBe(before);
});
