// @req F-701, F-702, F-703, F-705, F-707, F-708, F-710, NF-012, NF-013, NF-015
// AI サービス（Main）。1 回の依頼を、範囲の決定 → データとプロンプトの組み立て → プロバイダの実行 → 提案・指摘の回収、まで進め、
// 結果をイベントで画面へ流す（ストリーミング・キャンセル可。待機中も他の編集は止まらない）。
// 日程には一切書き込まない: 回収するのは AiToolbox が検証した「提案」と「指摘」だけで、適用は画面で利用者が承認したとき。
import { randomUUID } from 'node:crypto';
import type { Calendar } from '../../domain/calendar';
import { buildSystemPrompt, buildUserMessage } from '../../domain/ai/prompt';
import { buildAiContext, LARGE_CONTEXT_CHARS, type AiDataOptions, type AiScope } from '../../domain/ai/context';
import { AiToolbox, type Finding, type Proposal } from '../../domain/ai/tools';
import type { Schedule } from '../../domain/model';
import type { AiProvider } from './provider';
import type { AiStore } from './store';

export type AiEvent =
  | { readonly requestId: string; readonly type: 'text'; readonly delta: string }
  | { readonly requestId: string; readonly type: 'proposal'; readonly proposal: Proposal }
  | { readonly requestId: string; readonly type: 'findings'; readonly findings: readonly Finding[] }
  /** 完了。entryId は会話ログの id（提案を承認したときの記録に使う）。cancelled = 利用者が中止した。 */
  | { readonly requestId: string; readonly type: 'done'; readonly entryId: string; readonly cancelled: boolean }
  | { readonly requestId: string; readonly type: 'error'; readonly message: string };

export interface AskInput {
  readonly requestId: string;
  readonly kind: 'chat' | 'evaluate' | 'check';
  readonly message: string;
  readonly scope: AiScope;
  readonly options: AiDataOptions;
  /** 利用者が選んだ指示・観点の本文。 */
  readonly instruction?: string;
  readonly model?: string;
}

const scopeLabel = (s: AiScope): string => (s.kind === 'selection' ? `選択したプロジェクト（${s.projectIds.length} 件）` : s.kind === 'view' ? `表示中の期間（${s.from}〜${s.to}）` : '全体');

export class AiService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly provider: AiProvider,
    private readonly store: AiStore,
    private readonly send: (e: AiEvent) => void,
  ) {}

  async status(): Promise<{ available: boolean; reason?: string; models: string[]; enabled: boolean; model: string | null; maxChanges: number }> {
    const st = await this.provider.status().catch((e: unknown) => ({ available: false, reason: e instanceof Error ? e.message : String(e), models: [] as string[] }));
    const s = this.store.settings();
    return { ...st, models: [...st.models], available: st.available && s.enabled, ...(s.enabled ? (st.reason ? { reason: st.reason } : {}) : { reason: 'AI 機能は、設定で無効にされています' }), enabled: s.enabled, model: s.model, maxChanges: s.maxChanges };
  }

  /** 送信前のプレビュー（F-707）。AI に渡すテキストそのもの。 */
  preview(schedule: Schedule, calendar: Calendar, scope: AiScope, options: AiDataOptions, today: string): { text: string; stats: { projects: number; events: number; milestones: number; dependencies: number; chars: number }; large: boolean } {
    const c = buildAiContext(schedule, calendar, scope, options, today);
    return { text: c.text, stats: c.stats, large: c.stats.chars > LARGE_CONTEXT_CHARS };
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort();
  }

  /** 依頼を実行する。結果はイベントで流す。 */
  async ask(input: AskInput, schedule: Schedule, calendar: Calendar, today: string): Promise<void> {
    const st = await this.status();
    const entryId = randomUUID();
    const answer: string[] = [];
    const emit = (e: AiEvent): void => this.send(e);
    if (!st.available) {
      emit({ requestId: input.requestId, type: 'error', message: st.reason ?? 'AI を使えません' });
      return;
    }
    const controller = new AbortController();
    this.running.set(input.requestId, controller);
    const toolbox = new AiToolbox(schedule, calendar, input.scope, input.options, today);
    let error: string | undefined;
    try {
      await this.provider.run({
        system: buildSystemPrompt(input.instruction),
        user: buildUserMessage(input.message, toolbox.context.text),
        model: input.model ?? st.model ?? undefined,
        toolbox,
        signal: controller.signal,
        onText: (delta) => {
          answer.push(delta);
          emit({ requestId: input.requestId, type: 'text', delta });
        },
      });
      for (const p of toolbox.proposals) emit({ requestId: input.requestId, type: 'proposal', proposal: p });
      if (toolbox.findings.length > 0) emit({ requestId: input.requestId, type: 'findings', findings: toolbox.findings });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      emit({ requestId: input.requestId, type: 'error', message: error });
    } finally {
      this.running.delete(input.requestId);
    }
    // 会話・提案のログ（ローカルのみ。利用者が削除できる。F-710）
    this.store.addHistory({
      id: entryId,
      at: new Date().toISOString(),
      kind: input.kind,
      request: input.message,
      scope: scopeLabel(input.scope),
      answer: answer.join(''),
      ...(error ? { error } : controller.signal.aborted ? { error: '中止しました' } : {}),
      proposals: toolbox.proposals.map((p) => ({ id: p.id, summary: p.summary, lines: [...p.lines], changeCount: p.changeCount, applied: false })),
      findings: toolbox.findings,
    });
    if (!error) emit({ requestId: input.requestId, type: 'done', entryId, cancelled: controller.signal.aborted });
  }
}
