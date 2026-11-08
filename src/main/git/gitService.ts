// @req F-502, F-504, F-508, F-513, F-517, F-518, F-520, F-522, F-523, NF-003
// GitService: 解決済みの Git 実行ファイル（外部 / 同梱）だけを使い、Git の操作を業務の言葉の操作に包む。main 層のみ。
// 方針（docs/architecture.html 3.5）: execFile / spawn に引数配列で渡す（シェル経由禁止）。GIT_TERMINAL_PROMPT=0。
// 認証情報は設定・引数・ログに残さない（認証は Git Credential Manager に任せる）。
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CALENDAR_PATH } from '../../domain/calendar';
import { TEMPLATE_PATH_RE } from '../../domain/template';
import { deleteTemplate, isKnown, saveCalendar, saveFiles, saveTemplate } from '../fileRepository';

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
  readonly hasRemote: boolean;
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


export interface WorkVersion {
  /** 内部名（work/yyyymmdd-xxxx）。 */
  readonly name: string;
  /** 表示名（日本語）。 */
  readonly display: string;
  readonly date: string;
  /** 正式版より先に進んでいる履歴の件数。 */
  readonly ahead: number;
}

export type MergeInputs =
  | { readonly status: 'dirty' }
  | { readonly status: 'up-to-date' }
  | {
      readonly status: 'merge';
      /** work = 作業版に正式版の最新を取り込む / main = 正式版の直接編集に共有先の更新を取り込む。 */
      readonly mode: 'work' | 'main';
      readonly theirsRef: string;
      /** 自分側に変更が無く、相手側へそのまま進めるだけ。 */
      readonly fastForward: boolean;
      readonly base: Files;
      readonly ours: Files;
      readonly theirs: Files;
    };

export type OpResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export type ReflectStatus =
  | { readonly status: 'ok' }
  | { readonly status: 'dirty' }
  | { readonly status: 'outdated' }
  | { readonly status: 'rejected' }
  | { readonly status: 'identity-required' }
  | { readonly status: 'error'; readonly message: string };

const BRANCH_RE = /^(main|work\/[0-9A-Za-z_-]+)$/;
const REF_RE = /^[0-9A-Za-z_./-]+$/;
const REJECTED = /rejected|non-fast-forward|fetch first|failed to push some refs/i;
const APP_IDENT: NodeJS.ProcessEnv = { GIT_AUTHOR_NAME: 'app', GIT_AUTHOR_EMAIL: 'app@localhost', GIT_COMMITTER_NAME: 'app', GIT_COMMITTER_EMAIL: 'app@localhost' };

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
    if (!(await this.isRepo())) return { isRepo: false, branch: null, dirty: false, head: null, hasRemote: false };
    this.ensureExcluded();
    const branch = await this.text(['symbolic-ref', '--short', '-q', 'HEAD']);
    const dirty = ((await this.text(['status', '--porcelain']))?.length ?? 0) > 0;
    const head = (await this.hasCommits()) ? await this.filesAt('HEAD') : null;
    return { isRepo: true, branch, dirty, head, hasRemote: await this.hasRemote() };
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

  /** ある版と、その 1 つ前の版（最初の版なら null）の日程データ。履歴の変更要約・版の比較に使う（F-510, F-505）。 */
  async commitChange(hash: string): Promise<{ before: Files | null; after: Files }> {
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error(`不正な指定: ${hash}`);
    const parent = await this.rev(`${hash}^`); // 親が無い（最初の版）なら null。マージは最初の親
    return { before: parent ? await this.filesAt(parent) : null, after: await this.filesAt(hash) };
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

  // ---- 共有先 ----
  async hasRemote(): Promise<boolean> {
    return ((await this.text(['remote'])) ?? '') !== '';
  }

  /** 共有先（origin）を設定する。 */
  async setRemote(url: string): Promise<OpResult> {
    if (url.trim() === '' || url.startsWith('-')) return { ok: false, message: '共有先の指定が正しくありません' };
    const r = (await this.hasRemote()) ? await this.run(['remote', 'set-url', 'origin', '--', url]) : await this.run(['remote', 'add', 'origin', '--', url]);
    return r.ok ? { ok: true } : { ok: false, message: r.stderr };
  }

  /** 共有先から取得する（F-501 の (a)）。dest は存在しないか空のフォルダ。 */
  static async clone(git: GitInfo, url: string, dest: string): Promise<OpResult> {
    if (url.trim() === '' || url.startsWith('-')) return { ok: false, message: '共有先の指定が正しくありません' };
    mkdirSync(dirname(dest), { recursive: true });
    const r = await new GitService(git, dirname(dest)).run(['clone', '--', url, dest]);
    return r.ok ? { ok: true } : { ok: false, message: r.stderr };
  }

  /** 履歴がまだ無いとき、最初の版を載せる版の名前を main にする（空の共有先を取得した直後など。共有先の既定の名前に依らない）。 */
  async ensureMainBranch(): Promise<void> {
    if (await this.hasCommits()) return;
    await this.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }

  /** 共有先の最新を取得する。共有先が無ければ何もしない。利用者の操作として実行するので、認証が必要ならブラウザでのサインインが出る。 */
  async fetch(): Promise<OpResult> {
    if (!(await this.hasRemote())) return { ok: true };
    const r = await this.run(['fetch', 'origin'], { timeoutMs: 120_000 });
    return r.ok ? { ok: true } : { ok: false, message: r.stderr };
  }

  /** 正式版の最新の参照（共有先があればそれ、なければ手元の main）。 */
  private async mainRef(): Promise<string> {
    return (await this.run(['rev-parse', '--verify', '-q', 'refs/remotes/origin/main'])).ok ? 'origin/main' : 'main';
  }

  private async rev(ref: string): Promise<string | null> {
    return this.text(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', a, b])).ok;
  }

  // ---- 作業版（F-513, F-514, F-515）----
  async workVersions(): Promise<WorkVersion[]> {
    const r = await this.text(['for-each-ref', '--format=%(refname:short)%1f%(committerdate:iso-strict)', 'refs/heads/work/']);
    if (!r) return [];
    const main = await this.mainRef();
    const out: WorkVersion[] = [];
    for (const line of r.split('\n')) {
      const [name = '', date = ''] = line.split('\x1f');
      if (!BRANCH_RE.test(name)) continue;
      const display = (await this.text(['config', '--get', `branch.${name}.description`])) || name;
      const ahead = Number((await this.text(['rev-list', '--count', `${main}..${name}`])) ?? 0);
      out.push({ name, display, date, ahead });
    }
    return out.sort((x, y) => (x.date < y.date ? 1 : -1));
  }

  /** 保存前の変更を、この版の名前で退避する（refs/app/pending/<版>）。作業ツリーはきれいになる。 */
  private async stashPending(branch: string): Promise<string | null> {
    if (((await this.text(['status', '--porcelain'])) ?? '') === '') return null;
    const r = await this.run(['stash', 'push', '-u', '-m', 'app-pending'], { env: APP_IDENT });
    if (!r.ok) return r.stderr;
    const h = await this.text(['rev-parse', 'refs/stash']);
    if (!h) return '変更を退避できませんでした';
    const u = await this.run(['update-ref', `refs/app/pending/${branch}`, h]);
    if (!u.ok) return u.stderr;
    await this.run(['stash', 'drop'], { env: APP_IDENT });
    return null;
  }

  /** 退避してあった変更を戻す。 */
  private async restorePending(branch: string): Promise<string | null> {
    const ref = `refs/app/pending/${branch}`;
    const h = await this.text(['rev-parse', '--verify', '-q', ref]);
    if (!h) return null;
    const r = await this.run(['stash', 'apply', h], { env: APP_IDENT });
    if (!r.ok) return r.stderr;
    await this.run(['update-ref', '-d', ref]);
    return null;
  }

  private async currentBranch(): Promise<string | null> {
    return this.text(['symbolic-ref', '--short', '-q', 'HEAD']);
  }

  /** 作業版を作る。正式版の最新から作り、以後その作業版で編集する。保存前の変更は元の版に退避する。 */
  async createWork(display: string): Promise<OpResult & { name?: string }> {
    const label = display.trim();
    if (label === '') return { ok: false, message: '作業版の名前を入力してください' };
    if (!(await this.hasCommits())) return { ok: false, message: '先に最初の変更を履歴に残してください' };
    const cur = (await this.currentBranch()) ?? 'main';
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const name = `work/${ymd}-${Math.random().toString(36).slice(2, 6)}`;
    await this.fetch(); // 正式版の最新を取得してから作る（取得できなければ手元の最新から）
    const base = await this.mainRef();
    const err = await this.stashPending(cur);
    if (err) return { ok: false, message: err };
    const c = await this.run(['checkout', '--no-track', '-b', name, base]);
    if (!c.ok) {
      await this.restorePending(cur);
      return { ok: false, message: c.stderr };
    }
    await this.run(['config', `branch.${name}.description`, label]);
    return { ok: true, name };
  }

  /** 版を切り替える（正式版 = main / 作業版）。保存前の変更は自動で退避し、戻ったときに復元する。 */
  async switchTo(target: string): Promise<OpResult> {
    if (!BRANCH_RE.test(target)) return { ok: false, message: '切り替え先が正しくありません' };
    const cur = await this.currentBranch();
    if (cur === target) return { ok: true };
    const err = await this.stashPending(cur ?? 'main');
    if (err) return { ok: false, message: err };
    const c = await this.run(['checkout', target]);
    if (!c.ok) {
      if (cur) await this.restorePending(cur);
      return { ok: false, message: c.stderr };
    }
    const back = await this.restorePending(target);
    return back ? { ok: false, message: back } : { ok: true };
  }

  // ---- 取り込みと反映（F-511, F-517, F-518, F-506）----
  /**
   * 取り込みの材料（3 版）。作業版なら正式版の最新、正式版の直接編集なら共有先の最新を相手にする。
   * 保存前の変更があれば dirty（先に履歴に残す）。マージそのものはドメイン層の mergeSchedules が行う。
   */
  async mergeInputs(): Promise<MergeInputs> {
    if (((await this.text(['status', '--porcelain'])) ?? '') !== '') return { status: 'dirty' };
    const cur = await this.currentBranch();
    if (!cur) return { status: 'up-to-date' };
    const mode = cur === 'main' ? 'main' : 'work';
    const theirsRef = await this.mainRef();
    if (mode === 'main' && theirsRef === 'main') return { status: 'up-to-date' }; // 共有先が無い
    if (await this.isAncestor(theirsRef, 'HEAD')) return { status: 'up-to-date' };
    const fastForward = await this.isAncestor('HEAD', theirsRef);
    const baseHash = await this.text(['merge-base', 'HEAD', theirsRef]);
    if (!baseHash) throw new Error('共通の履歴が見つかりません');
    return { status: 'merge', mode, theirsRef, fastForward, base: await this.filesAt(baseHash), ours: await this.filesAt('HEAD'), theirs: await this.filesAt(theirsRef) };
  }

  /**
   * 標準日程（templates/）とカレンダー（calendar.json）は項目ごとの比較をせず、ファイル単位で 3 版を合わせる: 自分が変えていなければ相手の版、
   * 相手が変えていなければ自分の版、双方が別々に変えたら自分の版を残す。
   * ponytail: 双方が同じ標準日程を変えた場合は自分の版が勝つ（相手の変更は履歴に残る）。競合の解決 UI は R5 で検討。
   */
  private async mergeTemplates(theirsRef: string): Promise<void> {
    const baseHash = await this.text(['merge-base', 'HEAD', theirsRef]);
    if (!baseHash) return;
    const [b, o, t] = [await this.filesAt(baseHash), await this.filesAt('HEAD'), await this.filesAt(theirsRef)];
    const paths = new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)].filter((p) => TEMPLATE_PATH_RE.test(p) || p === CALENDAR_PATH));
    for (const p of paths) {
      const [bv, ov, tv] = [b[p], o[p], t[p]];
      const result = ov === tv ? ov : ov === bv ? tv : tv === bv ? ov : ov;
      if (result === ov) continue;
      if (p === CALENDAR_PATH) {
        if (result !== undefined) saveCalendar(this.root, result); // 削除はしない（設定の既定に戻るだけ）
        continue;
      }
      const id = p.slice('templates/'.length, -'.json'.length);
      if (result === undefined) deleteTemplate(this.root, id);
      else saveTemplate(this.root, id, result);
    }
  }

  /** 正式版の最新（共有先があればそれ）の日程データ。 */
  async mainFiles(): Promise<Files> {
    return this.filesAt(await this.mainRef());
  }

  private async hasIdentity(): Promise<boolean> {
    return ((await this.text(['config', 'user.name'])) ?? '') !== '' && ((await this.text(['config', 'user.email'])) ?? '') !== '';
  }

  private async setIdentity(identity: Identity): Promise<string | null> {
    for (const [k, v] of [['user.name', identity.name], ['user.email', identity.email]] as const) {
      const r = await this.run(['config', '--local', k, v]);
      if (!r.ok) return r.stderr;
    }
    return null;
  }

  /**
   * マージ結果（merged = ドメイン層が作った全ファイル）を、相手の履歴を取り込んだ 1 つの版として記録する。
   * Git の競合状態は作らない（-s ours --no-commit で履歴だけ結び、内容は結果で置き換える）。自分側に変更が無ければ早送り。
   */
  async completeMerge(merged: Files, theirsRef: string, message: string, identity?: Identity): Promise<ReflectStatus> {
    if (!REF_RE.test(theirsRef) || theirsRef.startsWith('-')) return { status: 'error', message: '指定が正しくありません' };
    if (await this.isAncestor('HEAD', theirsRef)) {
      const ff = await this.run(['merge', '--ff-only', theirsRef]);
      return ff.ok ? { status: 'ok' } : { status: 'error', message: ff.stderr };
    }
    if (identity) {
      const e = await this.setIdentity(identity);
      if (e) return { status: 'error', message: e };
    }
    if (!(await this.hasIdentity())) return { status: 'identity-required' };
    const m = await this.run(['merge', '-s', 'ours', '--no-ff', '--no-commit', theirsRef]);
    if (!m.ok) return { status: 'error', message: m.stderr || m.stdout.toString('utf8') };
    try {
      saveFiles(this.root, merged);
      await this.mergeTemplates(theirsRef);
      const add = await this.run(['add', '-A']);
      const commit = add.ok ? await this.run(['commit', '-m', message]) : add;
      if (!commit.ok) throw new Error(commit.stderr || commit.stdout.toString('utf8'));
    } catch (e) {
      await this.run(['merge', '--abort']);
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    return { status: 'ok' };
  }

  /**
   * 作業版を正式版へ反映する。作業版が正式版の最新を取り込み済みであること（outdated なら取り込み直す）。
   * 反映は --no-ff のマージコミット（作業版の履歴を残す）。元に戻す用の退避参照を作ってから送信し、拒否されたら何も変えない。
   */
  async finishReflect(display: string, identity?: Identity): Promise<ReflectStatus> {
    if (((await this.text(['status', '--porcelain'])) ?? '') !== '') return { status: 'dirty' };
    const cur = await this.currentBranch();
    if (!cur || cur === 'main') return { status: 'error', message: '作業版を開いて操作してください' };
    if (identity) {
      const e = await this.setIdentity(identity);
      if (e) return { status: 'error', message: e };
    }
    if (!(await this.hasIdentity())) return { status: 'identity-required' };
    const tip = await this.rev(await this.mainRef());
    if (!tip) return { status: 'error', message: '正式版が見つかりません' };
    if (!(await this.isAncestor(tip, 'HEAD'))) return { status: 'outdated' };
    const c = await this.run(['commit-tree', 'HEAD^{tree}', '-p', tip, '-p', 'HEAD', '-m', `反映: ${display}`]);
    const commit = c.stdout.toString('utf8').trim();
    if (!c.ok || commit === '') return { status: 'error', message: c.stderr };
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    await this.run(['update-ref', `refs/app/backup/${stamp}`, tip]);
    if (await this.hasRemote()) {
      const p = await this.run(['push', 'origin', `${commit}:refs/heads/main`], { timeoutMs: 120_000 });
      if (!p.ok) return REJECTED.test(p.stderr) ? { status: 'rejected' } : { status: 'error', message: p.stderr };
      await this.run(['update-ref', 'refs/remotes/origin/main', commit]);
    }
    const u = await this.run(['update-ref', 'refs/heads/main', commit]);
    return u.ok ? { status: 'ok' } : { status: 'error', message: u.stderr };
  }

  /** 正式版を直接編集しているとき、共有先へ送る（共有する）。拒否されたら取り込み直す。 */
  async push(): Promise<ReflectStatus> {
    if (!(await this.hasRemote())) return { status: 'error', message: '共有先が設定されていません' };
    const p = await this.run(['push', '-u', 'origin', 'main'], { timeoutMs: 120_000 });
    if (p.ok) return { status: 'ok' };
    return REJECTED.test(p.stderr) ? { status: 'rejected' } : { status: 'error', message: p.stderr };
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
