// @req F-702, F-709, F-711, NF-012
// AI 提案（ChangeSet）。AI が返す日程変更案を zod で検証し、ドメインのコマンド列（1 つの batch）に変換する。
// AI は日程を直接書き換えない: ここで作るのは「提案」だけで、適用は利用者が差分を確認して承認した後に、
// 通常の編集と同じ経路（commit → Undo 1 単位）で行う。docs/data-model.html 6。純 TypeScript。
import { z } from 'zod';
import { applyCommand, type Command } from '../commands';
import { dateSchema, type Id, type Schedule } from '../model';
import { diffSchedule } from '../diff';
import { addProjectCommand, newId } from '../edit';
import { summarizeChange } from '../summary';
import { newIssues, type ValidationIssue } from '../validate';

const ref = z.string().min(1).max(80); // 既存の ID、または同じ提案内の tempId
const name = z.string().min(1).max(500);
const note = z.string().max(20000);
const type = z.string().min(1).max(64);

const atLeastOne = (o: Record<string, unknown>, keys: readonly string[]): boolean => keys.some((k) => o[k] !== undefined);

export const changeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('addProject'), tempId: ref.optional(), name, parentId: ref.nullable().optional() }),
  z.strictObject({ op: z.literal('updateProject'), projectId: ref, name: name.optional(), status: z.enum(['notStarted', 'inProgress', 'done', 'onHold']).optional(), assignee: z.string().max(200).optional(), note: note.optional() }).refine((o) => atLeastOne(o, ['name', 'status', 'assignee', 'note']), '変更する項目がありません'),
  z.strictObject({ op: z.literal('deleteProject'), projectId: ref }),
  z.strictObject({ op: z.literal('addEvent'), tempId: ref.optional(), projectId: ref, name, start: dateSchema, end: dateSchema, type: type.optional(), note: note.optional() }),
  z.strictObject({ op: z.literal('updateEvent'), eventId: ref, name: name.optional(), start: dateSchema.optional(), end: dateSchema.optional(), type: type.optional(), note: note.optional() }).refine((o) => atLeastOne(o, ['name', 'start', 'end', 'type', 'note']), '変更する項目がありません'),
  z.strictObject({ op: z.literal('deleteEvent'), eventId: ref }),
  z.strictObject({ op: z.literal('addMilestone'), tempId: ref.optional(), projectId: ref, name, date: dateSchema, type: type.optional(), note: note.optional() }),
  z.strictObject({ op: z.literal('updateMilestone'), milestoneId: ref, name: name.optional(), date: dateSchema.optional(), type: type.optional(), note: note.optional() }).refine((o) => atLeastOne(o, ['name', 'date', 'type', 'note']), '変更する項目がありません'),
  z.strictObject({ op: z.literal('deleteMilestone'), milestoneId: ref }),
  z.strictObject({ op: z.literal('addDependency'), tempId: ref.optional(), from: ref, to: ref, kind: z.enum(['FS', 'SS', 'FF', 'SF']).optional(), lagDays: z.number().int().min(-3650).max(3650).optional() }),
  z.strictObject({ op: z.literal('updateDependency'), dependencyId: ref, kind: z.enum(['FS', 'SS', 'FF', 'SF']).optional(), lagDays: z.number().int().min(-3650).max(3650).optional() }).refine((o) => atLeastOne(o, ['kind', 'lagDays']), '変更する項目がありません'),
  z.strictObject({ op: z.literal('deleteDependency'), dependencyId: ref }),
]);
export type AiChange = z.infer<typeof changeSchema>;

export const MAX_CHANGES = 200;

export const changeSetSchema = z.strictObject({
  /** 提案の要約（承認画面の見出し・保存メモに使う）。 */
  summary: z.string().min(1).max(500),
  /** 理由・根拠。 */
  rationale: z.string().max(4000).optional(),
  changes: z.array(changeSchema).min(1).max(MAX_CHANGES),
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

const OP_LABEL: Readonly<Record<AiChange['op'], string>> = {
  addProject: 'プロジェクトの追加',
  updateProject: 'プロジェクトの変更',
  deleteProject: 'プロジェクトの削除',
  addEvent: 'イベントの追加',
  updateEvent: 'イベントの変更',
  deleteEvent: 'イベントの削除',
  addMilestone: 'マイルストーンの追加',
  updateMilestone: 'マイルストーンの変更',
  deleteMilestone: 'マイルストーンの削除',
  addDependency: '依存の追加',
  updateDependency: '依存の変更',
  deleteDependency: '依存の削除',
};

export type EvaluatedChangeSet =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly rationale: string | undefined;
      /** 承認後に commit するコマンド（1 つの batch = Undo 1 単位）。 */
      readonly command: Command;
      readonly after: Schedule;
      /** diffSchedule と同じ形式の変更一覧（日本語）。 */
      readonly lines: readonly string[];
      readonly changeCount: number;
      /** この提案で新たに生じる指摘（適用後の validateSchedule − 適用前）。 */
      readonly newIssues: readonly ValidationIssue[];
    }
  | { readonly ok: false; readonly message: string };

/** 提案に出てくる、既存の項目・プロジェクトの ID（範囲の確認に使う）。 */
export function referencedIds(cs: ChangeSet): Id[] {
  const out: Id[] = [];
  for (const c of cs.changes) {
    switch (c.op) {
      case 'updateProject':
      case 'deleteProject':
        out.push(c.projectId);
        break;
      case 'addEvent':
      case 'addMilestone':
        out.push(c.projectId);
        break;
      case 'addProject':
        if (c.parentId) out.push(c.parentId);
        break;
      case 'updateEvent':
      case 'deleteEvent':
        out.push(c.eventId);
        break;
      case 'updateMilestone':
      case 'deleteMilestone':
        out.push(c.milestoneId);
        break;
      case 'addDependency':
        out.push(c.from, c.to);
        break;
      case 'updateDependency':
      case 'deleteDependency':
        out.push(c.dependencyId);
        break;
    }
  }
  return out;
}

/**
 * AI の出力（未検証の値）を検証し、適用後の日程・変更一覧・新たな指摘まで作る。失敗したときの message は、
 * AI に返して再提案させる文言（どの変更がなぜ不正か）。tempId は新しい ID に置き換える。
 */
export function evaluateChangeSet(s: Schedule, input: unknown, rand?: () => number): EvaluatedChangeSet {
  const parsed = changeSetSchema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '提案'}: ${i.message}`).join(' / ');
    return { ok: false, message: `提案の形式が正しくありません: ${msg}` };
  }
  const cs = parsed.data;
  const idMap = new Map<string, Id>();
  const used = new Set<Id>();
  const fresh = (cur: Schedule): Id => {
    for (;;) {
      const id = newId(cur, rand);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const resolve = (r: string): Id => idMap.get(r) ?? r;
  const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

  const commands: Command[] = [];
  let cur = s;
  for (const [i, c] of cs.changes.entries()) {
    const fail = (m: string): EvaluatedChangeSet => ({ ok: false, message: `${i + 1} 番目の変更（${OP_LABEL[c.op]}）: ${m}` });
    let cmd: Command;
    switch (c.op) {
      case 'addProject': {
        const id = fresh(cur);
        if (c.tempId) idMap.set(c.tempId, id);
        cmd = addProjectCommand(cur, { id, name: c.name, parentId: c.parentId ? resolve(c.parentId) : null });
        break;
      }
      case 'updateProject':
        cmd = { type: 'updateProject', id: resolve(c.projectId), patch: defined({ name: c.name, status: c.status, assignee: c.assignee, note: c.note }) };
        break;
      case 'deleteProject':
        cmd = { type: 'deleteProject', id: resolve(c.projectId) };
        break;
      case 'addEvent': {
        const id = fresh(cur);
        if (c.tempId) idMap.set(c.tempId, id);
        cmd = { type: 'addEvent', projectId: resolve(c.projectId), id, event: { name: c.name, start: c.start, end: c.end, type: c.type ?? Object.keys(cur.types)[0] ?? 'task', ...(c.note ? { note: c.note } : {}) } };
        break;
      }
      case 'updateEvent':
        cmd = { type: 'updateEvent', id: resolve(c.eventId), patch: defined({ name: c.name, start: c.start, end: c.end, type: c.type, note: c.note }) };
        break;
      case 'deleteEvent':
        cmd = { type: 'deleteEvent', id: resolve(c.eventId) };
        break;
      case 'addMilestone': {
        const id = fresh(cur);
        if (c.tempId) idMap.set(c.tempId, id);
        cmd = { type: 'addMilestone', projectId: resolve(c.projectId), id, milestone: { name: c.name, date: c.date, type: c.type ?? Object.keys(cur.types)[0] ?? 'milestone', ...(c.note ? { note: c.note } : {}) } };
        break;
      }
      case 'updateMilestone':
        cmd = { type: 'updateMilestone', id: resolve(c.milestoneId), patch: defined({ name: c.name, date: c.date, type: c.type, note: c.note }) };
        break;
      case 'deleteMilestone':
        cmd = { type: 'deleteMilestone', id: resolve(c.milestoneId) };
        break;
      case 'addDependency': {
        const id = fresh(cur);
        if (c.tempId) idMap.set(c.tempId, id);
        const [from, to] = [resolve(c.from), resolve(c.to)];
        const kindOf = (x: Id): 'event' | 'milestone' | null => {
          for (const p of Object.values(cur.projects)) {
            if (p.events[x]) return 'event';
            if (p.milestones[x]) return 'milestone';
          }
          return null;
        };
        const [fk, tk] = [kindOf(from), kindOf(to)];
        if (!fk || !tk) return fail(`依存の端点（${fk ? c.to : c.from}）が見つかりません`);
        cmd = { type: 'addDependency', dependency: { id, from: { kind: fk, id: from }, to: { kind: tk, id: to }, type: c.kind ?? 'FS', lagDays: c.lagDays ?? 0 } };
        break;
      }
      case 'updateDependency':
        cmd = { type: 'updateDependency', id: resolve(c.dependencyId), patch: defined({ type: c.kind, lagDays: c.lagDays }) };
        break;
      case 'deleteDependency':
        cmd = { type: 'deleteDependency', id: resolve(c.dependencyId) };
        break;
    }
    const r = applyCommand(cur, cmd);
    if (!r.ok) return fail(r.error.message);
    cur = r.schedule;
    commands.push(cmd);
  }
  return {
    ok: true,
    summary: cs.summary,
    rationale: cs.rationale,
    command: { type: 'batch', commands, label: `AI 提案: ${cs.summary}` },
    after: cur,
    lines: diffSchedule(s, cur).map(summarizeChange),
    changeCount: cs.changes.length,
    newIssues: newIssues(s, cur),
  };
}
