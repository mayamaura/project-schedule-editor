// @req NF-004, NF-018, F-210, F-211
// FileRepository: 日程データのファイル入出力（Node のファイルシステム。main 層のみ）。
// 方針（docs/architecture.html 8, 9.3 で検証済み）:
//   ・書き込みは「同じ場所の一時ファイル → fsync → rename」の原子的置換（途中で落ちても旧版か新版のどちらかが残る）
//   ・複数ファイルの更新は pending.json（意図の記録）を先に書き、起動時に先へ進める（roll-forward）ことで全て同一版にそろえる
// ドメイン層（純関数）が作る「パス → 内容」を受け渡すだけで、データの意味は知らない。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CALENDAR_PATH } from '../domain/calendar';
import { TEMPLATE_PATH_RE, templatePath } from '../domain/template';

export type Files = Record<string, string>;

const AUTOSAVE_DIR = '.autosave';
const PENDING = 'pending.json';

type Entry = { readonly tmp: string; readonly final: string } | { readonly remove: string };

/** データのルートからの相対パスを検証して絶対パスにする（.. や絶対パスでルートの外に出さない）。 */
function resolveInside(root: string, rel: string): string {
  if (rel === '' || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`不正なパス: ${rel}`);
  }
  const abs = resolve(root, rel);
  if (!abs.startsWith(resolve(root) + sep)) throw new Error(`ルートの外のパス: ${rel}`);
  return abs;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows ではウイルス対策ソフトなどが一瞬ファイルを掴み、rename が失敗することがある。短く再試行する。
function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      sleepSync(10);
    }
  }
}

function writeTmp(file: string, text: string | Buffer): string {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    if (typeof text === 'string') writeSync(fd, text);
    else for (let off = 0; off < text.length; ) off += writeSync(fd, text, off, text.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** 1ファイルの原子的な書き込み（一時ファイル → fsync → rename）。 */
export function writeAtomic(file: string, text: string | Buffer): void {
  renameRetry(writeTmp(file, text), file);
}

function pendingPath(root: string): string {
  return join(root, AUTOSAVE_DIR, PENDING);
}

/**
 * 複数ファイルの更新（書き込みと削除）を、全て同じ版にそろえて適用する。
 *  ① 全ての新しい内容を一時ファイルに書く → ② pending.json（何をどうするか）を原子的に書く
 *  → ③ 順に rename / 削除 → ④ pending.json を削除。②の後に落ちても、recover() が③を完了させる。
 */
export function writeTransaction(root: string, write: Files, remove: readonly string[] = []): void {
  const entries: Entry[] = [];
  for (const [rel, text] of Object.entries(write)) {
    const final = resolveInside(root, rel);
    entries.push({ tmp: writeTmp(final, text), final });
  }
  for (const rel of remove) entries.push({ remove: resolveInside(root, rel) });
  if (entries.length === 0) return;
  writeAtomic(pendingPath(root), JSON.stringify(entries));
  applyEntries(entries);
  unlinkSync(pendingPath(root));
}

function applyEntries(entries: readonly Entry[]): void {
  for (const e of entries) {
    if ('remove' in e) {
      if (existsSync(e.remove)) unlinkSync(e.remove);
    } else if (existsSync(e.tmp)) renameRetry(e.tmp, e.final); // 既に済んでいれば tmp は無い（再実行しても安全）
  }
}

function removeOrphanTmp(dir: string): number {
  let n = 0;
  if (!existsSync(dir)) return 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== '.git' && d.name !== 'node_modules') n += removeOrphanTmp(p);
    } else if (d.name.endsWith('.tmp')) {
      unlinkSync(p);
      n++;
    }
  }
  return n;
}

export interface RecoverResult {
  /** pending.json が残っていた（更新の途中で落ちた）ため、先へ進めて完了させたか。 */
  readonly completedTransaction: boolean;
  /** 削除した、書きかけの一時ファイルの数。 */
  readonly removedTmpFiles: number;
}

/** 起動時の復旧。途中だった更新を完了させ、書きかけの一時ファイルを片付ける。 */
export function recover(root: string): RecoverResult {
  let completed = false;
  const p = pendingPath(root);
  if (existsSync(p)) {
    let entries: Entry[] | null = null;
    try {
      entries = JSON.parse(readFileSync(p, 'utf8')) as Entry[];
    } catch {
      entries = null; // pending.json 自体が壊れている（②の途中で落ちた）→ ③は始まっていないので捨ててよい
    }
    if (entries) {
      applyEntries(entries);
      completed = true;
    }
    unlinkSync(p);
  }
  return { completedTransaction: completed, removedTmpFiles: removeOrphanTmp(root) };
}

const KNOWN = [/^schedule\.json$/, /^types\.json$/, /^projects\/[A-Za-z0-9_-]+\.json$/, /^dependencies\/[A-Za-z0-9_-]+\.json$/, TEMPLATE_PATH_RE, /^calendar\.json$/];
export const isKnown = (rel: string): boolean => KNOWN.some((r) => r.test(rel));

function listKnown(root: string): string[] {
  const out: string[] = [];
  for (const rel of ['schedule.json', 'types.json', CALENDAR_PATH]) if (existsSync(join(root, rel))) out.push(rel);
  for (const dir of ['projects', 'dependencies', 'templates']) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) if (isKnown(`${dir}/${name}`)) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

/** 日程データのファイル（schedule.json / types.json / projects/ / dependencies/ / templates/）を全て読む。 */
export function loadFiles(root: string): Files {
  const files: Files = {};
  for (const rel of listKnown(root)) files[rel] = readFileSync(join(root, rel), 'utf8');
  return files;
}

/** 標準日程 1 件の保存・削除（F-801, F-807）。日程の自動保存とは別に、操作の確定時に呼ぶ。 */
export function saveTemplate(root: string, id: string, text: string): void {
  writeTransaction(root, { [templatePath(id)]: text });
}
/** カレンダー設定の保存（F-603）。 */
export function saveCalendar(root: string, text: string): void {
  writeTransaction(root, { [CALENDAR_PATH]: text });
}
export function deleteTemplate(root: string, id: string): void {
  writeTransaction(root, {}, [templatePath(id)]);
}

export interface SaveResult {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

/**
 * 日程データを保存する。内容が変わったファイルだけを書き、無くなったファイルを削除する（トランザクション）。
 * 日程データ以外のファイル（.git・views/ など）は触らない。
 */
export function saveFiles(root: string, files: Files): SaveResult {
  for (const rel of Object.keys(files)) if (!isKnown(rel)) throw new Error(`保存できないパス: ${rel}`);
  const existing = new Set(listKnown(root));
  const changed: Files = {};
  for (const [rel, text] of Object.entries(files)) {
    if (!existing.has(rel) || readFileSync(join(root, rel), 'utf8') !== text) changed[rel] = text;
  }
  // 標準日程（templates/）とカレンダー（calendar.json）は日程の自動保存の対象外: 渡されなくても消さない（削除は deleteTemplate）
  const removed = [...existing].filter((rel) => !(rel in files) && !TEMPLATE_PATH_RE.test(rel) && rel !== CALENDAR_PATH).sort();
  writeTransaction(root, changed, removed);
  return { written: Object.keys(changed).sort(), removed };
}

const RUNNING = 'running';
const BASE = 'base.json';

export interface SessionStart {
  /** 前回が正常終了しなかった（running が残っていた）。 */
  readonly crashed: boolean;
  /** crashed のとき、前回の正常な開始時点のファイル内容（復元時の変更一覧・破棄の基準）。 */
  readonly base: Files | null;
}

/**
 * 編集の開始。running を作り、前回の異常終了を検出する（F-210/F-211）。
 * 正常に始まるたびに、その時点の内容を基準（.autosave/base.json）として残す。異常終了後は基準を更新しない。
 * ponytail: 基準は Git が使えるまでの代用（Phase 4 で HEAD に置き換える）。
 */
export function beginSession(root: string): SessionStart {
  const dir = join(root, AUTOSAVE_DIR);
  const crashed = existsSync(join(dir, RUNNING));
  let base: Files | null = null;
  if (crashed) {
    try {
      base = JSON.parse(readFileSync(join(dir, BASE), 'utf8')) as Files;
    } catch {
      base = null;
    }
  } else {
    writeAtomic(join(dir, BASE), JSON.stringify(loadFiles(root)));
  }
  writeAtomic(join(dir, RUNNING), String(Date.now()));
  return { crashed, base };
}

/** 正常終了の印（running の削除）。 */
export function endSession(root: string): void {
  try {
    unlinkSync(join(root, AUTOSAVE_DIR, RUNNING));
  } catch {
    /* 無ければ何もしない */
  }
}

export type CreateResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'not-empty' };

/**
 * 新規作成（F-501）。空のフォルダ（.git だけは許す）に、渡されたファイル一式（空の日程データ）を書く。
 * 他のファイルがあるフォルダには何も書かない（既存のファイルを巻き込まないため）。
 */
export function createEmpty(root: string, files: Files): CreateResult {
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).some((name) => name !== '.git')) return { ok: false, reason: 'not-empty' };
  writeTransaction(root, files);
  return { ok: true };
}
