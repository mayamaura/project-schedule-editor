// PostToolUse(Edit|Write): 編集直後の軽量チェック。問題があれば exit 2 で Claude にフィードバック。
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/docs.mjs';

let input = {};
try { input = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)); })); } catch {}
const p = String(input.tool_input?.file_path ?? '').replace(/\\/g, '/');

const script = /\/docs\/[^/]+\.html$/.test(p) ? 'scripts/check-docs.mjs'
  : /\/(src|tests|e2e)\//.test(p) ? 'scripts/trace.mjs' : null;
if (!script) process.exit(0);

const r = spawnSync('node', [script], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  console.error((r.stdout + r.stderr).trim());
  process.exit(2);
}
