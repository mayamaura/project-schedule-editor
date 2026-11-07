// ドキュメント整合性チェック。使い方: node scripts/check-docs.mjs [--staged|--worktree]
// error があれば exit 1。warn は表示のみ。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS, docFiles, read, requirements, changedFiles } from './lib/docs.mjs';

const errors = [];
const warns = [];
const files = docFiles();
const hrefsOf = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

// 1. 各ページの基本構造
for (const f of files) {
  const h = read(f);
  if (!/<html lang="ja"/.test(h)) errors.push(`${f}: <html lang="ja"> がない`);
  if (!/<title>[^<]+<\/title>/.test(h)) errors.push(`${f}: <title> がない`);
  if (!/href="style\.css"/.test(h)) errors.push(`${f}: style.css を読み込んでいない`);
}

// 2. ナビが全ページで同一、かつ全 HTML を網羅し、現在ページだけ cur
const expected = [...files].sort().join(',');
for (const f of files) {
  const nav = read(f).match(/<nav>(.*?)<\/nav>/s)?.[1];
  if (!nav) { errors.push(`${f}: <nav> がない`); continue; }
  const links = hrefsOf(nav).sort().join(',');
  if (links !== expected) errors.push(`${f}: nav のリンクが docs/*.html と一致しない（新規ページは全ページの nav に追加）`);
  const cur = nav.match(/class="cur" href="([^"]+)"/)?.[1];
  if (cur !== f) errors.push(`${f}: nav の class="cur" が自ページを指していない（${cur}）`);
}

// 3. 内部リンク（ファイル・アンカー）
for (const f of files) {
  for (const href of hrefsOf(read(f))) {
    if (/^(https?:|mailto:)/.test(href) || href === 'style.css') continue;
    const [file, anchor] = href.split('#');
    const target = file || f;
    if (!existsSync(join(DOCS, target))) { errors.push(`${f}: リンク切れ ${href}`); continue; }
    if (anchor && !new RegExp(`id="${anchor}"`).test(read(target))) errors.push(`${f}: アンカーなし ${href}`);
  }
}

// 4. 要件ID: 重複なし、他文書の参照先が存在
const { reqs, dups } = requirements();
for (const d of dups) errors.push(`requirements.html: 要件ID重複 ${d}`);
for (const f of files) {
  for (const [, id] of read(f).matchAll(/\b((?:NF|F)-\d{3})\b/g)) {
    if (!reqs.has(id)) errors.push(`${f}: 存在しない要件ID ${id}`);
  }
}

// 5. 決定事項の参照（Ax）が open-questions.html に存在
const oq = read('open-questions.html');
for (const f of files) {
  for (const [, n] of read(f).matchAll(/（A(\d+)）/g)) {
    if (!new RegExp(`<td>★?A${n}</td>`).test(oq)) errors.push(`${f}: 存在しない質問番号 A${n}`);
  }
}
for (const [, row] of oq.matchAll(/<tr>(<td>★A\d+<\/td>.*?)<\/tr>/g)) {
  if (!row.includes('決定:')) warns.push(`open-questions.html: 未決の★項目 ${row.match(/A\d+/)[0]}`);
}

// 6. 仕様文書を変更したら changelog.html も更新する
const mode = process.argv.includes('--staged') ? 'staged' : process.argv.includes('--worktree') ? 'worktree' : null;
if (mode) {
  const ch = changedFiles(mode).map((p) => p.replace(/\\/g, '/'));
  const spec = ch.filter((p) => /^docs\/(requirements|data-model|architecture|ui-design|git-ux|open-questions)\.html$/.test(p));
  if (spec.length && !ch.includes('docs/changelog.html')) {
    errors.push(`仕様文書を変更したが docs/changelog.html が未更新: ${spec.join(', ')}`);
  }
}

warns.forEach((w) => console.warn('WARN  ' + w));
errors.forEach((e) => console.error('ERROR ' + e));
console.log(`check-docs: ${files.length} files, ${reqs.size} requirements, ${errors.length} errors, ${warns.length} warnings`);
process.exit(errors.length ? 1 : 0);
