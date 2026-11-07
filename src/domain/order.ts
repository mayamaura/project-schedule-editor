// @req F-205
// 並び順（fractional index）。文字列の辞書順で並べる。a と b の間に常に新しい値を作れるため、
// 並べ替えは1要素の変更で済み、Git での競合が起きにくい（data-model 1）。
// 数字 0-9a-z（36進）の小数として扱う。有効な値は末尾が '0' でない。

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export function isValidOrder(s: string): boolean {
  return /^[0-9a-z]*[1-9a-z]$/.test(s);
}

const idx = (c: string | undefined): number => DIGITS.indexOf(c ?? '0');

/** a < 結果 < b を満たす文字列。a=null は先頭、b=null は末尾（無限大）を表す。 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? idx(a[0]) : 0;
  const db = b !== null ? idx(b[0]) : BASE;
  if (db - da > 1) return DIGITS.charAt(Math.round(0.5 * (da + db)));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(da) + midpoint(a.slice(1), null);
}

export function orderBetween(a: string | null, b: string | null): string {
  if (a !== null && !isValidOrder(a)) throw new RangeError(`不正な並び順: ${a}`);
  if (b !== null && !isValidOrder(b)) throw new RangeError(`不正な並び順: ${b}`);
  if (a !== null && b !== null && a >= b) throw new RangeError(`並び順の大小が逆: ${a} >= ${b}`);
  return midpoint(a ?? '', b);
}
