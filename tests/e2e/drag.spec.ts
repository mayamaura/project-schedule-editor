// @req F-201, F-206, NF-001
// 25,000 イベントのサンプルで、バーのドラッグ移動のフレーム時間を測る。確定は 1 コマンド（Undo 1 回で元に戻る）。
import { expect, test } from '@playwright/test';
import { launch } from './launch';

test('バーのドラッグ: フレーム時間と、Undo 1 回で元に戻ること', async () => {
  const { app, page } = await launch();
  try {
    await page.getByTestId('sample').click();
    const canvas = page.getByTestId('timeline-canvas');
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.getAttribute('data-probe')).toMatch(/\d+,\d+/);
    // 掴みやすいよう拡大してから、最初の項目の中心を取る
    for (let i = 0; i < 3; i++) await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(200);
    const [x, y] = (await canvas.getAttribute('data-probe'))!.split(',').map(Number) as [number, number];
    const box = (await canvas.boundingBox())!;
    await page.getByTestId('timeline-canvas').click({ position: { x, y } });
    const label = await page.getByTestId('selection-status').innerText();

    const frames = await page.evaluate(async () => {
      const times: number[] = [];
      let on = true;
      const tick = (t: number): void => {
        times.push(t);
        if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { stop: () => number[] }).stop = () => {
        on = false;
        return times;
      };
      return true;
    });
    expect(frames).toBe(true);
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(box.x + x + i * 3, box.y + y);
      await page.waitForTimeout(8);
    }
    const times = await page.evaluate(() => (window as unknown as { stop: () => number[] }).stop());
    await page.mouse.up();
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const max = Math.max(...gaps);
    console.log(`[perf] ドラッグ中のフレーム間隔: 平均 ${avg.toFixed(1)} ms / 最大 ${max.toFixed(1)} ms（25,000イベント）`);
    expect(avg).toBeLessThan(33);

    await expect(page.getByTestId('undo')).toBeEnabled();
    expect(await page.getByTestId('selection-status').innerText()).not.toBe(label); // 日付が変わった
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('undo')).toBeDisabled(); // 1 回で元に戻る = ドラッグは 1 コマンド
    await expect(page.getByTestId('selection-status')).toContainText(label.split('（')[0]!);
  } finally {
    await app.close();
  }
});
