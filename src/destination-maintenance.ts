import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** The destination is being written by a worker or another maintenance task. */
export class DestinationBusyError extends Error {
  override readonly name = 'DestinationBusyError';
}

export interface MaintenanceLeaseStore {
  acquire(destinationKey: string, ownerId: string, ttlMs: number): boolean;
  renew(destinationKey: string, ownerId: string, ttlMs: number): boolean;
  release(destinationKey: string, ownerId: string): void;
}

export interface MaintenanceContext {
  /** Extends the lease; false means it lapsed and another writer may hold it. */
  renew(): boolean;
}

/**
 * Runs Bluesky writes that are not queue deliveries (delete-all, pin and
 * profile sync) under the same destination lease the queue workers take, with
 * an owner id of its own. Workers skip a destination leased by another owner,
 * and a destination a worker is posting to refuses maintenance, so these
 * writes never interleave with a delivery to the same account.
 */
export class DestinationMaintenanceRunner {
  /** Shared by every process on this host, so a restart can clear its predecessor's leases. */
  static readonly hostOwnerPrefix = `maintenance:${hostname() || 'local'}:`;
  readonly ownerId: string;
  // The store's acquire is re-entrant for one owner, so tasks in this process
  // are kept apart here; otherwise the first to finish would drop the lease
  // the other is still writing under.
  private readonly held = new Set<string>();

  constructor(
    private readonly store: MaintenanceLeaseStore,
    private readonly ttlMs: number,
    ownerId = `${DestinationMaintenanceRunner.hostOwnerPrefix}${process.pid}:${randomUUID().slice(0, 8)}`,
  ) {
    this.ownerId = ownerId;
  }

  /** Throws `DestinationBusyError` when another writer holds the destination. */
  async run<T>(destinationKey: string, task: (context: MaintenanceContext) => Promise<T>): Promise<T> {
    if (this.held.has(destinationKey) || !this.store.acquire(destinationKey, this.ownerId, this.ttlMs)) {
      throw new DestinationBusyError(
        'This destination is busy posting or running another maintenance task. Try again in a minute.',
      );
    }
    this.held.add(destinationKey);
    try {
      return await task({ renew: () => this.store.renew(destinationKey, this.ownerId, this.ttlMs) });
    } finally {
      this.held.delete(destinationKey);
      this.store.release(destinationKey, this.ownerId);
    }
  }
}

/**
 * Starts background work without making the caller wait for it. A key that is
 * still running is not started again, so a slow task cannot pile up behind
 * itself across sweeps. Failures are reported, never thrown to the caller.
 */
export class DetachedTaskRunner {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly onError: (key: string, error: unknown) => void) {}

  start(key: string, task: () => Promise<void>): boolean {
    if (this.running.has(key)) return false;
    const run = (async () => {
      try {
        await task();
      } catch (error) {
        this.onError(key, error);
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, run);
    return true;
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** Waits for the tasks started so far, or only those whose key matches. */
  async settle(matches: (key: string) => boolean = () => true): Promise<void> {
    await Promise.all([...this.running].filter(([key]) => matches(key)).map(([, run]) => run));
  }
}

/** Runs `worker` over `items` with at most `limit` calls in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}
