// @req F-502, F-504, F-523, NF-019
// 実際の Electron と Git で、未保存の変更の表示 → 保存 → 履歴 → 過去の版に戻す、と診断を確認する。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { serializeSchedule } from '../../src/domain/serialize';
import { basic } from '../domain/fixtures';
import { launch } from './launch';

let dir: string;
let app: ElectronApplication;
let page: Page;
test.describe.configure({ mode: 'serial' });

const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ver-e2e-'));
  for (const [rel, text] of Object.entries(serializeSchedule(basic()))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'テスト');
  git('config', 'user.email', 't@example.com');
  git('add', '-A');
  git('commit', '-m', '最初の版');
  ({ app, page } = await launch());
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  await page.getByTestId('open').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('編集すると「未保存の変更」が日本語で数えられ、保存すると 0 に戻る（F-502）', async () => {
  await expect(page.getByTestId('unsaved')).toHaveText('未保存の変更なし');
  const canvas = page.getByTestId('timeline-canvas');
  await expect.poll(() => canvas.getAttribute('data-probe')).toMatch(/\d+,\d+/);
  const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  await canvas.click({ position: { x, y } });
  const name = page.getByTestId('detail-panel').getByLabel('名称');
  await name.fill('設計（改）');
  await name.blur();
  await expect(page.getByTestId('unsaved')).toHaveText('未保存の変更: 1 件');

  await page.getByTestId('ver-save').click();
  await expect(page.getByTestId('dialog-save')).toContainText('設計（改）');
  await expect(page.getByTestId('ver-memo')).toHaveValue(/設計/);
  await page.getByTestId('ver-do-save').click();
  await expect(page.getByTestId('dialog-save')).toBeHidden();
  await expect(page.getByTestId('unsaved')).toHaveText('未保存の変更なし');
  expect(git('log', '--format=%s').trim().split('\n')).toHaveLength(2);
  expect(git('status', '--porcelain').trim()).toBe(''); // .autosave は対象外
});

test('履歴に保存が並び、前の版に戻すと未保存の変更になる（F-504）', async () => {
  await page.getByTestId('ver-history').click();
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await expect(page.getByTestId('history-item').first()).toContainText('設計（改）');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('history-item').nth(1).getByRole('button', { name: 'この版に戻す…' }).click();
  await expect(page.getByTestId('dialog-history')).toBeHidden();
  await expect(page.getByTestId('unsaved')).toHaveText('未保存の変更: 1 件');
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
});

test('診断が項目別に出る（F-523）', async () => {
  await page.getByTestId('ver-diagnose').click();
  const list = page.getByTestId('diag-list');
  await expect(list).toContainText('Git');
  await expect(list).toContainText('データの場所');
  await expect(list).toContainText('共有先は未設定');
});
