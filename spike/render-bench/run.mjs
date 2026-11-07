// bench.html を実ブラウザ（Edge/Chrome, Chromium）で実行し、結果を表示・保存する。
// 使い方: node spike/render-bench/run.mjs [edge|chrome] [--gpu]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] === 'chrome' ? 'chrome' : 'edge';
const gpu = process.argv.includes('--gpu');
const exe = which === 'chrome' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'bench-'));
const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1500,900', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  ...(gpu ? [] : ['--disable-gpu']), 'about:blank'];
const proc = spawn(exe, args, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  if (!ver) throw new Error('browser did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(resolve(here, 'bench.html')).href)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  const call = (method, params) => new Promise((resolveCall) => { const id = call.n = (call.n ?? 0) + 1; const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener('message', h); resolveCall(d); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params })); });
  await call('Page.enable', {}); await call('Page.bringToFront', {}); await call('Emulation.setFocusEmulationEnabled', { enabled: true }); await sleep(800);
  // プローブ: 描画フレーム(rAF)が進まないと計測できない。5秒で見切って原因を表示する
  const probe = await Promise.race([call('Runtime.evaluate', { expression: `new Promise(r=>requestAnimationFrame(t=>r({vis:document.visibilityState,t})))`, awaitPromise: true, returnByValue: true }), sleep(5000).then(() => null)]);
  if (!probe) throw new Error('requestAnimationFrame が発火しない（ページが非表示扱い）。--gpu の有無を変えて再実行');
  console.log('probe:', JSON.stringify(probe.result.result.value));
  const mode = process.argv.includes('--text') ? 'text' : '';
  const r = await call('Runtime.evaluate', { expression: `window.runAll('${mode}')`, awaitPromise: true, returnByValue: true, timeout: 900000 });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  const data = r.result.result.value;
  const file = join(here, `results-${which}${gpu ? '-gpu' : ''}${mode ? '-text' : ''}.json`); writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(data.ua, `dpr=${data.dpr}`, gpu ? '(GPU有効)' : '(--disable-gpu: ソフトウェア描画)');
  console.log('kind'.padEnd(20), 'N'.padStart(6), 'init'.padStart(8), 'frame avg'.padStart(10), 'p95'.padStart(8), 'max'.padStart(8), 'js avg'.padStart(8), 'hit(us)'.padStart(8));
  for (const x of data.results) console.log(x.kind.padEnd(20), String(x.N).padStart(6), String(x.initMs).padStart(8), String(x.frameInterval.avg).padStart(10), String(x.frameInterval.p95).padStart(8), String(x.frameInterval.max).padStart(8), String(x.jsPerFrame.avg).padStart(8), String(x.hitUs ?? '-').padStart(8));
  ws.close();
} finally { proc.kill(); }
