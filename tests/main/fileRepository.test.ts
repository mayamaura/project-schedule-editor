// @req NF-004, NF-018, F-210, F-211
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptySchedule } from '../../src/domain/model';
import { parseSchedule, serializeSchedule } from '../../src/domain/serialize';
import { beginSession, createEmpty, deleteTemplate, endSession, loadFiles, recover, saveFiles, saveTemplate, writeAtomic, writeTransaction } from '../../src/main/fileRepository';
import { basic } from '../domain/fixtures';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const listTmp = (): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.tmp')) out.push(join(d, e.name));
    }
  };
  walk(root);
  return out;
};

describe('writeAtomic', () => {
  it('新規作成・上書きができ、一時ファイルが残らない（親ディレクトリも作る）', () => {
    writeAtomic(join(root, 'a', 'b.json'), 'one');
    expect(read('a/b.json')).toBe('one');
    writeAtomic(join(root, 'a', 'b.json'), 'two');
    expect(read('a/b.json')).toBe('two');
    expect(listTmp()).toEqual([]);
  });
});

describe('writeTransaction / recover（複数ファイルを全て同じ版にそろえる）', () => {
  it('通常は全て適用され、pending.json と一時ファイルは残らない', () => {
    writeTransaction(root, { 'projects/a.json': 'A1', 'projects/b.json': 'B1' });
    expect([read('projects/a.json'), read('projects/b.json')]).toEqual(['A1', 'B1']);
    expect(existsSync(join(root, '.autosave', 'pending.json'))).toBe(false);
    expect(listTmp()).toEqual([]);
  });
  it('書き込みと削除を同時に適用する', () => {
    writeTransaction(root, { 'projects/a.json': 'A1', 'projects/b.json': 'B1' });
    writeTransaction(root, { 'projects/a.json': 'A2' }, ['projects/b.json']);
    expect(read('projects/a.json')).toBe('A2');
    expect(existsSync(join(root, 'projects/b.json'))).toBe(false);
  });
  it('空の更新は何もしない', () => {
    writeTransaction(root, {});
    expect(existsSync(join(root, '.autosave'))).toBe(false);
  });

  // --- 途中で落ちた状態を、手で作って復旧を検証する（実際のプロセス強制終了は spike/autosave-atomic で検証済み）---
  const stage = (): void => {
    // writeTransaction の①②までを再現: 一時ファイルと pending.json があり、rename は1つも済んでいない
    writeFileSync(join(root, 'old.txt'), 'x');
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, '.autosave'), { recursive: true });
    writeFileSync(join(root, 'projects/a.json'), 'A-old');
    writeFileSync(join(root, 'projects/b.json'), 'B-old');
    writeFileSync(join(root, 'projects/a.json.1.tmp'), 'A-new');
    writeFileSync(join(root, 'projects/b.json.1.tmp'), 'B-new');
    writeFileSync(
      join(root, '.autosave', 'pending.json'),
      JSON.stringify([
        { tmp: join(root, 'projects/a.json.1.tmp'), final: join(root, 'projects/a.json') },
        { tmp: join(root, 'projects/b.json.1.tmp'), final: join(root, 'projects/b.json') },
        { remove: join(root, 'old.txt') },
      ]),
    );
  };
  it('② の後（pending あり・rename 未実施）で落ちた → 起動時に全て新しい版へ進める', () => {
    stage();
    const r = recover(root);
    expect(r).toEqual({ completedTransaction: true, removedTmpFiles: 0 });
    expect([read('projects/a.json'), read('projects/b.json')]).toEqual(['A-new', 'B-new']);
    expect(existsSync(join(root, 'old.txt'))).toBe(false);
    expect(existsSync(join(root, '.autosave', 'pending.json'))).toBe(false);
  });
  it('③ の途中（1つだけ rename 済み）で落ちた → 残りも進めて、全て同じ版になる', () => {
    stage();
    writeFileSync(join(root, 'projects/a.json'), 'A-new'); // a は適用済み
    rmSync(join(root, 'projects/a.json.1.tmp'));
    recover(root);
    expect([read('projects/a.json'), read('projects/b.json')]).toEqual(['A-new', 'B-new']);
  });
  it('復旧は何度実行しても安全（冪等）', () => {
    stage();
    recover(root);
    expect(recover(root)).toEqual({ completedTransaction: false, removedTmpFiles: 0 });
    expect([read('projects/a.json'), read('projects/b.json')]).toEqual(['A-new', 'B-new']);
  });
  it('① の途中（pending なし・一時ファイルだけ）で落ちた → 全て古い版のまま、一時ファイルを片付ける', () => {
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'projects/a.json'), 'A-old');
    writeFileSync(join(root, 'projects/a.json.1.tmp'), 'A-new（書きかけ）');
    writeFileSync(join(root, 'projects/b.json.1.tmp'), '');
    const r = recover(root);
    expect(r).toEqual({ completedTransaction: false, removedTmpFiles: 2 });
    expect(read('projects/a.json')).toBe('A-old');
    expect(listTmp()).toEqual([]);
  });
  it('pending.json 自体が書きかけで壊れている → ③ は未開始なので捨てて、古い版のまま', () => {
    mkdirSync(join(root, '.autosave'), { recursive: true });
    writeFileSync(join(root, '.autosave', 'pending.json'), '[{"tmp": "x'); // 途中で切れた JSON
    writeFileSync(join(root, 'a.json'), 'A-old');
    expect(recover(root)).toEqual({ completedTransaction: false, removedTmpFiles: 0 });
    expect(read('a.json')).toBe('A-old');
    expect(existsSync(join(root, '.autosave', 'pending.json'))).toBe(false);
  });
  it('.git の中の .tmp は触らない', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'x.tmp'), 'keep');
    recover(root);
    expect(existsSync(join(root, '.git', 'x.tmp'))).toBe(true);
  });
});

describe('パスの安全性（ルートの外に書かない）', () => {
  it.each(['../evil.json', 'a/../../evil.json', '/abs.json', 'C:/abs.json', 'a\\b.json', '', './a.json', 'a//b.json'])('%s は拒否', (rel) => {
    expect(() => writeTransaction(root, { [rel]: 'x' })).toThrow('パス');
  });
  it('削除のパスも検証する', () => {
    expect(() => writeTransaction(root, {}, ['../x'])).toThrow('パス');
  });
  it('saveFiles は日程データ以外のパスを拒否する', () => {
    expect(() => saveFiles(root, { 'views/x.json': '{}' })).toThrow('保存できない');
    expect(() => saveFiles(root, { '.git/config': '' })).toThrow('保存できない');
  });
});

describe('saveFiles / loadFiles（ドメインとの結合）', () => {
  it('保存 → 読み込みで同じ Schedule になる', () => {
    const s = basic();
    saveFiles(root, serializeSchedule(s));
    const r = parseSchedule(loadFiles(root));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.schedule).toEqual(s);
  });
  it('変更のあったファイルだけを書く / 無くなったファイルを削除する / 他のファイルは触らない', () => {
    const s = basic();
    expect(saveFiles(root, serializeSchedule(s)).written).toHaveLength(5);
    writeFileSync(join(root, 'README.md'), '触らない');
    mkdirSync(join(root, 'views'), { recursive: true });
    writeFileSync(join(root, 'views', 'v.json'), '触らない');

    expect(saveFiles(root, serializeSchedule(s))).toEqual({ written: [], removed: [] }); // 変更なし
    const changed = { ...s, projects: { ...s.projects, A1: { ...s.projects['A1']!, name: '筐体2' } } };
    expect(saveFiles(root, serializeSchedule(changed))).toEqual({ written: ['projects/A1.json'], removed: [] });
    const { A1: _gone, ...rest } = changed.projects;
    void _gone;
    expect(saveFiles(root, serializeSchedule({ ...changed, projects: rest, dependencies: {} }))).toEqual({
      written: [],
      removed: ['dependencies/d1.json', 'projects/A1.json'],
    });
    expect(read('README.md')).toBe('触らない');
    expect(read('views/v.json')).toBe('触らない');
  });
  it('空のディレクトリからの読み込み', () => {
    expect(loadFiles(root)).toEqual({});
  });
});

describe('セッション（異常終了の検出。F-210/F-211）', () => {
  const put = (name: string, text: string): void => {
    writeFileSync(join(root, name), text);
  };
  it('正常な開始 → 終了では crashed にならず、開いた時点の内容を基準に保存する', () => {
    put('schedule.json', '{"schemaVersion":1}\n');
    expect(beginSession(root)).toEqual({ crashed: false, base: null });
    expect(existsSync(join(root, '.autosave', 'running'))).toBe(true);
    endSession(root);
    expect(existsSync(join(root, '.autosave', 'running'))).toBe(false);
    expect(beginSession(root).crashed).toBe(false);
  });
  it('終了せずに再度開くと crashed。基準は最後の正常な開始時点のまま', () => {
    put('schedule.json', '{"schemaVersion":1}\n');
    beginSession(root);
    saveFiles(root, { 'schedule.json': '{"schemaVersion":2}\n' }); // 編集が自動保存された
    const r = beginSession(root); // 強制終了後の起動
    expect(r.crashed).toBe(true);
    expect(r.base).toEqual({ 'schedule.json': '{"schemaVersion":1}\n' });
    // 連続して落ちても基準は更新されない
    expect(beginSession(root).base).toEqual(r.base);
  });
  it('基準が壊れていても落ちない（base は null）', () => {
    put('schedule.json', '{}\n');
    beginSession(root);
    writeFileSync(join(root, '.autosave', 'base.json'), '{broken');
    expect(beginSession(root)).toEqual({ crashed: true, base: null });
  });
});

describe('新規作成（F-501）', () => {
  it('空のフォルダには空の日程データを作り、読み込める', () => {
    const files = serializeSchedule(emptySchedule());
    expect(createEmpty(root, files)).toEqual({ ok: true });
    const parsed = parseSchedule(loadFiles(root));
    expect(parsed.status).toBe('ok');
  });
  it('.git だけがあるフォルダは空として扱う', () => {
    mkdirSync(join(root, '.git'));
    expect(createEmpty(root, serializeSchedule(emptySchedule()))).toEqual({ ok: true });
  });
  it('中身があるフォルダには作らず、何も書かない', () => {
    writeFileSync(join(root, 'memo.txt'), 'x');
    expect(createEmpty(root, serializeSchedule(emptySchedule()))).toEqual({ ok: false, reason: 'not-empty' });
    expect(existsSync(join(root, 'schedule.json'))).toBe(false);
  });
});

describe('標準日程のファイル（F-801, F-807）', () => {
  it('日程の保存では消されず、読み込みに含まれる。個別に保存・削除できる', () => {
    saveFiles(root, serializeSchedule(basic()));
    saveTemplate(root, 't1', '{"id":"t1"}\n');
    expect(loadFiles(root)['templates/t1.json']).toBe('{"id":"t1"}\n');
    saveFiles(root, serializeSchedule(basic())); // 自動保存（標準日程を含まない）
    expect(existsSync(join(root, 'templates/t1.json'))).toBe(true);
    deleteTemplate(root, 't1');
    expect(existsSync(join(root, 'templates/t1.json'))).toBe(false);
    deleteTemplate(root, 't1'); // 無くても失敗しない
  });
});
