// docs/*.html を読む共通ヘルパ（依存ライブラリなし）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCS = join(ROOT, 'docs');
export const docFiles = () => readdirSync(DOCS).filter((f) => f.endsWith('.html'));
export const read = (f) => readFileSync(join(DOCS, f), 'utf8');

// requirements.html の表から要件を抽出。行が <td>F-101</td>... で始まるものが対象
export function requirements() {
  const reqs = new Map();
  const dups = [];
  for (const [, row] of read('requirements.html').matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const id = row.match(/^<td>((?:NF|F)-\d+)<\/td>/)?.[1];
    if (!id) continue;
    if (reqs.has(id)) dups.push(id);
    reqs.set(id, { id, pri: row.match(/class="(must|should|could)"/)?.[1] ?? null, deprecated: row.includes('（廃止）') });
  }
  return { reqs, dups };
}

// mode: 'staged' = コミット対象 / 'worktree' = 未コミットの全変更
export function changedFiles(mode) {
  const args = mode === 'staged' ? ['diff', '--cached', '--name-only'] : ['status', '--porcelain'];
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => (mode === 'staged' ? l : l.slice(3)).trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}
