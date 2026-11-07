// @req NF-009
import { describe, expect, it } from 'vitest';
import { t } from '../../src/renderer/i18n';

describe('文言の取得（NF-009）', () => {
  it('キーから日本語の文言を返す', () => {
    expect(t('app.title')).toBe('プロジェクトスケジュールエディタ');
  });
  it('{name} をパラメータで置換する', () => {
    expect(t('app.version', { version: '1.2.3' })).toBe('バージョン 1.2.3');
  });
  it('パラメータが無いときはプレースホルダをそのまま残す', () => {
    expect(t('app.version')).toBe('バージョン {version}');
  });
});
