// @req F-602
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/domain/commands';
import { exportRows, importRows, normalizeDate, parseCsv, toCsv } from '../../src/domain/csv';
import { basic, ev, ms, proj, schedule } from './fixtures';

describe('CSV の読み書き（F-602）', () => {
  it('引用符・カンマ・改行・二重引用符を含む値を読める。BOM と CRLF も扱う', () => {
    const text = '﻿a,b,c\r\n"x,y","1""2","line1\nline2"\r\n\r\nlast,,\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x,y', '1"2', 'line1\nline2'],
      ['last', '', ''],
    ]);
  });
  it('書き出しと読み込みは往復できる', () => {
    const rows = [['名称', '備考'], ['設計,改', 'a"b'], ['改行\nあり', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(toCsv(rows).includes('\r\n')).toBe(true);
  });
});

describe('日付の読み取り', () => {
  it('よくある書式を YYYY-MM-DD にそろえる。読めないものは null', () => {
    expect(normalizeDate('2026-11-01')).toBe('2026-11-01');
    expect(normalizeDate('2026/1/5')).toBe('2026-01-05');
    expect(normalizeDate('2026年12月15日')).toBe('2026-12-15');
    expect(normalizeDate(' 2026.3.9 ')).toBe('2026-03-09');
    expect(normalizeDate('46327')).toBe('2026-11-01'); // Excel のシリアル値（1900 年起点）
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('あした')).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });
});

describe('書き出し', () => {
  it('プロジェクト（階層は「 / 」区切り）・区分・名称・日付・種別・メモの行になる', () => {
    const s = schedule([
      proj('P', { name: '新製品A', order: 'a', events: { e1: ev('設計', '2026-11-01', '2026-12-15', { note: 'メモ' }) }, milestones: { m1: ms('レビュー', '2026-12-20') } }),
      proj('C', { name: '筐体', order: 'a', parentId: 'P', events: { e2: ev('試作', '2027-01-05', '2027-03-31') } }),
    ]);
    const rows = exportRows(s);
    expect(rows[0]).toEqual(['プロジェクト', '区分', '名称', '開始', '終了', '種別', 'メモ']);
    expect(rows).toContainEqual(['新製品A', 'イベント', '設計', '2026-11-01', '2026-12-15', 'phase', 'メモ']);
    expect(rows).toContainEqual(['新製品A', 'マイルストーン', 'レビュー', '2026-12-20', '2026-12-20', 'review', '']);
    expect(rows).toContainEqual(['新製品A / 筐体', 'イベント', '試作', '2027-01-05', '2027-03-31', 'phase', '']);
  });
});

describe('取り込み', () => {
  const header = ['プロジェクト', '区分', '名称', '開始', '終了', '種別', 'メモ'];

  it('新しいプロジェクト（階層つき）と、既存プロジェクトへの追加ができ、1 つの batch コマンドになる', () => {
    const base = basic();
    const existing = Object.values(base.projects)[0]!.name;
    const r = importRows(
      [
        header,
        ['新規X', 'イベント', '設計', '2026/11/1', '2026/12/15', 'phase', 'メモ'],
        ['新規X / 子', 'マイルストーン', 'リリース', '2027-03-31', '', '', ''],
        [existing, 'イベント', '追加分', '2027-04-01', '2027-04-10', '', ''],
      ],
      base,
    );
    expect(r.errors).toEqual([]);
    expect(r.command?.type).toBe('batch');
    expect(r.counts).toEqual({ projects: 2, events: 2, milestones: 1 });
    const done = applyCommand(base, r.command!);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const names = Object.values(done.schedule.projects).map((p) => p.name);
    expect(names).toContain('新規X');
    expect(names).toContain('子');
    const child = Object.values(done.schedule.projects).find((p) => p.name === '子')!;
    expect(child.parentId).toBe(Object.values(done.schedule.projects).find((p) => p.name === '新規X')!.id);
    const x = Object.values(done.schedule.projects).find((p) => p.name === '新規X')!;
    expect(Object.values(x.events)[0]).toMatchObject({ name: '設計', start: '2026-11-01', end: '2026-12-15', type: 'phase', note: 'メモ' });
    expect(Object.keys(done.schedule.projects)).toHaveLength(Object.keys(base.projects).length + 2); // 既存への追加ではプロジェクトを増やさない
  });

  it('区分が無い表でも、終了が空なら マイルストーン、あれば イベント とみなす。列名は英語でもよい', () => {
    const r = importRows(
      [
        ['project', 'name', 'start', 'end'],
        ['P1', 'a', '2026-11-01', '2026-11-10'],
        ['P1', 'b', '2026-11-12', ''],
      ],
      schedule(),
    );
    expect(r.errors).toEqual([]);
    expect(r.counts).toEqual({ projects: 1, events: 1, milestones: 1 });
  });

  it('おかしな行は理由つきで飛ばし、読める行だけ取り込める（行番号は 1 始まりで見出しを含む）', () => {
    const r = importRows(
      [
        header,
        ['P', 'イベント', '', '2026-11-01', '2026-11-10', '', ''], // 名称なし
        ['P', 'イベント', 'x', '2026-13-01', '2026-11-10', '', ''], // 日付が不正
        ['P', 'イベント', 'y', '2026-11-10', '2026-11-01', '', ''], // 終了 < 開始
        ['', 'イベント', 'z', '2026-11-01', '2026-11-02', '', ''], // プロジェクトなし
        ['P', 'イベント', 'ok', '2026-11-01', '2026-11-02', '', ''],
      ],
      schedule(),
    );
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(r.counts.events).toBe(1);
    expect(applyCommand(schedule(), r.command!).ok).toBe(true);
  });

  it('必要な列（プロジェクト・名称・開始）が無いと、取り込まずに理由を返す', () => {
    const r = importRows([['名称', '開始'], ['a', '2026-11-01']], schedule());
    expect(r.command).toBeNull();
    expect(r.errors[0]!.row).toBe(1);
  });

  it('書き出した表を別のデータへ取り込める（往復）', () => {
    const src = basic();
    const r = importRows(exportRows(src), schedule());
    expect(r.errors).toEqual([]);
    const done = applyCommand(schedule(), r.command!);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const count = (s: typeof src) => Object.values(s.projects).reduce((n, p) => n + Object.keys(p.events).length + Object.keys(p.milestones).length, 0);
    expect(count(done.schedule)).toBe(count(src));
  });
});
