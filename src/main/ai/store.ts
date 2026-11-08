// @req F-708, F-709, F-710, F-712, F-713
// AI の個人設定（有効/無効・モデル・件数の警告しきい値・個人用の指示）と、会話・提案のログ。
// 保存先はアプリのデータ領域（ローカル。Git 管理外。他の人には共有されない）。利用者が削除できる（F-710）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findingSchema } from '../../domain/ai/tools';
import { promptTemplateSchema } from '../../domain/ai/prompt';
import { writeAtomic } from '../fileRepository';

export const settingsSchema = z.object({
  /** AI 機能の個人設定（既定は有効。使えない環境では、有効でも画面に理由が出て AI だけが無効になる）。 */
  enabled: z.boolean().default(true),
  model: z.string().max(200).nullable().default(null),
  /** 一度に適用する変更が、この件数を超える提案は警告して再確認を求める（F-709）。 */
  maxChanges: z.number().int().min(1).max(200).default(20),
  /** 個人用の指示・観点（ローカルのみ）。チーム共有用は Git の ai-prompts/。 */
  prompts: z.array(promptTemplateSchema).default([]),
});
export type AiSettings = z.infer<typeof settingsSchema>;

export const historyEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['chat', 'evaluate', 'check']),
  request: z.string(),
  scope: z.string(),
  answer: z.string(),
  error: z.string().optional(),
  proposals: z.array(z.object({ id: z.string(), summary: z.string(), lines: z.array(z.string()), changeCount: z.number(), applied: z.boolean() })),
  findings: z.array(findingSchema),
});
export type AiHistoryEntry = z.infer<typeof historyEntrySchema>;

const MAX_HISTORY = 200;

export class AiStore {
  constructor(private readonly dir: string) {}
  private file(name: string): string {
    return join(this.dir, name);
  }
  private read<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
    try {
      const f = this.file(name);
      if (!existsSync(f)) return fallback;
      const r = schema.safeParse(JSON.parse(readFileSync(f, 'utf8')));
      return r.success ? r.data : fallback;
    } catch {
      return fallback;
    }
  }

  settings(): AiSettings {
    return this.read('ai-settings.json', settingsSchema, settingsSchema.parse({}));
  }
  saveSettings(patch: Partial<AiSettings>): AiSettings {
    const next = settingsSchema.parse({ ...this.settings(), ...patch });
    writeAtomic(this.file('ai-settings.json'), JSON.stringify(next, null, 2));
    return next;
  }

  history(): AiHistoryEntry[] {
    return this.read('ai-history.json', z.array(historyEntrySchema), []);
  }
  private saveHistory(list: AiHistoryEntry[]): void {
    writeAtomic(this.file('ai-history.json'), JSON.stringify(list.slice(-MAX_HISTORY)));
  }
  addHistory(e: AiHistoryEntry): void {
    this.saveHistory([...this.history(), e]);
  }
  /** 提案を承認して適用したことを記録する。 */
  markApplied(entryId: string, proposalId: string): void {
    this.saveHistory(this.history().map((e) => (e.id === entryId ? { ...e, proposals: e.proposals.map((p) => (p.id === proposalId ? { ...p, applied: true } : p)) } : e)));
  }
  /** 利用者による削除（id を省くと全て）。 */
  deleteHistory(id?: string): void {
    this.saveHistory(id === undefined ? [] : this.history().filter((e) => e.id !== id));
  }
}
