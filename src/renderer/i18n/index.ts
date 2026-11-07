import { ja } from './ja';

export type MessageKey = keyof typeof ja;

/** 文言の取得（NF-009: 文言は外出しし、将来の多言語化に備える）。{name} を params で置換する。 */
export function t(key: MessageKey, params: Record<string, string> = {}): string {
  return ja[key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
