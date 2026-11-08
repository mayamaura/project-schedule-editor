// @req F-701, F-702, F-703, F-705
// テスト用の決定的なプロバイダ（本物の AI を使わずに、ツール呼び出し → 提案・指摘 → 画面の流れを確かめる）。
// 本番では使われない（createProvider は、パッケージ版では PSE_AI_MOCK を見ない）。単体テストと E2E が使う。
import { addDays } from '../../domain/date';
import type { AiProvider, AiRunInput, AiStatus } from './provider';

interface ProjectJson {
  readonly id: string;
  readonly events: readonly { id: string; name: string; start: string; end: string }[];
}

export class MockProvider implements AiProvider {
  readonly id = 'mock';
  /** 受け取った依頼（テストでの確認用）。 */
  readonly calls: AiRunInput[] = [];
  constructor(private readonly opt: { available?: boolean; reason?: string; delayMs?: number; models?: readonly string[] } = {}) {}

  status(): Promise<AiStatus> {
    return Promise.resolve({ available: this.opt.available ?? true, ...(this.opt.reason ? { reason: this.opt.reason } : {}), models: this.opt.models ?? ['mock-small', 'mock-large'] });
  }

  async run(i: AiRunInput): Promise<void> {
    this.calls.push(i);
    const request = /<request>\n([\s\S]*?)\n<\/request>/.exec(i.user)?.[1] ?? '';
    const stream = async (text: string): Promise<void> => {
      for (const ch of text.match(/.{1,6}/gs) ?? []) {
        if (i.signal.aborted) return;
        i.onText(ch);
        if (this.opt.delayMs) await new Promise((r) => setTimeout(r, this.opt.delayMs));
      }
    };
    const data = JSON.parse(i.toolbox.invoke('get_schedule', {})) as { projects: ProjectJson[] };
    const first = data.projects.flatMap((p) => p.events)[0];
    const two = data.projects.flatMap((p) => p.events).slice(0, 2);
    if (/まとめて/.test(request) && two.length === 2) {
      await stream('2 つのイベントをまとめて延ばす案です。');
      const res = i.toolbox.invoke('propose_changes', { summary: '2 件をまとめて 1 週間延ばす', changes: two.map((e) => ({ op: 'updateEvent', eventId: e.id, end: addDays(e.end, 7) })) });
      await stream(`\n${res}`);
    } else if (/延ば|後ろ倒し|変更/.test(request) && first) {
      await stream('設計を 2 週間延ばす案を作ります。');
      const res = i.toolbox.invoke('propose_changes', { summary: `「${first.name}」を 2 週間延ばす`, rationale: '依頼どおりに終了日を 14 日後ろへ', changes: [{ op: 'updateEvent', eventId: first.id, end: addDays(first.end, 14) }] });
      await stream(`\n${res}`);
    } else if (/評価|指摘|矛盾|確認/.test(request) && first) {
      await stream('日程を確認しました。');
      i.toolbox.invoke('report_findings', { findings: [{ category: 'evaluation', severity: 'warning', title: '余裕が少ない可能性', detail: `「${first.name}」の後続との間に余裕がありません`, refs: [{ kind: 'event', id: first.id }] }] });
    } else if (/再提案|不正/.test(request)) {
      await stream('不正な提案を試します。');
      const bad = i.toolbox.invoke('propose_changes', { summary: 'x', changes: [{ op: 'updateEvent', eventId: 'does-not-exist', end: '2027-01-01' }] });
      await stream(`\n${bad}`);
    } else {
      await stream(`受け取りました: ${request.slice(0, 40)}`);
    }
  }
}
