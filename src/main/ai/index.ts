// @req NF-014, F-708
// AI プロバイダの選択（差し替え口）。ここだけを変えれば、AI の接続先を替えられる。
// 現在は、GitHub Copilot SDK を組み込む前の状態: 本番は NullProvider（AI 機能だけが無効で、理由が画面に出る）。
// Copilot SDK を組み込むときは、provider.ts のインターフェースを実装したアダプタ（このフォルダの copilot.ts）を作り、
// createProvider から返す。着手前の確認事項: ランタイム同梱の承認（open-questions I2）、SDK の追加（CLAUDE.md ルール 6）、
// 実契約での検証（認証・ツール制限の実挙動・EMU）。docs/architecture.html 17。
import { app } from 'electron';
import { MockProvider } from './mockProvider';
import { NullProvider, type AiProvider } from './provider';

export function createProvider(): AiProvider {
  // テスト用（開発・E2E のみ。パッケージ版では見ない）
  if (!app.isPackaged && process.env['PSE_AI_MOCK'] === '1') return new MockProvider({ delayMs: process.env['PSE_AI_MOCK_DELAY'] ? Number(process.env['PSE_AI_MOCK_DELAY']) : 0 });
  return new NullProvider();
}
