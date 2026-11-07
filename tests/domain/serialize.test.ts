// @req NF-005, NF-006, NF-004, F-501
import { describe, expect, it } from 'vitest';
import { generateSample } from '../../src/domain/sample';
import { parseSchedule, runMigrations, serializeSchedule, stableStringify, type Files } from '../../src/domain/serialize';
import { basic, ev, proj, schedule } from './fixtures';

describe('stableStringify（決定的な整形）', () => {
  it('キー昇順（再帰）・インデント2・LF・末尾改行', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe('{\n  "a": {\n    "c": "x",\n    "d": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n');
  });
  it('JSON.stringify(…, null, 2) と同じ体裁（キー順を除く）で、CRLF を含まない', () => {
    const v = { z: [{ b: 2, a: 1 }], y: null, x: 'あ' };
    const sorted = { x: 'あ', y: null, z: [{ a: 1, b: 2 }] };
    expect(stableStringify(v)).toBe(`${JSON.stringify(sorted, null, 2)}\n`);
    expect(stableStringify(v)).not.toContain('\r');
  });
  it('undefined の値は出力しない / 空の配列・オブジェクト', () => {
    expect(stableStringify({ a: undefined, b: [], c: {} })).toBe('{\n  "b": [],\n  "c": {}\n}\n');
  });
  it('整数風のキー（"10", "9"）も辞書順で出る（JS の整数キー順に依存しない）', () => {
    expect(stableStringify({ '9': 1, '10': 2, a: 3 })).toBe('{\n  "10": 2,\n  "9": 1,\n  "a": 3\n}\n');
  });
  it('キーの挿入順が違っても同じ出力になる', () => {
    expect(stableStringify({ a: 1, b: { x: 1, y: 2 } })).toBe(stableStringify({ b: { y: 2, x: 1 }, a: 1 }));
  });
  it('日本語・エスケープが必要な文字', () => {
    const t = stableStringify({ name: '設計"レビュー"\n次', note: '</script>' });
    expect(JSON.parse(t)).toEqual({ name: '設計"レビュー"\n次', note: '</script>' });
  });
});

describe('serializeSchedule / parseSchedule（往復）', () => {
  it('ファイル構成: 1プロジェクト1ファイル・1依存1ファイル・パスは昇順', () => {
    const files = serializeSchedule(basic());
    expect(Object.keys(files)).toEqual(['dependencies/d1.json', 'projects/A.json', 'projects/A1.json', 'schedule.json', 'types.json']);
    expect(JSON.parse(files['schedule.json'] ?? '')).toEqual({ schemaVersion: 1 });
  });
  it('往復して同一になる（Schedule → ファイル → Schedule → ファイル）', () => {
    const s = basic();
    const first = serializeSchedule(s);
    const r = parseSchedule(first);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.schedule).toEqual(s);
    expect(r.issues).toEqual([]);
    expect(serializeSchedule(r.schedule)).toEqual(first); // 出力が安定（無意味な差分を出さない）
  });
  it('500×50×8年のサンプルも往復で同一', () => {
    const s = generateSample({ projects: 500, eventsPerProject: 50, years: 8 });
    const r = parseSchedule(serializeSchedule(s));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.schedule).toEqual(s);
      expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
  it('1プロジェクトの変更は、そのプロジェクトのファイルだけが変わる（競合しにくい）', () => {
    const a = serializeSchedule(basic());
    const s2 = basic();
    const changed = { ...s2, projects: { ...s2.projects, A1: { ...s2.projects['A1']!, name: '筐体2' } } };
    const b = serializeSchedule(changed);
    expect(Object.keys(b).filter((k) => a[k] !== b[k])).toEqual(['projects/A1.json']);
  });
  it('項目の追加は1行ずつの差分になる（イベントはIDキーのオブジェクトで、隣の行のカンマが変わらない）', () => {
    const a = serializeSchedule(schedule([proj('A', { events: { e1: ev('a', '2026-01-01', '2026-01-02') } })]))['projects/A.json'] ?? '';
    const b = serializeSchedule(schedule([proj('A', { events: { e1: ev('a', '2026-01-01', '2026-01-02'), e2: ev('b', '2026-02-01', '2026-02-02') } })]))['projects/A.json'] ?? '';
    const al = new Set(a.split('\n'));
    const added = b.split('\n').filter((l) => !al.has(l));
    expect(added.some((l) => l.includes('"e2"'))).toBe(true);
    expect(a.split('\n').every((l) => b.split('\n').includes(l) || l.trim() === '},')).toBe(true);
  });
});

describe('parseSchedule（読み込めないもの・不整合）', () => {
  const good = (): Files => serializeSchedule(basic());

  it('schedule.json が無い / 壊れている / 版が不正', () => {
    const noMeta = good();
    delete noMeta['schedule.json'];
    expect(parseSchedule(noMeta)).toMatchObject({ status: 'error', errors: [{ path: 'schedule.json' }] });
    expect(parseSchedule({ ...good(), 'schedule.json': '{' })).toMatchObject({ status: 'error' });
    expect(parseSchedule({ ...good(), 'schedule.json': '{"schemaVersion":0}' })).toMatchObject({ status: 'error' });
    expect(parseSchedule({ ...good(), 'schedule.json': '{"schemaVersion":"1"}' })).toMatchObject({ status: 'error' });
  });
  it('新しい版のデータは tooNew（読み取り専用で開くため、中身は読まない）', () => {
    expect(parseSchedule({ ...good(), 'schedule.json': '{"schemaVersion":2}', 'projects/A.json': 'ぐちゃぐちゃ' })).toEqual({ status: 'tooNew', fileVersion: 2 });
  });
  it('壊れたファイルは、全ての問題をパス付きで返す（黙って捨てない）', () => {
    const f = good();
    f['projects/A.json'] = '{ broken';
    f['projects/A1.json'] = JSON.stringify({ id: 'A1', name: '', parentId: 'A', order: 'i', events: {}, milestones: {} });
    f['dependencies/d1.json'] = JSON.stringify({ id: 'd1', from: { kind: 'event', id: 'e1' }, to: { kind: 'event', id: 'e2' }, type: 'XX', lagDays: 0 });
    const r = parseSchedule(f);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      const paths = r.errors.map((e) => e.path);
      expect(paths).toContain('projects/A.json');
    }
    // JSON が読めるファイルだけにしても、スキーマ違反がパス付きで出る
    const g = good();
    g['projects/A1.json'] = JSON.stringify({ id: 'A1', name: '', parentId: 'A', order: 'i', events: {}, milestones: {} });
    g['dependencies/d1.json'] = JSON.stringify({ id: 'd1', from: { kind: 'event', id: 'e1' }, to: { kind: 'event', id: 'e2' }, type: 'XX', lagDays: 0 });
    const r2 = parseSchedule(g);
    expect(r2.status).toBe('error');
    if (r2.status === 'error') expect(r2.errors.map((e) => e.path)).toEqual(['dependencies/d1.json', 'projects/A1.json']);
  });
  it('JSON の構文エラーと、別のファイルのスキーマ違反を、1回で全て報告する（直しては開き直す手間をかけさせない）', () => {
    const f = good();
    f['projects/A.json'] = '{ broken'; // 構文エラー
    f['dependencies/d1.json'] = JSON.stringify({ id: 'd1', type: 'XX' }); // スキーマ違反（別のファイル）
    f['projects/A1.json'] = JSON.stringify({ id: 'A1', name: '', parentId: 'A', order: 'i', events: {}, milestones: {} }); // スキーマ違反
    const r = parseSchedule(f);
    expect(r.status).toBe('error');
    if (r.status === 'error') expect([...new Set(r.errors.map((e) => e.path))]).toEqual(['dependencies/d1.json', 'projects/A.json', 'projects/A1.json']);
  });
  it('構文エラーがあり、かつ古い版（マイグレーションが必要）のときは、構文エラーだけを返す（移行できないため）', () => {
    const r = parseSchedule({ ...good(), 'schedule.json': '{"schemaVersion":1}', 'projects/A.json': '{ broken' }, {}, 2);
    expect(r).toMatchObject({ status: 'error', errors: [{ path: 'projects/A.json' }] });
  });
  it('未知のキー・不正な日付・不正なIDは構造エラー（外部での編集ミスを検出）', () => {
    for (const bad of [
      { id: 'A', name: 'x', parentId: null, order: 'i', events: {}, milestones: {}, extra: 1 },
      { id: 'A', name: 'x', parentId: null, order: 'i', events: { e1: { name: 'a', start: '2026-02-30', end: '2026-03-01', type: 't' } }, milestones: {} },
      { id: 'A', name: 'x', parentId: null, order: 'i', events: { 'bad id': { name: 'a', start: '2026-01-01', end: '2026-01-02', type: 't' } }, milestones: {} },
      { id: 'A', name: 'x', parentId: null, order: 'I0', events: {}, milestones: {} },
    ]) {
      expect(parseSchedule({ 'schedule.json': '{"schemaVersion":1}', 'projects/A.json': JSON.stringify(bad) }).status).toBe('error');
    }
  });
  it('ファイル名と id が一致しない', () => {
    const f = good();
    f['projects/X.json'] = f['projects/A1.json'] ?? '';
    const r = parseSchedule(f);
    expect(r).toMatchObject({ status: 'error', errors: [{ path: 'projects/X.json' }] });
  });
  it('意味の不整合（終了＜開始・依存の循環など）は読み込めたうえで issues として返す', () => {
    const f = good();
    f['projects/A1.json'] = JSON.stringify({ id: 'A1', name: '筐体', parentId: 'A', order: 'i', events: { e3: { name: '金型', start: '2027-03-01', end: '2027-01-01', type: 'phase' } }, milestones: {} });
    const r = parseSchedule(f);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.issues.map((i) => i.rule)).toContain('end-before-start');
  });
  it('対象外のファイル（views/ など）は無視する。types.json が無くても読める', () => {
    const f = good();
    f['views/overview.json'] = '何でもよい';
    delete f['types.json'];
    expect(parseSchedule(f).status).toBe('ok');
  });
  it('types.json の構造エラー', () => {
    expect(parseSchedule({ ...good(), 'types.json': '{"phase": {"name": ""}}' }).status).toBe('error');
  });
});

describe('マイグレーション（NF-006）', () => {
  it('版を1つずつ順に上げる', () => {
    const table = {
      1: (raw: Record<string, unknown>) => ({ ...raw, a: 1 }),
      2: (raw: Record<string, unknown>) => ({ ...raw, b: (raw['a'] as number) + 1 }),
    };
    expect(runMigrations({}, 1, 3, table)).toEqual({ a: 1, b: 2 });
    expect(runMigrations({ x: 1 }, 2, 2, table)).toEqual({ x: 1 }); // 同じ版なら何もしない
  });
  it('マイグレーションが定義されていない版は例外（黙って通さない）', () => {
    expect(() => runMigrations({}, 1, 2, {})).toThrow('未定義');
  });
  it('parseSchedule が古い版のデータに、版ごとのマイグレーションを順に適用する', () => {
    const rename = (raw: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...raw };
      const a = out['projects/A.json'] as Record<string, unknown>;
      out['projects/A.json'] = { ...a, name: `${String(a['name'])}（移行済み）` };
      return out;
    };
    const r = parseSchedule(serializeSchedule(basic()), { 1: rename }, 2);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.schedule.projects['A']?.name).toBe('新製品A（移行済み）');
      expect(r.schedule.schemaVersion).toBe(2);
    }
  });
  it('マイグレーションが無い古い版は、読み込みエラーにする（黙って読まない）', () => {
    expect(parseSchedule(serializeSchedule(basic()), {}, 2)).toMatchObject({ status: 'error', errors: [{ path: 'schedule.json' }] });
  });
  it('目標より新しい版は tooNew', () => {
    expect(parseSchedule({ 'schedule.json': '{"schemaVersion":3}' }, {}, 2)).toEqual({ status: 'tooNew', fileVersion: 3 });
  });
});
