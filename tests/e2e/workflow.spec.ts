// @req F-503, F-506, F-511, F-513, F-514, F-517, F-518, F-520, NF-019
// 実際の Electron と Git（bare のリモート + 他の人）で、正式版の直接編集の確認 → 作業版を作る → 履歴に残す
// → 他の人の更新を取り込み → ぶつかった項目の解決 → 正式版へ反映、を通す。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { applyCommand, type Command } from '../../src/domain/commands';
import { parseSchedule, serializeSchedule, type Files } from '../../src/domain/serialize';
import { basic } from '../domain/fixtures';
import { launch } from './launch';

let top: string;
let remote: string;
let a: string;
let b: string;
let app: ElectronApplication;
let page: Page;
let canvas: Locator;
test.describe.configure({ mode: 'serial' });

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const k of Object.keys(ENV)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_.*|COMMITTER_.*)$/.test(k)) delete (ENV as Record<string, unknown>)[k];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const write = (dir: string, files: Files): void => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};
/** 他の人が正式版を更新して送る。 */
function otherPushes(cmd: Command): void {
  git(b, 'pull', '--no-rebase', 'origin', 'main');
  const files: Files = {};
  for (const rel of git(b, 'ls-files').split('\n')) files[rel] = readFileSync(join(b, rel), 'utf8');
  const p = parseSchedule(files);
  if (p.status !== 'ok') throw new Error('parse');
  const r = applyCommand(p.schedule, cmd);
  if (!r.ok) throw new Error(r.error.message);
  write(b, serializeSchedule(r.schedule));
  git(b, 'add', '-A');
  git(b, 'commit', '-m', '相手の変更');
  git(b, 'push', 'origin', 'main');
}
const remoteFile = (): string => git(remote, 'show', 'main:projects/A.json');

async function clickProbe(): Promise<void> {
  await expect.poll(() => canvas.getAttribute('data-probe')).toMatch(/\d+,\d+/);
  const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  await canvas.click({ position: { x, y } });
}
async function rename(name: string): Promise<void> {
  await clickProbe();
  const f = page.getByTestId('detail-panel').getByLabel('名称');
  await f.fill(name);
  await f.blur();
}
async function recordHistory(): Promise<void> {
  await page.getByTestId('ver-save').click();
  await page.getByTestId('ver-do-save').click();
  await expect(page.getByTestId('dialog-save')).toBeHidden();
}

test.beforeAll(async () => {
  top = mkdtempSync(join(tmpdir(), 'wf-e2e-'));
  remote = join(top, 'remote.git');
  a = join(top, 'a');
  b = join(top, 'b');
  git(top, 'init', '--bare', '-b', 'main', remote);
  git(top, 'clone', remote, a);
  git(top, 'clone', remote, b);
  for (const d of [a, b]) {
    git(d, 'config', 'user.name', d === a ? '山田' : '相手');
    git(d, 'config', 'user.email', 'x@example.com');
    git(d, 'config', 'core.autocrlf', 'false');
  }
  write(a, serializeSchedule(basic()));
  git(a, 'checkout', '-B', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-m', '最初の版');
  git(a, 'push', '-u', 'origin', 'main');
  git(b, 'pull', 'origin', 'main');
  ({ app, page } = await launch());
  canvas = page.getByTestId('timeline-canvas');
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as never;
  }, a);
  await page.getByTestId('open').click();
  await expect(canvas).toBeVisible();
});
test.afterAll(async () => {
  await app.close().catch(() => undefined);
  rmSync(top, { recursive: true, force: true });
});

test('正式版に居ることが常に表示され、直接編集しようとすると確認が出る → 作業版を作る（F-514, F-520, F-513）', async () => {
  await expect(page.getByTestId('branch-band')).toContainText('正式版');
  await rename('直接編集');
  await expect(page.getByTestId('dialog-direct')).toBeVisible();
  await page.getByTestId('direct-make-work').click();
  await expect(page.getByTestId('dialog-works')).toBeVisible();
  await page.getByTestId('work-name').fill('11月改訂案');
  await page.getByTestId('work-create').click();
  await expect(page.getByTestId('branch-band')).toContainText('作業版: 11月改訂案');
  await expect(page.getByTestId('unsaved')).toHaveText('未記録の変更なし'); // 確認前の編集は適用されていない
});

test('作業版で編集して履歴に残し、他の人の更新を取り込んで正式版へ反映する（F-517, F-511, F-518）', async () => {
  await rename('設計（改）');
  await expect(page.getByTestId('unsaved')).toHaveText('履歴に未記録の変更: 1 件');
  await recordHistory();
  otherPushes({ type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } }); // 同じイベントの別フィールド

  await page.getByTestId('ver-sync').click();
  await expect(page.getByTestId('incoming-list')).toContainText('2026-12-20');
  await expect(page.getByTestId('diff-list')).toBeVisible();
  await page.getByTestId('sync-go').click();
  await expect(page.getByTestId('sync-done')).toBeVisible();
  await page.getByTestId('sync-close').click();

  const main = remoteFile();
  expect(main).toContain('設計（改）');
  expect(main).toContain('2026-12-20');
  expect(git(remote, 'log', '--first-parent', '--format=%s', '-n1', 'main')).toBe('反映: 11月改訂案');
  await expect(page.getByTestId('branch-band')).toContainText('作業版'); // 反映後も作業版で続けられる
});

test('同じ項目がぶつかったら、項目ごとに選んで解決してから反映できる（F-506）', async () => {
  await clickProbe();
  const end = page.getByTestId('detail-panel').getByLabel('終了日');
  await end.fill('2026-12-22');
  await expect(page.getByTestId('unsaved')).toHaveText('履歴に未記録の変更: 1 件');
  await recordHistory();
  otherPushes({ type: 'updateEvent', id: 'e1', patch: { end: '2026-12-30' } });

  await page.getByTestId('ver-sync').click();
  await expect(page.getByTestId('conflict-list')).toBeVisible();
  await expect(page.getByTestId('conflict')).toHaveCount(1);
  await expect(page.getByTestId('conflict')).toContainText('終了日');
  await expect(page.getByTestId('conflicts-next')).toBeDisabled();
  await page.getByTestId('choose-theirs').click();
  await page.getByTestId('conflicts-next').click();
  await page.getByTestId('sync-go').click();
  await expect(page.getByTestId('sync-done')).toBeVisible();
  await page.getByTestId('sync-close').click();
  expect(remoteFile()).toContain('2026-12-30');
  await expect(page.getByTestId('unsaved')).toHaveText('未記録の変更なし');
});

test('共有先のアドレスを入れ、空のフォルダを選ぶと、共有先から取得して開ける（F-501）', async () => {
  const dest = join(top, 'cloned');
  mkdirSync(dest);
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [d] })) as never;
  }, dest);
  await page.getByTestId('clone').click();
  await page.getByTestId('clone-url').fill(remote);
  await page.getByTestId('clone-go').click();
  await expect(page.getByTestId('dialog-clone')).toBeHidden();
  await expect(page.getByTestId('branch-band')).toContainText('正式版');
  await expect(page.getByTestId('info')).toContainText(dest);
});
