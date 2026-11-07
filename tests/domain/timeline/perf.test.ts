// @req NF-001, F-107
// 25,000 イベントでの DrawList 生成・当たり判定の時間。閾値は桁違いの退行を検知するための余裕のある値。
// 60fps = 1フレーム 16.7ms。ここでは JS（DrawList 生成）の分だけ。Canvas への実描画は E2E で計測する。
import { describe, expect, it } from 'vitest';
import { toDays } from '../../../src/domain/date';
import { generateSample } from '../../../src/domain/sample';
import { buildDrawList, type DrawOptions } from '../../../src/domain/timeline/drawlist';
import { hitTest } from '../../../src/domain/timeline/hittest';
import { buildLayout } from '../../../src/domain/timeline/layout';

const s = generateSample(); // 500 × 50 × 8年
const mean = (fn: () => void, n: number): number => {
  fn(); // ウォームアップ
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};
const report = (label: string, ms: number, limit: number): void => {
  console.log(`[perf] ${label}: ${ms.toFixed(2)} ms（上限 ${limit} ms）`);
  expect(ms, `${label} が ${limit}ms を超えた`).toBeLessThan(limit);
};
const vp = (px: number, width: number, height: number, scrollY = 0): DrawOptions['viewport'] => ({ leftDay: toDays('2026-01-01'), pxPerDay: px, width, height, scrollY });

describe('25,000イベントでの描画準備', () => {
  const t0 = performance.now();
  const layout = buildLayout(s);
  console.log(`[perf] buildLayout（初回。500行・25,000項目のレーン割り当て込み）: ${(performance.now() - t0).toFixed(1)} ms`);

  it('レイアウト（レーンはキャッシュ済み）の再構築', () => {
    report('buildLayout（キャッシュ済み）', mean(() => buildLayout(s), 20), 100);
  });

  it('最悪ケース: 8年を縮小表示（0.5px/日）し、全500行・25,000項目が同時に見える', () => {
    const o: DrawOptions = { headerMode: 'month', viewport: vp(0.5, 1500, layout.totalHeight) };
    const dl = buildDrawList(s, layout, o);
    console.log(`[perf] 縮小表示の描画命令: 行 ${dl.stats.rows} / 項目 ${dl.stats.items} / 依存 ${dl.stats.deps} / 命令 ${dl.body.length}`);
    report('buildDrawList（全体を縮小表示）', mean(() => buildDrawList(s, layout, o), 5), 100);
  });

  it('通常: 1年分を表示（5px/日）、画面に約30行', () => {
    const o: DrawOptions = { headerMode: 'weekMonth', viewport: vp(5, 1400, 900, layout.rows[250]!.y) };
    const dl = buildDrawList(s, layout, o);
    console.log(`[perf] 通常表示の描画命令: 行 ${dl.stats.rows} / 項目 ${dl.stats.items} / 依存 ${dl.stats.deps} / 命令 ${dl.body.length}`);
    report('buildDrawList（通常表示）', mean(() => buildDrawList(s, layout, o), 50), 10);
  });

  it('拡大: 週単位（40px/日）', () => {
    const o: DrawOptions = { headerMode: 'weekMonth', viewport: vp(40, 1400, 900, layout.rows[100]!.y) };
    report('buildDrawList（拡大）', mean(() => buildDrawList(s, layout, o), 50), 10);
  });

  it('選択・ホバーあり、依存線は選択項目のみ', () => {
    const o: DrawOptions = { headerMode: 'weekMonth', viewport: vp(5, 1400, 900, layout.rows[250]!.y), selection: new Set(['p0250-e10']), hover: 'p0251-e01', dependencies: 'selected' };
    report('buildDrawList（選択あり）', mean(() => buildDrawList(s, layout, o), 50), 10);
  });

  it('当たり判定（最悪ケース: 全項目が表示範囲にある状態で、後ろから全走査）', () => {
    const o: DrawOptions = { headerMode: 'month', viewport: vp(0.5, 1500, layout.totalHeight) };
    const dl = buildDrawList(s, layout, o);
    expect(dl.hitBoxes.length).toBeGreaterThan(20000);
    // x が負（どの項目の箱にも入らない）= 全件を走査して、最後に行の判定に進む。y はヘッダの下
    expect(hitTest(dl, layout, o.viewport, -1000, dl.headerHeight + 10).kind).toBe('row');
    const per = mean(() => hitTest(dl, layout, o.viewport, -1000, dl.headerHeight + 10), 50);
    report(`hitTest（${dl.hitBoxes.length} 件を全走査）`, per, 2);
  });

  it('スケジュールを1件編集した直後の再構築（変更したプロジェクトだけレーンを再計算）', () => {
    const p = s.projects['p0100']!;
    const edited = { ...s, projects: { ...s.projects, p0100: { ...p, events: { ...p.events, 'p0100-e00': { ...p.events['p0100-e00']!, name: '改名' } } } } };
    const o: DrawOptions = { headerMode: 'weekMonth', viewport: vp(5, 1400, 900, layout.rows[100]!.y) };
    report('編集後の buildLayout + buildDrawList（初回: 依存の解析込み）', mean(() => buildDrawList(edited, buildLayout(edited), o), 1), 80);
  });
});
