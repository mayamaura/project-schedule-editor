// @req F-701, F-708, F-713, NF-012, NF-014
// Copilot SDK のアダプタを、SDK の偽物で検証する（実 LLM・実契約は使わない）。ツールの制限・権限の拒否・ストリーミング・中止・
// 使えないときの理由を確かめる。実契約での動作は、別途の実機検証（docs/architecture.html 17）。
import { describe, expect, it } from 'vitest';
import { defaultCalendar } from '../../src/domain/calendar';
import { defaultAiDataOptions } from '../../src/domain/ai/context';
import { AiToolbox, toolSpecs } from '../../src/domain/ai/tools';
import { CopilotProvider, type SdkClientLike, type SdkModuleLike, type SdkSessionLike } from '../../src/main/ai/copilot';
import { basic } from '../domain/fixtures';

type Handler = (e: { data: Record<string, unknown> }) => void;

class FakeSession implements SdkSessionLike {
  handlers = new Map<string, Handler[]>();
  aborted = false;
  disconnected = false;
  sent: string[] = [];
  /** send されたときに実行する台本（イベントの発火・ツール呼び出し）。 */
  script: (s: FakeSession) => Promise<void> = async (s) => s.emit('session.idle', {});
  constructor(readonly config: Record<string, unknown>) {}
  on(type: string, h: Handler): () => void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
    return () => this.handlers.set(type, (this.handlers.get(type) ?? []).filter((x) => x !== h));
  }
  emit(type: string, data: Record<string, unknown>): void {
    for (const h of this.handlers.get(type) ?? []) h({ data });
  }
  async send(o: { prompt: string }): Promise<void> {
    this.sent.push(o.prompt);
    void this.script(this);
  }
  async abort(): Promise<void> {
    this.aborted = true;
    this.emit('session.idle', {});
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function fakeSdk(opt: { authenticated?: boolean; authMessage?: string; models?: { id: string; policy?: { state?: string } }[]; startError?: string; script?: FakeSession['script'] } = {}) {
  const sessions: FakeSession[] = [];
  const calls = { start: 0, stop: 0 };
  const client: SdkClientLike = {
    start: async () => {
      calls.start++;
      if (opt.startError) throw new Error(opt.startError);
    },
    stop: async () => {
      calls.stop++;
    },
    getAuthStatus: async () => ({ isAuthenticated: opt.authenticated ?? true, ...(opt.authMessage ? { statusMessage: opt.authMessage } : {}) }),
    listModels: async () => opt.models ?? [{ id: 'gpt-5' }, { id: 'claude-sonnet-4.5' }, { id: 'old', policy: { state: 'disabled' } }],
    createSession: async (config) => {
      const s = new FakeSession(config);
      if (opt.script) s.script = opt.script;
      sessions.push(s);
      return s;
    },
  };
  const defined: { name: string; config: Record<string, unknown> }[] = [];
  const sdk: SdkModuleLike = {
    CopilotClient: function () {
      return client;
    } as unknown as SdkModuleLike['CopilotClient'],
    defineTool: (name, config) => {
      defined.push({ name, config });
      return { name, ...config };
    },
    ToolSet: class {
      items: string[] = [];
      addCustom(n: string) {
        this.items.push(`custom:${n}`);
        return this;
      }
      toArray() {
        return this.items;
      }
    } as unknown as SdkModuleLike['ToolSet'],
  };
  return { sdk, sessions, calls, defined };
}

const input = (toolbox: AiToolbox, over: Partial<Parameters<CopilotProvider['run']>[0]> = {}) => {
  const text: string[] = [];
  return { text, i: { system: 'SYSTEM', user: 'USER', model: undefined, toolbox, signal: new AbortController().signal, onText: (d: string) => text.push(d), ...over } };
};
const box = () => new AiToolbox(basic(), defaultCalendar(), { kind: 'all' }, defaultAiDataOptions(), '2026-11-08');

describe('状態（F-708, F-713）', () => {
  it('サインイン済みなら使え、無効化されたモデルを除いたモデル一覧を返す', async () => {
    const f = fakeSdk();
    const st = await new CopilotProvider(async () => f.sdk).status();
    expect(st).toEqual({ available: true, models: ['gpt-5', 'claude-sonnet-4.5'] });
  });
  it('未サインインなら、理由つきで使えない（AI だけが無効）', async () => {
    const f = fakeSdk({ authenticated: false, authMessage: 'not logged in' });
    const st = await new CopilotProvider(async () => f.sdk).status();
    expect(st.available).toBe(false);
    expect(st.reason).toContain('サインイン');
    expect(st.reason).toContain('not logged in');
  });
  it('SDK を読み込めない・実行本体を起動できないときも、例外にせず理由を返す。次の確認でやり直せる', async () => {
    const p = new CopilotProvider(async () => {
      throw new Error('module not found');
    });
    expect((await p.status()).reason).toContain('接続できません');
    const f = fakeSdk({ startError: 'spawn failed' });
    const q = new CopilotProvider(async () => f.sdk);
    expect((await q.status()).reason).toContain('spawn failed');
    await q.status();
    expect(f.calls.start).toBe(2); // 失敗は覚えず、もう一度試す
  });
  it('モデル一覧が取れなくても、AI は使える', async () => {
    const f = fakeSdk();
    f.sdk.CopilotClient = function () {
      return { ...(({}) as object), start: async () => undefined, stop: async () => undefined, getAuthStatus: async () => ({ isAuthenticated: true }), listModels: async () => { throw new Error('x'); }, createSession: async () => { throw new Error('unused'); } };
    } as unknown as SdkModuleLike['CopilotClient'];
    expect(await new CopilotProvider(async () => f.sdk).status()).toEqual({ available: true, models: [] });
  });
});

describe('依頼の実行（F-701, NF-012, NF-013）', () => {
  it('セッションは、カスタムツールだけを許可し、組み込み・MCP ツールを無効化し、空の一時フォルダで動く', async () => {
    const f = fakeSdk();
    const { i } = input(box(), { model: 'gpt-5' });
    await new CopilotProvider(async () => f.sdk).run(i);
    const cfg = f.sessions[0]!.config;
    expect(cfg['model']).toBe('gpt-5');
    expect(cfg['streaming']).toBe(true);
    expect((cfg['availableTools'] as { toArray(): string[] }).toArray()).toEqual(['custom:*']);
    expect(cfg['excludedTools']).toEqual(['builtin:*', 'mcp:*']);
    expect(cfg['systemMessage']).toEqual({ mode: 'append', content: 'SYSTEM' });
    expect(String(cfg['workingDirectory'])).toContain('pse-ai-workdir');
    expect(cfg['enableSessionTelemetry']).toBe(false);
    // 公開したツールは toolSpecs の 5 つだけ（書き込み系は無い）
    expect(f.defined.map((d) => d.name)).toEqual(toolSpecs.map((t) => t.name));
    expect(f.sessions[0]!.sent).toEqual(['USER']);
    expect(f.sessions[0]!.disconnected).toBe(true);
  });

  it('権限要求は、許可したカスタムツール以外を全て拒否する（シェル・ファイル・未知のツール）', async () => {
    const f = fakeSdk();
    await new CopilotProvider(async () => f.sdk).run(input(box()).i);
    const ask = f.sessions[0]!.config['onPermissionRequest'] as (r: { kind: string; toolName?: string }) => { kind: string };
    expect(ask({ kind: 'custom-tool', toolName: 'propose_changes' })).toEqual({ kind: 'approve-once' });
    expect(ask({ kind: 'custom-tool', toolName: 'get_schedule' }).kind).toBe('approve-once');
    for (const r of [{ kind: 'shell' }, { kind: 'write' }, { kind: 'read' }, { kind: 'url' }, { kind: 'mcp', toolName: 'x' }, { kind: 'custom-tool', toolName: 'write_file' }, { kind: 'custom-tool' }]) {
      expect(ask(r).kind).toBe('reject');
    }
  });

  it('ツールが呼ばれたら AiToolbox に渡る。提案は保持されるだけで、日程は変わらない', async () => {
    const f = fakeSdk();
    const b = box();
    const before = JSON.stringify(basic());
    const p = new CopilotProvider(async () => f.sdk);
    const sdkWithScript = fakeSdk({
      script: async (s) => {
        const tools = s.config['tools'] as { name: string; handler: (a: unknown) => string }[];
        const first = JSON.parse(tools.find((t) => t.name === 'get_schedule')!.handler({})) as { projects: { events: { id: string; end: string }[] }[] };
        const e = first.projects.flatMap((x) => x.events)[0]!;
        tools.find((t) => t.name === 'propose_changes')!.handler({ summary: '延長', changes: [{ op: 'updateEvent', eventId: e.id, end: '2030-01-01' }] });
        s.emit('assistant.message_delta', { deltaContent: '提案しました' });
        s.emit('session.idle', {});
      },
    });
    void f;
    const { text, i } = input(b);
    await new CopilotProvider(async () => sdkWithScript.sdk).run(i);
    expect(b.proposals).toHaveLength(1);
    expect(text.join('')).toBe('提案しました');
    expect(JSON.stringify(basic())).toBe(before);
    void p;
  });

  it('応答はストリーミングで流れる（差分ごと）', async () => {
    const f = fakeSdk({
      script: async (s) => {
        for (const d of ['こ', 'ん', 'に', 'ち', 'は']) s.emit('assistant.message_delta', { deltaContent: d });
        s.emit('session.idle', {});
      },
    });
    const { text, i } = input(box());
    await new CopilotProvider(async () => f.sdk).run(i);
    expect(text).toEqual(['こ', 'ん', 'に', 'ち', 'は']);
  });

  it('中止すると、セッションを中止して速やかに終わる', async () => {
    const f = fakeSdk({ script: async () => undefined }); // 完了しない台本
    const ac = new AbortController();
    const { i } = input(box(), { signal: ac.signal });
    const run = new CopilotProvider(async () => f.sdk).run(i);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await run;
    expect(f.sessions[0]!.aborted).toBe(true);
    expect(f.sessions[0]!.disconnected).toBe(true);
  });

  it('Copilot 側のエラーは例外になり（画面にエラー表示）、セッションは後片付けされる', async () => {
    const f = fakeSdk({
      script: async (s) => {
        s.emit('session.error', { message: 'rate limited' });
      },
    });
    const { i } = input(box());
    await expect(new CopilotProvider(async () => f.sdk).run(i)).rejects.toThrow('rate limited');
    expect(f.sessions[0]!.disconnected).toBe(true);
  });

  it('終了時に実行本体を止める', async () => {
    const f = fakeSdk();
    const p = new CopilotProvider(async () => f.sdk);
    await p.status();
    await p.dispose();
    expect(f.calls.stop).toBe(1);
  });
});
