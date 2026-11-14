// @req F-212, NF-009
// 操作（コマンド）の定義とショートカットの判定。メニュー・コマンドパレット・キー操作は、すべて同じ Cmd の一覧から作る
// （表示と実際の挙動がずれない）。DOM に依存しない純関数で、tests/unit で検証する。

export interface Cmd {
  readonly id: string;
  readonly label: string;
  /** 分類（コマンドパレットの表示用）。 */
  readonly group: string;
  /** 例: 'Ctrl+K' / 'Ctrl+Shift+Z' / 'T' / '+' / '?'。 */
  readonly shortcut?: string;
  /** 表示には出さない別のキー（Ctrl+Y に対する Ctrl+Shift+Z など）。 */
  readonly also?: string;
  readonly testid?: string;
  readonly enabled?: boolean;
  /** 入力欄にフォーカスがあっても効かせる（Ctrl 系の、文字入力と衝突しないものだけ）。 */
  readonly inputOk?: boolean;
  readonly run: () => void;
}

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** 'Ctrl++' のように末尾が '+' のものも分けられる。 */
const parts = (spec: string): string[] => spec.split(/\+(?=.)/);

export function matchShortcut(e: KeyLike, spec: string): boolean {
  const p = parts(spec);
  const key = p[p.length - 1]!;
  const mods = new Set(p.slice(0, -1));
  if ((e.ctrlKey || e.metaKey) !== mods.has('Ctrl')) return false;
  if (e.altKey !== mods.has('Alt')) return false;
  const symbol = key.length === 1 && !/[a-z0-9]/i.test(key); // 記号は Shift の有無を問わない（? は Shift で打つ）
  if (!symbol && e.shiftKey !== mods.has('Shift')) return false;
  if (key === '+') return e.key === '+' || e.key === '=';
  return e.key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/** キーに対応する、実行できるコマンド。入力欄では inputOk のものだけ。 */
export function findByKey(cmds: readonly Cmd[], e: KeyLike, inInput: boolean): Cmd | undefined {
  return cmds.find((c) => c.enabled !== false && (!inInput || c.inputOk === true) && [c.shortcut, c.also].some((s) => s !== undefined && matchShortcut(e, s)));
}

/** コマンドパレットの絞り込み。空白区切りの語をすべて含むもの（大文字小文字を区別しない）。 */
export function filterCmds(cmds: readonly Cmd[], query: string): Cmd[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cmds.filter((c) => c.enabled !== false && words.every((w) => `${c.group} ${c.label}`.toLowerCase().includes(w)));
}
