// 依存ライブラリのライセンス検査（商用ライブラリ禁止: NF-016）。
// 使い方: node scripts/check-licenses.mjs [node_modules のパス]
// 許諾型 OSS のみ OK。MPL 等は警告、それ以外（GPL 系・独自条件・不明）は error。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/docs.mjs';

const OK = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD', 'Apache-2.0', '0BSD', 'CC0-1.0', 'Unlicense',
  'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0', 'WTFPL', 'Zlib']);
const WARN = new Set(['MPL-2.0']);
// ユーザーが個別に承認した例外（理由を architecture.html 7 にも記録すること）: 'パッケージ名'
const EXCEPTIONS = new Set([]);

const nm = process.argv[2] ?? join(ROOT, 'node_modules');
if (!existsSync(nm)) { console.log('check-licenses: node_modules なし（スキップ）'); process.exit(0); }

const pkgs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  if (!d.isDirectory() || d.name.startsWith('.')) return [];
  return d.name.startsWith('@') ? pkgs(join(dir, d.name)) : [join(dir, d.name)];
});

// SPDX 式の簡易判定: 「A OR B」はどれか1つ許諾型なら OK、「A AND B」は全て必要
function classify(expr) {
  const e = expr.replace(/[()]/g, ' ').trim();
  const level = (id) => (OK.has(id) ? 0 : WARN.has(id) ? 1 : 2);
  const ors = e.split(/\s+OR\s+/i).map((o) => Math.max(...o.split(/\s+AND\s+/i).map((x) => level(x.trim()))));
  return Math.min(...ors);
}

let bad = 0, warn = 0, total = 0;
for (const dir of pkgs(nm)) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) continue;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  total++;
  if (EXCEPTIONS.has(j.name) || j.private) continue;
  const lic = typeof j.license === 'string' ? j.license
    : j.license?.type ?? (Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN');
  const lv = classify(lic || 'UNKNOWN');
  if (lv === 2) { console.error(`ERROR ${j.name}@${j.version}: ライセンス「${lic}」は許諾型 OSS ではない（承認が必要）`); bad++; }
  else if (lv === 1) { console.warn(`WARN  ${j.name}@${j.version}: ${lic}（要確認）`); warn++; }
}
console.log(`check-licenses: ${total} packages, ${bad} errors, ${warn} warnings`);
process.exit(bad ? 1 : 0);
