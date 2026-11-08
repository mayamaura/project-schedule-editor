// @req F-702, F-703, F-705, F-706, NF-012
// AI に公開するツール（読み取りと提案作成のみ）。SDK に依存しない純 TypeScript。SDK のアダプタ（src/main/ai/）は、
// ここの toolSpecs を defineTool に写し、呼ばれたら AiToolbox.invoke に渡すだけにする（SDK の差し替えに備える。NF-014）。
// 書き込み・ファイル・シェル系のツールは存在しない。範囲外のデータは読めず、範囲外への提案も拒否する。
import { z } from 'zod';
import type { Calendar } from '../calendar';
import type { DateStr } from '../date';
import type { Command } from '../commands';
import type { Id, Schedule } from '../model';
import { buildAiContext, type AiContext, type AiDataOptions, type AiScope } from './context';
import { changeSetSchema, evaluateChangeSet, referencedIds } from './changeset';

const ref = z.string().min(1).max(80);

export const findingSchema = z.strictObject({
  category: z.enum(['evaluation', 'contradiction']),
  severity: z.enum(['info', 'warning']),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000),
  refs: z.array(z.strictObject({ kind: z.enum(['project', 'event', 'milestone', 'dependency']), id: ref })).max(20),
});
export type Finding = z.infer<typeof findingSchema>;
export const findingsInputSchema = z.strictObject({ findings: z.array(findingSchema).min(1).max(50) });

export interface Proposal {
  readonly id: string;
  readonly summary: string;
  readonly rationale: string | undefined;
  /** 承認後に commit するコマンド（batch）。 */
  readonly command: Command;
  readonly lines: readonly string[];
  readonly changeCount: number;
  /** この提案で新たに生じる指摘の文言。 */
  readonly newIssues: readonly string[];
}

export const TOOL_NAMES = ['get_schedule', 'get_validation_issues', 'get_calendar', 'propose_changes', 'report_findings'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** SDK のアダプタが公開するツールの定義（名前・説明・引数のスキーマ）。ここに無いツールは許可しない。 */
export const toolSpecs: readonly { readonly name: ToolName; readonly description: string; readonly schema: z.ZodType }[] = [
  { name: 'get_schedule', description: '依頼の対象範囲の日程データ（プロジェクト・イベント・マイルストーン・依存・祝日カレンダー・ルールベースの指摘）を JSON で返す。読み取りのみ。', schema: z.strictObject({}) },
  { name: 'get_validation_issues', description: '範囲内のルールベースの指摘（依存違反・循環・期間の逸脱など）を返す。読み取りのみ。', schema: z.strictObject({}) },
  { name: 'get_calendar', description: '祝日・会社の休日・休みの曜日・特別稼働日の設定を返す。読み取りのみ。', schema: z.strictObject({}) },
  { name: 'propose_changes', description: '日程の変更を「提案」として作る。日程は書き換わらない（利用者が差分を確認して承認したときだけ反映される）。不正なときは理由が返るので直して再提案する。', schema: changeSetSchema },
  { name: 'report_findings', description: '評価・矛盾の指摘を報告する（確定ではなく「指摘・疑い」）。根拠と、該当するプロジェクト・イベント・マイルストーン・依存の ID を付ける。', schema: findingsInputSchema },
];

export const isAllowedTool = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

export class AiToolbox {
  readonly context: AiContext;
  readonly proposals: Proposal[] = [];
  readonly findings: Finding[] = [];
  private n = 0;

  constructor(
    private readonly schedule: Schedule,
    private readonly calendar: Calendar,
    scope: AiScope,
    options: AiDataOptions,
    today: DateStr,
    private readonly rand?: () => number,
  ) {
    this.context = buildAiContext(schedule, calendar, scope, options, today);
  }

  /** ツールの呼び出し。許可されていない名前・不正な引数は、実行せずに理由を返す（権限ハンドラの代わり）。 */
  invoke(name: string, args: unknown): string {
    if (!isAllowedTool(name)) return `ツール「${name}」は使えません。使えるのは ${TOOL_NAMES.join(' / ')} だけです。`;
    switch (name) {
      case 'get_schedule':
        return this.context.text;
      case 'get_validation_issues':
        return JSON.stringify(this.context.issues.map((i) => ({ rule: i.rule, severity: i.severity, target: i.target, message: i.message })));
      case 'get_calendar':
        return JSON.stringify({ weekend: this.calendar.weekend, japaneseHolidays: this.calendar.japaneseHolidays, companyHolidays: this.calendar.holidays, extraWorkdays: this.calendar.workdays });
      case 'propose_changes':
        return this.proposeChanges(args);
      case 'report_findings':
        return this.reportFindings(args);
    }
  }

  private proposeChanges(input: unknown): string {
    const parsed = changeSetSchema.safeParse(input);
    if (parsed.success) {
      // 範囲外の項目への提案は拒否する（最小送信の範囲を、AI が超えない）
      const temps = new Set(parsed.data.changes.flatMap((c) => ('tempId' in c && c.tempId ? [c.tempId] : [])));
      const outside = referencedIds(parsed.data).filter((id) => !temps.has(id) && !this.context.ids.has(id));
      if (outside.length > 0) return `提案は受け付けられません: 依頼の対象範囲にない項目（${[...new Set(outside)].join(', ')}）が含まれています。範囲内の ID だけを使ってください。`;
    }
    const r = evaluateChangeSet(this.schedule, input, this.rand);
    if (!r.ok) return `提案は受け付けられません: ${r.message}`;
    this.proposals.push({
      id: `p${++this.n}`,
      summary: r.summary,
      rationale: r.rationale,
      command: r.command,
      lines: r.lines,
      changeCount: r.changeCount,
      newIssues: r.newIssues.map((i) => i.message),
    });
    const warn = r.newIssues.length > 0 ? ` ただし、この提案を適用すると新たに ${r.newIssues.length} 件の指摘が出ます（${r.newIssues.slice(0, 3).map((i) => i.message).join(' / ')}）。必要なら直して再提案してください。` : '';
    return `提案を受け付けました（${r.changeCount} 件の変更）。日程はまだ変わっていません。利用者が差分を確認して承認したときだけ反映されます。${warn}`;
  }

  private reportFindings(input: unknown): string {
    const parsed = findingsInputSchema.safeParse(input);
    if (!parsed.success) return `報告は受け付けられません: ${parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join(' / ')}`;
    let dropped = 0;
    for (const f of parsed.data.findings) {
      const refs = f.refs.filter((r) => {
        const ok = this.context.ids.has(r.id);
        if (!ok) dropped++;
        return ok;
      });
      this.findings.push({ ...f, refs });
    }
    return `${parsed.data.findings.length} 件の報告を受け付けました。${dropped > 0 ? `存在しない ID への参照 ${dropped} 件は外しました。` : ''}`;
  }
}

export type { Id };
