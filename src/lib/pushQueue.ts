/**
 * Minimal single-consumer async queue.
 *
 * Bridges a push-based source (the `ws` event emitter) onto an async iterator
 * so callers can `for await` over engine frames. Not a general-purpose queue:
 * one producer, one consumer, no buffering cap (engine frames are small and
 * the consumer drains promptly).
 */

export type CloseReason = { kind: "done" } | { kind: "error"; error: unknown };

interface Waiter<T> {
  resolve: (r: IteratorResult<T>) => void;
  reject: (e: unknown) => void;
}

export class PushQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private closed = false;
  private closeError: unknown = undefined;

  /** Enqueue an item; wakes a waiting consumer if one exists. No-op after close. */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * End the stream. `{ kind: "done" }` resolves the iterator cleanly;
   * `{ kind: "error" }` rejects it so the consumer sees the failure.
   * Idempotent.
   */
  close(reason: CloseReason = { kind: "done" }): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason.kind === "error" ? reason.error : undefined;
    this.closeError = err;
    for (const w of this.waiters) {
      if (err !== undefined) w.reject(err);
      else w.resolve({ value: undefined as never, done: true });
    }
    this.waiters.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const self = this;
    return {
      next(): Promise<IteratorResult<T>> {
        if (self.buffer.length > 0) {
          return Promise.resolve({
            value: self.buffer.shift() as T,
            done: false,
          });
        }
        if (self.closed) {
          if (self.closeError !== undefined) {
            return Promise.reject(self.closeError);
          }
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          self.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
