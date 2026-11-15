import { ja } from './ja';

export type MessageKey = keyof typeof ja;

/** 文言の取得（NF-009: 文言は外出しし、将来の多言語化に備える）。{name} を params で置換する。 */
export function t(key: MessageKey, params: Record<string, string> = {}): string {
  return ja[key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

/** 依存の種類 → 画面の表示名（FS/SS/FF/SF は略号なので、そのまま見せない）。 */
export const DEP_LABEL = { FS: 'dep.FS', SS: 'dep.SS', FF: 'dep.FF', SF: 'dep.SF' } as const satisfies Record<string, MessageKey>;

/** 表示方法（style）の値 → 画面の表示名。 */
export const STYLE_LABEL = {
  bar: 'style.bar', roundBar: 'style.roundBar', line: 'style.line', band: 'style.band', outline: 'style.outline', striped: 'style.striped', arrow: 'style.arrow',
  diamond: 'style.diamond', circle: 'style.circle', triangle: 'style.triangle', triangleDown: 'style.triangleDown', square: 'style.square', star: 'style.star', flag: 'style.flag', tag: 'style.tag', labelOnly: 'style.labelOnly',
} as const satisfies Record<string, MessageKey>;
