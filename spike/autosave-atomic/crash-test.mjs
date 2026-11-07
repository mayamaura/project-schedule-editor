// 技術検証: 自動保存の原子的書き込み（一時ファイル → fsync → rename）と、途中終了への耐性。
// 使い方: node spike/autosave-atomic/crash-test.mjs [反復回数=150]
// 合格基準: ①原子的書き込みは何度強制終了しても全ファイルが壊れない ②複数ファイルのトランザクションは復旧後に全て同一版
//           ③素朴な writeFile は壊れる（比較用）④1ファイルの書き込みが NF-018（約1秒以内）に十分収まる
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sum = (s) => createHash('sha1').update(s).digest('hex');
const payload = (ver) => { const body = JSON.stringify({ ver, filler: 'x'.repeat(6000) }); return JSON.stringify({ body, sum: sum(body) }); }; // 約6KB（プロジェクト1件相当）
const verOf = (text) => { const o = JSON.parse(text); if (sum(o.body) !== o.sum) throw new Error('checksum'); return JSON.parse(o.body).ver; };

function renameRetry(a, b) { for (let i = 0; ; i++) { try { return renameSync(a, b); } catch (e) { if (i > 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } } }
function writeTmp(file, text) { const tmp = `${file}.${process.pid}.tmp`; const fd = openSync(tmp, 'w'); writeSync(fd, text); fsyncSync(fd); closeSync(fd); return tmp; }
export function writeAtomic(file, text) { renameRetry(writeTmp(file, text), file); }
export function writeNaive(file, text) { writeFileSync(file, text); }

// 複数ファイルのトランザクション: ①全 tmp を書く ②pending.json（tmp→最終の対応表）を原子的に書く ③順に rename ④pending を削除
export function writeTxn(dir, files) {
  const entries = Object.entries(files).map(([name, text]) => ({ tmp: writeTmp(join(dir, name), text), final: join(dir, name) }));
  writeAtomic(join(dir, 'pending.json'), JSON.stringify(entries));
  for (const e of entries) if (existsSync(e.tmp)) renameRetry(e.tmp, e.final);
  unlinkSync(join(dir, 'pending.json'));
}
// 起動時の復旧: pending があれば roll-forward（tmp が残っているものを rename）。無ければ孤児 tmp を削除
export function recover(dir) {
  const p = join(dir, 'pending.json');
  if (existsSync(p)) { for (const e of JSON.parse(readFileSync(p, 'utf8'))) if (existsSync(e.tmp)) renameRetry(e.tmp, e.final); unlinkSync(p); }
  for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) unlinkSync(join(dir, f));
}

if (process.argv[2] === '--child') {            // 子: 書き込みを延々と繰り返す（親が強制終了する）
  const [, , , mode, dir] = process.argv; const N = 5; let ver = 1;
  for (;;) {
    const files = Object.fromEntries(Array.from({ length: N }, (_, i) => [`f${i}.json`, payload(ver)]));
    if (mode === 'naive') for (const [n, t] of Object.entries(files)) writeNaive(join(dir, n), t);
    else if (mode === 'atomic') for (const [n, t] of Object.entries(files)) writeAtomic(join(dir, n), t);
    else writeTxn(dir, files);
    ver++;
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rounds = Number(process.argv[2] ?? 150), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = {};
  for (const mode of ['naive', 'atomic', 'txn']) {
    const dir = mkdtempSync(join(tmpdir(), `autosave-${mode}-`)); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.json`), payload(0));
    let corrupt = 0, inconsistent = 0, orphanTmp = 0;
    for (let r = 0; r < rounds; r++) {
      const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, dir], { stdio: 'ignore' });
      await sleep(20 + Math.random() * 120); c.kill('SIGKILL'); await new Promise((res) => c.on('exit', res));
      orphanTmp += readdirSync(dir).filter((f) => f.endsWith('.tmp')).length;
      if (mode === 'txn') recover(dir);
      else for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) unlinkSync(join(dir, f));
      const vers = [];
      for (let i = 0; i < 5; i++) { try { vers.push(verOf(readFileSync(join(dir, `f${i}.json`), 'utf8'))); } catch { corrupt++; vers.push(null); } }
      if (mode === 'txn' && new Set(vers).size > 1) inconsistent++;
    }
    results[mode] = { rounds, corruptFiles: corrupt, inconsistentGroups: inconsistent, orphanTmpSeen: orphanTmp };
    rmSync(dir, { recursive: true, force: true });
  }
  // 書き込み時間（fsync あり）: 6KB を 200 回
  const dir = mkdtempSync(join(tmpdir(), 'autosave-time-')); const ts = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); writeAtomic(join(dir, 'p.json'), payload(i)); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  const t50 = []; for (let i = 0; i < 20; i++) { const t = performance.now(); writeTxn(dir, Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`n${k}.json`, payload(i)]))); t50.push(performance.now() - t); }
  t50.sort((a, b) => a - b);
  results.latencyMs = { single6KB: { median: +ts[100].toFixed(2), p95: +ts[190].toFixed(2), max: +ts[199].toFixed(2) }, txn50files: { median: +t50[10].toFixed(1), max: +t50[19].toFixed(1) } };
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 2));
}
