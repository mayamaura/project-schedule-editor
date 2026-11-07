// @req NF-018, F-210
// 25,000 イベントでの自動保存の所要時間（シリアライズ + 変更ファイルだけの書き込み）。目標: 編集から約1秒以内に完了。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyCommand } from '../../src/domain/commands';
import { generateSample } from '../../src/domain/sample';
import { serializeSchedule } from '../../src/domain/serialize';
import { saveFiles } from '../../src/main/fileRepository';

it('25,000 イベントで1か所編集 → 自動保存が 1 秒未満', () => {
  const root = mkdtempSync(join(tmpdir(), 'autosave-perf-'));
  try {
    const s = generateSample();
    saveFiles(root, serializeSchedule(s)); // 初回（全書き込み）
    const p = Object.values(s.projects).find((x) => Object.keys(x.events).length > 0)!;
    const id = Object.keys(p.events)[0]!;
    const r = applyCommand(s, { type: 'updateEvent', id, patch: { name: '編集後' } });
    if (!r.ok) throw new Error(r.error.message);
    const t0 = performance.now();
    const res = saveFiles(root, serializeSchedule(r.schedule));
    const ms = performance.now() - t0;
    console.log(`[perf] 自動保存（25,000イベント・1プロジェクト変更）: ${ms.toFixed(0)} ms / 書き込み ${res.written.length} ファイル`);
    expect(res.written).toHaveLength(1);
    expect(ms).toBeLessThan(1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
