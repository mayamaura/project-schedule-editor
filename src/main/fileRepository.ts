// @req NF-004, NF-018, F-210, F-211
// FileRepository: 日程データのファイル入出力（Node のファイルシステム。main 層のみ）。
// 方針（docs/architecture.html 8, 9.3 で検証済み）:
//   ・書き込みは「同じ場所の一時ファイル → fsync → rename」の原子的置換（途中で落ちても旧版か新版のどちらかが残る）
//   ・複数ファイルの更新は pending.json（意図の記録）を先に書き、起動時に先へ進める（roll-forward）ことで全て同一版にそろえる
// ドメイン層（純関数）が作る「パス → 内容」を受け渡すだけで、データの意味は知らない。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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

function writeTmp(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** 1ファイルの原子的な書き込み（一時ファイル → fsync → rename）。 */
export function writeAtomic(file: string, text: string): void {
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

const KNOWN = [/^schedule\.json$/, /^types\.json$/, /^projects\/[A-Za-z0-9_-]+\.json$/, /^dependencies\/[A-Za-z0-9_-]+\.json$/];
const isKnown = (rel: string): boolean => KNOWN.some((r) => r.test(rel));

function listKnown(root: string): string[] {
  const out: string[] = [];
  for (const rel of ['schedule.json', 'types.json']) if (existsSync(join(root, rel))) out.push(rel);
  for (const dir of ['projects', 'dependencies']) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) if (isKnown(`${dir}/${name}`)) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

/** 日程データのファイル（schedule.json / types.json / projects/ / dependencies/）を全て読む。 */
export function loadFiles(root: string): Files {
  const files: Files = {};
  for (const rel of listKnown(root)) files[rel] = readFileSync(join(root, rel), 'utf8');
  return files;
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
  const removed = [...existing].filter((rel) => !(rel in files)).sort();
  writeTransaction(root, changed, removed);
  return { written: Object.keys(changed).sort(), removed };
}
