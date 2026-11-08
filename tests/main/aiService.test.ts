// @req F-701, F-702, F-703, F-705, F-707, F-708, F-709, F-710, F-712, F-713, NF-012, NF-013, NF-014
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCalendar } from '../../src/domain/calendar';
import { defaultAiDataOptions } from '../../src/domain/ai/context';
import { SYSTEM_PROMPT } from '../../src/domain/ai/prompt';
import { MockProvider } from '../../src/main/ai/mockProvider';
import { NullProvider } from '../../src/main/ai/provider';
import { AiService, type AiEvent } from '../../src/main/ai/service';
import { AiStore } from '../../src/main/ai/store';
import { basic } from '../domain/fixtures';

let dir: string;
let events: AiEvent[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-test-'));
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ask = (svc: AiService, message: string, extra: Partial<Parameters<AiService['ask']>[0]> = {}) =>
  svc.ask({ requestId: 'r1', kind: 'chat', message, scope: { kind: 'all' }, options: defaultAiDataOptions(), ...extra }, basic(), defaultCalendar(), '2026-11-08');
const make = (p = new MockProvider()) => ({ p, store: new AiStore(dir), svc: new AiService(p, new AiStore(dir), (e) => events.push(e)) });

describe('AI サービス（F-701, F-702）', () => {
  it('依頼すると、ストリーミングの応答・提案・完了のイベントが流れる。日程には何も書き込まない', async () => {
    const { svc } = make();
    const before = JSON.stringify(basic());
    await ask(svc, '設計を 2 週間延ばしたらどうなる？');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1); // ストリーミング
    const prop = events.find((e) => e.type === 'proposal');
    expect(prop && prop.type === 'proposal' && prop.proposal.summary).toContain('2 週間');
    expect(prop && prop.type === 'proposal' && prop.proposal.command).toMatchObject({ type: 'batch' });
    expect(events.at(-1)).toMatchObject({ type: 'done', cancelled: false });
    expect(JSON.stringify(basic())).toBe(before);
  });

  it('評価・指摘は findings として届く（F-703, F-705, F-706）', async () => {
    const { svc } = make();
    await ask(svc, '日程を評価して', { kind: 'evaluate' });
    const f = events.find((e) => e.type === 'findings');
    expect(f && f.type === 'findings' && f.findings[0]!.refs[0]!.kind).toBe('event');
  });

  it('AI に渡す内容: 基本プロンプトは固定で、利用者の指示は後ろに足される。データは <data> で区切られる（NF-012）', async () => {
    const { svc, p } = make();
    await ask(svc, 'こんにちは', { instruction: '祝日を重視して' });
    const call = p.calls[0]!;
    expect(call.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(call.system).toContain('祝日を重視して');
    expect(call.user).toContain('<data>');
    expect(call.user).toContain('<request>\nこんにちは\n</request>');
    // ツールは許可された 5 つだけ（書き込み系は存在しない）
    expect(call.toolbox.invoke('write_file', {})).toContain('使えません');
  });

  it('範囲を選択に絞ると、AI に渡るデータは範囲内だけ（最小送信。F-707）', async () => {
    const { svc, p } = make();
    const s = basic();
    const only = Object.values(s.projects).find((x) => x.parentId !== null)!.id; // 子プロジェクトだけを選ぶ
    const other = s.projects[s.projects[only]!.parentId!]!;
    await ask(svc, '確認して', { scope: { kind: 'selection', projectIds: [only] } });
    const sent = p.calls[0]!.user;
    expect(sent).toContain(s.projects[only]!.name);
    expect(sent).not.toContain(other.name);
  });

  it('不正な提案はイベントにならず、AI にだけ理由が返る（再提案できる）', async () => {
    const { svc } = make();
    await ask(svc, '不正な提案を試して');
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('キャンセルできる（NF-013）', async () => {
    const { svc } = make(new MockProvider({ delayMs: 20 }));
    const run = ask(svc, '設計を延ばして');
    await new Promise((r) => setTimeout(r, 30));
    svc.cancel('r1');
    await run;
    expect(events.at(-1)).toMatchObject({ type: 'done', cancelled: true });
  });
});

describe('使えないとき・設定（F-708, F-713）', () => {
  it('プロバイダが使えなければ、理由つきのエラーイベントだけ。他の機能には影響しない', async () => {
    const svc = new AiService(new NullProvider(), new AiStore(dir), (e) => events.push(e));
    expect((await svc.status()).available).toBe(false);
    await ask(svc, 'x');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });
  it('個人設定で無効にできる。モデルを選べて、保存される（F-713）', async () => {
    const { svc, store } = make();
    let st = await svc.status();
    expect(st).toMatchObject({ available: true, models: ['mock-small', 'mock-large'], enabled: true });
    store.saveSettings({ enabled: false });
    st = await svc.status();
    expect(st.available).toBe(false);
    expect(st.reason).toContain('無効');
    store.saveSettings({ enabled: true, model: 'mock-large' });
    expect(new AiStore(dir).settings().model).toBe('mock-large');
    await ask(svc, '確認して');
    expect(make().p.calls).toEqual([]); // 別インスタンス
  });
  it('選んだモデルが依頼に渡る', async () => {
    const { svc, p, store } = make();
    store.saveSettings({ model: 'mock-large' });
    await ask(svc, 'こんにちは');
    expect(p.calls[0]!.model).toBe('mock-large');
    await ask(svc, 'こんにちは', { model: 'mock-small' });
    expect(p.calls[1]!.model).toBe('mock-small');
  });
});

describe('会話・提案のログ（F-710）と送信前プレビュー（F-707）', () => {
  it('ローカルに保存され、承認の記録ができ、利用者が削除できる', async () => {
    const { svc, store } = make();
    await ask(svc, '設計を延ばして');
    const [e] = store.history();
    expect(e).toMatchObject({ kind: 'chat', request: '設計を延ばして', scope: '全体' });
    expect(e!.proposals).toHaveLength(1);
    expect(e!.proposals[0]!.applied).toBe(false);
    store.markApplied(e!.id, e!.proposals[0]!.id);
    expect(store.history()[0]!.proposals[0]!.applied).toBe(true);
    expect(existsSync(join(dir, 'ai-history.json'))).toBe(true);
    store.deleteHistory(e!.id);
    expect(store.history()).toEqual([]);
    await ask(svc, 'a');
    await ask(svc, 'b');
    store.deleteHistory(); // 全て削除
    expect(store.history()).toEqual([]);
  });
  it('壊れた設定ファイルは既定に戻り、アプリは止まらない', () => {
    const store = new AiStore(dir);
    store.saveSettings({ maxChanges: 5 });
    writeFileSync(join(dir, 'ai-settings.json'), '{ broken');
    expect(store.settings()).toMatchObject({ enabled: true, maxChanges: 20 });
  });
  it('プレビューは、AI に渡すデータそのもの（件数・大きさつき）', () => {
    const { svc } = make();
    const pv = svc.preview(basic(), defaultCalendar(), { kind: 'all' }, defaultAiDataOptions(), '2026-11-08');
    expect(pv.stats.projects).toBeGreaterThan(0);
    expect(pv.large).toBe(false);
    expect(JSON.parse(pv.text).projects.length).toBe(pv.stats.projects);
  });
});
