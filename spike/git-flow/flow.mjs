// 技術検証: 作業版（ブランチ）フロー・競合予告・退避/復元・性能・非対話での認証失敗。使い捨てコード。
// 使い方: node spike/git-flow/flow.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'gitflow-'));
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', GIT_AUTHOR_NAME: 'spike', GIT_AUTHOR_EMAIL: 's@x', GIT_COMMITTER_NAME: 'spike', GIT_COMMITTER_EMAIL: 's@x' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...a) => { try { return { ok: true, out: git(cwd, ...a) }; } catch (e) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status }; } };
const check = []; const ok = (name, cond, note = '') => { check.push({ name, pass: !!cond, note }); };
const proj = (ver, date) => JSON.stringify({ id: ver, events: { e1: { start: date, end: '2026-12-15' } } }, null, 2) + '\n';

// ---- 準備: bare リモート + 2 クローン（A=自分、B=他の人） ----
const remote = join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', remote);
const A = join(root, 'A'), B = join(root, 'B');
git(root, 'clone', remote, A); mkdirSync(join(A, 'projects'));
writeFileSync(join(A, 'projects', 'p1.json'), proj('p1', '2026-11-01')); writeFileSync(join(A, 'projects', 'p2.json'), proj('p2', '2026-11-05'));
git(A, 'add', '-A'); git(A, 'commit', '-m', 'init'); git(A, 'push', '-u', 'origin', 'main');
git(root, 'clone', remote, B);

// ---- 1. 作業版を作る（内部名は ASCII、表示名は branch.<name>.description）----
const WB = 'work/20261107-nov';
git(A, 'checkout', '-b', WB); git(A, 'config', `branch.${WB}.description`, '11月改訂案');
ok('作業版の表示名を保存・取得できる', git(A, 'config', `branch.${WB}.description`) === '11月改訂案');
writeFileSync(join(A, 'projects', 'p1.json'), proj('p1', '2026-11-10')); git(A, 'commit', '-am', '保存1');
writeFileSync(join(A, 'projects', 'p3.json'), proj('p3', '2026-12-01')); git(A, 'add', '-A'); git(A, 'commit', '-m', '保存2');

// ---- 2. 他の人（B）が同じ項目を変更して main へ push ----
writeFileSync(join(B, 'projects', 'p1.json'), proj('p1', '2026-11-20')); writeFileSync(join(B, 'projects', 'p2.json'), proj('p2', '2026-11-06'));
git(B, 'commit', '-am', 'B: 日程変更'); git(B, 'push', 'origin', 'main');

// ---- 3. 反映①: fetch → 競合予告（作業ツリーを触らない merge-tree）----
git(A, 'fetch', 'origin');
const mt = tryGit(A, 'merge-tree', '--write-tree', '--name-only', WB, 'origin/main');
ok('merge-tree で競合を事前予告できる（作業ツリー無変更）', !mt.ok && /projects\/p1\.json/.test(mt.out) && git(A, 'status', '--porcelain') === '', mt.out.split('\n').filter((l) => l.startsWith('projects')).join(','));

// ---- 4. 反映②: 作業版へ main を取り込み、競合を作業版側で解決 ----
const m = tryGit(A, 'merge', '--no-edit', 'origin/main');
const conflicted = git(A, 'diff', '--name-only', '--diff-filter=U').split('\n');
ok('競合ファイルを検出できる', !m.ok && conflicted.join() === 'projects/p1.json', conflicted.join());
const base = JSON.parse(git(A, 'show', ':1:projects/p1.json')), ours = JSON.parse(git(A, 'show', ':2:projects/p1.json')), theirs = JSON.parse(git(A, 'show', ':3:projects/p1.json'));
ok('3版（base/自分/相手）を項目単位で取得できる', base.events.e1.start === '2026-11-01' && ours.events.e1.start === '2026-11-10' && theirs.events.e1.start === '2026-11-20');
writeFileSync(join(A, 'projects', 'p1.json'), proj('p1', '2026-11-10')); git(A, 'add', 'projects/p1.json'); git(A, 'commit', '--no-edit');
ok('競合解決後に merge コミットできる', git(A, 'status', '--porcelain') === '');

// ---- 5. 反映③: main に --no-ff で取り込み → push。直前に他の人が push → 拒否 → 最初からやり直し ----
const bPush = (n) => { git(B, 'pull', '--no-rebase'); writeFileSync(join(B, 'projects', 'p2.json'), proj('p2', `2026-11-${n}`)); git(B, 'commit', '-am', `B: 更新${n}`); git(B, 'push', 'origin', 'main'); };
// hook は「A の fetch 後・push 前」に他の人が push する場面を再現する
const attempt = (hook) => { git(A, 'fetch', 'origin'); git(A, 'checkout', 'main'); git(A, 'merge', '--ff-only', 'origin/main'); git(A, 'merge', '--no-ff', '-m', '反映: 11月改訂案', WB); hook?.(); return tryGit(A, 'push', 'origin', 'main'); };
let loops = 0, push = attempt(() => bPush(9));
ok('他者が先に push すると反映の送信が拒否される', !push.ok && /rejected|non-fast-forward|fetch first/i.test(push.out), push.out.split('\n').slice(-2).join(' | '));
while (!push.ok && loops++ < 3) { git(A, 'fetch', 'origin'); git(A, 'reset', '--keep', 'origin/main'); git(A, 'checkout', WB); const mm = tryGit(A, 'merge', '--no-edit', 'origin/main'); ok(`再取り込み(${loops})が競合なしで通る`, mm.ok); push = attempt(); }
ok('やり直し後に反映（push）できる', push.ok);
const hist = git(A, 'log', '--oneline', '--first-parent', '-n', '3', 'main');
ok('反映は --no-ff のマージコミットで、作業版の履歴が残る', /反映: 11月改訂案/.test(hist) && git(A, 'rev-list', '--count', `main..${WB}`) === '0' && Number(git(A, 'rev-list', '--count', '--no-merges', 'main')) >= 4, hist.split('\n')[0]);

// ---- 6. 切替時の退避（stash create + refs/app/pending）と復元 ----
git(A, 'checkout', WB); writeFileSync(join(A, 'projects', 'p1.json'), proj('p1', '2027-01-01')); writeFileSync(join(A, 'projects', 'new.json'), proj('new', '2027-02-01'));
git(A, 'add', '-A'); const snap = git(A, 'stash', 'create', 'pending'); git(A, 'update-ref', `refs/app/pending/${WB}`, snap);
git(A, 'checkout', '-f', 'main'); for (const f of git(A, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) rmSync(join(A, f));
ok('退避後に作業ツリーがきれいになり、別の版に切替できる', git(A, 'status', '--porcelain') === '' && git(A, 'branch', '--show-current') === 'main');
git(A, 'checkout', WB); git(A, 'stash', 'apply', '--index', git(A, 'rev-parse', `refs/app/pending/${WB}`)); git(A, 'update-ref', '-d', `refs/app/pending/${WB}`);
ok('戻ったときに未保存の変更（新規ファイル含む）が復元される', JSON.parse(readFileSync(join(A, 'projects', 'p1.json'), 'utf8')).events.e1.start === '2027-01-01' && existsSync(join(A, 'projects', 'new.json')));

// ---- 7. 非対話での認証失敗（背景の fetch で GCM がブラウザを開いたり固まらないか）----
const t0 = Date.now(); const bad = tryGit(root, 'ls-remote', 'https://github.com/this-org-does-not-exist-xyz/none.git');
ok('認証が要る/存在しない接続先は、非対話で素早く失敗する（ハングしない）', !bad.ok && Date.now() - t0 < 20000, `${Date.now() - t0}ms: ${bad.out.trim().split('\n').pop()}`);
const pub = tryGit(root, 'ls-remote', '--heads', 'https://github.com/github/gitignore.git'); ok('公開リポジトリには認証なしで接続できる（ネットワーク確認）', pub.ok, pub.ok ? '' : pub.out.trim().slice(0, 100));

// ---- 8. 規模: 500 プロジェクト × 50 イベント ----
const S = join(root, 'scale'); git(root, 'init', '-b', 'main', S); mkdirSync(join(S, 'projects'));
const mk = (i) => { const ev = {}; for (let k = 0; k < 50; k++) ev[`e${String(k).padStart(2, '0')}`] = { name: `イベント${k}`, start: '2026-01-01', end: '2026-02-01', type: 'phase' }; return JSON.stringify({ id: `p${i}`, name: `プロジェクト${i}`, events: ev }, null, 2) + '\n'; };
const tg = (label, fn) => { const t = performance.now(); const r = fn(); const ms = performance.now() - t; return { label, ms: +ms.toFixed(0), r }; };
const perf = [];
perf.push(tg('500ファイル生成', () => { for (let i = 0; i < 500; i++) writeFileSync(join(S, 'projects', `p${i}.json`), mk(i)); }));
perf.push(tg('git add -A (初回)', () => git(S, 'add', '-A'))); perf.push(tg('git commit (初回)', () => git(S, 'commit', '-m', 'init')));
perf.push(tg('全500ファイルを読んで JSON.parse', () => readdirSync(join(S, 'projects')).map((f) => JSON.parse(readFileSync(join(S, 'projects', f), 'utf8'))).length));
writeFileSync(join(S, 'projects', 'p7.json'), mk(7).replace('2026-02-01', '2026-02-15'));
perf.push(tg('git status (1ファイル変更)', () => git(S, 'status', '--porcelain'))); perf.push(tg('git diff --name-only', () => git(S, 'diff', '--name-only')));
perf.push(tg('git commit (1ファイル変更)', () => git(S, 'commit', '-am', 'edit'))); perf.push(tg('git show HEAD~1:file', () => git(S, 'show', 'HEAD~1:projects/p7.json').length));
perf.push(tg('git log -n 50 --stat', () => git(S, 'log', '-n', '50', '--stat').length));
git(S, 'checkout', '-b', 'work/x'); for (let i = 0; i < 50; i++) writeFileSync(join(S, 'projects', `p${i}.json`), mk(i).replace('2026-01-01', '2026-01-08')); git(S, 'commit', '-am', 'bulk');
perf.push(tg('git checkout main (50ファイル差)', () => git(S, 'checkout', 'main')));

console.log(`git: ${git(root, '--version')} / GCM: ${tryGit(root, 'credential-manager', '--version').out.split('+')[0]} / helper: ${tryGit(root, 'config', '--get-all', 'credential.helper').out}`);
for (const c of check) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? '  — ' + c.note : ''}`);
console.log('--- 性能（500プロジェクト × 50イベント、1ファイル約 5KB）');
for (const p of perf) console.log(`${String(p.ms).padStart(6)} ms  ${p.label}`);
rmSync(root, { recursive: true, force: true });
process.exit(check.every((c) => c.pass) ? 0 : 1);
