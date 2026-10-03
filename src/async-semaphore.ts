export type SemaphoreOutcome<T> = { ran: true; value: T } | { ran: false; reason: 'timeout' | 'aborted' | 'disabled' };

/**
 * Caps how many callers run a section at once. Waiters are served in order;
 * one that gives up (timeout or abort) is removed from the line and never
 * takes a slot.
 */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly slots: number) {}

  async run<T>(task: () => Promise<T>, waitMs: number, signal?: AbortSignal): Promise<SemaphoreOutcome<T>> {
    const acquired = await this.acquire(waitMs, signal);
    if (acquired !== 'acquired') return { ran: false, reason: acquired };
    try {
      return { ran: true, value: await task() };
    } finally {
      this.release();
    }
  }

  private acquire(waitMs: number, signal?: AbortSignal): Promise<'acquired' | 'timeout' | 'aborted' | 'disabled'> {
    if (this.slots <= 0) return Promise.resolve('disabled');
    if (signal?.aborted) return Promise.resolve('aborted');
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve('acquired');
    }
    return new Promise((resolve) => {
      const leave = (reason: 'timeout' | 'aborted') => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(reason);
      };
      const onAbort = () => leave('aborted');
      const grant = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve('acquired');
      };
      const timer = setTimeout(() => leave('timeout'), waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
