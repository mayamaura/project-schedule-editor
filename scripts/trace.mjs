// 要件ID ⇔ コード/テストの追跡。使い方: node scripts/trace.mjs [--report]
// コード・テストに「@req F-201, F-202」とタグを書く。存在しない ID は error。
// --report: 必須(M)要件のうち、実装タグ・テストタグが無いものを一覧表示。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, requirements } from './lib/docs.mjs';

const SRC = ['src', 'tests', 'e2e'];
const walk = (d) =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
  });

const { reqs } = requirements();
const impl = new Map(); // id -> files（テスト以外）
const test = new Map(); // id -> files（テスト）
let bad = 0;

for (const dir of SRC) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const isTest = /(^tests\/|^e2e\/|\.test\.|\.spec\.)/.test(rel);
    for (const [, list] of readFileSync(file, 'utf8').matchAll(/@req\s+((?:(?:NF|F)-\d+[,\s]*)+)/g)) {
      for (const id of list.match(/(?:NF|F)-\d+/g)) {
        if (!reqs.has(id)) { console.error(`ERROR ${rel}: 存在しない要件ID ${id}`); bad++; continue; }
        const m = isTest ? test : impl;
        m.set(id, [...(m.get(id) ?? []), rel]);
      }
    }
  }
}

if (process.argv.includes('--report')) {
  const must = [...reqs.values()].filter((r) => r.pri === 'must');
  const rows = must.map((r) => `${r.id}  impl:${impl.has(r.id) ? 'o' : '-'}  test:${test.has(r.id) ? 'o' : '-'}`);
  console.log(rows.join('\n'));
  console.log(`必須要件 ${must.length} 件 / 実装タグあり ${must.filter((r) => impl.has(r.id)).length} / テストタグあり ${must.filter((r) => test.has(r.id)).length}`);
}
console.log(`trace: ${bad} errors`);
process.exit(bad ? 1 : 0);
