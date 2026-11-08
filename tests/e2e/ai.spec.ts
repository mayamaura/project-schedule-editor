// @req F-701, F-702, F-703, F-705, F-706, F-707, F-708, F-709, F-710, F-711, F-712, F-713, NF-012, NF-013
// AI パネル。本物の AI は使わず、テスト用のプロバイダ（PSE_AI_MOCK=1）で、依頼 → ストリーミング → 提案の差分確認と承認 →
// 反映（Undo 1 回）、評価・指摘とジャンプ、送信前プレビュー、件数の警告、キャンセル、ログ、指示・観点、設定を通す。
// 接続先（Copilot）が無いときは、AI だけが無効になり他の機能は動くことも確認する。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const projectFile = (): string => readdirSync(join(dir, 'projects')).map((f) => readFileSync(join(dir, 'projects', f), 'utf8')).join('');

async function openDir(a: ElectronApplication, p: Page, d: string): Promise<void> {
  await a.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [x] })) as never;
  }, d);
  await p.getByTestId('open').click();
  await expect(p.getByTestId('timeline-canvas')).toBeVisible();
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ai-e2e-'));
  for (const [rel, text] of Object.entries(serializeSchedule(basic()))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'テスト');
  git('config', 'user.email', 't@example.com');
  git('add', '-A');
  git('commit', '-m', '最初の版');
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('AI の接続先が無いときは、AI だけが無効になり、理由が出る。他の機能は動く（F-708）', async () => {
  const l = await launch({ PSE_AI_NONE: '1' });
  await openDir(l.app, l.page, dir);
  await l.page.getByTestId('ai-open').click();
  await expect(l.page.getByTestId('ai-unavailable')).toContainText('AI は利用できません');
  await expect(l.page.getByTestId('ai-send')).toBeDisabled();
  await expect(l.page.getByTestId('timeline-canvas')).toBeVisible(); // アプリ本体は通常どおり
  await l.page.getByTestId('ai-close').click();
  await l.app.close();
});

test('送信前に、AI に渡す内容をプレビューで確認できる。範囲・メモの有無を選べる（F-707, NF-015）', async () => {
  ({ app, page } = await launch({ PSE_AI_MOCK: '1' }));
  await openDir(app, page, dir);
  await page.getByTestId('ai-open').click();
  await expect(page.getByTestId('ai-unavailable')).toBeHidden();
  await page.getByTestId('ai-preview').click();
  await expect(page.getByTestId('ai-preview-text')).toContainText('設計');
  await expect(page.getByTestId('ai-preview-box')).toContainText('そのまま AI');
  await page.getByTestId('ai-notes').uncheck();
  await page.getByTestId('ai-assignee').uncheck();
  await page.getByTestId('ai-preview').click();
  await expect(page.getByTestId('ai-preview-text')).not.toContainText('"note"');
});

test('依頼すると応答が流れ、提案は差分で確認して承認すると反映される。1 回の Undo で戻る（F-701, F-702, F-711）', async () => {
  await page.getByTestId('ai-input').fill('設計を 2 週間延ばしたら、後続はどうなる？');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-answer')).toContainText('2 週間延ばす案');
  const card = page.getByTestId('ai-proposal');
  await expect(card).toContainText('2 週間延ばす');
  await expect(page.getByTestId('ai-proposal-lines')).toContainText('2026-12-29'); // 差分表示
  // 承認するまで、日程は変わらない
  expect(projectFile()).not.toContain('2026-12-29');

  await page.getByTestId('ai-apply').click();
  await page.getByTestId('direct-go').click(); // 正式版の直接編集の確認（F-520）
  await expect(page.getByTestId('ai-proposal-state')).toContainText('適用しました');
  await expect(page.getByTestId('save-state')).toHaveText('自動保存済み');
  await expect.poll(() => projectFile()).toContain('2026-12-29');

  // 履歴に残すときのメモに「AI提案」が付く（F-711）
  await page.getByTestId('ver-save').click();
  await expect(page.getByTestId('ver-memo')).toHaveValue(/AI提案: .*2 週間延ばす/);
  await page.getByTestId('ver-do-save').click();
  await expect(page.getByTestId('dialog-save')).toBeHidden();

  // 1 回の Undo で、提案ぶんが全て戻る
  await page.getByTestId('undo').click();
  await expect.poll(() => projectFile()).not.toContain('2026-12-29');
});

test('破棄すると何も変わらない。不正な提案は AI に理由が返り、画面には出ない（NF-012）', async () => {
  await page.getByTestId('ai-input').fill('設計を 2 週間延ばして');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-proposal').last()).toBeVisible();
  await page.getByTestId('ai-discard').last().click();
  await expect(page.getByTestId('ai-proposal-state').last()).toContainText('破棄');
  expect(projectFile()).not.toContain('2026-12-29');

  const before = await page.getByTestId('ai-proposal').count();
  await page.getByTestId('ai-input').fill('不正な提案を試して');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-answer').last()).toContainText('受け付けられません');
  expect(await page.getByTestId('ai-proposal').count()).toBe(before);
});

test('変更が多い提案は警告され、確認のチェックが要る（F-709）', async () => {
  await page.getByText('設定（個人）').click();
  await page.getByTestId('ai-max-changes').fill('1');
  await expect(page.getByTestId('ai-max-changes')).toHaveValue('1');
  await page.getByTestId('ai-input').fill('2 件まとめて延ばして');
  await page.getByTestId('ai-send').click();
  const card = page.getByTestId('ai-proposal').last();
  await expect(card.getByTestId('ai-large-warning')).toBeVisible();
  await expect(card.getByTestId('ai-apply')).toBeDisabled();
  await card.getByTestId('ai-large-confirm').check();
  await expect(card.getByTestId('ai-apply')).toBeEnabled();
  await card.getByTestId('ai-discard').click();
});

test('評価・指摘は「指摘・疑い」として出て、該当項目へジャンプできる（F-703, F-705, F-706）', async () => {
  await page.getByTestId('ai-evaluate').click();
  await expect(page.getByTestId('ai-findings')).toContainText('確定ではありません');
  await expect(page.getByTestId('ai-finding')).toContainText('余裕が少ない可能性');
  await page.getByTestId('ai-jump').first().click();
  await expect(page.getByTestId('selection-status')).toContainText('設計');
});

test('実行中は中止できる。待機中も他の操作ができる（NF-013）', async () => {
  await app.close();
  ({ app, page } = await launch({ PSE_AI_MOCK: '1', PSE_AI_MOCK_DELAY: '400' }));
  await openDir(app, page, dir);
  await page.getByTestId('ai-open').click();
  await page.getByTestId('ai-input').fill('こんにちは、これは少し長めの確認の文章です');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-stop')).toBeVisible();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
  await expect(page.getByTestId('branch-band')).toContainText('正式版'); // 版の情報が読み込まれてから編集する（確認の判定に必要）
  await page.getByTestId('add-project').click(); // 待機中でも編集できる
  await page.getByTestId('direct-go').click(); // 正式版の直接編集の確認（F-520）
  await expect(page.locator('.tree-row')).toHaveCount(3);
  await page.getByTestId('ai-stop').click();
  await expect(page.getByTestId('ai-send')).toBeVisible();
});

test('指示・観点を作って選べる。個人用はローカル、共有用は ai-prompts/ に保存される（F-712）', async () => {
  await page.getByTestId('ai-prompts-toggle').click();
  await page.getByTestId('ai-prompt-new').click();
  await page.getByTestId('ai-prompt-name').fill('年末の影響を重点的に');
  await page.getByTestId('ai-prompt-text').fill('年末年始をまたぐ工程を重点的に見てください');
  await page.getByTestId('ai-prompt-save').click();
  await expect(page.getByTestId('ai-prompt-item')).toContainText('年末の影響を重点的に');
  await page.getByTestId('ai-prompt-new').click();
  await page.getByTestId('ai-prompt-name').fill('チームの確認観点');
  await page.getByTestId('ai-prompt-text').fill('リリース前に必ず確認する観点');
  await page.getByTestId('ai-prompt-shared').check();
  await page.getByTestId('ai-prompt-save').click();
  await expect(page.getByTestId('ai-prompt-item')).toHaveCount(2);
  const shared = readdirSync(join(dir, 'ai-prompts'));
  expect(shared).toHaveLength(1);
  expect(readFileSync(join(dir, 'ai-prompts', shared[0]!), 'utf8')).toContain('チームの確認観点');
  await expect(page.getByTestId('ai-prompt-select')).toContainText('年末の影響を重点的に');
  await expect(page.getByTestId('ai-prompt-select')).toContainText('チームの確認観点');
  await expect(page.getByTestId('unsaved')).toContainText('未記録の変更'); // 共有の指示は「履歴に残す」対象
});

test('会話・提案のログはローカルに残り、利用者が削除できる（F-710）。モデルを選べる（F-713）', async () => {
  await page.getByText('会話・提案のログ').click();
  await expect(page.getByTestId('ai-history-item').first()).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('ai-history-clear').click();
  await expect(page.getByTestId('ai-history-item')).toHaveCount(0);

  await page.getByText('設定（個人）').click();
  await page.getByTestId('ai-model').selectOption('mock-large');
  await expect(page.getByTestId('ai-model')).toHaveValue('mock-large');
  await page.getByTestId('ai-enabled').click(); // 設定の保存を待って切り替わる（非同期）
  await expect(page.getByTestId('ai-unavailable')).toContainText('無効');
  await page.getByTestId('ai-enabled').click();
  await expect(page.getByTestId('ai-unavailable')).toBeHidden();
});
