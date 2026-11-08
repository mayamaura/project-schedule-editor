// @req F-801, F-802, F-803, F-804, F-805, F-807, F-808, F-809
// 標準日程（テンプレート）。起点（0）からの相対オフセットで項目を持ち、起点の日付を与えて実日付に展開する。
// 純 TypeScript（ドメイン層）。docs/data-model.html 8。展開後のプロジェクトは標準日程から独立する（F-807）。
import { z } from 'zod';
import { addDays, addMonths, fromDays, isDateStr, toDays, weekday, type DateStr } from './date';
import { applyCommand, type Command } from './commands';
import { addProjectCommand, newId } from './edit';
import { endpointSchema, eventStyleSchema, idSchema, milestoneStyleSchema, type Id, type Schedule } from './model';
import { stableStringify, type Files } from './serialize';

const nonNeg = (n: number | undefined): number => n ?? 0;

/** 起点からのオフセット。符号は負=前・正=後。ヶ月と日は同じ向き（併用可）。省略は 0。 */
export const offsetSchema = z
  .strictObject({
    months: z.number().int().min(-1200).max(1200).optional(),
    days: z.number().int().min(-36500).max(36500).optional(),
  })
  .refine((o) => nonNeg(o.months) * nonNeg(o.days) >= 0, 'ヶ月と日は同じ向き（前か後）で指定する');
export type Offset = z.infer<typeof offsetSchema>;

const nameSchema = z.string().min(1, '名称が空').max(500);
const textSchema = z.string().max(20000);

export const templateEventSchema = z.strictObject({
  name: nameSchema,
  type: z.string().max(64),
  start: offsetSchema,
  end: offsetSchema,
  color: z.string().max(32).optional(),
  style: eventStyleSchema.optional(),
  note: textSchema.optional(),
});
export const templateMilestoneSchema = z.strictObject({
  name: nameSchema,
  type: z.string().max(64),
  date: offsetSchema,
  style: milestoneStyleSchema.optional(),
  note: textSchema.optional(),
});
export const templateDependencySchema = z.strictObject({
  from: endpointSchema,
  to: endpointSchema,
  type: z.enum(['FS', 'SS', 'FF', 'SF']),
  lagDays: z.number().int().min(-36500).max(36500),
});

export const templateSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  /** 展開時に「マイルストーン起点」を選んだときの既定（任意）。 */
  defaultAnchor: idSchema.optional(),
  /** 日の数え方: 暦日 / 稼働日（F-804）。 */
  dayMode: z.enum(['calendar', 'working']),
  /** 非稼働日に当たったときの補正: そのまま / 前倒し / 後ろ倒し。 */
  adjust: z.enum(['none', 'earlier', 'later']),
  events: z.record(idSchema, templateEventSchema),
  milestones: z.record(idSchema, templateMilestoneSchema),
  dependencies: z.record(idSchema, templateDependencySchema),
});
export type Template = z.infer<typeof templateSchema>;

// ---- 日付計算 ----

export type WorkdayFn = (date: DateStr) => boolean;
/** 稼働日 = 土日以外。祝日（F-603）は未対応で、対応したら呼び出し側がこの関数を差し替える。 */
export const weekendWorkday: WorkdayFn = (d) => {
  const w = weekday(d);
  return w !== 0 && w !== 6;
};

export interface CalcOptions {
  readonly dayMode: Template['dayMode'];
  readonly adjust: Template['adjust'];
  readonly isWorkday: WorkdayFn;
}

const SEARCH_LIMIT = 366;

/** 稼働日で n 日進める（負なら戻る）。稼働日が見つからない設定でも止まらない（元の日付を返す）。 */
function stepWorkdays(date: DateStr, n: number, isWorkday: WorkdayFn): DateStr {
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  let day = toDays(date);
  let guard = remaining * 10 + SEARCH_LIMIT;
  while (remaining > 0) {
    if (--guard < 0) return date;
    day += step;
    if (isWorkday(fromDays(day))) remaining--;
  }
  return fromDays(day);
}

function shiftDays(date: DateStr, n: number, o: CalcOptions): DateStr {
  return o.dayMode === 'working' ? stepWorkdays(date, n, o.isWorkday) : addDays(date, n);
}

function adjustToWorkday(date: DateStr, o: CalcOptions): DateStr {
  if (o.adjust === 'none' || o.isWorkday(date)) return date;
  const step = o.adjust === 'earlier' ? -1 : 1;
  let day = toDays(date);
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    day += step;
    if (o.isWorkday(fromDays(day))) return fromDays(day);
  }
  return date;
}

/** 起点の日付にオフセットを適用する。ヶ月（暦月・月末丸め）→ 日（暦日または稼働日）→ 非稼働日の補正。 */
export function applyOffset(anchor: DateStr, off: Offset, o: CalcOptions): DateStr {
  return adjustToWorkday(shiftDays(addMonths(anchor, nonNeg(off.months)), nonNeg(off.days), o), o);
}

/** オフセットを逆向きに適用する（日 → ヶ月の順。マイルストーン起点から起点（0）を求める）。補正はしない。 */
export function reverseOffset(date: DateStr, off: Offset, o: CalcOptions): DateStr {
  return addMonths(shiftDays(date, -nonNeg(off.days), o), -nonNeg(off.months));
}

// ---- 画面用の単位変換（週は日 ×7 で保存。F-801） ----

export interface OffsetInput {
  readonly months: number;
  readonly weeks: number;
  readonly days: number;
}
export type OffsetDir = 'before' | 'after';

export function makeOffset(dir: OffsetDir, i: OffsetInput): Offset {
  const sign = dir === 'before' ? -1 : 1;
  const months = Math.abs(Math.trunc(i.months)) * sign;
  const days = (Math.abs(Math.trunc(i.weeks)) * 7 + Math.abs(Math.trunc(i.days))) * sign;
  return { ...(months !== 0 ? { months } : {}), ...(days !== 0 ? { days } : {}) };
}

export function splitOffset(o: Offset): OffsetInput & { readonly dir: OffsetDir } {
  const m = nonNeg(o.months);
  const d = nonNeg(o.days);
  const dir: OffsetDir = m < 0 || (m === 0 && d < 0) ? 'before' : 'after';
  const ad = Math.abs(d);
  return { dir, months: Math.abs(m), weeks: Math.floor(ad / 7), days: ad % 7 };
}

// ---- 検証 ----

/** 標準日程の意味の検証（スキーマで防げないもの）。指摘の文言を返す。 */
export function validateTemplate(t: Template): string[] {
  const out: string[] = [];
  if (t.defaultAnchor !== undefined && !t.milestones[t.defaultAnchor]) out.push(`既定の起点のマイルストーン「${t.defaultAnchor}」がありません`);
  const has = (e: { kind: 'event' | 'milestone'; id: Id }): boolean => (e.kind === 'event' ? Boolean(t.events[e.id]) : Boolean(t.milestones[e.id]));
  const adj = new Map<Id, Id[]>();
  for (const [id, d] of Object.entries(t.dependencies)) {
    if (!has(d.from) || !has(d.to)) {
      out.push(`依存 ${id}: 端点の項目がありません`);
      continue;
    }
    if (d.from.id === d.to.id) {
      out.push(`依存 ${id}: 自分自身への依存です`);
      continue;
    }
    adj.set(d.from.id, [...(adj.get(d.from.id) ?? []), d.to.id]);
  }
  // 循環（色塗りの DFS）
  const state = new Map<Id, 1 | 2>();
  const visit = (v: Id): boolean => {
    state.set(v, 1);
    for (const w of adj.get(v) ?? []) {
      if (state.get(w) === 1) return true;
      if (!state.has(w) && visit(w)) return true;
    }
    state.set(v, 2);
    return false;
  };
  for (const v of adj.keys()) if (!state.has(v) && visit(v)) {
    out.push('依存に循環があります');
    break;
  }
  return out;
}

// ---- 展開 ----

export type AnchorSpec =
  /** 起点（0）の日付を直接指定。 */
  | { readonly kind: 'date'; readonly date: DateStr }
  /** 標準日程内のマイルストーンを選び、その日付を指定。 */
  | { readonly kind: 'milestone'; readonly milestoneId: Id; readonly date: DateStr };
export type ExpandTarget =
  | { readonly kind: 'newProject'; readonly name: string; readonly parentId: Id | null }
  | { readonly kind: 'existing'; readonly projectId: Id };

export interface ExpandOptions {
  readonly anchor: AnchorSpec;
  readonly target: ExpandTarget;
  readonly isWorkday?: WorkdayFn;
  readonly rand?: () => number;
}
export interface PreviewItem {
  readonly kind: 'event' | 'milestone';
  readonly name: string;
  readonly start: DateStr;
  readonly end: DateStr;
}
export type ExpandResult =
  | { readonly ok: true; readonly schedule: Schedule; readonly command: Command; readonly projectId: Id; readonly items: readonly PreviewItem[] }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): ExpandResult => ({ ok: false, message });
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * 標準日程を展開するコマンド（1 つの batch = Undo 1 単位）と、適用後の日程・プレビュー用の一覧を作る。
 * 生成した項目は新しい ID を持ち、標準日程への参照は残さない。ID 以外の失敗（不正な名称など）は message で返す。
 */
export function expandTemplate(s: Schedule, t: Template, opt: ExpandOptions): ExpandResult {
  const calc: CalcOptions = { dayMode: t.dayMode, adjust: t.adjust, isWorkday: opt.isWorkday ?? weekendWorkday };
  if (!isDateStr(opt.anchor.date)) return fail('起点の日付が正しくありません');
  let d0 = opt.anchor.date;
  let pinned: Id | null = null;
  if (opt.anchor.kind === 'milestone') {
    const m = t.milestones[opt.anchor.milestoneId];
    if (!m) return fail('起点のマイルストーンが標準日程にありません');
    d0 = reverseOffset(opt.anchor.date, m.date, calc);
    pinned = opt.anchor.milestoneId; // 選んだマイルストーンは、指定した日付に必ず一致させる
  }
  if (opt.target.kind === 'existing' && !s.projects[opt.target.projectId]) return fail('展開先のプロジェクトがありません');

  const used = new Set<Id>();
  const fresh = (): Id => {
    for (;;) {
      const id = newId(s, opt.rand);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const commands: Command[] = [];
  let projectId: Id;
  if (opt.target.kind === 'newProject') {
    projectId = fresh();
    commands.push(addProjectCommand(s, { id: projectId, name: opt.target.name, parentId: opt.target.parentId }));
  } else {
    projectId = opt.target.projectId;
  }

  const items: PreviewItem[] = [];
  const idMap = new Map<string, Id>(); // 'event:t1' → 新しい ID
  for (const [tid, e] of Object.entries(t.events)) {
    const id = fresh();
    idMap.set(`event:${tid}`, id);
    const start = applyOffset(d0, e.start, calc);
    const end0 = applyOffset(d0, e.end, calc);
    const end = toDays(end0) < toDays(start) ? start : end0; // 補正で逆転したら開始に揃える
    commands.push({ type: 'addEvent', projectId, id, event: { name: e.name, start, end, type: e.type, ...defined({ color: e.color, style: e.style, note: e.note }) } });
    items.push({ kind: 'event', name: e.name, start, end });
  }
  for (const [tid, m] of Object.entries(t.milestones)) {
    const id = fresh();
    idMap.set(`milestone:${tid}`, id);
    const date = tid === pinned && opt.anchor.kind === 'milestone' ? opt.anchor.date : applyOffset(d0, m.date, calc);
    commands.push({ type: 'addMilestone', projectId, id, milestone: { name: m.name, date, type: m.type, ...defined({ style: m.style, note: m.note }) } });
    items.push({ kind: 'milestone', name: m.name, start: date, end: date });
  }
  for (const dd of Object.values(t.dependencies)) {
    const from = idMap.get(`${dd.from.kind}:${dd.from.id}`);
    const to = idMap.get(`${dd.to.kind}:${dd.to.id}`);
    if (!from || !to) continue; // 端点が無い依存は複製しない（validateTemplate が指摘する）
    commands.push({ type: 'addDependency', dependency: { id: fresh(), from: { kind: dd.from.kind, id: from }, to: { kind: dd.to.kind, id: to }, type: dd.type, lagDays: dd.lagDays } });
  }

  const command: Command = { type: 'batch', commands, label: `標準日程「${t.name}」を展開` };
  const r = applyCommand(s, command);
  if (!r.ok) return fail(r.error.message);
  items.sort((a, b) => toDays(a.start) - toDays(b.start) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, schedule: r.schedule, command, projectId, items };
}

// ---- 保存形式（templates/<id>.json。F-807） ----

export const templatePath = (id: Id): string => `templates/${id}.json`;
export const TEMPLATE_PATH_RE = /^templates\/[A-Za-z0-9_-]+\.json$/;

export function serializeTemplate(t: Template): string {
  return stableStringify(t);
}

export function parseTemplate(text: string): { readonly ok: true; readonly template: Template } | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `JSON として読めない: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = templateSchema.safeParse(raw);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.map(String).join('.') || '値'}: ${i.message}`).join(' / ') };
  return { ok: true, template: r.data };
}

export interface ParsedTemplates {
  readonly templates: Readonly<Record<Id, Template>>;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

/** templates/ 以下のファイルを読む。読めないものは errors に入れ、他は読む（黙って捨てない）。 */
export function parseTemplates(files: Files): ParsedTemplates {
  const templates: Record<Id, Template> = {};
  const errors: { path: string; message: string }[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith('templates/')) continue;
    const r = parseTemplate(text);
    if (!r.ok) errors.push({ path, message: r.message });
    else if (path !== templatePath(r.template.id)) errors.push({ path, message: `ファイル名と id「${r.template.id}」が一致しない` });
    else templates[r.template.id] = r.template;
  }
  return { templates, errors };
}

export function duplicateTemplate(t: Template, id: Id, name: string): Template {
  return { ...t, id, name };
}
