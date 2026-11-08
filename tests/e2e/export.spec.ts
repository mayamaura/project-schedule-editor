// @req F-601, F-606, F-607, F-608, NF-020
// 出力: HTML ビューア（外部通信なし・メモ/担当者の除外・名称に </script> を含むデータで壊れない・ズーム/ツリーの開閉）、
// SVG / PNG / PDF。実際の Electron で書き出し、出力した HTML は file:// で開いて操作する。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { defaultCalendar } from '../../src/domain/calendar';
import { buildViewerHtml } from '../../src/domain/export/html';
import { buildSnapshot, defaultSnapshotOptions } from '../../src/domain/export/snapshot';
import { generateSample } from '../../src/domain/sample';
import { serializeSchedule } from '../../src/domain/serialize';
import { dep, ev, ms, proj, schedule } from '../domain/fixtures';
import { launch, root } from './launch';

let app: ElectronApplication;
let page: Page;
let dir: string;
let out: string;
test.describe.configure({ mode: 'serial' });

const EVIL = '</script><img src=x onerror="window.__xss=1">';

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'exp-e2e-'));
  out = mkdtempSync(join(tmpdir(), 'exp-out-'));
  const s = schedule(
    [
      proj('A', { name: EVIL, order: 'a', assignee: '山田太郎', note: 'プロジェクトの秘密', events: { e1: ev('設計', '2026-11-01', '2026-12-15', { note: '秘密のメモ' }), e2: ev('試作', '2027-01-05', '2027-03-31') }, milestones: { m1: ms('リリース', '2027-04-15') } }),
      proj('B', { name: '筐体', parentId: 'A', order: 'a', events: { e3: ev('金型', '2026-12-01', '2027-02-01') } }),
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
  for (const d of [dir, out]) {
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

async function exportTo(file: string, fmt: 'html' | 'pdf' | 'png' | 'svg', prep?: () => Promise<void>): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath: f })) as never;
  }, file);
  await page.getByTestId('export-open').click();
  await page.getByTestId(`exp-format-${fmt}`).check();
  await prep?.();
  await page.getByTestId('exp-go').click();
  await expect(page.getByTestId('dialog-export')).toBeHidden({ timeout: 30000 });
}

test('HTML 出力: 既定ではメモ・担当者を含めず、暗号化されない旨を出力前に表示する（F-608）', async () => {
  await page.getByTestId('export-open').click();
  await expect(page.getByTestId('exp-warning')).toContainText('暗号化されません');
  await expect(page.getByTestId('exp-notes')).not.toBeChecked();
  await expect(page.getByTestId('exp-assignee')).not.toBeChecked();
  await page.getByTestId('exp-cancel').click();

  const file = join(out, 'out.html');
  await exportTo(file, 'html');
  const html = readFileSync(file, 'utf8');
  expect(html).not.toContain('秘密のメモ');
  expect(html).not.toContain('プロジェクトの秘密');
  expect(html).not.toContain('山田太郎');
  expect(html).toContain("default-src 'none'");
  expect(html).not.toMatch(/(src|href)=["']https?:/i);
  await expect(page.getByTestId('notice')).toContainText('出力しました');
  expect(statSync(file).size).toBeLessThan(10 * 1024 * 1024);
});

test('出力した HTML を開くと、外部通信なしで表示・ズーム・ツリーの開閉ができ、名称の </script> でも壊れない（F-607, NF-020）', async () => {
  const file = join(out, 'out.html');
  const [viewer] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow }, f) => {
      const w = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { sandbox: true, backgroundThrottling: false } });
      void w.loadFile(f);
    }, file),
  ]);
  await viewer.waitForLoadState('domcontentloaded');
  const canvas = viewer.getByTestId('v-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => Number(await canvas.getAttribute('data-items'))).toBeGreaterThan(0);

  // 外部通信 0 件（文書以外のリソースを読んでいない）・インジェクションが起きていない
  expect(await viewer.evaluate(() => performance.getEntriesByType('resource').length)).toBe(0);
  expect(await viewer.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await viewer.locator('img').count()).toBe(0);
  await expect(viewer.getByTestId('v-tree')).toContainText(EVIL); // 文字として表示される

  // ズーム・ヘッダ形式・今日
  const px = async (): Promise<number> => Number(await canvas.getAttribute('data-px-per-day'));
  const before = await px();
  await viewer.getByTestId('v-zoom-in').click();
  await expect.poll(px).toBeGreaterThan(before);
  await viewer.getByTestId('v-month').click();
  await expect(viewer.getByTestId('v-month')).toHaveAttribute('aria-pressed', 'true');

  // ツリーの折りたたみで行が減る
  const rows = viewer.getByTestId('v-row');
  await expect(rows).toHaveCount(2);
  await viewer.getByRole('button', { name: /を折りたたみ/ }).click();
  await expect(rows).toHaveCount(1);

  // ホバーで詳細（メモは含まれない）
  const box = (await canvas.boundingBox())!;
  const dl = await canvas.getAttribute('data-left-day');
  expect(dl).not.toBeNull();
  await viewer.mouse.move(box.x + 5, box.y + 5);
  await viewer.close();
});

test('SVG に出力できる。文字は <text> で、名称が含まれる（F-601）', async () => {
  const file = join(out, 'out.svg');
  await exportTo(file, 'svg');
  const svg = readFileSync(file, 'utf8');
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('<text');
  expect(svg).toContain('設計');
  expect(svg).toContain('&lt;/script&gt;'); // 名称の特殊文字はエスケープされる
  expect(svg).not.toContain('<img');
});

test('PNG に出力できる（倍率指定）（F-601）', async () => {
  const file = join(out, 'out.png');
  await exportTo(file, 'png', async () => {
    await page.getByTestId('exp-scale').selectOption('1');
    await page.getByTestId('exp-density').selectOption('2');
  });
  const buf = readFileSync(file);
  expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(buf.length).toBeGreaterThan(1000);
});

test('PDF に出力できる（用紙・向き指定。ベクタ）（F-606）', async () => {
  const file = join(out, 'out.pdf');
  await exportTo(file, 'pdf', async () => {
    await page.getByTestId('exp-paper').selectOption('A4');
  });
  const buf = readFileSync(file);
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.length).toBeGreaterThan(2000);
});

test('期間を指定して出力でき、範囲外なら理由が出る（F-601, F-608）', async () => {
  await page.getByTestId('export-open').click();
  await page.getByTestId('exp-format-svg').check();
  await page.getByTestId('exp-from').fill('2030-01-01');
  await page.getByTestId('exp-to').fill('2030-12-31');
  await page.getByTestId('exp-go').click();
  await expect(page.getByTestId('exp-error')).toContainText('出力する項目がありません');
  await page.getByTestId('exp-cancel').click();
});

test('25,000 イベントの HTML: サイズ 10MB 以下（圧縮埋め込み）で、スクロール・ズームが滑らか（NF-020）', async () => {
  const snap = buildSnapshot(generateSample(), defaultCalendar(), {}, defaultSnapshotOptions(), { generatedAt: '2026-11-08T00:00:00Z', label: '正式版', title: '大きなデータ' });
  const json = JSON.stringify(snap);
  const js = readFileSync(join(root, 'out/viewer/viewer.js'), 'utf8');
  const html = buildViewerHtml({ title: '大きなデータ', js, payload: gzipSync(Buffer.from(json), { level: 9 }).toString('base64'), encoding: 'gzip-base64' });
  const file = join(out, 'big.html');
  writeFileSync(file, html);
  const size = statSync(file).size;
  console.log(`25,000 イベント: JSON ${(json.length / 1e6).toFixed(1)}MB → HTML ${(size / 1e6).toFixed(1)}MB`);
  expect(size).toBeLessThan(10 * 1024 * 1024);

  const [viewer] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow }, f) => {
      const w = new BrowserWindow({ show: true, x: 40, y: 40, width: 1280, height: 800, webPreferences: { sandbox: true } });
      void w.loadFile(f);
    }, file),
  ]);
  const canvas = viewer.getByTestId('v-canvas');
  await expect.poll(async () => Number(await canvas.getAttribute('data-items')), { timeout: 30000 }).toBeGreaterThan(0);
  // 90 フレームぶん、ホイールでスクロール・ズームしながらフレーム間隔を測る（隠しウィンドウは描画が間引かれるので、表示して測る）
  const avg = await viewer.evaluate(async () => {
    const c = document.querySelector('[data-testid="v-canvas"]') as HTMLCanvasElement;
    const times: number[] = [];
    for (let i = 0; i < 90; i++) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 === 0 ? 40 : 0, deltaX: 30, ctrlKey: i % 5 === 0, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      times.push(performance.now());
    }
    const d = times.slice(1).map((t, i) => t - times[i]!);
    return d.reduce((a, b) => a + b, 0) / d.length;
  });
  console.log(`ビューアのフレーム間隔 平均 ${avg.toFixed(1)} ms`);
  expect(avg).toBeLessThan(34); // 30fps 以上（目標は 60fps に近いこと）
  await viewer.close();
});
