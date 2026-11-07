// @req NF-005, F-506
// 実際の Git で、整形出力した JSON が自動マージできるか（できないのはどの場合か）を確認する。
// 「1プロジェクト1ファイル・IDキーのオブジェクト・1フィールド1行」の設計（data-model 2, 11）の根拠。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../../src/domain/commands';
import type { Schedule } from '../../src/domain/model';
import { serializeSchedule } from '../../src/domain/serialize';
import { saveFiles } from '../../src/main/fileRepository';
import { dep, ev, ms, proj, schedule } from '../domain/fixtures';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
};

/** 10 イベントを持つプロジェクト（e00〜e09）。IDは昇順に並ぶので、追加位置を制御しやすい。 */
function base(): Schedule {
  const events = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`e${String(i * 2).padStart(2, '0')}`, ev(`イベント${i}`, `2026-0${(i % 9) + 1}-01`, `2026-0${(i % 9) + 1}-10`)]));
  return schedule(
    [proj('A', { name: 'A', events, milestones: { m00: ms('M', '2026-12-01') } }), proj('B', { name: 'B', order: 'j', events: { b00: ev('b', '2026-01-01', '2026-01-31') } })],
    [dep('d00', ['event', 'e00'], ['event', 'e02'])],
  );
}

let root: string;
let a: string;
let b: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '-b', 'main', remote);
  a = join(root, 'A');
  b = join(root, 'B');
  git(root, 'clone', remote, a);
  saveFiles(a, serializeSchedule(base()));
  git(a, 'add', '-A');
  git(a, 'commit', '-m', 'init');
  git(a, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, b);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A と B がそれぞれコマンドを適用して commit し、B が A の変更を取り込む（merge）。 */
function mergeOutcome(cmdsA: Command[], cmdsB: Command[]): { clean: boolean; conflicted: string[] } {
  const edit = (dir: string, cmds: Command[]): void => {
    let cur = base();
    for (const c of cmds) {
      const r = applyCommand(cur, c);
      if (!r.ok) throw new Error(r.error.message);
      cur = r.schedule;
    }
    saveFiles(dir, serializeSchedule(cur));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'edit');
  };
  edit(a, cmdsA);
  git(a, 'push', 'origin', 'main');
  edit(b, cmdsB);
  git(b, 'fetch', 'origin');
  const m = git(b, 'merge', '--no-edit', 'origin/main');
  const conflicted = m.ok ? [] : git(b, 'diff', '--name-only', '--diff-filter=U').out.trim().split('\n');
  return { clean: m.ok, conflicted };
}

const upd = (id: string, patch: object): Command => ({ type: 'updateEvent', id, patch });
const addEv = (id: string, projectId = 'A'): Command => ({ type: 'addEvent', projectId, id, event: ev(`新${id}`, '2027-01-01', '2027-01-31') });

describe('実際の git でのマージ（整形出力した JSON）', () => {
  it('別々のプロジェクトを編集 → 自動マージできる（ファイルが別）', () => {
    expect(mergeOutcome([upd('e00', { name: 'A側' })], [upd('b00', { name: 'B側' })])).toEqual({ clean: true, conflicted: [] });
  });

  it('同じプロジェクトの、離れたイベントを編集 → 自動マージできる', () => {
    expect(mergeOutcome([upd('e02', { start: '2026-02-05' })], [upd('e16', { end: '2026-09-20' })])).toEqual({ clean: true, conflicted: [] });
  });

  it('同じイベントの、離れたフィールドを編集（名称と種別）→ 自動マージできる', () => {
    // キーは昇順（end, name, start, type）。name と type の間には start があり、行が隣り合わない
    expect(mergeOutcome([upd('e04', { name: '改名' })], [upd('e04', { type: 'review' })])).toEqual({ clean: true, conflicted: [] });
  });

  it('同じイベントの、隣り合うフィールドを編集（終了日と名称）→ Git は競合とみなす（実測）。アプリが項目単位で自動解決する', () => {
    // 異なるフィールドの変更なので、意味の上では衝突していない。行が隣り合うため Git の行単位マージでは競合になる。
    // → 競合解決（F-506）は、Git の競合マーカーではなく base / 自分 / 相手の3版を項目単位で比較し、
    //    重ならない変更は自動で取り込む（docs/git-ux.html 2.3）。
    expect(mergeOutcome([upd('e04', { name: '改名' })], [upd('e04', { end: '2026-03-20' })])).toEqual({ clean: false, conflicted: ['projects/A.json'] });
  });

  it('同じイベントの同じ日付を、別の値に変更 → 競合する（アプリの競合解決 UI で解決する。F-506）', () => {
    const r = mergeOutcome([upd('e04', { end: '2026-03-15' })], [upd('e04', { end: '2026-03-20' })]);
    expect(r).toEqual({ clean: false, conflicted: ['projects/A.json'] });
  });

  it('同じプロジェクトに、離れた位置へ新しいイベントを追加 → 自動マージできる', () => {
    expect(mergeOutcome([addEv('e03')], [addEv('e15')])).toEqual({ clean: true, conflicted: [] });
  });

  it('既存のイベントを挟んだ別々の隙間への追加（e03 と e05）→ 自動マージできる（Git 2.55 での実測）', () => {
    expect(mergeOutcome([addEv('e03')], [addEv('e05')])).toEqual({ clean: true, conflicted: [] });
  });

  it('末尾への追加どうし（イベントIDが全ての既存より後ろ）→ 直前の行のカンマが変わるため競合する（実測）', () => {
    expect(mergeOutcome([addEv('e30')], [addEv('e31')])).toEqual({ clean: false, conflicted: ['projects/A.json'] });
  });

  it('依存の追加と、別プロジェクトの編集 → 自動マージできる（依存は1つ1ファイル）', () => {
    expect(mergeOutcome([{ type: 'addDependency', dependency: dep('d01', ['event', 'e04'], ['event', 'e06']) }], [upd('b00', { name: 'B側' })])).toEqual({ clean: true, conflicted: [] });
  });

  it('2つの依存を別々に追加 → 自動マージできる（別ファイル）', () => {
    expect(
      mergeOutcome(
        [{ type: 'addDependency', dependency: dep('d01', ['event', 'e04'], ['event', 'e06']) }],
        [{ type: 'addDependency', dependency: dep('d02', ['event', 'e08'], ['event', 'e10']) }],
      ),
    ).toEqual({ clean: true, conflicted: [] });
  });

  it('同じ名前のプロジェクトを別IDで追加 → ファイルが別なので自動マージできる', () => {
    expect(
      mergeOutcome(
        [{ type: 'addProject', project: proj('C1', { name: '新規', order: 'k' }) }],
        [{ type: 'addProject', project: proj('C2', { name: '新規', order: 'l' }) }],
      ),
    ).toEqual({ clean: true, conflicted: [] });
  });

  it('プロジェクトの並べ替え（order）と、そのプロジェクトのイベント編集 → 自動マージできる', () => {
    expect(mergeOutcome([{ type: 'moveProject', id: 'B', parentId: null, order: 'k' }], [upd('b00', { name: 'B側' })])).toEqual({ clean: true, conflicted: [] });
  });
});
