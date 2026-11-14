// @req F-212, NF-009
import { describe, expect, it } from 'vitest';
import { filterCmds, findByKey, matchShortcut, type Cmd } from '../../src/renderer/shortcuts';

const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
const run = () => undefined;

describe('matchShortcut', () => {
  it('Ctrl+K は Ctrl（または Cmd）と k', () => {
    expect(matchShortcut(k('k', { ctrlKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchShortcut(k('K', { metaKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchShortcut(k('k'), 'Ctrl+K')).toBe(false);
  });
  it('Shift の有無を区別する（Ctrl+Z と Ctrl+Shift+Z）', () => {
    expect(matchShortcut(k('z', { ctrlKey: true, shiftKey: true }), 'Ctrl+Z')).toBe(false);
    expect(matchShortcut(k('Z', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z')).toBe(true);
  });
  it('修飾キーなしのキーは、Ctrl や Alt が付いていると効かない', () => {
    expect(matchShortcut(k('t'), 'T')).toBe(true);
    expect(matchShortcut(k('t', { ctrlKey: true }), 'T')).toBe(false);
    expect(matchShortcut(k('t', { altKey: true }), 'T')).toBe(false);
  });
  it('記号は Shift の有無を問わない（? / +）', () => {
    expect(matchShortcut(k('?', { shiftKey: true }), '?')).toBe(true);
    expect(matchShortcut(k('+', { shiftKey: true }), '+')).toBe(true);
    expect(matchShortcut(k('='), '+')).toBe(true);
    expect(matchShortcut(k('-'), '-')).toBe(true);
  });
});

describe('findByKey / filterCmds', () => {
  const cmds: Cmd[] = [
    { id: 'palette', label: '操作を検索', group: '表示', shortcut: 'Ctrl+K', inputOk: true, run },
    { id: 'today', label: '今日へ移動', group: '表示', shortcut: 'T', run },
    { id: 'redo', label: 'やり直し', group: '編集', shortcut: 'Ctrl+Y', also: 'Ctrl+Shift+Z', run },
    { id: 'off', label: '無効', group: '編集', shortcut: 'Q', enabled: false, run },
  ];
  it('入力欄では inputOk のものだけ効く', () => {
    expect(findByKey(cmds, k('t'), true)).toBeUndefined();
    expect(findByKey(cmds, k('t'), false)?.id).toBe('today');
    expect(findByKey(cmds, k('k', { ctrlKey: true }), true)?.id).toBe('palette');
  });
  it('also のキーでも実行できる。無効なコマンドは効かない', () => {
    expect(findByKey(cmds, k('Z', { ctrlKey: true, shiftKey: true }), false)?.id).toBe('redo');
    expect(findByKey(cmds, k('q'), false)).toBeUndefined();
  });
  it('パレットの絞り込みは、空白区切りの語をすべて含むもの。無効は出さない', () => {
    expect(filterCmds(cmds, '').map((c) => c.id)).toEqual(['palette', 'today', 'redo']);
    expect(filterCmds(cmds, '編集 やり').map((c) => c.id)).toEqual(['redo']);
    expect(filterCmds(cmds, '無効')).toEqual([]);
  });
});
