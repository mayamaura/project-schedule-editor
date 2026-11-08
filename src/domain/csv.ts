// @req F-602
// CSV（・Excel の表）の取り込みと書き出し。純 TypeScript。表は「行 × 列の文字列」で扱うので、Excel のファイルの読み書きは
// その外側（Main 層）が行い、ここは表と日程の変換だけを担う。docs/architecture.html 15.5。
import { applyCommand, type Command } from './commands';
import { fromDays, isDateStr, type DateStr } from './date';
import { addProjectCommand, newId } from './edit';
import type { EventData, Id, MilestoneData, Project, Schedule } from './model';

// ---- CSV の文字列 ⇄ 表 ----

/** RFC 4180 の CSV を表にする（引用符・値の中のカンマ・改行・"" を扱う。BOM と CRLF も可。空行は飛ばす）。 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // その行に何か文字があったか（空行の判定）
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    if (started || row.some((f) => f !== '')) rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      endField();
      started = true;
    } else if (c === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else if (c === '\n') endRow();
    else {
      field += c;
      started = true;
    }
  }
  if (field !== '' || row.length > 0 || started) endRow();
  return rows;
}

/** 表を CSV にする（改行は CRLF。必要な値だけ引用符で囲む）。 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const q = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---- 日付 ----

const EXCEL_EPOCH_OFFSET = 25569; // Excel のシリアル値（1900 年起点）で 1970-01-01 に当たる値

/** よくある書式（2026-11-01 / 2026/1/5 / 2026年12月15日 / 2026.3.9 / Excel のシリアル値）を YYYY-MM-DD にする。読めなければ null。 */
export function normalizeDate(raw: string): DateStr | null {
  const v = raw.trim();
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(v);
  if (m) {
    const d = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
    return isDateStr(d) ? d : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const n = Math.floor(Number(v));
    if (n >= 20000 && n <= 80000) return fromDays(n - EXCEL_EPOCH_OFFSET);
  }
  return null;
}

// ---- 書き出し ----

export const CSV_HEADER = ['プロジェクト', '区分', '名称', '開始', '終了', '種別', 'メモ'] as const;
const KIND_EVENT = 'イベント';
const KIND_MILESTONE = 'マイルストーン';
const PATH_SEP = ' / ';

/** 日程を表にする。プロジェクトは階層を「 / 」でつないだ名前、並びは画面と同じ（親 → 子、並び順）。 */
export function exportRows(s: Schedule): string[][] {
  const rows: string[][] = [[...CSV_HEADER]];
  const children = new Map<Id | null, Project[]>();
  for (const p of Object.values(s.projects)) {
    const key = p.parentId !== null && s.projects[p.parentId] ? p.parentId : null;
    children.set(key, [...(children.get(key) ?? []), p]);
  }
  const visit = (parent: Id | null, prefix: string): void => {
    for (const p of (children.get(parent) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))) {
      const path = prefix === '' ? p.name : `${prefix}${PATH_SEP}${p.name}`;
      const items: { start: string; row: string[] }[] = [
        ...Object.entries(p.events).map(([id, e]) => ({ id, start: e.start, row: [path, KIND_EVENT, e.name, e.start, e.end, e.type, e.note ?? ''] })),
        ...Object.entries(p.milestones).map(([id, m]) => ({ id, start: m.date, row: [path, KIND_MILESTONE, m.name, m.date, m.date, m.type, m.note ?? ''] })),
      ];
      items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      for (const it of items) rows.push(it.row);
      visit(p.id, path);
    }
  };
  visit(null, '');
  return rows;
}

// ---- 取り込み ----

const ALIASES: Readonly<Record<'project' | 'kind' | 'name' | 'start' | 'end' | 'type' | 'note', readonly string[]>> = {
  project: ['プロジェクト', 'プロジェクト名', 'project'],
  kind: ['区分', 'kind'],
  name: ['名称', '名前', 'name', 'タスク', '項目'],
  start: ['開始', '開始日', 'start', '日付', 'date'],
  end: ['終了', '終了日', 'end'],
  type: ['種別', 'type'],
  note: ['メモ', '備考', 'note'],
};
type Col = keyof typeof ALIASES;

export interface ImportError {
  /** 表の行番号（1 始まり。見出しの行が 1）。 */
  readonly row: number;
  readonly message: string;
}
export interface ImportResult {
  /** 取り込めた行をまとめた 1 コマンド（Undo 1 単位）。取り込める行が無ければ null。 */
  readonly command: Command | null;
  readonly counts: { readonly projects: number; readonly events: number; readonly milestones: number };
  readonly errors: readonly ImportError[];
}

const NONE: ImportResult['counts'] = { projects: 0, events: 0, milestones: 0 };

/**
 * 表（1 行目は見出し）を、プロジェクト・イベント・マイルストーンを追加するコマンドにする。
 * プロジェクトは「 / 」区切りの階層で、同じ名前のものがあればそこへ、無ければ作る。おかしな行は理由つきで飛ばす。
 */
export function importRows(rows: readonly (readonly string[])[], s: Schedule, rand?: () => number): ImportResult {
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = {} as Record<Col, number>;
  for (const k of Object.keys(ALIASES) as Col[]) col[k] = head.findIndex((h) => ALIASES[k].some((a) => a.toLowerCase() === h));
  const missing = (['project', 'name', 'start'] as const).filter((k) => col[k] < 0);
  if (missing.length > 0) return { command: null, counts: NONE, errors: [{ row: 1, message: `必要な列がありません: ${missing.map((k) => ALIASES[k][0]).join('・')}（見出しの行に「プロジェクト」「名称」「開始」が必要です）` }] };

  const cell = (r: readonly string[], k: Col): string => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
  const errors: ImportError[] = [];
  const commands: Command[] = [];
  let cur = s;
  const apply = (c: Command): boolean => {
    const r = applyCommand(cur, c);
    if (!r.ok) return false;
    cur = r.schedule;
    commands.push(c);
    return true;
  };
  const counts = { projects: 0, events: 0, milestones: 0 };
  const firstType = Object.keys(s.types)[0];

  /** 階層の名前から、プロジェクトの ID（無ければ作る）。 */
  const resolveProject = (path: string): Id | null => {
    let parent: Id | null = null;
    for (const seg of path.split(/\s*\/\s*/).filter((x) => x !== '')) {
      const found: Project | undefined = Object.values(cur.projects).find((p) => p.parentId === parent && p.name === seg);
      if (found) {
        parent = found.id;
        continue;
      }
      const id = newId(cur, rand);
      if (!apply(addProjectCommand(cur, { id, name: seg, parentId: parent }))) return null;
      counts.projects++;
      parent = id;
    }
    return parent;
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const row = i + 1;
    if (r.every((c) => c.trim() === '')) continue;
    const name = cell(r, 'name');
    const projectPath = cell(r, 'project');
    if (projectPath === '') {
      errors.push({ row, message: 'プロジェクトが空です' });
      continue;
    }
    if (name === '') {
      errors.push({ row, message: '名称が空です' });
      continue;
    }
    const start = normalizeDate(cell(r, 'start'));
    if (start === null) {
      errors.push({ row, message: `開始の日付が読めません（${cell(r, 'start') || '空'}）` });
      continue;
    }
    const kindText = cell(r, 'kind').toLowerCase();
    const endText = cell(r, 'end');
    const isMilestone = kindText.includes('マイル') || kindText.includes('milestone') ? true : kindText.includes('イベント') || kindText.includes('event') ? false : endText === '';
    let end: DateStr = start;
    if (!isMilestone) {
      const e = endText === '' ? start : normalizeDate(endText);
      if (e === null) {
        errors.push({ row, message: `終了の日付が読めません（${endText}）` });
        continue;
      }
      if (e < start) {
        errors.push({ row, message: `終了（${e}）が開始（${start}）より前です` });
        continue;
      }
      end = e;
    }
    const type = cell(r, 'type').slice(0, 64);
    const note = cell(r, 'note');
    // プロジェクトを作る前に、行が取り込めることを確かめる（失敗した行のためにプロジェクトを増やさない）
    const before = { cur, n: commands.length, projects: counts.projects };
    const pid = resolveProject(projectPath);
    const id = newId(cur, rand);
    const ok =
      pid !== null &&
      apply(
        isMilestone
          ? ({ type: 'addMilestone', projectId: pid, id, milestone: { name: name.slice(0, 500), date: start, type: type || firstType || 'milestone', ...(note ? { note } : {}) } satisfies MilestoneData } as Command)
          : ({ type: 'addEvent', projectId: pid, id, event: { name: name.slice(0, 500), start, end, type: type || firstType || 'task', ...(note ? { note } : {}) } satisfies EventData } as Command),
      );
    if (!ok) {
      cur = before.cur;
      commands.length = before.n;
      counts.projects = before.projects;
      errors.push({ row, message: '取り込めませんでした（項目の内容が正しくありません）' });
      continue;
    }
    if (isMilestone) counts.milestones++;
    else counts.events++;
  }
  return { command: commands.length === 0 ? null : { type: 'batch', commands, label: 'CSV・Excel の取り込み' }, counts, errors };
}
