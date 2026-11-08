// @req F-603, F-804
// 祝日・稼働日カレンダー（純 TypeScript）。日本の祝日（振替休日・国民の休日を含む）の計算と、会社の休日・特別稼働日・休みの曜日の設定。
// 設定は calendar.json（日程の自動保存の対象外。標準日程と同じ扱い。docs/data-model.html 2, 8）。
import { z } from 'zod';
import { addDays, fromDays, isDateStr, toDays, weekdayOfDay, type DateStr } from './date';
import { stableStringify } from './serialize';

export const CALENDAR_PATH = 'calendar.json';

const dateKeyed = z.record(
  z.string().refine(isDateStr, '不正な日付（YYYY-MM-DD）'),
  z.string().max(200),
);

export const calendarSchema = z.strictObject({
  /** 日本の祝日（振替休日・国民の休日を含む）を休みにするか。 */
  japaneseHolidays: z.boolean(),
  /** 毎週の休みの曜日（0=日曜 … 6=土曜）。 */
  weekend: z.array(z.number().int().min(0).max(6)).max(7),
  /** 会社の休日・追加の休日（日付 → 名称）。 */
  holidays: dateKeyed,
  /** 特別稼働日（土曜出勤・祝日出勤など。日付 → 名称）。休みに勝つ。 */
  workdays: dateKeyed,
});
export type Calendar = z.infer<typeof calendarSchema>;

export const defaultCalendar = (): Calendar => ({ japaneseHolidays: true, weekend: [0, 6], holidays: {}, workdays: {} });

export function serializeCalendar(c: Calendar): string {
  return stableStringify({ ...c, weekend: [...new Set(c.weekend)].sort() });
}

export function parseCalendar(text: string): { readonly ok: true; readonly calendar: Calendar } | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `JSON として読めない: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = calendarSchema.safeParse(raw);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.map(String).join('.') || '値'}: ${i.message}`).join(' / ') };
  return { ok: true, calendar: r.data };
}

// ---- 日本の祝日 ----

const FIRST_YEAR = 1980; // 春分・秋分の近似式の有効範囲（1980〜2099）
const LAST_YEAR = 2099;
const p2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): DateStr => `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;

/** その月の第 n 月曜日の日（1〜31）。 */
function nthMondayDay(y: number, m: number, n: number): number {
  const first = toDays(ymd(y, m, 1));
  return Number(fromDays(first + ((1 - weekdayOfDay(first) + 7) % 7) + (n - 1) * 7).slice(8));
}

const springEquinox = (y: number): number => Math.floor(20.8431 + 0.242194 * (y - 1980)) - Math.floor((y - 1980) / 4);
const autumnEquinox = (y: number): number => Math.floor(23.2488 + 0.242194 * (y - 1980)) - Math.floor((y - 1980) / 4);

const cache = new Map<number, Readonly<Record<DateStr, string>>>();

/** その年の日本の祝日（日付 → 名称）。1980〜2099 年のみ（範囲外は空）。 */
export function japaneseHolidays(year: number): Readonly<Record<DateStr, string>> {
  const hit = cache.get(year);
  if (hit) return hit;
  const h: Record<DateStr, string> = {};
  if (year >= FIRST_YEAR && year <= LAST_YEAR) {
    const add = (m: number, d: number, name: string): void => {
      h[ymd(year, m, d)] = name;
    };
    add(1, 1, '元日');
    if (year >= 2000) add(1, nthMondayDay(year, 1, 2), '成人の日');
    else add(1, 15, '成人の日');
    if (year >= 1967) add(2, 11, '建国記念の日');
    if (year >= 2020) add(2, 23, '天皇誕生日');
    add(3, springEquinox(year), '春分の日');
    add(4, 29, year >= 2007 ? '昭和の日' : year >= 1989 ? 'みどりの日' : '天皇誕生日');
    add(5, 3, '憲法記念日');
    if (year >= 2007) add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    if (year === 2020) add(7, 23, '海の日');
    else if (year === 2021) add(7, 22, '海の日');
    else if (year >= 2003) add(7, nthMondayDay(year, 7, 3), '海の日');
    else if (year >= 1996) add(7, 20, '海の日');
    if (year === 2020) add(8, 10, '山の日');
    else if (year === 2021) add(8, 8, '山の日');
    else if (year >= 2016) add(8, 11, '山の日');
    if (year >= 2003) add(9, nthMondayDay(year, 9, 3), '敬老の日');
    else add(9, 15, '敬老の日');
    add(9, autumnEquinox(year), '秋分の日');
    const sports = year >= 2020 ? 'スポーツの日' : '体育の日';
    if (year === 2020) add(7, 24, sports);
    else if (year === 2021) add(7, 23, sports);
    else if (year >= 2000) add(10, nthMondayDay(year, 10, 2), sports);
    else add(10, 10, sports);
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');
    if (year >= 1989 && year <= 2018) add(12, 23, '天皇誕生日');
    if (year === 2019) {
      add(5, 1, '休日（天皇の即位の日）');
      add(10, 22, '休日（即位礼正殿の儀）');
    }
    if (year === 1989) add(2, 24, '昭和天皇の大喪の礼');
    if (year === 1990) add(11, 12, '即位礼正殿の儀');
    if (year === 1993) add(6, 9, '皇太子殿下の結婚の儀');
    if (year >= 1985) {
      // 国民の休日: 前日も翌日も祝日の平日（日曜は休みなので対象外）
      const base = { ...h };
      for (const d of Object.keys(base)) {
        const next = addDays(d, 1);
        const after = addDays(d, 2);
        if (!base[next] && base[after] && weekdayOfDay(toDays(next)) !== 0) h[next] = '国民の休日';
      }
    }
    // 振替休日: 日曜の祝日は、翌日以降で最初の祝日でない日が休み
    for (const d of Object.keys({ ...h }).sort()) {
      if (weekdayOfDay(toDays(d)) !== 0 || h[d] === '振替休日') continue;
      let n = addDays(d, 1);
      while (h[n]) n = addDays(n, 1);
      if (n.startsWith(`${year}-`)) h[n] = '振替休日';
    }
  }
  cache.set(year, h);
  return h;
}

// ---- 判定 ----

const yearOf = (d: DateStr): number => Number(d.slice(0, 4));

/** 休みの名称（会社の休日 → 日本の祝日の順。特別稼働日は休みにしない）。無ければ null。 */
export function holidayName(c: Calendar, date: DateStr): string | null {
  if (c.workdays[date] !== undefined) return null;
  const own = c.holidays[date];
  if (own !== undefined) return own;
  return c.japaneseHolidays ? (japaneseHolidays(yearOf(date))[date] ?? null) : null;
}

/** 稼働日でない日か（特別稼働日 → 休みの曜日 → 休日の順に判定）。 */
export function isNonWorking(c: Calendar, date: DateStr): boolean {
  if (c.workdays[date] !== undefined) return false;
  if (c.weekend.includes(weekdayOfDay(toDays(date)))) return true;
  return holidayName(c, date) !== null;
}

/** 標準日程の日数計算などで使う「稼働日か」の関数。 */
export const workdayFn = (c: Calendar) => (date: DateStr): boolean => !isNonWorking(c, date);

/** 通算日数版（描画で大量に判定する。1970-01-01 = 0）。 */
export const nonWorkingDayFn = (c: Calendar) => (day: number): boolean => isNonWorking(c, fromDays(day));
