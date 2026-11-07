// @req NF-001, NF-018, F-107, F-206
// 仕様上限（500プロジェクト × 50イベント × 8年 ≒ 25,000イベント）での処理時間。
// 閾値は CI の揺れを考慮した「桁違いの退行を検知する」ための余裕のある値。実測値は標準出力に表示する。
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/domain/commands';
import { diffSchedule } from '../../src/domain/diff';
import { History } from '../../src/domain/history';
import { generateSample } from '../../src/domain/sample';
import { parseSchedule, serializeSchedule } from '../../src/domain/serialize';
import { validateSchedule } from '../../src/domain/validate';

const time = <T>(label: string, fn: () => T, limitMs: number): T => {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  console.log(`[perf] ${label}: ${ms.toFixed(1)} ms（上限 ${limitMs} ms）`);
  expect(ms, `${label} が ${limitMs}ms を超えた`).toBeLessThan(limitMs);
  return r;
};

describe('25,000イベントでの性能', () => {
  const s = time('サンプル生成', () => generateSample(), 3000);

  it('整形出力 → 読み込み（全データ）', () => {
    const files = time('serializeSchedule（501ファイル + 依存）', () => serializeSchedule(s), 3000);
    const r = time('parseSchedule（スキーマ検証 + 整合性チェック込み）', () => parseSchedule(files), 5000);
    expect(r.status).toBe('ok');
  });

  it('整合性チェック（validateSchedule）', () => {
    time('validateSchedule', () => validateSchedule(s), 2000);
  });

  it('1コマンドの適用（ドラッグ確定・編集1回分）が NF-018 の「約1秒」に対して十分小さい', () => {
    const id = 'p0250-e10';
    const N = 200;
    const t0 = performance.now();
    let cur = s;
    for (let i = 0; i < N; i++) {
      const r = applyCommand(cur, { type: 'updateEvent', id, patch: { name: `改名${i}` } });
      if (!r.ok) throw new Error(r.error.message);
      cur = r.schedule;
    }
    const per = (performance.now() - t0) / N;
    console.log(`[perf] updateEvent 1回: ${per.toFixed(3)} ms（${N}回の平均、上限 20 ms）`);
    expect(per).toBeLessThan(20);
  });

  it('Undo 履歴は構造共有で軽量: 1,000回の編集を積んでも元の大半を共有する', () => {
    const h = new History(s);
    time(
      '1,000回の編集 + Undo 全部戻し',
      () => {
        for (let i = 0; i < 1000; i++) h.execute({ type: 'updateEvent', id: `p${String((i % 500) + 0).padStart(4, '0')}-e00`, patch: { name: `n${i}` } });
        while (h.undo());
      },
      5000,
    );
    expect(h.present).toBe(s);
  });

  it('差分検出（diffSchedule）: 全体の比較と、1件変更の検出', () => {
    const changed = applyCommand(s, { type: 'updateEvent', id: 'p0100-e05', patch: { start: '2026-02-01', end: '2026-03-01' } });
    if (!changed.ok) throw new Error(changed.error.message);
    const cs = time('diffSchedule（25,000イベント）', () => diffSchedule(s, changed.schedule), 1500);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: 'item-dates', id: 'p0100-e05' });
  });
});
