// @req F-206
import { describe, expect, it } from 'vitest';
import type { Command } from '../../src/domain/commands';
import { History } from '../../src/domain/history';
import { basic, ev } from './fixtures';

const add = (id: string): Command => ({ type: 'addEvent', projectId: 'A', id, event: ev(id, '2027-01-01', '2027-01-02') });
const names = (h: History): string[] => Object.keys(h.present.projects['A']?.events ?? {});

describe('History（Undo / Redo）', () => {
  it('実行 → 取り消し → やり直し', () => {
    const h = new History(basic());
    expect(h.canUndo || h.canRedo).toBe(false);
    h.execute(add('n1'));
    h.execute(add('n2'));
    expect(names(h)).toEqual(['e1', 'e2', 'n1', 'n2']);
    expect(h.undo()).toBe(true);
    expect(names(h)).toEqual(['e1', 'e2', 'n1']);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false); // これ以上戻れない
    expect(names(h)).toEqual(['e1', 'e2']);
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(false);
    expect(names(h)).toEqual(['e1', 'e2', 'n1', 'n2']);
  });

  it('batch は Undo 1回で全て戻る（F-206: 確定時に1コマンド）', () => {
    const h = new History(basic());
    h.execute({ type: 'batch', commands: [add('n1'), add('n2'), add('n3')] });
    h.undo();
    expect(names(h)).toEqual(['e1', 'e2']);
  });

  it('削除の連鎖も Undo で全て復元される（プロジェクト・項目・依存）', () => {
    const h = new History(basic());
    const before = h.present;
    h.execute({ type: 'deleteProject', id: 'A' });
    expect(h.present.projects).toEqual({});
    h.undo();
    expect(h.present).toBe(before); // 同一参照で完全に復元
  });

  it('失敗したコマンドは履歴にも状態にも影響しない', () => {
    const h = new History(basic());
    const r = h.execute({ type: 'deleteEvent', id: 'none' });
    expect(r.ok).toBe(false);
    expect(h.canUndo).toBe(false);
    h.execute(add('n1'));
    h.undo();
    h.execute({ type: 'deleteEvent', id: 'none' }); // 失敗しても Redo は消えない
    expect(h.canRedo).toBe(true);
  });

  it('新しいコマンドを実行すると Redo 履歴は破棄される', () => {
    const h = new History(basic());
    h.execute(add('n1'));
    h.undo();
    h.execute(add('n2'));
    expect(h.canRedo).toBe(false);
    expect(names(h)).toEqual(['e1', 'e2', 'n2']);
  });

  it('深さの上限を超えた古い履歴は捨てる', () => {
    const h = new History(basic(), 3);
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) h.execute(add(id));
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(3);
    expect(names(h)).toEqual(['e1', 'e2', 'a1', 'a2']); // 3回戻った先（最古の2件は戻れない）
  });

  it('isDirty / markSaved: 保存した状態に Undo で戻れば未保存ではなくなる', () => {
    const h = new History(basic());
    expect(h.isDirty).toBe(false);
    h.execute(add('n1'));
    expect(h.isDirty).toBe(true);
    h.markSaved();
    expect(h.isDirty).toBe(false);
    h.execute(add('n2'));
    expect(h.isDirty).toBe(true);
    h.undo();
    expect(h.isDirty).toBe(false);
    h.undo();
    expect(h.isDirty).toBe(true);
  });

  it('reset で状態を差し替え、履歴を破棄する', () => {
    const h = new History(basic());
    h.execute(add('n1'));
    h.reset(basic());
    expect(h.canUndo).toBe(false);
    expect(h.isDirty).toBe(false);
  });
});
