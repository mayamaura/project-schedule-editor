// @req NF-014, NF-012, F-708
// AI プロバイダ（SDK の差し替え口）。GitHub Copilot SDK は 1.0.x だが一部 API が実験的なので、SDK に触れるコードは
// このインターフェースの実装 1 つに隔離する（NF-014）。アプリ側（AiService・画面）は SDK を知らない。
// 実装が守ること（NF-012）: 公開するツールは AiToolbox.toolSpecs だけ（組み込みツールは無効化）、呼ばれたら
// toolbox.invoke に渡す、権限要求は toolSpecs 以外を全て拒否する、データを書き込むツールを足さない。
import type { AiToolbox } from '../../domain/ai/tools';

export interface AiStatus {
  /** AI を使えるか（SDK・認証・契約・ネットワーク）。使えなくても、他の機能には影響しない。 */
  readonly available: boolean;
  /** 使えない理由（利用者に見せる）。 */
  readonly reason?: string;
  /** 選べるモデル（F-713）。 */
  readonly models: readonly string[];
}

export interface AiRunInput {
  /** システムプロンプト（基本プロンプト + 利用者の指示・観点）。 */
  readonly system: string;
  /** 利用者のメッセージ（依頼 + 区切ったデータ）。 */
  readonly user: string;
  readonly model: string | undefined;
  readonly toolbox: AiToolbox;
  readonly signal: AbortSignal;
  /** 応答のストリーミング（NF-013）。 */
  readonly onText: (delta: string) => void;
}

export interface AiProvider {
  readonly id: string;
  status(): Promise<AiStatus>;
  /** 1 回の依頼を実行する。キャンセルされたら signal が中止になるので、速やかに終わらせる。 */
  run(input: AiRunInput): Promise<void>;
  /** アプリ終了時の後片付け（実行本体の停止など）。 */
  dispose?(): Promise<void>;
}

/** SDK が組み込まれていない（または無効な）ときの既定。AI 機能だけが無効になり、他の機能は影響を受けない。 */
export class NullProvider implements AiProvider {
  readonly id = 'none';
  constructor(private readonly reason = 'AI 機能の接続先（GitHub Copilot）がこのビルドに組み込まれていません') {}
  status(): Promise<AiStatus> {
    return Promise.resolve({ available: false, reason: this.reason, models: [] });
  }
  run(): Promise<void> {
    return Promise.reject(new Error(this.reason));
  }
}
