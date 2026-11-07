// @req NF-005, NF-006, F-501
// 整形出力と読み込み（Git で差分・マージしやすい決定的な JSON）。docs/data-model.html 2, 11。
// ファイルの読み書き自体（原子的書き込み）は main 層。ここは「パス → 文字列」の純関数だけを扱う。
import { dependencySchema, metaSchema, projectSchema, SCHEMA_VERSION, typesSchema, type Dependency, type Project, type Schedule } from './model';
import { validateSchedule, type ValidationIssue } from './validate';

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json | undefined };

function write(v: Json | undefined, depth: number): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x: Json | undefined) => pad + write(x ?? null, depth + 1)).join(',\n')}\n${end}]`;
  }
  const obj = v as { readonly [k: string]: Json | undefined };
  // 既定の sort（UTF-16 コード単位の昇順）。JS のオブジェクトは整数風のキーを先頭に並べ替えてしまうため、
  // 自前で並べて出力する（キー順を実装・環境に依存させない）。
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${write(obj[k], depth + 1)}`).join(',\n')}\n${end}}`;
}

/** キー昇順（再帰）・インデント2・LF・末尾改行の JSON。undefined の値は出力しない。 */
export function stableStringify(value: unknown): string {
  return `${write(value as Json, 0)}\n`;
}

export type Files = Record<string, string>;

export const PATHS = {
  meta: 'schedule.json',
  types: 'types.json',
  project: (id: string): string => `projects/${id}.json`,
  dependency: (id: string): string => `dependencies/${id}.json`,
} as const;

/** Schedule を「パス → 内容」に変換する（パスは昇順）。 */
export function serializeSchedule(s: Schedule): Files {
  const out: Files = {
    [PATHS.meta]: stableStringify({ schemaVersion: s.schemaVersion }),
    [PATHS.types]: stableStringify(s.types),
  };
  for (const p of Object.values(s.projects)) out[PATHS.project(p.id)] = stableStringify(p);
  for (const d of Object.values(s.dependencies)) out[PATHS.dependency(d.id)] = stableStringify(d);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface ParseIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult =
  /** 読み込めた。issues は意味の検証結果（依存違反など）。外部で編集された不整合は、ここで知らせて修復できる。 */
  | { readonly status: 'ok'; readonly schedule: Schedule; readonly issues: readonly ValidationIssue[] }
  /** 新しいアプリで作られたデータ。読み取り専用で開く（NF-006）。 */
  | { readonly status: 'tooNew'; readonly fileVersion: number }
  /** 構造が壊れていて読み込めない。データを黙って捨てず、全ての問題を返す。 */
  | { readonly status: 'error'; readonly errors: readonly ParseIssue[] };

/** 版 N のデータを版 N+1 に上げる関数（キー = 元の版）。生の JSON（パス → 値）を受け取り、新しいものを返す。 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
export type MigrationTable = Readonly<Record<number, Migration>>;

/** 現在は版 1 のみ。版を上げるときはここに追加し、マイグレーションのテストを書く。 */
export const MIGRATIONS: MigrationTable = {};

export function runMigrations(raw: Record<string, unknown>, from: number, to: number, table: MigrationTable): Record<string, unknown> {
  let cur = raw;
  for (let v = from; v < to; v++) {
    const m = table[v];
    if (!m) throw new Error(`マイグレーション ${v} → ${v + 1} が未定義`);
    cur = m(cur);
  }
  return cur;
}

function parseJson(path: string, text: string, errors: ParseIssue[]): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    errors.push({ path, message: `JSON として読めない: ${e instanceof Error ? e.message : String(e)}` });
    return undefined;
  }
}

function zodIssues(path: string, error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }, errors: ParseIssue[]): void {
  for (const i of error.issues) errors.push({ path, message: `${i.path.map(String).join('.') || '値'}: ${i.message}` });
}

/** target は現在の版（テストでマイグレーション経路を検証するために注入できる）。 */
export function parseSchedule(files: Files, table: MigrationTable = MIGRATIONS, target: number = SCHEMA_VERSION): ParseResult {
  const errors: ParseIssue[] = [];

  const metaText = files[PATHS.meta];
  if (metaText === undefined) return { status: 'error', errors: [{ path: PATHS.meta, message: 'schedule.json が無い' }] };
  const metaRaw = parseJson(PATHS.meta, metaText, errors);
  const meta = metaSchema.safeParse(metaRaw);
  if (!meta.success) {
    if (metaRaw !== undefined) zodIssues(PATHS.meta, meta.error, errors);
    return { status: 'error', errors };
  }
  const version = meta.data.schemaVersion;
  if (version > target) return { status: 'tooNew', fileVersion: version };

  // 生の JSON を集める（マイグレーションは生の値に対して行う）
  const raw: Record<string, unknown> = {};
  for (const [path, text] of Object.entries(files)) {
    if (path === PATHS.meta) continue;
    if (path === PATHS.types || /^projects\/[^/]+\.json$/.test(path) || /^dependencies\/[^/]+\.json$/.test(path)) {
      const v = parseJson(path, text, errors);
      if (v !== undefined) raw[path] = v;
    } // それ以外（views/, templates/ など、このモジュールの対象外のファイル）は無視する
  }
  // 構文エラーがあっても、現在の版（マイグレーション不要）なら、読めたファイルのスキーマ検証を続けて
  // 全ての問題を1回で報告する。古い版は、全てのファイルが読めないと移行できないので、構文エラーだけを返す。
  if (errors.length > 0 && version !== target) return { status: 'error', errors };

  let migrated: Record<string, unknown>;
  try {
    migrated = runMigrations(raw, version, target, table);
  } catch (e) {
    return { status: 'error', errors: [{ path: PATHS.meta, message: e instanceof Error ? e.message : String(e) }] };
  }

  const projects: Record<string, Project> = {};
  const dependencies: Record<string, Dependency> = {};
  let types: Schedule['types'] = {};
  for (const [path, value] of Object.entries(migrated)) {
    if (path === PATHS.types) {
      const r = typesSchema.safeParse(value);
      if (r.success) types = r.data;
      else zodIssues(path, r.error, errors);
    } else if (path.startsWith('projects/')) {
      const r = projectSchema.safeParse(value);
      if (!r.success) zodIssues(path, r.error, errors);
      else if (path !== PATHS.project(r.data.id)) errors.push({ path, message: `ファイル名と id「${r.data.id}」が一致しない` });
      else projects[r.data.id] = r.data;
    } else {
      const r = dependencySchema.safeParse(value);
      if (!r.success) zodIssues(path, r.error, errors);
      else if (path !== PATHS.dependency(r.data.id)) errors.push({ path, message: `ファイル名と id「${r.data.id}」が一致しない` });
      else dependencies[r.data.id] = r.data;
    }
  }
  if (errors.length > 0) return { status: 'error', errors: errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };

  const schedule: Schedule = { schemaVersion: target, projects, dependencies, types };
  return { status: 'ok', schedule, issues: validateSchedule(schedule) };
}
