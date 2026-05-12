/**
 * Bounded async FIFO used as the per-pair backpressure buffer between the
 * HistoricalDataFeed's producer (DB cursor) and its consumers (per-pair
 * subscribe iterators).
 *
 * `push(item)` resolves when the item is accepted; if the buffer is full
 * it awaits until a consumer drains via `next()`. `next()` resolves with
 * the next item, or null once the queue has been closed AND drained.
 * `close()` is idempotent and wakes all waiters.
 */

export class AsyncQueue<T> {
  private readonly buf: T[] = [];
  private readonly pushWaiters: Array<() => void> = [];
  private readonly nextWaiters: Array<(v: T | null) => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error("AsyncQueue: capacity must be >= 1");
    }
  }

  async push(item: T): Promise<void> {
    while (this.buf.length >= this.capacity && !this.closed) {
      await new Promise<void>((resolve) => {
        this.pushWaiters.push(resolve);
      });
    }
    if (this.closed) {
      return;
    }
    const waiter = this.nextWaiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    this.buf.push(item);
  }

  async next(): Promise<T | null> {
    const head = this.buf.shift();
    if (head !== undefined) {
      const pushWaiter = this.pushWaiters.shift();
      if (pushWaiter !== undefined) {
        pushWaiter();
      }
      return head;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<T | null>((resolve) => {
      this.nextWaiters.push(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.nextWaiters.length > 0) {
      const w = this.nextWaiters.shift();
      w?.(null);
    }
    while (this.pushWaiters.length > 0) {
      const w = this.pushWaiters.shift();
      w?.();
    }
  }

  get size(): number {
    return this.buf.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
