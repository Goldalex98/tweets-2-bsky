import type { QueueBatch, QueueItem } from '../db.js';

export interface QueueWorkerDestination {
  id: string;
  enabled: boolean;
  metadata: {
    legacyMappingIds: string[];
  };
}

export interface QueueWorkerConfig {
  destinations: readonly QueueWorkerDestination[];
}

export interface QueueWorkerMapping {
  id: string;
  bskyIdentifier: string;
}

export interface QueueSettlement {
  posted: number;
  skipped: number;
  retrying: number;
  parked: number;
  error?: string;
}

export interface QueueWorkerDependencies<
  Config extends QueueWorkerConfig,
  Mapping extends QueueWorkerMapping,
> {
  clock: { now(): number };
  sleep(durationMs: number): Promise<void>;
  getConfig(): Config;
  findMapping(config: Config, mappingId: string): Mapping | undefined;
  claimNextBatch(
    activeDestinationKeys: Set<string>,
    allowedMappingIds: Set<string>,
    resolveDestinationKey: (mappingId: string) => string,
    acquireLease?: (destinationKey: string) => boolean,
  ): QueueBatch | null;
  /**
   * Cross-process destination locking. The in-memory active set only serialises
   * workers within one process, so without a shared lease two replicas can post
   * to the same destination at once.
   */
  leases?: {
    heldByOthers(): readonly string[];
    acquire(destinationKey: string): boolean;
    renew(destinationKey: string): boolean;
    release(destinationKey: string): void;
  };
  deleteByMappingId(mappingId: string): void;
  deliver(
    mapping: Mapping,
    batch: QueueBatch,
    context: { mode: 'worker' | 'drain' },
  ): Promise<void>;
  findSettlement(item: QueueItem): { status: string } | null;
  markDone(item: QueueItem): void;
  releaseForRetry(item: QueueItem, error: string, maxAttempts: number): void;
  describeError(error: unknown): string;
  classifyError(error: unknown): string;
  metrics: {
    increment(name: 'posted' | 'skipped' | 'retries' | 'failed', amount: number): void;
    observe(name: 'postDurationMs', value: number): void;
  };
  recordDestinationFailure(destinationId: string, category: string, message: string): void;
  notifyParked(destinationId: string, parked: number, category: string): void;
  updateJob?(
    id: string,
    patch:
      | {
          account: string;
          target: string;
          mappingId: string;
          itemCount: number;
        }
      | null,
  ): void;
  onBatchStart?(mapping: Mapping, batch: QueueBatch): void;
  onBatchSettled?(mapping: Mapping, batch: QueueBatch, settlement: QueueSettlement): void;
  onWorkerError?(error: unknown): void;
}

export interface QueueRecoveryDependencies<Config extends QueueWorkerConfig> {
  resetProcessing(): number;
  purgeFailedOlderThan(ageMs: number): void;
  listMappingIds(): readonly string[];
  deleteByMappingId(mappingId: string): void;
  onRecovered?(count: number): void;
  onPending?(count: number): void;
  pendingCount(): number;
  getConfig(): Config;
}

function destinationClaimScope(config: QueueWorkerConfig): {
  allowedMappingIds: Set<string>;
  resolveDestinationKey(mappingId: string): string;
} {
  const enabledDestinations = config.destinations.filter((destination) => destination.enabled);
  const destinationKeyByMappingId = new Map<string, string>();
  for (const destination of enabledDestinations) {
    for (const id of [destination.id, ...destination.metadata.legacyMappingIds]) {
      destinationKeyByMappingId.set(id, destination.id);
    }
  }
  return {
    allowedMappingIds: new Set(destinationKeyByMappingId.keys()),
    resolveDestinationKey: (mappingId) =>
      destinationKeyByMappingId.get(mappingId) ?? `mapping:${mappingId}`,
  };
}

/**
 * Claims and settles durable queue batches. The active destination set may be
 * shared with digest workers, making destination serialization explicit.
 */
export class DestinationQueueWorkerService<
  Config extends QueueWorkerConfig,
  Mapping extends QueueWorkerMapping,
> {
  readonly activeDestinations: Set<string>;
  private started = false;
  private readonly running = new Set<Promise<void>>();
  private readonly leasedDestinations = new Set<string>();

  constructor(
    private readonly dependencies: QueueWorkerDependencies<Config, Mapping>,
    private readonly concurrency: number,
    private readonly maxAttempts: number,
    activeDestinations?: Set<string>,
  ) {
    this.activeDestinations = activeDestinations ?? new Set<string>();
  }

  get isStarted(): boolean {
    return this.started;
  }

  private acquireLease(destinationKey: string): boolean {
    if (!this.dependencies.leases) return true;
    if (!this.dependencies.leases.acquire(destinationKey)) return false;
    this.leasedDestinations.add(destinationKey);
    return true;
  }

  private releaseLease(destinationKey: string): void {
    if (!this.leasedDestinations.delete(destinationKey)) return;
    this.dependencies.leases?.release(destinationKey);
  }

  /**
   * A claim can acquire a lease and still come back empty (the group drained
   * between selection and claim). Releasing the unused lease immediately keeps
   * the destination available instead of parking it until the lease expires.
   */
  private claimBatch(scope: ReturnType<typeof destinationClaimScope>): QueueBatch | null {
    const before = new Set(this.leasedDestinations);
    const batch = this.dependencies.claimNextBatch(
      this.blockedDestinationKeys(),
      scope.allowedMappingIds,
      scope.resolveDestinationKey,
      this.dependencies.leases ? (key) => this.acquireLease(key) : undefined,
    );
    if (!batch) {
      for (const key of [...this.leasedDestinations]) {
        if (!before.has(key)) this.releaseLease(key);
      }
    }
    return batch;
  }

  async runBatch(
    mapping: Mapping,
    batch: QueueBatch,
    mode: 'worker' | 'drain' = 'worker',
  ): Promise<QueueSettlement> {
    const startedAt = this.dependencies.clock.now();
    let batchError: string | undefined;
    this.dependencies.onBatchStart?.(mapping, batch);
    try {
      await this.dependencies.deliver(mapping, batch, { mode });
    } catch (error) {
      batchError = this.dependencies.describeError(error);
    }

    const settlement: QueueSettlement = {
      posted: 0,
      skipped: 0,
      retrying: 0,
      parked: 0,
      ...(batchError ? { error: batchError } : {}),
    };
    const retryError = batchError ?? 'Post delivery did not create a processed record.';
    for (const item of batch.items) {
      const record = this.dependencies.findSettlement(item);
      if (record) {
        this.dependencies.markDone(item);
        if (record.status === 'migrated') settlement.posted += 1;
        else settlement.skipped += 1;
        continue;
      }
      this.dependencies.releaseForRetry(item, retryError, this.maxAttempts);
      if (item.attempts + 1 >= this.maxAttempts) settlement.parked += 1;
      else settlement.retrying += 1;
    }

    this.dependencies.metrics.increment('posted', settlement.posted);
    this.dependencies.metrics.increment('skipped', settlement.skipped);
    this.dependencies.metrics.increment('retries', settlement.retrying);
    this.dependencies.metrics.increment('failed', settlement.parked);
    this.dependencies.metrics.observe('postDurationMs', this.dependencies.clock.now() - startedAt);
    if (settlement.retrying + settlement.parked > 0) {
      const category = this.dependencies.classifyError(retryError);
      this.dependencies.recordDestinationFailure(mapping.id, category, retryError);
      if (settlement.parked > 0) {
        this.dependencies.notifyParked(mapping.id, settlement.parked, category);
      }
    }
    this.dependencies.onBatchSettled?.(mapping, batch, settlement);
    return settlement;
  }

  /** Excludes destinations locked in this process and by other replicas. */
  private blockedDestinationKeys(): Set<string> {
    const blocked = new Set(this.activeDestinations);
    for (const key of this.dependencies.leases?.heldByOthers() ?? []) blocked.add(key);
    return blocked;
  }

  /** Keeps leases for in-flight batches alive while a slow batch is delivering. */
  renewLeases(): void {
    if (!this.dependencies.leases) return;
    for (const key of this.leasedDestinations) this.dependencies.leases.renew(key);
  }

  scheduleAvailable(): number {
    const config = this.dependencies.getConfig();
    const scope = destinationClaimScope(config);
    let launched = 0;
    while (this.activeDestinations.size < this.concurrency) {
      const batch = this.claimBatch(scope);
      if (!batch) break;
      const mapping = this.dependencies.findMapping(config, batch.mapping_id);
      if (!mapping) {
        this.releaseLease(batch.destination_key);
        this.dependencies.deleteByMappingId(batch.mapping_id);
        continue;
      }

      this.activeDestinations.add(batch.destination_key);
      launched += 1;
      const jobId = `mirror:${batch.bsky_identifier}:${batch.twitter_username}`;
      this.dependencies.updateJob?.(jobId, {
        account: batch.twitter_username,
        target: mapping.bskyIdentifier,
        mappingId: mapping.id,
        itemCount: batch.items.length,
      });
      const running: Promise<void> = this.runBatch(mapping, batch, 'worker')
        .then(
          () => undefined,
          (error) => {
            this.dependencies.onWorkerError?.(error);
          },
        )
        .finally(() => {
          this.activeDestinations.delete(batch.destination_key);
          this.releaseLease(batch.destination_key);
          this.dependencies.updateJob?.(jobId, null);
          this.running.delete(running);
        });
      this.running.add(running);
    }
    return launched;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  async drain(): Promise<void> {
    while (true) {
      const config = this.dependencies.getConfig();
      const scope = destinationClaimScope(config);
      const batch = this.claimBatch(scope);
      if (!batch) return;
      const mapping = this.dependencies.findMapping(config, batch.mapping_id);
      if (!mapping) {
        this.releaseLease(batch.destination_key);
        this.dependencies.deleteByMappingId(batch.mapping_id);
        continue;
      }
      this.activeDestinations.add(batch.destination_key);
      try {
        await this.runBatch(mapping, batch, 'drain');
      } finally {
        this.activeDestinations.delete(batch.destination_key);
        this.releaseLease(batch.destination_key);
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runForever();
  }

  private async runForever(): Promise<never> {
    while (true) {
      let launched = 0;
      try {
        this.renewLeases();
        launched = this.scheduleAvailable();
      } catch (error) {
        this.dependencies.onWorkerError?.(error);
      }
      await this.dependencies.sleep(launched > 0 ? 250 : 1_000);
    }
  }
}

export function recoverDestinationQueue<Config extends QueueWorkerConfig>(
  dependencies: QueueRecoveryDependencies<Config>,
  failedRetentionMs: number,
): number {
  const recovered = dependencies.resetProcessing();
  if (recovered > 0) dependencies.onRecovered?.(recovered);
  dependencies.purgeFailedOlderThan(failedRetentionMs);

  const knownMappingIds = new Set(
    dependencies
      .getConfig()
      .destinations.flatMap((destination) => [destination.id, ...destination.metadata.legacyMappingIds]),
  );
  for (const mappingId of dependencies.listMappingIds()) {
    if (!knownMappingIds.has(mappingId)) dependencies.deleteByMappingId(mappingId);
  }
  const pending = dependencies.pendingCount();
  if (pending > 0) dependencies.onPending?.(pending);
  return recovered;
}
