// @req F-502, F-504, F-522, F-523, NF-003
// 実際の Git で GitService を確認する（一時リポジトリ）。保存（commit）・履歴・過去版の取得・診断・Git の解決。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, parseGitVersion, resolveGit } from '../../src/main/git/gitService';

let root: string;
let svc: GitService;
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const id = { name: '山田', email: 'y@example.com' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitsvc-'));
  const git = resolveGit({});
  if (!git) throw new Error('git が見つからない');
  svc = new GitService(git, root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Git の解決（F-522）', () => {
  it('バージョン文字列を解釈する', () => {
    expect(parseGitVersion('git version 2.55.0.windows.2')).toEqual([2, 55, 0]);
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39, 5]);
    expect(parseGitVersion('なにか')).toBeNull();
  });
  it('PATH 上の Git を見つける。存在しない指定は無視して次の候補へ', () => {
    const g = resolveGit({ configuredPath: join(root, 'no-such-git') });
    expect(g?.source).toBe('external');
    expect(g?.version[0]).toBeGreaterThanOrEqual(2);
  });
  it('最低バージョン未満の外部 Git は使わず、同梱 Git にフォールバックする', () => {
    expect(resolveGit({ minVersion: [99, 0, 0] })).toBeNull();
    const g = resolveGit({ minVersion: [99, 0, 0], bundledPath: resolveGit({})!.path });
    expect(g?.source).toBe('bundled');
  });
});

describe('保存・履歴（F-502, F-504）', () => {
  it('新規作成 → 保存すると履歴に載り、変更が無ければ何もしない', async () => {
    expect((await svc.state()).isRepo).toBe(false);
    await svc.init();
    put('schedule.json', '{"schemaVersion":1}\n');
    put('projects/A.json', '{"a":1}\n');
    const r = await svc.save('最初の保存', id);
    expect(r.status).toBe('ok');
    const log = await svc.log(10);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ message: '最初の保存', author: '山田' });
    expect((await svc.save('変化なし', id)).status).toBe('nothing');
    expect(await svc.log(10)).toHaveLength(1);
  });
  it('名前とメールが無ければ identity-required を返し、渡せば保存できる', async () => {
    await svc.init();
    put('schedule.json', '{}\n');
    const r = await svc.save('x', undefined, { ignoreGlobalIdentity: true });
    expect(r.status).toBe('identity-required');
    expect((await svc.save('x', id)).status).toBe('ok');
  });
  it('.autosave は保存の対象にならない', async () => {
    await svc.init();
    put('schedule.json', '{}\n');
    put('.autosave/running', '1');
    await svc.save('a', id);
    expect((await svc.filesAt('HEAD'))['.autosave/running']).toBeUndefined();
    expect((await svc.state()).dirty).toBe(false);
  });
  it('過去の版のファイルを取得できる（日本語・改行を含む内容もそのまま）', async () => {
    await svc.init();
    put('schedule.json', '{"v":1}\n');
    put('projects/A.json', '{"name":"新製品A\n"}\n');
    await svc.save('v1', id);
    const first = (await svc.log(1))[0]!.hash;
    put('projects/A.json', '{"name":"改"}\n');
    put('projects/B.json', '{"b":1}\n');
    await svc.save('v2', id);
    const old = await svc.filesAt(first);
    expect(Object.keys(old).sort()).toEqual(['projects/A.json', 'schedule.json']);
    expect(old['projects/A.json']).toBe('{"name":"新製品A\n"}\n');
    expect(Object.keys(await svc.filesAt('HEAD'))).toHaveLength(3);
  });
  it('履歴が空のとき log は空、HEAD の内容は null', async () => {
    await svc.init();
    expect(await svc.log(10)).toEqual([]);
    expect((await svc.state()).head).toBeNull();
  });
  it('CRLF に変換されない（改行コードの自動変換を無効にして実行する）', async () => {
    await svc.init();
    put('schedule.json', '{}\n');
    await svc.save('a', id);
    expect((await svc.filesAt('HEAD'))['schedule.json']).toBe('{}\n');
  });
});

describe('診断（F-523）', () => {
  it('Git の検出・リポジトリ・接続先の有無を項目ごとに返す', async () => {
    await svc.init();
    const items = await svc.diagnose();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['git']?.ok).toBe(true);
    expect(byKey['repo']?.ok).toBe(true);
    expect(byKey['remote']?.ok).toBe(false); // リモート未設定（ローカルのみ。編集と保存はできる）
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.autosave/');
  });
});
