// @req NF-014, F-708
// AI プロバイダの選択（差し替え口）。ここだけを変えれば、AI の接続先を替えられる。
// 本番は CopilotProvider（copilot.ts）。SDK への依存はそこに隔離され、差し替えは createProvider だけで済む。
// 実契約での検証（認証・ツール制限の実挙動・EMU）は未実施: docs/architecture.html 17。
import { app } from 'electron';
import { CopilotProvider } from './copilot';
import { MockProvider } from './mockProvider';
import { NullProvider, type AiProvider } from './provider';

export function createProvider(): AiProvider {
  // テスト用（開発・E2E のみ。パッケージ版では見ない）: 接続先が無い状態（NullProvider）にする / 決定的なモック
  if (!app.isPackaged && process.env['PSE_AI_NONE'] === '1') return new NullProvider();
  if (!app.isPackaged && process.env['PSE_AI_MOCK'] === '1') return new MockProvider({ delayMs: process.env['PSE_AI_MOCK_DELAY'] ? Number(process.env['PSE_AI_MOCK_DELAY']) : 0 });
  // 本番は Copilot SDK（実行本体も同梱。決定 I2）。使えない理由（未サインイン・接続失敗など）は status() が返し、AI だけが無効になる
  return new CopilotProvider();
}
