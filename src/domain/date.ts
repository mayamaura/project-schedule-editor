// @req F-104, F-809
// 日付計算（純 TypeScript）。日付は文字列 'YYYY-MM-DD' のみ。Date 型・タイムゾーンを使わない。
// 内部は「1970-01-01 からの通算日数」（整数）。アルゴリズムは Howard Hinnant の civil 日付変換。
// 終了日は「含む」（決定 K5）、週は月曜始まり、月の加減算は暦月で月末に丸める（決定 F7）。

/** 'YYYY-MM-DD'（年は 0001〜9999）。 */
export type DateStr = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function parts(s: string): [number, number, number] | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return [y, mo, d];
}

export function isDateStr(v: unknown): v is DateStr {
  return typeof v === 'string' && parts(v) !== null;
}

function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/** 通算日数（1970-01-01 = 0）。不正な日付は RangeError。 */
export function toDays(s: DateStr): number {
  const p = parts(s);
  if (!p) throw new RangeError(`不正な日付: ${s}`);
  return daysFromCivil(p[0], p[1], p[2]);
}

export function fromDays(n: number): DateStr {
  const [y, m, d] = civilFromDays(n);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function addDays(s: DateStr, n: number): DateStr {
  return fromDays(toDays(s) + n);
}

/** b − a（日数）。 */
export function daysBetween(a: DateStr, b: DateStr): number {
  return toDays(b) - toDays(a);
}

export function compareDates(a: DateStr, b: DateStr): number {
  return toDays(a) - toDays(b);
}

/** 期間の日数。終了日を含む（12/1〜12/15 = 15日間）。 */
export function durationDays(start: DateStr, end: DateStr): number {
  return daysBetween(start, end) + 1;
}

/** 曜日（0=日曜 … 6=土曜）。 */
export function weekday(s: DateStr): number {
  return (((toDays(s) + 4) % 7) + 7) % 7;
}

/** その日を含む週の月曜日（週は月曜始まり）。 */
export function mondayOf(s: DateStr): DateStr {
  return addDays(s, -((weekday(s) + 6) % 7));
}

/** 暦月で n ヶ月加減する。存在しない日付は月末に丸める（例: 3/31 の1ヶ月前 = 2/28）。 */
export function addMonths(s: DateStr, n: number): DateStr {
  const p = parts(s);
  if (!p) throw new RangeError(`不正な日付: ${s}`);
  const total = p[0] * 12 + (p[1] - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(Math.min(p[2], daysInMonth(y, m)), 2)}`;
}
