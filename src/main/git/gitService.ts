// @req F-502, F-504, F-522, F-523, NF-003
// GitService: 解決済みの Git 実行ファイル（外部 / 同梱）だけを使い、Git の操作を業務の言葉の操作に包む。main 層のみ。
// 方針（docs/architecture.html 3.5）: execFile / spawn に引数配列で渡す（シェル経由禁止）。GIT_TERMINAL_PROMPT=0。
// 認証情報は設定・引数・ログに残さない（認証は Git Credential Manager に任せる）。
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isKnown } from '../fileRepository';

export type GitSource = 'external' | 'bundled';
export type Version = readonly [number, number, number];

export interface GitInfo {
  readonly path: string;
  readonly version: Version;
  readonly source: GitSource;
}

/** 使用するコマンド（merge-tree --write-tree など）に必要な最低バージョン（architecture 3.5）。 */
export const MIN_GIT_VERSION: Version = [2, 38, 0];

export function parseGitVersion(text: string): Version | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const atLeast = (v: Version, min: Version): boolean => v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];

function probe(path: string): Version | null {
  try {
    return parseGitVersion(execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true }));
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** 利用者が指定した外部 Git のパス。 */
  readonly configuredPath?: string;
  /** 同梱 Git のパス（無ければ null / 未指定）。 */
  readonly bundledPath?: string | null;
  readonly minVersion?: Version;
}

/**
 * Git の解決順（F-522）: ①利用者が指定した外部 Git ②PATH 上の git（Windows は Git for Windows の既定場所も探索）③同梱 Git。
 * 外部が最低バージョン未満・見つからない場合は同梱にフォールバックする。使える Git が無ければ null。
 */
export function resolveGit(o: ResolveOptions): GitInfo | null {
  const min = o.minVersion ?? MIN_GIT_VERSION;
  const external = [
    ...(o.configuredPath ? [o.configuredPath] : []),
    'git',
    ...(process.platform === 'win32' ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'] : []),
  ];
  for (const path of external) {
    const version = probe(path);
    if (version && atLeast(version, min)) return { path, version, source: 'external' };
  }
  if (o.bundledPath) {
    const version = probe(o.bundledPath);
    if (version && atLeast(version, MIN_GIT_VERSION)) return { path: o.bundledPath, version, source: 'bundled' }; // 同梱は常に既定の下限で判定
  }
  return null;
}

export interface RunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export type Files = Record<string, string>;

export interface GitState {
  readonly isRepo: boolean;
  /** 現在の作業版（ブランチ）名。履歴が無い・リポジトリでないときは null。 */
  readonly branch: string | null;
  /** 保存していない変更がある（日程データのファイルが HEAD と違う）。 */
  readonly dirty: boolean;
  /** 最後に保存した版の日程データ。履歴が無ければ null。 */
  readonly head: Files | null;
}

export type SaveStatus = { readonly status: 'ok'; readonly hash: string } | { readonly status: 'nothing' } | { readonly status: 'identity-required' } | { readonly status: 'error'; readonly message: string };

export interface LogEntry {
  readonly hash: string;
  readonly date: string;
  readonly author: string;
  readonly message: string;
}

export interface DiagItem {
  readonly key: 'git' | 'repo' | 'identity' | 'remote' | 'connection';
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SaveOptions {
  /** テスト用: 利用者のグローバル設定（名前・メール）を無視する。 */
  readonly ignoreGlobalIdentity?: boolean;
}

const COMMON = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'];

// 親の git（フック内など）から引き継いだ環境変数は、対象のリポジトリ・作者・インデックスを上書きしてしまうので使わない
const INHERITED = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|AUTHOR_.*|COMMITTER_.*)$/;
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
}

export class GitService {
  constructor(
    private readonly git: GitInfo,
    private readonly root: string,
  ) {}

  get info(): GitInfo {
    return this.git;
  }

  /** git を実行する。background = 起動時・定期の処理（認証画面を出さずに失敗させる）。 */
  run(args: readonly string[], o: { input?: string | Buffer; background?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(o.background ? { GCM_INTERACTIVE: 'never' } : {}), ...o.env };
    return new Promise((resolve) => {
      const child = spawn(this.git.path, [...COMMON, ...args], { cwd: this.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : null;
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e) => resolve({ ok: false, code: null, stdout: Buffer.alloc(0), stderr: String(e) }));
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.input);
    });
  }

  private async text(args: readonly string[], o?: Parameters<GitService['run']>[1]): Promise<string | null> {
    const r = await this.run(args, o);
    return r.ok ? r.stdout.toString('utf8').trim() : null;
  }

  async isRepo(): Promise<boolean> {
    return (await this.text(['rev-parse', '--is-inside-work-tree'])) === 'true' && existsSync(join(this.root, '.git'));
  }

  /** 新規作成。作業版の名前は main。 */
  async init(): Promise<void> {
    const r = await this.run(['init', '-b', 'main']);
    if (!r.ok) throw new Error(r.stderr);
    this.ensureExcluded();
  }

  /** 自動保存の作業用フォルダは Git の対象外にする（リポジトリ内の除外設定。共有されない）。 */
  private ensureExcluded(): void {
    const file = join(this.root, '.git', 'info', 'exclude');
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (cur.split(/\r?\n/).includes('.autosave/')) return;
    mkdirSync(join(this.root, '.git', 'info'), { recursive: true });
    appendFileSync(file, `${cur === '' || cur.endsWith('\n') ? '' : '\n'}.autosave/\n`);
  }

  private async hasCommits(): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '-q', 'HEAD'])).ok;
  }

  async state(): Promise<GitState> {
    if (!(await this.isRepo())) return { isRepo: false, branch: null, dirty: false, head: null };
    this.ensureExcluded();
    const branch = await this.text(['symbolic-ref', '--short', '-q', 'HEAD']);
    const dirty = ((await this.text(['status', '--porcelain']))?.length ?? 0) > 0;
    const head = (await this.hasCommits()) ? await this.filesAt('HEAD') : null;
    return { isRepo: true, branch, dirty, head };
  }

  /** 指定した版（コミット）の日程データのファイルを全て読む。 */
  async filesAt(ref: string): Promise<Files> {
    if (!/^[0-9A-Za-z_./-]+$/.test(ref) || ref.startsWith('-')) throw new Error(`不正な指定: ${ref}`);
    const ls = await this.run(['ls-tree', '-r', '-z', '--name-only', ref]);
    if (!ls.ok) throw new Error(ls.stderr);
    const paths = ls.stdout.toString('utf8').split('\0').filter((p) => p !== '' && isKnown(p));
    if (paths.length === 0) return {};
    // 1 回の cat-file --batch でまとめて読む（ファイル数ぶんプロセスを起動しない）
    const batch = await this.run(['cat-file', '--batch'], { input: paths.map((p) => `${ref}:${p}\n`).join('') });
    if (!batch.ok) throw new Error(batch.stderr);
    const buf = batch.stdout;
    const files: Files = {};
    let pos = 0;
    for (const p of paths) {
      const nl = buf.indexOf(0x0a, pos);
      const header = buf.subarray(pos, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (header[1] !== 'blob' || !Number.isFinite(size)) throw new Error(`読み取れないファイル: ${p}`);
      files[p] = buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
      pos = nl + 1 + size + 1;
    }
    return files;
  }

  async log(limit: number): Promise<LogEntry[]> {
    if (!(await this.hasCommits())) return [];
    const r = await this.run(['log', `-n${Math.max(1, Math.floor(limit))}`, '--format=%H%x1f%aI%x1f%an%x1f%s%x1e']);
    if (!r.ok) return [];
    return r.stdout
      .toString('utf8')
      .split('\x1e')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [hash = '', date = '', author = '', message = ''] = x.split('\x1f');
        return { hash, date, author, message };
      });
  }

  /**
   * 変更を保存する（= 全ての変更を 1 つの版として記録）。変更が無ければ nothing。
   * 名前・メールが未設定なら identity-required（identity を渡せばこのリポジトリに設定して保存する）。
   */
  async save(message: string, identity?: Identity, o: SaveOptions = {}): Promise<SaveStatus> {
    const env: NodeJS.ProcessEnv = o.ignoreGlobalIdentity ? { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {};
    if (identity) {
      for (const [k, v] of [['user.name', identity.name], ['user.email', identity.email]] as const) {
        const r = await this.run(['config', '--local', k, v], { env });
        if (!r.ok) return { status: 'error', message: r.stderr };
      }
    }
    const has = async (k: string): Promise<boolean> => ((await this.text(['config', k], { env })) ?? '') !== '';
    if (!(await has('user.name')) || !(await has('user.email'))) return { status: 'identity-required' };
    this.ensureExcluded();
    const add = await this.run(['add', '-A'], { env });
    if (!add.ok) return { status: 'error', message: add.stderr };
    if ((await this.run(['diff', '--cached', '--quiet'], { env })).ok) return { status: 'nothing' };
    const c = await this.run(['commit', '-m', message], { env });
    if (!c.ok) return { status: 'error', message: c.stderr || c.stdout.toString('utf8') };
    return { status: 'ok', hash: (await this.text(['rev-parse', 'HEAD'], { env })) ?? '' };
  }

  /** Git 環境の診断（F-523）。問題と対処を項目別に返す。接続テストは認証画面を出さない。 */
  async diagnose(): Promise<DiagItem[]> {
    const items: DiagItem[] = [];
    const v = this.git.version.join('.');
    items.push({ key: 'git', label: 'Git', ok: true, detail: `${this.git.source === 'bundled' ? '同梱' : '外部'}の Git ${v}（${this.git.path}）` });
    const repo = await this.isRepo();
    items.push({ key: 'repo', label: 'データの場所', ok: repo, detail: repo ? this.root : 'このフォルダはまだ版管理されていません（新規作成するか、共有先から取得してください）' });
    if (repo) {
      this.ensureExcluded();
      const named = ((await this.text(['config', 'user.name'])) ?? '') !== '' && ((await this.text(['config', 'user.email'])) ?? '') !== '';
      items.push({ key: 'identity', label: '名前とメール', ok: named, detail: named ? '設定済み' : '保存するときに入力してください' });
      const remote = (await this.text(['remote'])) ?? '';
      items.push({ key: 'remote', label: '共有先', ok: remote !== '', detail: remote !== '' ? remote.split('\n').join(', ') : '共有先は未設定です（編集と保存はできます）' });
      if (remote !== '') {
        const r = await this.run(['ls-remote', '--exit-code', remote.split('\n')[0]!, 'HEAD'], { background: true, timeoutMs: 20_000 });
        items.push({ key: 'connection', label: '共有先への接続', ok: r.ok, detail: r.ok ? '接続できました' : '接続できません。サインインが必要か、ネットワークに接続されていない可能性があります' });
      }
    }
    return items;
  }
}
