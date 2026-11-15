// @req F-108
import { describe, expect, it } from 'vitest';
import { fitLines, stickyLanes, wrapText } from '../../../src/domain/timeline/sticky';

describe('wrapText', () => {
  it('改行を守り、幅に収まるよう文字単位で折り返す', () => {
    expect(wrapText('ab\ncd', 100, 11)).toEqual(['ab', 'cd']);
    expect(wrapText('あいうえお', 22, 11)).toEqual(['あい', 'うえ', 'お']); // 全角 11px/字、幅 22px
    expect(wrapText('', 100, 11)).toEqual(['']);
    expect(wrapText('あ', 1, 11)).toEqual(['あ']); // 幅より大きい 1 文字でも無限ループしない
  });
});

describe('stickyLanes / fitLines', () => {
  it('行数がレーン数（1〜8）。幅（span）が狭いほど増える', () => {
    expect(stickyLanes({ text: 'a' })).toBe(1);
    expect(stickyLanes({ text: 'a\nb\nc' })).toBe(3);
    expect(stickyLanes({ text: 'あ'.repeat(200), span: 3 })).toBe(8);
    expect(stickyLanes({ text: 'あ'.repeat(30), span: 3 })).toBeGreaterThan(stickyLanes({ text: 'あ'.repeat(30), span: 30 }));
  });
  it('収まらなければ最後の行を省略記号で終える', () => {
    expect(fitLines(['a', 'b'], 3)).toEqual(['a', 'b']);
    expect(fitLines(['a', 'b', 'c'], 2)).toEqual(['a', 'b…']);
  });
});
