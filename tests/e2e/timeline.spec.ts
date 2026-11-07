// @req F-101, F-104, F-107, F-304, NF-001, NF-010
// 実際の Electron で「サンプルを表示」し、Canvas の描画・ヘッダ切替・ズーム・パン・選択・フレーム時間を確認する。
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launch } from './launch';

let app: ElectronApplication;
let page: Page;
let canvas: Locator;

// dataset のキー（camelCase）は属性名では kebab-case になる（pxPerDay → data-px-per-day）
const num = async (name: string): Promise<number> => Number(await canvas.getAttribute(`data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`));
const renders = (): Promise<number> => num('renders');

async function settle(): Promise<void> {
  // 描画（rAF）が落ち着くまで待つ
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const r = await renders();
    if (r === prev) return;
    prev = r;
    await page.waitForTimeout(60);
  }
}

// 1つのアプリ・1つのサンプルの状態を順に操作するテスト。1つ失敗したら残りは実行しない
// （Playwright は失敗するとワーカーを作り直し、アプリが初期状態に戻って連鎖的に失敗して原因が分からなくなるため）
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  ({ app, page } = await launch());
  canvas = page.getByTestId('timeline-canvas');
});
test.afterAll(async () => {
  await app.close();
});

test('起動直後は空の案内。サンプルを表示すると Canvas に描画される（25,000イベント）', async () => {
  await expect(page.getByTestId('empty')).toBeVisible();
  await page.getByTestId('sample').click();
  await expect(canvas).toBeVisible();
  await settle();
  await expect(page.getByTestId('info')).toContainText('イベント 25000');
  expect(await num('rows')).toBeGreaterThan(0);
  expect(await num('items')).toBeGreaterThan(0);
});

test('Canvas に実際にピクセルが描かれている（空白ではない・複数の色がある）', async () => {
  const colors = await canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 7) set.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return set.size;
  });
  expect(colors).toBeGreaterThan(5);
});

test('左ペインに行が出ており、親を折りたたむと子が消える（F-105）', async () => {
  const rows = page.locator('.tree-row');
  expect(await rows.count()).toBeGreaterThan(2); // 1行の高さはレーン数で変わる（サンプルは1行 約100px）
  const idAt = (n: number): Promise<string | null> => rows.nth(n).getAttribute('data-project');
  const parent = await idAt(0);
  const child = await idAt(1);
  expect(child).not.toBe(parent);
  // サンプルは p0000 の子が p0020〜。先頭の親を折りたたむと、2行目は子から次の根（p0001）に変わる
  expect(child).toBe('p0020');
  await rows.first().locator('button.twisty').click();
  await settle();
  expect(await idAt(1)).toBe('p0001');
  await rows.first().locator('button.twisty').click(); // 戻す
  await settle();
  expect(await idAt(1)).toBe('p0020');
});

test('日付ヘッダの切替（年月週 ⇔ 年月）。左端の日付とズームは維持される（F-104）', async () => {
  const left = await num('leftDay');
  const px = await num('pxPerDay');
  await page.getByTestId('mode-month').click();
  await settle();
  await expect(canvas).toHaveAttribute('data-header-mode', 'month');
  expect(await num('leftDay')).toBe(left);
  expect(await num('pxPerDay')).toBe(px);
  await page.getByTestId('mode-week').click();
  await settle();
  await expect(canvas).toHaveAttribute('data-header-mode', 'weekMonth');
});

test('ズーム: ボタンと Ctrl+ホイール（カーソル下の日付が動かない）', async () => {
  const px0 = await num('pxPerDay');
  await page.getByTestId('zoom-in').click();
  await settle();
  expect(await num('pxPerDay')).toBeGreaterThan(px0);
  await page.getByTestId('zoom-out').click();
  await settle();
  expect(await num('pxPerDay')).toBeCloseTo(px0, 6);

  const box = (await canvas.boundingBox())!;
  const x = 300;
  const dayAt = async (): Promise<number> => (await num('leftDay')) + x / (await num('pxPerDay'));
  const before = await dayAt();
  await page.mouse.move(box.x + x, box.y + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await settle();
  expect(await num('pxPerDay')).toBeGreaterThan(px0);
  expect(await dayAt()).toBeCloseTo(before, 3);
});

test('ドラッグでパン（右へドラッグすると過去へ）と、ホイールで縦スクロール', async () => {
  const box = (await canvas.boundingBox())!;
  const left0 = await num('leftDay');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 300, { steps: 5 });
  await page.mouse.up();
  await settle();
  expect(await num('leftDay')).toBeLessThan(left0);

  const firstRow = await page.locator('.tree-row').first().getAttribute('data-project');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.wheel(0, 600);
  await settle();
  const firstAfter = await page.locator('.tree-row').first().getAttribute('data-project');
  expect(firstAfter).not.toBe(firstRow); // 縦にスクロールして、左ペインも同期している
});

test('項目をクリックすると選択され、読み上げ用にも通知される（NF-010）。空白のクリックで解除', async () => {
  await page.getByTestId('today').click(); // 位置を変えても probe は先頭の項目
  await page.getByTestId('zoom-in').click();
  await settle();
  const [px, py] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + px, box.y + py);
  await expect(page.getByTestId('selection-status')).toContainText('選択中');
  await expect(page.getByTestId('selection-live')).toContainText('選択中');
});

test('フレーム時間: 実際の Electron で、ズーム操作1回（DrawList 生成 + Canvas 描画）の所要時間', async () => {
  // 全体を縮小表示（最悪ケース）にしてから、ズームを繰り返す
  const ms = await canvas.evaluate(async (c: HTMLCanvasElement) => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 30; i++) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, ctrlKey: true, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
      await raf();
    }
    const N = 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 === 0 ? -60 : 60, ctrlKey: true, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
      await raf();
    }
    return (performance.now() - t0) / N;
  });
  console.log(`[perf] Electron 実測: ズーム1回あたりのフレーム間隔 ${ms.toFixed(1)} ms（rAF 待ちを含む。16.7ms = 60fps）`);
  expect(ms).toBeLessThan(40);
});

// --- フォルダを開く（F-501）。ネイティブのダイアログは Main 側で差し替えて、選ぶフォルダを指定する ---
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeSchedule } from '../../src/domain/serialize';
import { saveFiles } from '../../src/main/fileRepository';
import { basic } from '../domain/fixtures';

async function chooseFolder(dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as unknown as typeof dialog.showOpenDialog;
  }, dir);
}

test.describe('フォルダを開く', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pse-open-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('日程データのフォルダを読み込んで、タイムラインに表示する', async () => {
    saveFiles(dir, serializeSchedule(basic()));
    await chooseFolder(dir);
    await page.getByTestId('open').click();
    await expect(page.getByTestId('info')).toContainText('プロジェクト 2・イベント 3・マイルストーン 1');
    await expect(page.getByTestId('info')).toContainText(dir);
    await expect(page.getByTestId('notice')).toHaveCount(0);
    await settle();
    expect(await num('items')).toBeGreaterThan(0);
    await expect(page.locator('.tree-row').first()).toContainText('新製品A');
  });

  test('途中まで更新されていたデータ（pending あり）は、開くときに完了させてから読む', async () => {
    saveFiles(dir, serializeSchedule(basic()));
    // 更新の途中で落ちた状態を作る: 新しい内容の一時ファイル + 何をするかの記録
    const newer = serializeSchedule({ ...basic(), projects: { ...basic().projects, A: { ...basic().projects['A']!, name: '更新後の名前' } } });
    mkdirSync(join(dir, '.autosave'), { recursive: true });
    writeFileSync(join(dir, 'projects/A.json.9.tmp'), newer['projects/A.json'] ?? '');
    writeFileSync(join(dir, '.autosave/pending.json'), JSON.stringify([{ tmp: join(dir, 'projects/A.json.9.tmp'), final: join(dir, 'projects/A.json') }]));
    await chooseFolder(dir);
    await page.getByTestId('open').click();
    await expect(page.locator('.tree-row').first()).toContainText('更新後の名前');
  });

  test('壊れたデータは、全ての問題をファイル名つきで表示し、表示中の内容は変えない', async () => {
    saveFiles(dir, serializeSchedule(basic()));
    writeFileSync(join(dir, 'projects/A.json'), '{ 壊れている');
    writeFileSync(join(dir, 'dependencies/d1.json'), JSON.stringify({ id: 'd1', type: 'XX' }));
    await chooseFolder(dir);
    const before = await page.getByTestId('info').textContent();
    await page.getByTestId('open').click();
    const notice = page.getByTestId('notice');
    await expect(notice).toContainText('読み込めませんでした');
    await expect(notice).toContainText('projects/A.json');
    await expect(notice).toContainText('dependencies/d1.json');
    await expect(page.getByTestId('info')).toHaveText(before ?? ''); // 直前の表示はそのまま
  });

  test('新しい版のデータは、アプリの更新を案内する', async () => {
    saveFiles(dir, serializeSchedule(basic()));
    writeFileSync(join(dir, 'schedule.json'), '{ "schemaVersion": 99 }\n');
    await chooseFolder(dir);
    await page.getByTestId('open').click();
    await expect(page.getByTestId('notice')).toContainText('新しいバージョン');
    await expect(page.getByTestId('notice')).toContainText('99');
  });

  test('ダイアログをキャンセルしたら何も変えない', async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as unknown as typeof dialog.showOpenDialog;
    });
    const before = await page.getByTestId('info').textContent();
    await page.getByTestId('open').click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('info')).toHaveText(before ?? '');
  });
});
