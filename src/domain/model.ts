// @req F-301, NF-006
// データモデル（型と zod スキーマ）。docs/data-model.html 1, 11。
// スキーマは「構造」を検証する。意味の検証（終了＜開始、依存違反など）は validate.ts / commands.ts が行う
// （外部で編集された不整合なデータを、読み込めたうえで警告・修復できるようにするため）。
import { z } from 'zod';
import { isDateStr } from './date';

export const SCHEMA_VERSION = 1;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const idSchema = z.string().regex(ID_PATTERN, 'ID は英数字・_・- の1〜64文字');
export const dateSchema = z.string().refine(isDateStr, '不正な日付（YYYY-MM-DD）');
const nameSchema = z.string().min(1, '名称が空').max(500);
const textSchema = z.string().max(20000);
const orderSchema = z.string().regex(/^[0-9a-z]*[1-9a-z]$/, '並び順は 0-9a-z で末尾が 0 でない');

export const eventStyleSchema = z.enum(['bar', 'roundBar', 'line', 'band', 'outline', 'striped']);
export const milestoneStyleSchema = z.enum(['diamond', 'circle', 'triangle', 'square', 'star', 'flag', 'labelOnly']);

export const eventSchema = z.strictObject({
  name: nameSchema,
  start: dateSchema,
  end: dateSchema,
  type: z.string().max(64),
  color: z.string().max(32).optional(),
  style: eventStyleSchema.optional(),
  note: textSchema.optional(),
});

export const milestoneSchema = z.strictObject({
  name: nameSchema,
  date: dateSchema,
  type: z.string().max(64),
  style: milestoneStyleSchema.optional(),
  note: textSchema.optional(),
});

export const projectSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  parentId: idSchema.nullable(),
  order: orderSchema,
  status: z.enum(['notStarted', 'inProgress', 'done', 'onHold']).optional(),
  assignee: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).optional(),
  color: z.string().max(32).optional(),
  note: textSchema.optional(),
  events: z.record(idSchema, eventSchema),
  milestones: z.record(idSchema, milestoneSchema),
});

export const endpointSchema = z.strictObject({ kind: z.enum(['event', 'milestone']), id: idSchema });

export const dependencySchema = z.strictObject({
  id: idSchema,
  from: endpointSchema,
  to: endpointSchema,
  type: z.enum(['FS', 'SS', 'FF', 'SF']),
  lagDays: z.number().int().min(-36500).max(36500),
});

export const typeDefSchema = z.strictObject({
  name: nameSchema,
  color: z.string().max(32),
  eventStyle: eventStyleSchema.optional(),
  milestoneStyle: milestoneStyleSchema.optional(),
});

export const typesSchema = z.record(z.string().max(64), typeDefSchema);
export const metaSchema = z.strictObject({ schemaVersion: z.number().int().min(1) });

export type Id = string;
export type EventData = z.infer<typeof eventSchema>;
export type MilestoneData = z.infer<typeof milestoneSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type Dependency = z.infer<typeof dependencySchema>;
export type TypeDef = z.infer<typeof typeDefSchema>;

/** 日程データ全体（不変データとして扱う。更新は変更部分だけ新しいオブジェクトにする）。 */
export interface Schedule {
  readonly schemaVersion: number;
  readonly projects: Readonly<Record<Id, Project>>;
  readonly dependencies: Readonly<Record<Id, Dependency>>;
  readonly types: Readonly<Record<string, TypeDef>>;
}

export function emptySchedule(): Schedule {
  return { schemaVersion: SCHEMA_VERSION, projects: {}, dependencies: {}, types: {} };
}

/** イベント・マイルストーンを共通に扱うための索引エントリ。 */
export interface ItemRef {
  readonly kind: 'event' | 'milestone';
  readonly id: Id;
  readonly projectId: Id;
  readonly start: string;
  readonly end: string;
}

/** 全プロジェクトのイベント・マイルストーンの索引（ID → 参照）。重複 ID は最初のものを採用する。 */
export function buildItemIndex(s: Schedule): Map<Id, ItemRef> {
  const map = new Map<Id, ItemRef>();
  for (const p of Object.values(s.projects)) {
    for (const [id, e] of Object.entries(p.events)) {
      if (!map.has(id)) map.set(id, { kind: 'event', id, projectId: p.id, start: e.start, end: e.end });
    }
    for (const [id, m] of Object.entries(p.milestones)) {
      if (!map.has(id)) map.set(id, { kind: 'milestone', id, projectId: p.id, start: m.date, end: m.date });
    }
  }
  return map;
}
