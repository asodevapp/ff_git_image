import * as vscode from "vscode";

export class ImageActionTask {
  message = "Queued";
  finished = false;
  readonly result: Promise<number>;
  private readonly progress = new vscode.EventEmitter<string>();
  private resolve!: (count: number) => void;
  private reject!: (error: unknown) => void;
  readonly keys = new Set<string>();

  constructor(
    readonly label: string,
    readonly execute: (report: (message: string) => void) => Promise<number>,
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  onProgress(listener: (message: string) => void): vscode.Disposable {
    const subscription = this.progress.event(listener);
    listener(this.message);
    return subscription;
  }

  report(message: string) {
    this.message = message;
    this.progress.fire(message);
  }

  complete(count: number) {
    this.finished = true;
    this.resolve(count);
    this.progress.dispose();
  }
  fail(error: unknown) {
    this.finished = true;
    this.reject(error);
    this.progress.dispose();
  }
}

/** One FIFO for image mutations. Failed/cancelled actions cannot poison its tail. */
export class ImageActionQueue {
  private readonly tasks = new Map<string, ImageActionTask>();
  private readonly waiting: ImageActionTask[] = [];
  private current?: ImageActionTask;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly idleWaiters = new Set<() => void>();

  get idle() {
    return !this.current && !this.waiting.length;
  }
  get message() {
    const task = this.current ?? this.waiting[0];
    const waiting = this.current
      ? this.waiting.length
      : Math.max(0, this.waiting.length - 1);
    return task
      ? `${task.label}: ${task.message}${waiting ? ` · ${waiting} waiting` : ""}`
      : "All image actions finished";
  }

  find(key: string) {
    return this.tasks.get(key);
  }

  enqueue(key: string, label: string, execute: ImageActionTask["execute"]) {
    const duplicate = this.tasks.get(key);
    if (duplicate) return duplicate;
    const task = new ImageActionTask(label, execute);
    this.alias(task, key);
    this.waiting.push(task);
    this.updatePositions();
    // Enqueue/capture stays synchronous, so rapid commands keep click order.
    queueMicrotask(() => {
      void this.drain();
    });
    return task;
  }

  alias(task: ImageActionTask, key: string) {
    if (task.finished || this.tasks.has(key)) return;
    task.keys.add(key);
    this.tasks.set(key, task);
  }

  whenIdle(): Promise<void> {
    return this.idle
      ? Promise.resolve()
      : new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private updatePositions() {
    this.waiting.forEach((task, index) =>
      task.report(`Queued · ${index + (this.current ? 1 : 0)} ahead`),
    );
    this.changed.fire();
  }

  private async drain() {
    if (this.current) return;
    const task = this.waiting.shift();
    if (!task) return;
    this.current = task;
    task.report("Starting…");
    this.updatePositions();
    try {
      const count = await task.execute((message) => {
        task.report(message);
        this.changed.fire();
      });
      task.complete(count);
    } catch (error) {
      task.fail(error);
    } finally {
      for (const key of task.keys) this.tasks.delete(key);
      this.current = undefined;
      this.updatePositions();
      if (this.waiting.length) void this.drain();
      else {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }
}
