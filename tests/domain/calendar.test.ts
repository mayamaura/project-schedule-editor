// @req F-603, F-804
import { describe, expect, it } from 'vitest';
import { toDays } from '../../src/domain/date';
import {
  defaultCalendar,
  holidayName,
  isNonWorking,
  japaneseHolidays,
  parseCalendar,
  serializeCalendar,
  workdayFn,
  type Calendar,
} from '../../src/domain/calendar';
import { applyOffset } from '../../src/domain/template';

const dates = (y: number, month?: string): string[] =>
  Object.keys(japaneseHolidays(y))
    .filter((d) => !month || d.startsWith(`${y}-${month}`))
    .sort();

describe('日本の祝日（F-603）', () => {
  it('2026 年: 振替休日・国民の休日を含む 18 日', () => {
    expect(dates(2026)).toEqual([
      '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
      '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
    ]);
    expect(japaneseHolidays(2026)['2026-05-06']).toBe('振替休日');
    expect(japaneseHolidays(2026)['2026-09-22']).toBe('国民の休日');
    expect(japaneseHolidays(2026)['2026-03-20']).toBe('春分の日');
  });
  it('2027 年: 春分の日が日曜なので月曜が振替休日', () => {
    expect(dates(2027, '03')).toEqual(['2027-03-21', '2027-03-22']);
    expect(japaneseHolidays(2027)['2027-03-22']).toBe('振替休日');
    expect(dates(2027)).toHaveLength(17);
    expect(dates(2027, '09')).toEqual(['2027-09-20', '2027-09-23']);
  });
  it('2020 年の東京五輪の特例（海の日・スポーツの日・山の日の移動）と天皇誕生日の振替', () => {
    expect(dates(2020, '07')).toEqual(['2020-07-23', '2020-07-24']);
    expect(dates(2020, '08')).toEqual(['2020-08-10']);
    expect(dates(2020, '10')).toEqual([]);
    expect(japaneseHolidays(2020)['2020-02-24']).toBe('振替休日'); // 2/23（天皇誕生日）が日曜
    expect(japaneseHolidays(2020)['2020-07-24']).toBe('スポーツの日');
  });
  it('2019 年のゴールデンウィーク（4/27〜5/6 の連休の祝日）', () => {
    expect(dates(2019, '04')).toEqual(['2019-04-29', '2019-04-30']);
    expect(dates(2019, '05')).toEqual(['2019-05-01', '2019-05-02', '2019-05-03', '2019-05-04', '2019-05-05', '2019-05-06']);
    expect(japaneseHolidays(2019)['2019-12-23']).toBeUndefined(); // 2019 年の天皇誕生日は無い
  });
  it('天皇誕生日の移り変わり', () => {
    expect(japaneseHolidays(2018)['2018-12-23']).toBe('天皇誕生日');
    expect(japaneseHolidays(2021)['2021-02-23']).toBe('天皇誕生日');
  });
  it('対応範囲外の年は空', () => {
    expect(japaneseHolidays(1970)).toEqual({});
    expect(japaneseHolidays(2200)).toEqual({});
  });
});

describe('カレンダー（F-603）', () => {
  const cal = (c: Partial<Calendar> = {}): Calendar => ({ ...defaultCalendar(), ...c });

  it('既定は日本の祝日あり・土日が休み', () => {
    expect(holidayName(cal(), '2027-01-01')).toBe('元日');
    expect(isNonWorking(cal(), '2027-01-01')).toBe(true); // 祝日
    expect(isNonWorking(cal(), '2027-01-02')).toBe(true); // 土
    expect(isNonWorking(cal(), '2027-01-04')).toBe(false); // 月
  });
  it('祝日を使わない設定', () => {
    expect(isNonWorking(cal({ japaneseHolidays: false }), '2027-01-01')).toBe(false); // 金
    expect(holidayName(cal({ japaneseHolidays: false }), '2027-01-01')).toBeNull();
  });
  it('会社の休日を足せる。特別稼働日は休みに勝つ（土曜出勤・祝日出勤）', () => {
    const c = cal({ holidays: { '2026-12-29': '年末休業' }, workdays: { '2027-01-02': '休日出勤', '2027-01-01': '特別' } });
    expect(holidayName(c, '2026-12-29')).toBe('年末休業');
    expect(isNonWorking(c, '2026-12-29')).toBe(true); // 火
    expect(isNonWorking(c, '2027-01-02')).toBe(false); // 土だが稼働日
    expect(isNonWorking(c, '2027-01-01')).toBe(false); // 祝日だが稼働日
  });
  it('休みの曜日を変えられる（土曜稼働・水曜休み）', () => {
    const c = cal({ weekend: [0, 3] });
    expect(isNonWorking(c, '2027-01-02')).toBe(false); // 土
    expect(isNonWorking(c, '2027-01-06')).toBe(true); // 水
  });
  it('稼働日関数は標準日程の日数計算に使える（祝日を飛ばす）', () => {
    // 2027-01-01(金,元日) を挟む。12/31(金) から稼働日 +1 → 1/4(月)
    const o = { dayMode: 'working', adjust: 'none', isWorkday: workdayFn(cal()) } as const;
    expect(applyOffset('2026-12-31', { days: 1 }, o)).toBe('2027-01-04');
    expect(toDays('2027-01-04') - toDays('2026-12-31')).toBe(4);
  });
  it('保存形式: 整形出力を読み戻すと同じ。壊れた内容は理由を返す', () => {
    const c = cal({ holidays: { '2026-12-29': '年末休業' } });
    const text = serializeCalendar(c);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseCalendar(text)).toEqual({ ok: true, calendar: c });
    expect(parseCalendar('{').ok).toBe(false);
    expect(parseCalendar('{"japaneseHolidays":"yes"}').ok).toBe(false);
    expect(parseCalendar(JSON.stringify({ ...c, holidays: { 'x': 'y' } })).ok).toBe(false); // 日付でないキー
    expect(parseCalendar(JSON.stringify({ ...c, weekend: [7] })).ok).toBe(false);
  });
});
