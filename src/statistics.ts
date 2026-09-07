import * as vscode from "vscode";

export interface PixelStatistics {
  changed: number;
  total: number;
  error?: string;
}

export class ImageStatistics implements vscode.Disposable {
  private readonly values = new Map<string, PixelStatistics>();
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.changed.event;
  get(revision?: string) {
    if (!revision) return undefined;
    const value = this.values.get(revision);
    if (value) {
      this.values.delete(revision);
      this.values.set(revision, value);
    }
    return value;
  }
  retryUnavailable() {
    for (const [revision, result] of this.values)
      if (result.error) {
        this.values.delete(revision);
        this.changed.fire(revision);
      }
  }
  set(revision: string, result: PixelStatistics) {
    if (
      !Number.isSafeInteger(result.changed) ||
      !Number.isSafeInteger(result.total) ||
      result.changed < 0 ||
      result.total < result.changed ||
      result.total > 16_000_000
    )
      return;
    const previous = this.values.get(revision);
    if (
      previous?.changed === result.changed &&
      previous?.total === result.total &&
      previous?.error === result.error
    )
      return;
    this.values.delete(revision);
    this.values.set(revision, { ...result });
    if (this.values.size > 2000)
      this.values.delete(this.values.keys().next().value!);
    this.changed.fire(revision);
  }
  dispose() {
    this.changed.dispose();
    this.values.clear();
  }
}
