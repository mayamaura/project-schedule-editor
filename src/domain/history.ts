// @req F-206
// Undo/Redo の履歴。変更前のスナップショットを積む。Schedule は不変データで構造共有されるため、
// 25,000 イベントでも 1 件あたりのコストは変更部分だけ（data-model 11）。
import { applyCommand, type ApplyResult, type Command } from './commands';
import type { Schedule } from './model';

export class History {
  private current: Schedule;
  private past: Schedule[] = [];
  private future: Schedule[] = [];
  private saved: Schedule;

  constructor(
    initial: Schedule,
    private readonly limit = 1000,
  ) {
    this.current = initial;
    this.saved = initial;
  }

  get present(): Schedule {
    return this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  /** 最後に markSaved した状態から変わっているか（Undo で戻れば false に戻る）。 */
  get isDirty(): boolean {
    return this.current !== this.saved;
  }

  /** コマンドを適用する。成功したら履歴に積み、Redo 履歴を破棄する。失敗なら何も変えない。 */
  execute(command: Command): ApplyResult {
    const r = applyCommand(this.current, command);
    if (!r.ok) return r;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.current = r.schedule;
    return r;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.current);
    this.current = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.current);
    this.current = next;
    return true;
  }

  markSaved(): void {
    this.saved = this.current;
  }

  /** 読み込み・復元などで状態を差し替える（履歴は破棄）。 */
  reset(schedule: Schedule): void {
    this.current = schedule;
    this.saved = schedule;
    this.past = [];
    this.future = [];
  }
}
