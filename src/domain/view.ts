// @req F-403
// 保存したビュー（名前付き）。表示の絞り込み・日付ヘッダ・依存線の表示・折りたたみを保存し、切り替えられる。
// チーム共有のビューは Git の views/<id>.json（他のデータと同じ出力規則）、個人用はローカル（この PC）。docs/data-model.html 2。
import { z } from 'zod';
import { idSchema, type Id } from './model';
import { stableStringify, type Files } from './serialize';

export const viewFilterSchema = z.strictObject({
  text: z.string().max(200).optional(),
  statuses: z.array(z.enum(['notStarted', 'inProgress', 'done', 'onHold'])).max(4).optional(),
  assignees: z.array(z.string().max(200)).max(200).optional(),
  tags: z.array(z.string().max(100)).max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const viewSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(200),
  /** チームで共有する（Git の views/）か、個人用（この PC のみ）か。 */
  shared: z.boolean(),
  filter: viewFilterSchema,
  headerMode: z.enum(['weekMonth', 'month']),
  dependencies: z.enum(['all', 'selected', 'none']),
  /** 折りたたんだプロジェクト。 */
  collapsed: z.array(idSchema).max(5000),
});
export type SavedView = z.infer<typeof viewSchema>;

export const VIEW_PATH_RE = /^views\/[A-Za-z0-9_-]+\.json$/;
export const viewPath = (id: Id): string => `views/${id}.json`;
export const serializeView = (v: SavedView): string => stableStringify(v);

export function parseView(text: string): { readonly ok: true; readonly view: SavedView } | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `JSON として読めない: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = viewSchema.safeParse(raw);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.map(String).join('.') || '値'}: ${i.message}`).join(' / ') };
  return { ok: true, view: r.data };
}

/** views/ のファイルを読む（共有ビュー）。読めないものは errors に入れ、他は読む。 */
export function parseViews(files: Files): { views: SavedView[]; errors: { path: string; message: string }[] } {
  const views: SavedView[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith('views/')) continue;
    const r = parseView(text);
    if (!r.ok) errors.push({ path, message: r.message });
    else if (path !== viewPath(r.view.id)) errors.push({ path, message: `ファイル名と id「${r.view.id}」が一致しない` });
    else views.push({ ...r.view, shared: true });
  }
  return { views, errors };
}
