// 品質ゲート（「完了」の定義）。使い方: node scripts/verify.mjs [--staged|--worktree]
// docs 整合 → 要件ID追跡 → （package.json があれば）typecheck / lint / test を順に実行。
// pre-commit フックと Stop フックから呼ばれる。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/docs.mjs';

const extra = process.argv.slice(2).filter((a) => a === '--staged' || a === '--worktree');
const steps = [
  ['check-docs', 'node', ['scripts/check-docs.mjs', ...extra]],
  ['trace', 'node', ['scripts/trace.mjs']],
];
const pkgPath = join(ROOT, 'package.json');
if (existsSync(pkgPath)) {
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  for (const s of ['typecheck', 'lint', 'test']) if (scripts[s]) steps.push([s, 'npm', ['run', '--silent', s]]);
}

let failed = false;
for (const [name, cmd, args] of steps) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0) { failed = true; console.error(`✗ ${name}\n${out.trim().split('\n').slice(-40).join('\n')}`); }
  else console.log(`✓ ${name}`);
}
process.exit(failed ? 1 : 0);
