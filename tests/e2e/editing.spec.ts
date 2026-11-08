// @req F-201, F-202, F-204, F-205, F-206, F-208, F-209, F-210, F-211, F-305
// 実際の Electron で、フォルダを開いて編集 → 自動保存 → 強制終了 → 再起動して復元、までを確認する。
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { serializeSchedule } from '../../src/domain/serialize';
import { basic } from '../domain/fixtures';
import { launch } from './launch';

let dir: string;
let app: ElectronApplication;
let page: Page;
let canvas: Locator;

test.describe.configure({ mode: 'serial' });

const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');

async function openDir(): Promise<void> {
  // ネイティブのフォルダ選択ダイアログは操作できないので、開く先を差し替える
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as never;
  }, dir);
  await page.getByTestId('open').click();
  await expect(canvas).toBeVisible();
}

/** probe（最初の項目の中心。キャンバス内の座標）をクリックして選択する。 */
async function clickProbe(button: 'left' | 'right' = 'left'): Promise<void> {
  await expect.poll(() => canvas.getAttribute('data-probe')).toMatch(/\d+,\d+/);
  // 直前の操作で配置が変わった直後は、描画が落ち着くまで待つ（古い座標を押さない）
  let prev = '';
  await expect.poll(async () => {
    const cur = (await canvas.getAttribute('data-probe')) ?? '';
    const stable = cur === prev;
    prev = cur;
    return stable;
  }, { intervals: [150] }).toBe(true);
  const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  await canvas.click({ position: { x, y }, button });
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sched-e2e-'));
  for (const [rel, text] of Object.entries(serializeSchedule(basic()))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  ({ app, page } = await launch());
  canvas = page.getByTestId('timeline-canvas');
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('詳細パネルで名称を変えると自動保存され、Undo で戻る（F-204, F-206, F-210）', async () => {
  await openDir();
  await clickProbe();
  const name = page.getByTestId('detail-panel').getByLabel('名称');
  await name.fill('設計（改）');
  await name.blur();
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  expect(read('projects/A.json')).toContain('設計（改）');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  await expect.poll(() => read('projects/A.json')).not.toContain('設計（改）');
});

test('終了日を開始日より前にすると理由が出て、値は変わらない（F-208）', async () => {
  const end = page.getByTestId('detail-panel').getByLabel('終了日');
  const before = await end.inputValue();
  await end.fill('2026-01-01');
  await expect(page.getByTestId('edit-error')).toContainText('終了日');
  await expect(end).toHaveValue(before);
});

test('空白を右クリック →「イベントを作成」で作成され、選択される（F-202, F-209）', async () => {
  const [, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  const count = async (): Promise<number> => Number(await canvas.getAttribute('data-items'));
  const before = await count();
  await canvas.click({ position: { x: 3, y }, button: 'right' });
  await page.getByRole('menuitem', { name: 'イベントを作成' }).click();
  await expect.poll(count).toBe(before + 1);
  await expect(page.getByTestId('detail-panel').getByLabel('名称')).toHaveValue('新しいイベント');
});

test('プロジェクトを追加し、ドラッグ&ドロップで子にできる（F-205）', async () => {
  await page.getByTestId('add-project').click();
  await expect(page.locator('.tree-row')).toHaveCount(3);
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  const added = page.locator('.tree-row', { hasText: '新しいプロジェクト' });
  await added.dragTo(page.locator('.tree-row', { hasText: '新製品A' }).first(), { targetPosition: { x: 60, y: 16 } });
  await expect.poll(() => readAllProjects()).toContain('新しいプロジェクト');
  await expect.poll(() => readAllProjects()).toMatch(/"parentId": "A"/);
});

function readAllProjects(): string {
  return readdirSync(join(dir, 'projects')).map((f) => read(`projects/${f}`)).join('');
}

test('メニューの「依存を追加」で依存先の指定になり、Esc で中止できる（F-305。作成と循環拒否は単体テスト）', async () => {
  await clickProbe('right');
  await page.getByRole('menuitem', { name: '依存を追加' }).click();
  await expect(page.getByTestId('selection-status')).toContainText('依存先');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-status')).not.toContainText('依存先');
});

test('強制終了しても編集は残り、再起動すると復元の案内が出る。破棄で元に戻る（F-210, F-211）', async () => {
  await page.getByTestId('detail-panel').getByLabel('名称').fill('強制終了前の名前');
  await page.getByTestId('detail-panel').getByLabel('名称').blur();
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  expect(read('projects/A.json') + readAllProjects()).toContain('強制終了前の名前');
  // close() は正常終了の処理（running の削除）を走らせてしまうので、プロセスを直接止める
  const exited = new Promise((r) => app.process().once('exit', r));
  app.process().kill('SIGKILL');
  await exited;

  expect(existsSync(join(dir, '.autosave', 'running'))).toBe(true);
  ({ app, page } = await launch());
  canvas = page.getByTestId('timeline-canvas');
  await openDir();
  await expect(page.getByTestId('recovery')).toContainText('前回の編集内容を復元しました');
  expect(read('projects/A.json') + readAllProjects()).toContain('強制終了前の名前');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('recover-discard').click();
  await expect(page.getByTestId('recovery')).toBeHidden();
  expect(readAllProjects() + read('projects/A.json')).not.toContain('強制終了前の名前');
});
