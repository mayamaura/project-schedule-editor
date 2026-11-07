// Stop: 未コミットの変更がある状態で品質ゲートが落ちていたら、終了させず Claude に修正させる。
import { spawnSync } from 'node:child_process';
import { ROOT, changedFiles } from '../lib/docs.mjs';

let input = {};
try { input = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)); })); } catch {}
if (input.stop_hook_active) process.exit(0); // 無限ループ防止
if (changedFiles('worktree').length === 0) process.exit(0);

const r = spawnSync('node', ['scripts/verify.mjs', '--worktree'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  console.error('品質ゲート(scripts/verify.mjs)が失敗しています。修正してください:\n' + (r.stdout + r.stderr).trim());
  process.exit(2);
}
