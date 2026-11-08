// @req F-513, F-514, F-515, F-517, F-518, F-520, F-506, F-511
// 実際の Git（bare のリモート + 自分 + 他の人）で、作業版 → 取り込み → 競合解決 → 正式版へ反映、を通す。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../../src/domain/commands';
import { emptySchedule } from '../../src/domain/model';
import { createEmpty } from '../../src/main/fileRepository';
import { mergeSchedules } from '../../src/domain/merge';
import type { Schedule } from '../../src/domain/model';
import { parseSchedule, serializeSchedule, type Files } from '../../src/domain/serialize';
import { GitService, resolveGit, type MergeInputs } from '../../src/main/git/gitService';
import { basic } from '../domain/fixtures';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
for (const k of Object.keys(ENV)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|AUTHOR_.*|COMMITTER_.*)$/.test(k)) delete (ENV as Record<string, unknown>)[k];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const id = { name: '山田', email: 'y@example.com' };

let top: string;
let remote: string;
let a: string; // 自分
let b: string; // 他の人
let svc: GitService;

const write = (dir: string, files: Files): void => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};
const apply = (s: Schedule, ...cs: Command[]): Schedule => {
  let cur = s;
  for (const c of cs) {
    const r = applyCommand(cur, c);
    if (!r.ok) throw new Error(r.error.message);
    cur = r.schedule;
  }
  return cur;
};
const load = (dir: string): Schedule => {
  const files: Files = {};
  for (const rel of git(dir, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n')) files[rel] = readFileSync(join(dir, rel), 'utf8');
  const p = parseSchedule(files);
  if (p.status !== 'ok') throw new Error('parse');
  return p.schedule;
};
/** 他の人が変更して正式版へ送る。 */
const otherPushes = (...cs: Command[]): void => {
  git(b, 'pull', '--no-rebase', 'origin', 'main');
  write(b, serializeSchedule(apply(load(b), ...cs)));
  git(b, 'add', '-A');
  git(b, 'commit', '-m', '相手の変更');
  git(b, 'push', 'origin', 'main');
};
const projectsFile = (ref: string): string => git(remote, 'show', `${ref}:projects/A.json`);

/** 取り込み（fetch → 3 版のマージ → 反映用のファイルを作る）。競合の解決は resolutions で指定。 */
async function pullIn(resolutions: Record<string, 'ours' | 'theirs'> = {}): Promise<{ inputs: MergeInputs; conflicts: number }> {
  expect((await svc.fetch()).ok).toBe(true);
  const inputs = await svc.mergeInputs();
  if (inputs.status !== 'merge') return { inputs, conflicts: 0 };
  const parse = (f: Files): Schedule => {
    const p = parseSchedule(f);
    if (p.status !== 'ok') throw new Error('parse');
    return p.schedule;
  };
  const r = mergeSchedules(parse(inputs.base), parse(inputs.ours), parse(inputs.theirs), resolutions);
  if (r.conflicts.length === 0) expect(await svc.completeMerge(serializeSchedule(r.schedule), inputs.theirsRef, '正式版の最新を取り込み')).toMatchObject({ status: 'ok' });
  return { inputs, conflicts: r.conflicts.length };
}

beforeEach(async () => {
  top = mkdtempSync(join(tmpdir(), 'gitflow-'));
  remote = join(top, 'remote.git');
  a = join(top, 'a');
  b = join(top, 'b');
  git(top, 'init', '--bare', '-b', 'main', remote);
  git(top, 'clone', remote, a);
  git(top, 'clone', remote, b);
  for (const d of [a, b]) {
    git(d, 'config', 'user.name', d === a ? '山田' : '相手');
    git(d, 'config', 'user.email', 'x@example.com');
    git(d, 'config', 'core.autocrlf', 'false');
  }
  write(a, serializeSchedule(basic()));
  git(a, 'checkout', '-B', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-m', '最初の版');
  git(a, 'push', '-u', 'origin', 'main');
  git(b, 'pull', 'origin', 'main');
  git(b, 'checkout', '-B', 'main', 'origin/main');
  svc = new GitService(resolveGit({})!, a);
});
afterEach(() => {
  rmSync(top, { recursive: true, force: true });
});

describe('作業版（F-513, F-514, F-515）', () => {
  it('作成すると正式版の最新から作業版になり、表示名が日本語で残る。一覧に出る', async () => {
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { name: '相手の更新' } });
    const r = await svc.createWork('11月改訂案');
    expect(r).toMatchObject({ ok: true });
    expect((await svc.state()).branch).toMatch(/^work\/\d{8}-[0-9a-z]+$/);
    expect(load(a).projects['A']!.events['e1']!.name).toBe('相手の更新'); // 正式版の最新から
    const list = await svc.workVersions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ display: '11月改訂案', ahead: 0 });
  });
  it('作業版での履歴は正式版に影響せず、先行する件数が数えられる', async () => {
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '作業中' } })));
    expect(await svc.save('作業1', id)).toMatchObject({ status: 'ok' });
    expect((await svc.workVersions())[0]!.ahead).toBe(1);
    expect(git(remote, 'show', 'main:projects/A.json')).not.toContain('作業中');
  });
  it('切り替えるとき保存前の変更は自動で退避され、戻ると復元される（新規ファイルも）', async () => {
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '正式版で編集中' } }, { type: 'addProject', project: { id: 'NEW', name: '新規', parentId: null, order: 'z', events: {}, milestones: {} } })));
    const w = await svc.createWork('案');
    expect(w.ok).toBe(true);
    expect((await svc.state()).dirty).toBe(false);
    expect(load(a).projects['A']!.events['e1']!.name).toBe('設計');
    const sw = await svc.switchTo('main');
    expect(sw.ok).toBe(true);
    const s = load(a);
    expect(s.projects['A']!.events['e1']!.name).toBe('正式版で編集中');
    expect(s.projects['NEW']).toBeDefined();
    expect(git(a, 'for-each-ref', 'refs/app/pending')).toBe(''); // 復元したら退避は消える
  });
  it('履歴が無いと作れない', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gitempty-'));
    try {
      const s = new GitService(resolveGit({})!, empty);
      await s.init();
      expect(await s.createWork('x')).toMatchObject({ ok: false });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('正式版へ反映（F-517, F-518, F-511, F-506）', () => {
  it('他の人が先に更新していても、重ならない変更は自動で取り込まれ、反映できる', async () => {
    await svc.createWork('11月改訂案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '設計（改）' } })));
    await svc.save('作業1', id);
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } }); // 同じイベントの別フィールド

    const { inputs, conflicts } = await pullIn();
    expect(inputs.status).toBe('merge');
    expect(conflicts).toBe(0);
    const merged = load(a).projects['A']!.events['e1']!;
    expect(merged).toMatchObject({ name: '設計（改）', end: '2026-12-20' });

    expect(await svc.finishReflect('11月改訂案', id)).toMatchObject({ status: 'ok' });
    const main = projectsFile('main');
    expect(main).toContain('設計（改）');
    expect(main).toContain('2026-12-20');
    expect(git(remote, 'log', '--first-parent', '--format=%s', '-n1', 'main')).toBe('反映: 11月改訂案');
    expect(git(remote, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3); // 先頭は --no-ff のマージコミット（親が 2 つ）
    expect(git(a, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));
    expect(git(a, 'for-each-ref', 'refs/app/backup')).toContain('refs/app/backup/'); // 元に戻す用の退避
    expect((await svc.state()).branch).toMatch(/^work\//); // 反映後も作業版にいる（続ける / 整理する）
  });
  it('同じ項目を別の値にしていたら競合。選んだ側で解決して反映できる', async () => {
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { end: '2026-12-20' } })));
    await svc.save('作業1', id);
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { end: '2026-12-25' } });
    const first = await pullIn();
    expect(first.conflicts).toBe(1);
    expect((await svc.state()).dirty).toBe(false); // 競合の間は何も変えていない
    const second = await pullIn({ 'projects/A/events/e1/end': 'theirs' });
    expect(second.conflicts).toBe(0);
    expect(load(a).projects['A']!.events['e1']!.end).toBe('2026-12-25');
  });
  it('反映の送信直前に他の人が更新したら拒否され、取り込み直せば反映できる', async () => {
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '作業中' } })));
    await svc.save('作業1', id);
    await pullIn();
    otherPushes({ type: 'updateEvent', id: 'e2', patch: { name: '直前の更新' } });
    expect(await svc.finishReflect('案', id)).toMatchObject({ status: 'rejected' });
    expect(git(a, 'rev-parse', 'main')).not.toBe(git(remote, 'rev-parse', 'main')); // 失敗したら何も変えない
    await pullIn();
    expect(await svc.finishReflect('案', id)).toMatchObject({ status: 'ok' });
    const main = projectsFile('main');
    expect(main).toContain('作業中');
    expect(main).toContain('直前の更新');
  });
  it('正式版の最新を取り込んでいない作業版は反映できない', async () => {
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '作業中' } })));
    await svc.save('作業1', id);
    otherPushes({ type: 'updateEvent', id: 'e2', patch: { name: '更新' } });
    await svc.fetch();
    expect(await svc.finishReflect('案', id)).toMatchObject({ status: 'outdated' });
  });
  it('保存前の変更があると取り込みも反映もしない', async () => {
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: '未保存' } })));
    expect((await svc.mergeInputs()).status).toBe('dirty');
    expect(await svc.finishReflect('案', id)).toMatchObject({ status: 'dirty' });
  });
  it('他の人の更新が無ければ取り込み不要', async () => {
    await svc.createWork('案');
    await svc.fetch();
    expect((await svc.mergeInputs()).status).toBe('up-to-date');
  });
  it('作業版に変更が無く、正式版だけが進んでいるときは早送りで取り込む', async () => {
    await svc.createWork('案');
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { name: '先に更新' } });
    const { inputs } = await pullIn();
    expect(inputs).toMatchObject({ status: 'merge', fastForward: true });
    expect(git(a, 'rev-list', '--count', '--merges', 'HEAD')).toBe('0');
    expect(load(a).projects['A']!.events['e1']!.name).toBe('先に更新');
  });
  it('共有先が無いときは、手元の正式版へ反映する', async () => {
    git(a, 'remote', 'remove', 'origin');
    await svc.createWork('案');
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e1', patch: { name: 'ローカルで反映' } })));
    await svc.save('作業1', id);
    expect(await svc.hasRemote()).toBe(false);
    expect(await svc.finishReflect('案', id)).toMatchObject({ status: 'ok' });
    expect(git(a, 'show', 'main:projects/A.json')).toContain('ローカルで反映');
  });
});

describe('正式版の直接編集と共有（F-520, F-503）', () => {
  it('履歴に残してから共有すると、他の人の更新を取り込んで送信される', async () => {
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e2', patch: { name: '自分の更新' } })));
    await svc.save('自分', id);
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { name: '相手の更新' } });
    const { inputs } = await pullIn();
    expect(inputs).toMatchObject({ status: 'merge', mode: 'main' });
    expect(await svc.push()).toMatchObject({ status: 'ok' });
    const main = projectsFile('main');
    expect(main).toContain('自分の更新');
    expect(main).toContain('相手の更新');
  });
  it('他の人が先に送っていたら拒否される', async () => {
    write(a, serializeSchedule(apply(load(a), { type: 'updateEvent', id: 'e2', patch: { name: '自分の更新' } })));
    await svc.save('自分', id);
    otherPushes({ type: 'updateEvent', id: 'e1', patch: { name: '相手の更新' } });
    expect(await svc.push()).toMatchObject({ status: 'rejected' });
  });
});

describe('共有先の設定と取得（F-501）', () => {
  it('共有先を設定でき、接続診断が通る', async () => {
    git(a, 'remote', 'remove', 'origin');
    expect(await svc.hasRemote()).toBe(false);
    await svc.setRemote(remote);
    expect(await svc.hasRemote()).toBe(true);
    const diag = await svc.diagnose();
    expect(diag.find((d) => d.key === 'connection')?.ok).toBe(true);
  });
  it('共有先から取得（clone）できる', async () => {
    const dest = join(top, 'cloned');
    const r = await GitService.clone(resolveGit({})!, remote, dest);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dest, 'schedule.json'), 'utf8')).toContain('schemaVersion');
  });
  it('存在しない共有先は失敗し、理由が返る', async () => {
    const r = await GitService.clone(resolveGit({})!, join(top, 'nothing.git'), join(top, 'c2'));
    expect(r.ok).toBe(false);
  });
});

describe('空の共有先から始める（F-501）', () => {
  it('取得した空のフォルダに新規作成し、最初の履歴を残して共有できる（共有先の既定の名前が main でなくても）', async () => {
    const emptyRemote = join(top, 'empty.git');
    git(top, 'init', '--bare', '-b', 'master', emptyRemote); // 作ったばかりの共有先
    const dest = join(top, 'fresh');
    expect(await GitService.clone(resolveGit({})!, emptyRemote, dest)).toEqual({ ok: true });
    const s = new GitService(resolveGit({})!, dest);
    expect((await s.state()).head).toBeNull(); // 履歴なし

    expect(createEmpty(dest, serializeSchedule(emptySchedule()))).toEqual({ ok: true });
    await s.ensureMainBranch();
    expect((await s.state()).branch).toBe('main');
    expect(await s.save('最初の版', id)).toMatchObject({ status: 'ok' });
    expect(await s.mergeInputs()).toMatchObject({ status: 'up-to-date' }); // 取り込む更新なし
    expect(await s.push()).toMatchObject({ status: 'ok' });
    expect(git(emptyRemote, 'log', '--format=%s', 'main')).toBe('最初の版');
  });
});
