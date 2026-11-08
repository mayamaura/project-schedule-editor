// @req F-701, F-708, F-713, NF-012, NF-014
// GitHub Copilot SDK のアダプタ（AiProvider の実装）。SDK に触れるのはこのファイルだけ（NF-014）。
// SDK は 1.0.x だが一部 API が実験的なので、使う範囲を小さく保つ: CopilotClient の start / getAuthStatus / listModels / createSession / stop、
// セッションの on / send / abort / disconnect、defineTool、ToolSet、approve-once / reject の権限結果。
// 安全（NF-012）: 公開するツールは AiToolbox の toolSpecs だけ（custom:* のみ許可し、組み込みツール（ファイル・シェル等）は無効化）。
// 権限要求は、許可したカスタムツール以外を全て拒否する。作業フォルダは空の一時フォルダ（プロジェクトのファイルに触れさせない）。
// 実行本体（Copilot CLI）は SDK のプラットフォーム別パッケージに同梱されたものを使う（決定 I2）。COPILOT_CLI_PATH で差し替え可能。
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedTool, toolSpecs } from '../../domain/ai/tools';
import type { AiProvider, AiRunInput, AiStatus } from './provider';

/** このアダプタが使う SDK の範囲（型の最小限。テストでは偽物を渡す）。 */
export interface SdkClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; host?: string; statusMessage?: string }>;
  listModels(): Promise<{ id: string; name?: string; policy?: { state?: string } }[]>;
  createSession(config: Record<string, unknown>): Promise<SdkSessionLike>;
}
export interface SdkSessionLike {
  on(type: string, handler: (event: { data: Record<string, unknown> }) => void): () => void;
  send(options: { prompt: string }): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface SdkModuleLike {
  CopilotClient: new (options?: Record<string, unknown>) => SdkClientLike;
  defineTool: (name: string, config: Record<string, unknown>) => unknown;
  ToolSet: new () => { addCustom(name: string): unknown; toArray(): string[] };
}

export type SdkLoader = () => Promise<SdkModuleLike>;

/** 実際の SDK を読み込む（ESM パッケージなので動的 import。読み込めなければ呼び出し側が AI を無効にする）。 */
export const loadSdk: SdkLoader = async () => (await import('@github/copilot-sdk')) as unknown as SdkModuleLike;

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class CopilotProvider implements AiProvider {
  readonly id = 'copilot';
  private client: SdkClientLike | null = null;
  private starting: Promise<SdkClientLike> | null = null;

  constructor(private readonly load: SdkLoader = loadSdk) {}

  private async ensureClient(): Promise<SdkClientLike> {
    if (this.client) return this.client;
    this.starting ??= (async () => {
      const sdk = await this.load();
      const c = new sdk.CopilotClient({ logLevel: 'error' });
      await c.start();
      this.client = c;
      return c;
    })().catch((e: unknown) => {
      this.starting = null; // 次の依頼で、もう一度試せるようにする
      throw e;
    });
    return this.starting;
  }

  async status(): Promise<AiStatus> {
    try {
      const c = await this.ensureClient();
      const auth = await c.getAuthStatus();
      if (!auth.isAuthenticated) {
        return { available: false, reason: auth.statusMessage ? `GitHub にサインインしていません（${auth.statusMessage}）` : 'GitHub にサインインしていません。Copilot にサインインしてください', models: [] };
      }
      let models: string[] = [];
      try {
        models = (await c.listModels()).filter((m) => m.policy?.state !== 'disabled').map((m) => m.id);
      } catch {
        /* モデル一覧が取れなくても、AI 自体は使える（既定のモデルで動く） */
      }
      return { available: true, models };
    } catch (e) {
      return { available: false, reason: `Copilot に接続できません（${reasonOf(e)}）`, models: [] };
    }
  }

  async run(i: AiRunInput): Promise<void> {
    const sdk = await this.load();
    const client = await this.ensureClient();
    // 作業フォルダは空の一時フォルダ（プロジェクトのファイルに触れさせない）
    const cwd = join(tmpdir(), 'pse-ai-workdir');
    mkdirSync(cwd, { recursive: true });

    const tools = toolSpecs.map((spec) =>
      sdk.defineTool(spec.name, {
        description: spec.description,
        parameters: spec.schema,
        // 呼ばれたら AiToolbox に渡すだけ（検証・範囲の確認・提案の保持は toolbox が行う）
        handler: (args: unknown) => i.toolbox.invoke(spec.name, args),
        skipPermission: true,
      }),
    );
    const session = await client.createSession({
      ...(i.model ? { model: i.model } : {}),
      streaming: true,
      tools,
      // 使えるのは、ここで定義したカスタムツールだけ。組み込みツール（ファイル・シェル・Web など）は無効化する
      availableTools: new sdk.ToolSet().addCustom('*'),
      excludedTools: ['builtin:*', 'mcp:*'],
      systemMessage: { mode: 'append', content: i.system },
      workingDirectory: cwd,
      enableSessionStore: false,
      enableSessionTelemetry: false,
      // 権限要求は、許可したカスタムツール以外を全て拒否する（多重の防御。NF-012）
      onPermissionRequest: (request: { kind: string; toolName?: string }) =>
        request.kind === 'custom-tool' && typeof request.toolName === 'string' && isAllowedTool(request.toolName) ? { kind: 'approve-once' } : { kind: 'reject', feedback: 'このアプリでは許可されていません' },
    });

    let off: Array<() => void> = [];
    try {
      const done = new Promise<void>((resolve, reject) => {
        off = [
          session.on('assistant.message_delta', (e) => {
            const d = e.data['deltaContent'];
            if (typeof d === 'string' && d !== '') i.onText(d);
          }),
          session.on('session.error', (e) => reject(new Error(String(e.data['message'] ?? 'Copilot でエラーが発生しました')))),
          session.on('session.idle', () => resolve()),
        ];
      });
      const onAbort = (): void => void session.abort().catch(() => undefined);
      i.signal.addEventListener('abort', onAbort, { once: true });
      if (i.signal.aborted) onAbort();
      try {
        await session.send({ prompt: i.user });
        await done;
      } finally {
        i.signal.removeEventListener('abort', onAbort);
      }
    } finally {
      for (const f of off) f();
      await session.disconnect().catch(() => undefined);
    }
  }

  /** アプリ終了時に実行本体を止める。 */
  async dispose(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.starting = null;
    await c?.stop().catch(() => undefined);
  }
}
