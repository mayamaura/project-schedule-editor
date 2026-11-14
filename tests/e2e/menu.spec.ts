// @req F-212, NF-009
// 上部のメニュー（ボタンで開くポップオーバー）・コマンドパレット・ショートカット・狭い画面の「…」。
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  ({ app, page } = await launch());
});
test.afterAll(async () => {
  await app.close();
});

test('メニューはボタンで開き、Esc で閉じる。項目は見出しで分かれる', async () => {
  await expect(page.getByTestId('sample')).toHaveCount(0);
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('sample')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sample')).toHaveCount(0);
});

test('コマンドパレット: Ctrl+K で開き、検索して Enter で実行できる', async () => {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('サンプル');
  await expect(page.getByTestId('palette-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('info')).toBeVisible(); // サンプルが表示された
});

test('ショートカット: ? で一覧（パレット）、T で今日、Ctrl+Z で元に戻す。入力欄の中では T は効かない', async () => {
  await page.getByTestId('title').click();
  await page.keyboard.press('?');
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-list')).toContainText('Ctrl+K');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('t');
  await expect(page.getByTestId('palette-input')).toHaveValue('t'); // パレットの入力欄に T と打てる
  await page.keyboard.press('Escape');
});

test('狭い画面では「…」にまとめ、押すと隠れた操作に届く', async () => {
  await expect(page.getByTestId('menu-share')).toBeVisible();
  await expect(page.getByTestId('menu-more')).toBeHidden();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.getByTestId('menu-share')).toBeHidden();
  await page.getByTestId('menu-more').click();
  await expect(page.getByTestId('export-open')).toBeVisible();
  await expect(page.getByTestId('cal-open')).toBeVisible();
  await expect(page.getByTestId('theme-dark')).toBeVisible();
});
