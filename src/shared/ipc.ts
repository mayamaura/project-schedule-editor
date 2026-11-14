import { z } from 'zod';
import { promptTemplateSchema } from '../domain/ai/prompt';
import { findingSchema } from '../domain/ai/tools';
import { dateSchema } from '../domain/model';

const identitySchema = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(200) });
const reflectResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('dirty') }),
  z.object({ status: z.literal('outdated') }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('identity-required') }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

// ---- AI（F-701〜F-713）----
export const aiScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), projectIds: z.array(z.string().max(80)).min(1).max(500) }),
  z.object({ kind: z.literal('view'), from: dateSchema, to: dateSchema }),
  z.object({ kind: z.literal('all') }),
]);
export const aiOptionsSchema = z.object({ includeNotes: z.boolean(), includeAssignee: z.boolean() });
export const aiStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  models: z.array(z.string()),
  enabled: z.boolean(),
  model: z.string().nullable(),
  maxChanges: z.number(),
});
export const aiProposalSchema = z.object({
  id: z.string(),
  summary: z.string(),
  rationale: z.string().optional(),
  /** 承認後に commit するコマンド（batch）。適用時に applyCommand が改めて検証する。 */
  command: z.unknown(),
  lines: z.array(z.string()),
  changeCount: z.number(),
  newIssues: z.array(z.string()),
});
/** Main → Renderer のイベント（ストリーミング・提案・指摘・完了・エラー）。 */
export const aiEventSchema = z.discriminatedUnion('type', [
  z.object({ requestId: z.string(), type: z.literal('text'), delta: z.string() }),
  z.object({ requestId: z.string(), type: z.literal('proposal'), proposal: aiProposalSchema }),
  z.object({ requestId: z.string(), type: z.literal('findings'), findings: z.array(findingSchema) }),
  z.object({ requestId: z.string(), type: z.literal('done'), entryId: z.string(), cancelled: z.boolean() }),
  z.object({ requestId: z.string(), type: z.literal('error'), message: z.string() }),
]);
export type AiEventMessage = z.infer<typeof aiEventSchema>;
const aiHistorySchema = z.object({
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

const exportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('ok'), path: z.string(), bytes: z.number() }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);

// IPC チャネルの定義（唯一の正）。入出力は zod で検証する。
// 新しいチャネルは必ずここに追加し、Main 側は handle() で実装する（architecture 2）。
export const ipcSchemas = {
  'app:getVersion': { input: z.undefined(), output: z.string() },
  /** 画面の配色（システムに合わせる/ライト/ダーク）。Main の nativeTheme を切り替える。 */
  'app:setTheme': { input: z.enum(['system', 'light', 'dark']), output: z.undefined() },
  /** フォルダ選択ダイアログ → 日程データを読み込む。キャンセルなら null（F-501 の「開く」）。 */
  'repo:open': {
    input: z.undefined(),
    output: z
      .object({
        path: z.string(),
        files: z.record(z.string(), z.string()),
        /** 前回が正常終了しなかった（F-211）。 */
        crashed: z.boolean(),
        /** crashed のとき、前回の正常な開始時点の内容（変更一覧・破棄の基準）。 */
        base: z.record(z.string(), z.string()).nullable(),
      })
      .nullable(),
  },
  /** 最近開いたフォルダ（新しい順。存在するものだけ）。 */
  'repo:recent': { input: z.undefined(), output: z.array(z.string()) },
  /** 最近開いたフォルダの一覧にあるパスだけを、ダイアログなしで開く。一覧に無い・存在しなければ null。 */
  'repo:openRecent': {
    input: z.object({ path: z.string().max(1000) }),
    output: z
      .object({ path: z.string(), files: z.record(z.string(), z.string()), crashed: z.boolean(), base: z.record(z.string(), z.string()).nullable() })
      .nullable(),
  },
  /** フォルダを選んで新規作成する（F-501）。空のフォルダに空の日程データと保存の履歴を用意して開く。 */
  'repo:create': {
    input: z.undefined(),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('not-empty') }),
      z.object({ status: z.literal('ok'), path: z.string(), files: z.record(z.string(), z.string()), crashed: z.boolean(), base: z.record(z.string(), z.string()).nullable() }),
    ]),
  },
  /** 開いているフォルダへ自動保存する（F-210）。パスは Main が保持するものを使い、Renderer からは受け取らない。 */
  'repo:save': { input: z.object({ files: z.record(z.string(), z.string()) }), output: z.object({ written: z.number() }) },
  /** 版管理の状態（F-502/F-514）。Git が使えなければ available=false。head は最後に保存した版の日程データ。 */
  'git:state': {
    input: z.undefined(),
    output: z.object({
      available: z.boolean(),
      isRepo: z.boolean(),
      branch: z.string().nullable(),
      dirty: z.boolean(),
      head: z.record(z.string(), z.string()).nullable(),
      hasRemote: z.boolean(),
      inMerge: z.boolean(),
    }),
  },
  /** データの場所を新規作成する（版管理を始める）。 */
  'git:init': { input: z.undefined(), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 変更を保存する（F-502）。名前・メールが未設定なら identity-required。 */
  'git:save': {
    input: z.object({ message: z.string().min(1).max(2000), identity: z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(200) }).optional() }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ok'), hash: z.string() }),
      z.object({ status: z.literal('nothing') }),
      z.object({ status: z.literal('identity-required') }),
      z.object({ status: z.literal('error'), message: z.string() }),
    ]),
  },
  /** 履歴（新しい順）。 */
  'git:log': { input: z.object({ limit: z.number().int().min(1).max(500) }), output: z.array(z.object({ hash: z.string(), date: z.string(), author: z.string(), message: z.string() })) },
  /** 過去の版の日程データ（F-504）。 */
  'git:filesAt': { input: z.object({ hash: z.string().regex(/^[0-9a-f]{7,40}$/) }), output: z.record(z.string(), z.string()) },
  /** 作業版の一覧と現在地（F-513, F-514）。 */
  'work:list': {
    input: z.undefined(),
    output: z.object({
      current: z.string().nullable(),
      hasRemote: z.boolean(),
      items: z.array(z.object({ name: z.string(), display: z.string(), date: z.string(), ahead: z.number(), archived: z.boolean(), backup: z.enum(['none', 'done', 'outdated']) })),
    }),
  },
  /** 作業版を作る（正式版の最新から。保存前の変更は元の版に退避）。 */
  'work:create': { input: z.object({ display: z.string().min(1).max(100) }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 今の作業版を共有先へバックアップする（F-516）。 */
  'work:backup': { input: z.undefined(), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 作業版を一覧から隠す / 戻す（整理。履歴は消さない。F-519）。 */
  'work:archive': { input: z.object({ name: z.string().max(100), archived: z.boolean() }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 反映・共有の途中の印（F-521）。アプリが落ちたあとに、再開かやり直しを選べるようにする。 */
  'flow:get': { input: z.undefined(), output: z.object({ kind: z.enum(['reflect', 'share']), startedAt: z.string() }).nullable() },
  'flow:set': { input: z.object({ kind: z.enum(['reflect', 'share']) }), output: z.undefined() },
  'flow:clear': { input: z.undefined(), output: z.undefined() },
  /** 途中で終了した取り込みを取りやめる（保存した履歴は失われない。F-521）。 */
  'git:abortMerge': { input: z.undefined(), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 版を切り替える（保存前の変更は自動で退避・復元）。 */
  'work:switch': { input: z.object({ name: z.string().max(100) }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 作業ツリーの日程データを読み直す（切替・取り込みの後）。 */
  /** 標準日程 1 件の保存・削除（F-801, F-807）。内容は Main でも検証する。 */
  'template:save': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().max(2_000_000) }), output: z.undefined() },
  'template:delete': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), output: z.undefined() },
  /** カレンダー設定の保存（F-603）。内容は Main でも検証する。 */
  'calendar:save': { input: z.object({ text: z.string().max(2_000_000) }), output: z.undefined() },
  /** ある版と、その 1 つ前の版の日程データ（履歴の変更要約。F-510）。 */
  'git:commitChange': {
    input: z.object({ hash: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    output: z.object({ before: z.record(z.string(), z.string()).nullable(), after: z.record(z.string(), z.string()) }),
  },
  /** CSV ファイルを選んで読み、表にする（F-602）。 */
  'csv:import': {
    input: z.undefined(),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('ok'), fileName: z.string(), rows: z.array(z.array(z.string())) }),
      z.object({ status: z.literal('failed'), message: z.string() }),
    ]),
  },
  /** 表を CSV ファイルに書き出す（F-602）。保存先は利用者が選ぶ。 */
  'csv:export': {
    input: z.object({ rows: z.array(z.array(z.string())).max(1_000_000) }),
    output: z.discriminatedUnion('status', [z.object({ status: z.literal('cancelled') }), z.object({ status: z.literal('ok'), path: z.string() }), z.object({ status: z.literal('failed'), message: z.string() })]),
  },
  /** 出力ファイルの保存（F-601, F-606, F-607）。保存先は利用者が選ぶ。 */
  'export:html': { input: z.object({ payload: z.string().max(400_000_000), title: z.string().max(500) }), output: exportResultSchema },
  'export:file': { input: z.object({ kind: z.enum(['svg', 'png']), data: z.string().max(400_000_000) }), output: exportResultSchema },
  'export:pdf': { input: z.object({ svg: z.string().max(400_000_000), paper: z.enum(['A4', 'A3']), landscape: z.boolean() }), output: exportResultSchema },
  'ai:status': { input: z.undefined(), output: aiStatusSchema },
  'ai:settings': { input: z.object({ enabled: z.boolean().optional(), model: z.string().max(200).nullable().optional(), maxChanges: z.number().int().min(1).max(200).optional() }), output: aiStatusSchema },
  /** 送信前のプレビュー（F-707）。AI に渡すテキストそのもの。 */
  'ai:preview': {
    input: z.object({ scope: aiScopeSchema, options: aiOptionsSchema }),
    output: z.object({ text: z.string(), large: z.boolean(), stats: z.object({ projects: z.number(), events: z.number(), milestones: z.number(), dependencies: z.number(), chars: z.number() }) }),
  },
  /** 依頼を始める。結果はイベント（ai:event）で流れる。 */
  'ai:ask': {
    input: z.object({
      requestId: z.string().min(1).max(100),
      kind: z.enum(['chat', 'evaluate', 'check']),
      message: z.string().min(1).max(8000),
      scope: aiScopeSchema,
      options: aiOptionsSchema,
      instruction: z.string().max(4000).optional(),
      model: z.string().max(200).optional(),
    }),
    output: z.undefined(),
  },
  'ai:cancel': { input: z.object({ requestId: z.string().max(100) }), output: z.undefined() },
  'ai:history': { input: z.undefined(), output: z.array(aiHistorySchema) },
  'ai:history-delete': { input: z.object({ id: z.string().max(100).optional() }), output: z.undefined() },
  'ai:applied': { input: z.object({ entryId: z.string().max(100), proposalId: z.string().max(100) }), output: z.undefined() },
  'ai:prompts': { input: z.undefined(), output: z.array(promptTemplateSchema) },
  'ai:prompt-save': { input: z.object({ prompt: promptTemplateSchema }), output: z.undefined() },
  'ai:prompt-delete': { input: z.object({ id: z.string().max(80), shared: z.boolean() }), output: z.undefined() },
  /** チーム共有のビューの保存・削除（F-403）。内容は Main でも検証する。 */
  'view:save': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().max(2_000_000) }), output: z.undefined() },
  'view:delete': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), output: z.undefined() },
  'repo:reload': { input: z.undefined(), output: z.object({ files: z.record(z.string(), z.string()) }) },
  /** 取り込みの準備: 共有先の最新を取得し、3 版の材料を返す（F-511, F-518）。main = 正式版の最新（作業版のとき）。 */
  'sync:prepare': {
    input: z.undefined(),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('fetch-failed'), message: z.string() }),
      z.object({ status: z.literal('dirty') }),
      z.object({ status: z.literal('up-to-date'), mode: z.enum(['work', 'main']), main: z.record(z.string(), z.string()).nullable() }),
      z.object({
        status: z.literal('merge'),
        mode: z.enum(['work', 'main']),
        theirsRef: z.string(),
        fastForward: z.boolean(),
        base: z.record(z.string(), z.string()),
        ours: z.record(z.string(), z.string()),
        theirs: z.record(z.string(), z.string()),
      }),
    ]),
  },
  /** マージ結果を、相手の履歴を取り込んだ 1 つの版として記録する。 */
  'sync:complete': {
    input: z.object({ files: z.record(z.string(), z.string()), theirsRef: z.string().max(200), message: z.string().min(1).max(2000), identity: identitySchema.optional() }),
    output: reflectResultSchema,
  },
  /** 作業版を正式版へ反映する（送信まで）。 */
  'sync:reflect': { input: z.object({ display: z.string().min(1).max(100), identity: identitySchema.optional() }), output: reflectResultSchema },
  /** 正式版を直接編集しているとき、共有先へ送る。 */
  'sync:push': { input: z.undefined(), output: reflectResultSchema },
  /** 共有先（URL）を設定する。 */
  'git:setRemote': { input: z.object({ url: z.string().min(1).max(500) }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 共有先から取得して開く（F-501 の (a)）。空のフォルダを選ぶ。 */
  'repo:clone': {
    input: z.object({ url: z.string().min(1).max(500) }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('not-empty') }),
      z.object({ status: z.literal('failed'), message: z.string() }),
      z.object({ status: z.literal('ok'), path: z.string(), files: z.record(z.string(), z.string()), crashed: z.boolean(), base: z.record(z.string(), z.string()).nullable() }),
    ]),
  },
  /** Git 環境の診断（F-523）。 */
  'git:diagnose': {
    input: z.undefined(),
    output: z.array(z.object({ key: z.enum(['git', 'repo', 'identity', 'remote', 'connection']), label: z.string(), ok: z.boolean(), detail: z.string() })),
  },
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipcSchemas)[C]['output']>;

/** Renderer に公開する API（preload が contextBridge で window.api として公開する）。 */
export interface Api {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>>;
  /** Main からのイベントの購読（許可したチャネルのみ）。解除する関数を返す。 */
  on(channel: 'ai:event', listener: (message: unknown) => void): () => void;
}
