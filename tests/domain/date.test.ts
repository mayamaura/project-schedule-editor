// @req F-104, F-809
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  durationDays,
  fromDays,
  isDateStr,
  isLeapYear,
  mondayOf,
  toDays,
  weekday,
} from '../../src/domain/date';

describe('isDateStr（形式と暦の検証）', () => {
  it.each(['2026-11-07', '2024-02-29', '0001-01-01', '9999-12-31'])('%s は正しい日付', (d) => {
    expect(isDateStr(d)).toBe(true);
  });
  it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-31', '2026-4-1', '26-11-07', '2026/11/07', '2026-11-07T00:00', '', 'abc', '0000-01-01'])(
    '%s は不正',
    (d) => {
      expect(isDateStr(d)).toBe(false);
    },
  );
  it('文字列以外は不正', () => {
    expect(isDateStr(20261107)).toBe(false);
    expect(isDateStr(null)).toBe(false);
    expect(isDateStr(undefined)).toBe(false);
  });
});

describe('閏年と月の日数', () => {
  it.each([
    [2000, true],
    [1900, false],
    [2024, true],
    [2026, false],
    [2100, false],
  ])('%i 年の閏年判定 = %s', (y, leap) => {
    expect(isLeapYear(y)).toBe(leap);
  });
  it('月の日数（閏年の2月を含む）', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('通算日数との変換', () => {
  it('1970-01-01 が 0', () => {
    expect(toDays('1970-01-01')).toBe(0);
    expect(fromDays(0)).toBe('1970-01-01');
  });
  it('往復して元に戻る（1900〜2200 年の全日）', () => {
    for (let n = toDays('1900-01-01'); n <= toDays('2200-12-31'); n += 1) {
      const s = fromDays(n);
      expect(toDays(s)).toBe(n);
    }
  });
  it('既知の値と一致する（Date.UTC で独立に検算した値）', () => {
    expect(toDays('2000-03-01')).toBe(11017);
    expect(toDays('2026-11-07')).toBe(20764);
  });
  it('不正な日付は例外', () => {
    expect(() => toDays('2026-02-30')).toThrow(RangeError);
  });
});

describe('日数の加減算と差', () => {
  it('月跨ぎ・年跨ぎ・閏日', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-11-07', 0)).toBe('2026-11-07');
  });
  it('差と比較', () => {
    expect(daysBetween('2026-12-01', '2026-12-15')).toBe(14);
    expect(daysBetween('2026-12-15', '2026-12-01')).toBe(-14);
    expect(compareDates('2026-12-01', '2026-12-15')).toBeLessThan(0);
    expect(compareDates('2026-12-15', '2026-12-01')).toBeGreaterThan(0);
    expect(compareDates('2026-12-01', '2026-12-01')).toBe(0);
  });
  it('期間の日数は終了日を含む（K5）: 12/1〜12/15 は15日間', () => {
    expect(durationDays('2026-12-01', '2026-12-15')).toBe(15);
    expect(durationDays('2026-12-01', '2026-12-01')).toBe(1);
  });
});

describe('曜日と週（月曜始まり）', () => {
  it('曜日（0=日曜〜6=土曜）', () => {
    expect(weekday('2026-11-07')).toBe(6); // 土曜
    expect(weekday('2026-11-08')).toBe(0); // 日曜
    expect(weekday('2026-11-09')).toBe(1); // 月曜
    expect(weekday('1970-01-01')).toBe(4); // 木曜
  });
  it('その週の月曜日（図の例: 11/2, 9, 16, 23, 30）', () => {
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02'); // 日曜は前の月曜
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-12-06')).toBe('2026-11-30'); // 月跨ぎ
    expect(mondayOf('2027-01-03')).toBe('2026-12-28'); // 年跨ぎ
  });
});

describe('月の加減算（暦月・月末に丸める。決定 F7）', () => {
  it.each([
    ['2026-03-31', -1, '2026-02-28'],
    ['2024-03-31', -1, '2024-02-29'], // 閏年
    ['2026-01-31', 1, '2026-02-28'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-11-30', 3, '2027-02-28'], // 年跨ぎ
    ['2026-01-01', -1, '2025-12-01'], // 年跨ぎ（遡る）
    ['2026-05-31', -3, '2026-02-28'],
    ['2026-08-31', 6, '2027-02-28'],
    ['2026-11-07', 0, '2026-11-07'],
    ['2026-03-15', 12, '2027-03-15'],
    ['2026-03-15', -24, '2024-03-15'],
  ])('%s に %i ヶ月 = %s', (d, n, expected) => {
    expect(addMonths(d, n)).toBe(expected);
  });
  it('加法的でない: 3/31 の1ヶ月前（2/28）の1ヶ月後は 3/28 で、3/31 に戻らない', () => {
    expect(addMonths(addMonths('2026-03-31', -1), 1)).toBe('2026-03-28');
  });
});
