import { z } from 'zod';

const identitySchema = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(200) });
const reflectResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('dirty') }),
  z.object({ status: z.literal('outdated') }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('identity-required') }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

// IPC チャネルの定義（唯一の正）。入出力は zod で検証する。
// 新しいチャネルは必ずここに追加し、Main 側は handle() で実装する（architecture 2）。
export const ipcSchemas = {
  'app:getVersion': { input: z.undefined(), output: z.string() },
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
      items: z.array(z.object({ name: z.string(), display: z.string(), date: z.string(), ahead: z.number() })),
    }),
  },
  /** 作業版を作る（正式版の最新から。保存前の変更は元の版に退避）。 */
  'work:create': { input: z.object({ display: z.string().min(1).max(100) }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 版を切り替える（保存前の変更は自動で退避・復元）。 */
  'work:switch': { input: z.object({ name: z.string().max(100) }), output: z.object({ ok: z.boolean(), message: z.string().optional() }) },
  /** 作業ツリーの日程データを読み直す（切替・取り込みの後）。 */
  /** 標準日程 1 件の保存・削除（F-801, F-807）。内容は Main でも検証する。 */
  'template:save': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().max(2_000_000) }), output: z.undefined() },
  'template:delete': { input: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }), output: z.undefined() },
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
}
