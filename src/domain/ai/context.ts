// @req F-707, E2, NF-015
// AI に渡すデータ（最小送信）。範囲（選択 / 表示中のビュー / 全体）を決め、送るテキストそのものをここで作る。
// 送信前のプレビュー（F-707）と、AI のツール（get_schedule）が返す内容は、同じ関数の出力で、食い違わない。純 TypeScript。
import type { Calendar } from '../calendar';
import { buildSnapshot, withDescendants } from '../export/snapshot';
import type { DateStr } from '../date';
import type { Id, Schedule } from '../model';
import { validateSchedule, type ValidationIssue } from '../validate';

export type AiScope =
  /** 選択したプロジェクト（子孫を含む）。 */
  | { readonly kind: 'selection'; readonly projectIds: readonly Id[] }
  /** 表示中の期間（この期間に重なる項目）。 */
  | { readonly kind: 'view'; readonly from: DateStr; readonly to: DateStr }
  | { readonly kind: 'all' };

export interface AiDataOptions {
  /** メモ・担当者を含めて送信してよい（決定 E2）。利用者が外すこともできる。 */
  readonly includeNotes: boolean;
  readonly includeAssignee: boolean;
}
export const defaultAiDataOptions = (): AiDataOptions => ({ includeNotes: true, includeAssignee: true });

export interface AiContext {
  /** AI に渡すテキスト（JSON）。 */
  readonly text: string;
  /** 範囲に含まれる項目の ID（プロジェクト・イベント・マイルストーン・依存）。AI の提案がこの範囲を超えないか確認するのに使う。 */
  readonly ids: ReadonlySet<Id>;
  readonly stats: { readonly projects: number; readonly events: number; readonly milestones: number; readonly dependencies: number; readonly chars: number };
  /** 範囲内のルールベースの指摘（F-704）。AI はこれと重複した指摘をしない（F-705）。 */
  readonly issues: readonly ValidationIssue[];
}

/** この文字数を超えたら、送信前の確認で「大きい」と知らせる（目安）。 */
export const LARGE_CONTEXT_CHARS = 200_000;

export function buildAiContext(s: Schedule, calendar: Calendar, scope: AiScope, opt: AiDataOptions, today: DateStr): AiContext {
  const snap = buildSnapshot(
    s,
    calendar,
    scope.kind === 'selection' ? { projectIds: scope.projectIds } : scope.kind === 'view' ? { from: scope.from, to: scope.to } : {},
    { includeNotes: opt.includeNotes, includeAssignee: opt.includeAssignee, dependencies: true, headerMode: 'weekMonth' },
    { generatedAt: today, label: '', title: '' },
  );
  const ids = new Set<Id>();
  let events = 0;
  let milestones = 0;
  for (const p of snap.projects) {
    ids.add(p.id);
    for (const id of Object.keys(p.events)) {
      ids.add(id);
      events++;
    }
    for (const id of Object.keys(p.milestones)) {
      ids.add(id);
      milestones++;
    }
  }
  const deps = Object.values(snap.dependencies);
  for (const d of deps) ids.add(d.id);
  const issues = validateSchedule({ ...s, projects: Object.fromEntries(snap.projects.map((p) => [p.id, p])), dependencies: snap.dependencies }).filter((i) => ids.has(i.target.id));
  const body = {
    today,
    projects: snap.projects.map((p) => ({
      id: p.id,
      name: p.name,
      parentId: p.parentId,
      ...(p.status ? { status: p.status } : {}),
      ...(p.assignee ? { assignee: p.assignee } : {}),
      ...(p.note ? { note: p.note } : {}),
      events: Object.entries(p.events).map(([id, e]) => ({ id, name: e.name, start: e.start, end: e.end, type: e.type, ...(e.note ? { note: e.note } : {}) })),
      milestones: Object.entries(p.milestones).map(([id, m]) => ({ id, name: m.name, date: m.date, type: m.type, ...(m.note ? { note: m.note } : {}) })),
    })),
    dependencies: deps.map((d) => ({ id: d.id, from: d.from.id, to: d.to.id, type: d.type, lagDays: d.lagDays })),
    calendar: { weekend: calendar.weekend, japaneseHolidays: calendar.japaneseHolidays, companyHolidays: calendar.holidays, extraWorkdays: calendar.workdays },
    ruleBasedIssues: issues.map((i) => ({ rule: i.rule, severity: i.severity, target: i.target, message: i.message })),
  };
  const text = JSON.stringify(body);
  return { text, ids, issues, stats: { projects: snap.projects.length, events, milestones, dependencies: deps.length, chars: text.length } };
}

/** 選択したプロジェクトとその子孫の ID（範囲の表示用）。 */
export const scopeProjectIds = (s: Schedule, scope: AiScope): Set<Id> => (scope.kind === 'selection' ? withDescendants(s, scope.projectIds) : new Set(Object.keys(s.projects)));
