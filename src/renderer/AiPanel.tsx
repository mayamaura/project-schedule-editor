// @req F-701, F-702, F-703, F-705, F-706, F-707, F-708, F-709, F-710, F-712, F-713, NF-012, NF-013
// AI パネル（チャット・提案の差分確認と承認・評価と指摘・送信前プレビュー・指示/観点・設定・ログ）。
// 画面を塞がない（モーダルではない）ので、待機中も他の編集を続けられる。AI は日程を書き換えない: 提案は
// 「差分を確認して承認」したときだけ、通常の編集と同じ経路（onApply → commit。Undo 1 単位）で反映される。
import { useCallback, useEffect, useRef, useState } from 'react';
import { PRESET_PROMPTS, type Finding, type Id, type PromptKind, type PromptTemplate, type Schedule } from '@domain/index';
import { aiEventSchema, type AiEventMessage } from '@shared/ipc';
import type { TimelineApi } from './ExportDialog';
import { t } from './i18n';

type Status = { available: boolean; reason?: string; models: string[]; enabled: boolean; model: string | null; maxChanges: number };
type Proposal = Extract<AiEventMessage, { type: 'proposal' }>['proposal'];
type ScopeKind = 'selection' | 'view' | 'all';

interface Turn {
  readonly id: string;
  readonly kind: 'chat' | 'evaluate' | 'check';
  readonly request: string;
  text: string;
  proposals: (Proposal & { state: 'open' | 'applied' | 'discarded'; confirmed: boolean; error?: string })[];
  findings: Finding[];
  running: boolean;
  entryId?: string;
  error?: string;
}


const KIND_LABEL: Record<PromptKind, 'ai.kindEvaluation' | 'ai.kindEdit' | 'ai.kindCheck'> = { evaluation: 'ai.kindEvaluation', edit: 'ai.kindEdit', check: 'ai.kindCheck' };

function PromptEditor({ prompts, onSaved }: { prompts: PromptTemplate[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<PromptTemplate | null>(null);
  const [error, setError] = useState('');
  const save = async (): Promise<void> => {
    if (!draft) return;
    try {
      await window.api.invoke('ai:prompt-save', { prompt: draft });
      setDraft(null);
      setError('');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div data-testid="ai-prompt-editor">
      <ul className="ai-list">
        {prompts.map((p) => (
          <li key={p.id} data-testid="ai-prompt-item">
            <span>
              {p.name}（{t(KIND_LABEL[p.kind])}）{p.shared ? ` ${t('ai.shared')}` : ''}
            </span>
            <button type="button" onClick={() => setDraft(p)}>
              {t('tpl.editBtn')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('ai.promptDeleteConfirm', { name: p.name }))) void window.api.invoke('ai:prompt-delete', { id: p.id, shared: p.shared }).then(onSaved);
              }}
            >
              {t('tpl.delete')}
            </button>
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="ai-form">
          <input aria-label={t('tpl.name')} data-testid="ai-prompt-name" placeholder={t('tpl.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select aria-label={t('ai.kind')} data-testid="ai-prompt-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as PromptKind })}>
            {(['evaluation', 'edit', 'check'] as const).map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
          <textarea aria-label={t('ai.instruction')} data-testid="ai-prompt-text" rows={4} placeholder={t('ai.instruction')} value={draft.instruction} onChange={(e) => setDraft({ ...draft, instruction: e.target.value })} />
          <label>
            <input type="checkbox" data-testid="ai-prompt-shared" checked={draft.shared} onChange={(e) => setDraft({ ...draft, shared: e.target.checked })} /> {t('ai.shareWithTeam')}
          </label>
          <p className="hint">{t('ai.promptHint')}</p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="actions">
            <button type="button" data-testid="ai-prompt-save" disabled={draft.name.trim() === '' || draft.instruction.trim() === ''} onClick={() => void save()}>
              {t('tpl.save')}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              {t('sync.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="ai-prompt-new"
          onClick={() => setDraft({ id: `pt-${Math.random().toString(36).slice(2, 8)}`, name: '', kind: 'evaluation', instruction: '', shared: false })}
        >
          {t('ai.promptNew')}
        </button>
      )}
    </div>
  );
}

export function AiPanel({
  schedule,
  sharedPrompts,
  api,
  flush,
  onApply,
  onClose,
  onReloadShared,
}: {
  schedule: Schedule;
  sharedPrompts: readonly PromptTemplate[];
  api: TimelineApi | null;
  flush: () => Promise<void>;
  /** 承認された提案を適用する（通常の編集と同じ経路）。成功なら null、失敗なら理由。 */
  onApply: (command: unknown, summary: string) => string | null;
  onClose: () => void;
  onReloadShared: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [personal, setPersonal] = useState<PromptTemplate[]>([]);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const [notes, setNotes] = useState(true);
  const [assignee, setAssignee] = useState(true);
  const [promptId, setPromptId] = useState('');
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [preview, setPreview] = useState<{ text: string; large: boolean; stats: { projects: number; events: number; milestones: number; dependencies: number; chars: number } } | null>(null);
  const [history, setHistory] = useState<{ id: string; at: string; kind: string; request: string; scope: string; proposals: { summary: string; applied: boolean }[] }[]>([]);
  const [showPrompts, setShowPrompts] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  const selected = api?.selectedProjectId() ?? null;
  const allPrompts = [...PRESET_PROMPTS, ...personal, ...sharedPrompts];

  const refresh = useCallback(async () => {
    setStatus(await window.api.invoke('ai:status'));
    setPersonal(await window.api.invoke('ai:prompts'));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Main からのイベント（ストリーミング・提案・指摘・完了・エラー）
  useEffect(() => {
    return window.api.on('ai:event', (raw) => {
      const p = aiEventSchema.safeParse(raw);
      if (!p.success) return;
      const e = p.data;
      setTurns((list) =>
        list.map((turn) => {
          if (turn.id !== e.requestId) return turn;
          if (e.type === 'text') return { ...turn, text: turn.text + e.delta };
          if (e.type === 'proposal') return { ...turn, proposals: [...turn.proposals, { ...e.proposal, state: 'open', confirmed: false }] };
          if (e.type === 'findings') return { ...turn, findings: [...turn.findings, ...e.findings] };
          if (e.type === 'done') return { ...turn, running: false, entryId: e.entryId };
          return { ...turn, running: false, error: e.message };
        }),
      );
      if (e.type === 'done' || e.type === 'error') setRunning((r) => (r === e.requestId ? null : r));
    });
  }, []);

  const scope = (): { kind: 'selection'; projectIds: string[] } | { kind: 'view'; from: string; to: string } | { kind: 'all' } => {
    if (scopeKind === 'selection' && selected) return { kind: 'selection', projectIds: [selected] };
    if (scopeKind === 'view' && api) return { kind: 'view', ...api.visibleRange() };
    return { kind: 'all' };
  };
  const options = { includeNotes: notes, includeAssignee: assignee };

  const showPreview = async (): Promise<void> => {
    await flush();
    setPreview(await window.api.invoke('ai:preview', { scope: scope(), options }));
  };

  const ask = async (kind: Turn['kind'], message: string): Promise<void> => {
    if (!status?.available || running) return;
    await flush(); // 自動保存を完了させてから、今の日程を渡す
    const requestId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const instruction = allPrompts.find((p) => p.id === promptId)?.instruction;
    setTurns((l) => [...l, { id: requestId, kind, request: message, text: '', proposals: [], findings: [], running: true }]);
    setRunning(requestId);
    setInput('');
    try {
      await window.api.invoke('ai:ask', { requestId, kind, message, scope: scope(), options, ...(instruction ? { instruction } : {}), ...(status.model ? { model: status.model } : {}) });
    } catch (e) {
      setTurns((l) => l.map((x) => (x.id === requestId ? { ...x, running: false, error: e instanceof Error ? e.message : String(e) } : x)));
      setRunning(null);
    }
  };

  const apply = (turn: Turn, p: Turn['proposals'][number]): void => {
    const err = onApply(p.command, p.summary);
    setTurns((l) => l.map((x) => (x.id === turn.id ? { ...x, proposals: x.proposals.map((q) => (q.id === p.id ? (err ? { ...q, error: err } : { ...q, state: 'applied' as const, error: undefined }) : q)) } : x)));
    if (!err && turn.entryId) void window.api.invoke('ai:applied', { entryId: turn.entryId, proposalId: p.id });
  };
  const setProposal = (turn: Turn, id: string, patch: Partial<Turn['proposals'][number]>): void => setTurns((l) => l.map((x) => (x.id === turn.id ? { ...x, proposals: x.proposals.map((q) => (q.id === id ? { ...q, ...patch } : q)) } : x)));

  const loadHistory = async (): Promise<void> => setHistory([...(await window.api.invoke('ai:history'))].reverse());
  const nameOf = (id: Id): string => {
    for (const pr of Object.values(schedule.projects)) {
      if (pr.id === id) return pr.name;
      if (pr.events[id]) return pr.events[id]!.name;
      if (pr.milestones[id]) return pr.milestones[id]!.name;
    }
    return id;
  };

  // 接続の確認が済むまで（Copilot の実行本体の起動に数秒かかる）は、送信できない
  const disabledReason = status === null ? t('ai.checking') : !status.available ? (status.reason ?? t('ai.unavailable')) : '';
  const defaultMessage = (k: 'evaluate' | 'check'): string => (k === 'evaluate' ? t('ai.defaultEvaluate') : t('ai.defaultCheck'));

  return (
    <aside className="ai-panel" role="complementary" aria-label={t('ai.title')} data-testid="ai-panel">
      <div className="ai-head">
        <strong>{t('ai.title')}</strong>
        <button type="button" data-testid="ai-close" onClick={onClose} aria-label={t('sync.close')}>
          ×
        </button>
      </div>

      {status === null ? (
        <p role="status" data-testid="ai-checking">
          {t('ai.checking')}
        </p>
      ) : disabledReason ? (
        <p role="status" className="ai-unavailable" data-testid="ai-unavailable">
          {t('ai.unavailableFmt', { reason: disabledReason })}
        </p>
      ) : null}

      <details>
        <summary>{t('ai.settings')}</summary>
        {status ? (
          <div className="ai-form" data-testid="ai-settings">
            <label>
              <input type="checkbox" data-testid="ai-enabled" checked={status.enabled} onChange={(e) => void window.api.invoke('ai:settings', { enabled: e.target.checked }).then(setStatus)} /> {t('ai.enable')}
            </label>
            <label>
              {t('ai.model')}{' '}
              <select data-testid="ai-model" value={status.model ?? ''} disabled={status.models.length === 0} onChange={(e) => void window.api.invoke('ai:settings', { model: e.target.value || null }).then(setStatus)}>
                <option value="">{t('ai.modelDefault')}</option>
                {status.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              {t('ai.maxChanges')}{' '}
              <input type="number" min={1} max={200} data-testid="ai-max-changes" value={status.maxChanges} onChange={(e) => void window.api.invoke('ai:settings', { maxChanges: Math.max(1, Math.min(200, Number(e.target.value) || 20)) }).then(setStatus)} />
            </label>
          </div>
        ) : null}
      </details>

      <fieldset className="ai-scope">
        <legend>{t('ai.scope')}</legend>
        <label>
          <input type="radio" name="ai-scope" data-testid="ai-scope-all" checked={scopeKind === 'all'} onChange={() => setScopeKind('all')} /> {t('exp.scopeAll')}
        </label>
        <label>
          <input type="radio" name="ai-scope" data-testid="ai-scope-selection" checked={scopeKind === 'selection'} disabled={!selected} onChange={() => setScopeKind('selection')} /> {t('ai.scopeSelection')}
        </label>
        <label>
          <input type="radio" name="ai-scope" data-testid="ai-scope-view" checked={scopeKind === 'view'} disabled={!api} onChange={() => setScopeKind('view')} /> {t('ai.scopeView')}
        </label>
        <label>
          <input type="checkbox" data-testid="ai-notes" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> {t('exp.notes')}
        </label>
        <label>
          <input type="checkbox" data-testid="ai-assignee" checked={assignee} onChange={(e) => setAssignee(e.target.checked)} /> {t('exp.assignee')}
        </label>
        <button type="button" data-testid="ai-preview" onClick={() => void showPreview()}>
          {t('ai.previewBtn')}
        </button>
        {preview ? (
          <div data-testid="ai-preview-box">
            <p className="hint">
              {t('ai.previewStats', { projects: String(preview.stats.projects), events: String(preview.stats.events), milestones: String(preview.stats.milestones), chars: String(preview.stats.chars) })}
              {preview.large ? ` ${t('ai.previewLarge')}` : ''}
            </p>
            <pre className="ai-preview" data-testid="ai-preview-text">
              {preview.text}
            </pre>
            <p className="hint">{t('ai.previewNote')}</p>
          </div>
        ) : null}
      </fieldset>

      <label className="ai-prompt-select">
        {t('ai.promptSelect')}{' '}
        <select data-testid="ai-prompt-select" value={promptId} onChange={(e) => setPromptId(e.target.value)}>
          <option value="">{t('ai.promptNone')}</option>
          {allPrompts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.shared ? ` ${t('ai.shared')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" data-testid="ai-prompts-toggle" onClick={() => setShowPrompts((v) => !v)}>
        {t('ai.promptEdit')}
      </button>
      {showPrompts ? (
        <PromptEditor
          prompts={[...personal, ...sharedPrompts]}
          onSaved={() => {
            void refresh();
            onReloadShared();
          }}
        />
      ) : null}

      <div className="ai-chat" data-testid="ai-chat" aria-live="polite">
        {turns.length === 0 ? <p className="hint">{t('ai.chatHint')}</p> : null}
        {turns.map((turn) => (
          <div key={turn.id} className="ai-turn" data-testid="ai-turn">
            <div className="ai-user">{turn.request}</div>
            {turn.text ? (
              <div className="ai-answer" data-testid="ai-answer">
                {turn.text}
              </div>
            ) : null}
            {turn.running ? <p role="status">{t('ai.thinking')}</p> : null}
            {turn.error ? (
              <p role="alert" className="issues" data-testid="ai-error">
                {turn.error}
              </p>
            ) : null}
            {turn.proposals.map((p) => (
              <div key={p.id} className="ai-proposal" data-testid="ai-proposal">
                <strong>{t('ai.proposal')}: {p.summary}</strong>
                {p.rationale ? <p className="hint">{p.rationale}</p> : null}
                <ul className="changes" data-testid="ai-proposal-lines">
                  {p.lines.slice(0, 30).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                {p.newIssues.length > 0 ? (
                  <p className="issues" data-testid="ai-proposal-issues">
                    {t('ai.newIssues', { count: String(p.newIssues.length), detail: p.newIssues.slice(0, 3).join(' / ') })}
                  </p>
                ) : null}
                {status && p.changeCount > status.maxChanges ? (
                  <label className="issues" data-testid="ai-large-warning">
                    <input type="checkbox" data-testid="ai-large-confirm" checked={p.confirmed} onChange={(e) => setProposal(turn, p.id, { confirmed: e.target.checked })} /> {t('ai.largeConfirm', { count: String(p.changeCount) })}
                  </label>
                ) : null}
                {p.error ? (
                  <p role="alert" className="issues" data-testid="ai-apply-error">
                    {p.error}
                  </p>
                ) : null}
                {p.state === 'open' ? (
                  <div className="actions">
                    <button type="button" data-testid="ai-apply" disabled={status ? p.changeCount > status.maxChanges && !p.confirmed : false} onClick={() => apply(turn, p)}>
                      {t('ai.apply')}
                    </button>
                    <button type="button" data-testid="ai-discard" onClick={() => setProposal(turn, p.id, { state: 'discarded' })}>
                      {t('ai.discard')}
                    </button>
                  </div>
                ) : (
                  <p className="hint" data-testid="ai-proposal-state">
                    {p.state === 'applied' ? t('ai.applied') : t('ai.discarded')}
                  </p>
                )}
              </div>
            ))}
            {turn.findings.length > 0 ? (
              <div className="ai-findings" data-testid="ai-findings">
                <p className="hint">{t('ai.findingsNote')}</p>
                {turn.findings.map((f, i) => (
                  <div key={i} className={`ai-finding ${f.severity}`} data-testid="ai-finding">
                    <strong>{f.severity === 'warning' ? '⚠ ' : 'ℹ '}{f.title}</strong>
                    <p>{f.detail}</p>
                    {f.refs.map((r) => (
                      <button key={`${r.kind}${r.id}`} type="button" data-testid="ai-jump" onClick={() => api?.jumpTo(r.id)}>
                        → {nameOf(r.id)}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="ai-input">
        <textarea
          aria-label={t('ai.inputLabel')}
          data-testid="ai-input"
          rows={3}
          placeholder={t('ai.inputPlaceholder')}
          value={input}
          disabled={!!disabledReason}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && input.trim() !== '') void ask('chat', input.trim());
          }}
        />
        <div className="actions">
          {running ? (
            <button type="button" data-testid="ai-stop" onClick={() => void window.api.invoke('ai:cancel', { requestId: running })}>
              {t('ai.stop')}
            </button>
          ) : (
            <>
              <button type="button" data-testid="ai-send" disabled={!!disabledReason || input.trim() === ''} onClick={() => void ask('chat', input.trim())}>
                {t('ai.send')}
              </button>
              <button type="button" data-testid="ai-evaluate" disabled={!!disabledReason} onClick={() => void ask('evaluate', input.trim() || allPrompts.find((p) => p.id === promptId)?.name || defaultMessage('evaluate'))}>
                {t('ai.evaluate')}
              </button>
              <button type="button" data-testid="ai-check" disabled={!!disabledReason} onClick={() => void ask('check', input.trim() || defaultMessage('check'))}>
                {t('ai.check')}
              </button>
            </>
          )}
        </div>
      </div>

      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void loadHistory()}>
        <summary>{t('ai.history')}</summary>
        <p className="hint">{t('ai.historyNote')}</p>
        <ul className="ai-list" data-testid="ai-history">
          {history.map((h) => (
            <li key={h.id} data-testid="ai-history-item">
              <span>
                {new Date(h.at).toLocaleString('ja-JP')} {h.request.slice(0, 30)}（{h.scope}）{h.proposals.map((p) => ` / ${p.summary}${p.applied ? t('ai.appliedMark') : ''}`).join('')}
              </span>
              <button type="button" onClick={() => void window.api.invoke('ai:history-delete', { id: h.id }).then(loadHistory)}>
                {t('tpl.delete')}
              </button>
            </li>
          ))}
        </ul>
        {history.length > 0 ? (
          <button type="button" data-testid="ai-history-clear" onClick={() => window.confirm(t('ai.historyClearConfirm')) && void window.api.invoke('ai:history-delete', {}).then(loadHistory)}>
            {t('ai.historyClear')}
          </button>
        ) : null}
      </details>
    </aside>
  );
}
