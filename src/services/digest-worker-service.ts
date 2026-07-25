import type { DigestPolicy } from '../config/schemas.js';
import type { DigestEntry, DigestJob } from '../db.js';
import type { DigestChunk, DigestPreview } from '../digest.js';
import { parsePolicySnapshot } from '../policy-snapshot.js';

export interface DigestWorkerRoute {
  id: string;
  destinationId: string;
  delivery?: {
    mode: string;
    digest: DigestPolicy;
  };
}

export interface DigestWorkerDestination {
  id: string;
}

export interface DigestWorkerMapping {
  id: string;
}

export interface DigestWorkerConfig<
  Route extends DigestWorkerRoute,
  Destination extends DigestWorkerDestination,
  Mapping extends DigestWorkerMapping,
> {
  routes: readonly Route[];
  destinations: readonly Destination[];
  mappings: readonly Mapping[];
}

export interface DigestStrongRef {
  uri: string;
  cid: string;
}

export interface DigestCheckpoint {
  uri?: string;
  cid?: string;
  root?: DigestStrongRef;
  parent?: DigestStrongRef;
  tail?: DigestStrongRef;
  completedAt?: number;
}

export interface DigestDeliverySession {
  publish(input: {
    destinationId: string;
    runKey: string;
    chunk: DigestChunk;
    createdAt: string;
    reply?: { root: DigestStrongRef; parent: DigestStrongRef };
  }): Promise<DigestStrongRef>;
}

export interface DigestDeliveryAdapter<Mapping extends DigestWorkerMapping> {
  createSession(mapping: Mapping): Promise<DigestDeliverySession | null>;
}

export interface DigestWorkerDependencies<
  Config extends DigestWorkerConfig<Route, Destination, Mapping>,
  Route extends DigestWorkerRoute,
  Destination extends DigestWorkerDestination,
  Mapping extends DigestWorkerMapping,
> {
  sleep(durationMs: number): Promise<void>;
  getConfig(): Config;
  jobs: {
    resetProcessing(): number;
    list(): DigestJob[];
    arm(destinationId: string, routeId: string, nextRunAt: number): DigestJob;
    claimNext(
      excludedDestinationIds: ReadonlySet<string>,
      resolveMaxEntries?: (job: DigestJob) => number,
    ): DigestJob | null;
    checkpoint(id: string, claimToken: string, checkpoint: number, contentHash: string): boolean;
    releaseEntries(id: string, claimToken: string, entryIds: readonly number[]): boolean;
    complete(
      id: string,
      claimToken: string,
      nextRunAt: number,
      deliveredEntryIds?: readonly number[],
    ): boolean;
    fail(id: string, claimToken: string, error: unknown): boolean;
  };
  entries: {
    list(options: { routeId: string; status: 'claimed'; jobId?: string; limit: number }): DigestEntry[];
  };
  checkpoints: {
    initialize(
      destinationId: string,
      externalPostId: string,
      chunks: Array<{ contentHash: string; createdAt: string }>,
    ): DigestCheckpoint[];
    list(destinationId: string, externalPostId: string): DigestCheckpoint[];
    recordSuccess(input: {
      destinationId: string;
      externalPostId: string;
      chunkIndex: number;
      uri: string;
      cid: string;
      root: DigestStrongRef;
      parent?: DigestStrongRef;
      tail: DigestStrongRef;
    }): void;
  };
  delivery: DigestDeliveryAdapter<Mapping>;
  buildPreview(entries: readonly DigestEntry[], policy: DigestPolicy, runKey: string): DigestPreview;
  nextRun(policy: DigestPolicy): number;
  metrics: {
    increment(name: 'digestRuns' | 'digestFailures'): void;
  };
  onWorkerError?(error: unknown): void;
}

export interface DigestSnapshotCohort {
  policy: DigestPolicy;
  snapshotHash?: string;
  entries: DigestEntry[];
  deferredEntryIds: number[];
}

/**
 * Splits claimed entries by the policy snapshot captured when they were routed
 * and returns the cohort containing the oldest entry, plus the digest policy
 * recorded in that snapshot. Entries from other cohorts are deferred so they
 * still get delivered under their own policy on a later run.
 */
export function selectSnapshotCohort(
  entries: readonly DigestEntry[],
  fallbackPolicy: DigestPolicy,
): DigestSnapshotCohort {
  const cohorts = new Map<string, DigestEntry[]>();
  for (const entry of entries) {
    const key = entry.policySnapshot ?? '';
    const bucket = cohorts.get(key) ?? [];
    bucket.push(entry);
    cohorts.set(key, bucket);
  }
  const oldest = entries.reduce((left, right) =>
    right.createdAt < left.createdAt || (right.createdAt === left.createdAt && right.id < left.id) ? right : left,
  );
  const activeKey = oldest.policySnapshot ?? '';
  const selected = cohorts.get(activeKey) ?? [...entries];
  const snapshot = parsePolicySnapshot(oldest.policySnapshot);
  const digest = snapshot?.routeDelivery?.digest;
  return {
    policy: digest ?? fallbackPolicy,
    snapshotHash: snapshot?.hash,
    entries: selected,
    deferredEntryIds: entries.filter((entry) => (entry.policySnapshot ?? '') !== activeKey).map((entry) => entry.id),
  };
}

/**
 * Schedules durable digest jobs and resumes chunk delivery from checkpoints.
 * Destination locks are shared with immediate queue workers.
 */
export class DigestWorkerService<
  Config extends DigestWorkerConfig<Route, Destination, Mapping>,
  Route extends DigestWorkerRoute,
  Destination extends DigestWorkerDestination,
  Mapping extends DigestWorkerMapping,
> {
  private started = false;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly dependencies: DigestWorkerDependencies<Config, Route, Destination, Mapping>,
    private readonly activeDestinations: Set<string>,
  ) {}

  initialize(): void {
    this.dependencies.jobs.resetProcessing();
    const config = this.dependencies.getConfig();
    const jobs = this.dependencies.jobs.list();
    for (const route of config.routes) {
      if (route.delivery?.mode !== 'digest' || !route.delivery.digest.enabled) continue;
      if (!jobs.some((job) => job.routeId === route.id)) {
        this.dependencies.jobs.arm(
          route.destinationId,
          route.id,
          this.dependencies.nextRun(route.delivery.digest),
        );
      }
    }
  }

  async execute(job: DigestJob): Promise<void> {
    if (!job.claimToken) return;
    const config = this.dependencies.getConfig();
    const route = config.routes.find((candidate) => candidate.id === job.routeId);
    const destination = config.destinations.find((candidate) => candidate.id === job.destinationId);
    const mapping = config.mappings.find((candidate) => candidate.id === job.destinationId);
    if (route?.delivery?.mode !== 'digest' || !destination || !mapping) {
      this.dependencies.jobs.fail(
        job.id,
        job.claimToken,
        new Error('Digest route or destination is unavailable.'),
      );
      return;
    }

    try {
      const runKey = `${job.id}:${job.nextRunAt}`;
      // Listing every entry claimed by this job (rather than capping the list at
      // the configured maximum) is what keeps the render set and the completion
      // set in agreement; anything left over is released explicitly below.
      const claimed = this.dependencies.entries
        .list({
          routeId: route.id,
          status: 'claimed',
          jobId: job.id,
          limit: Math.max(job.entryIds.length, 1),
        })
        .filter((entry) => entry.jobId === job.id && job.entryIds.includes(entry.id));
      if (claimed.length === 0) {
        this.dependencies.jobs.complete(
          job.id,
          job.claimToken,
          this.dependencies.nextRun(route.delivery.digest),
          [],
        );
        return;
      }

      // Entries captured a policy snapshot when they were routed. Render the
      // snapshot cohort that the oldest claimed entry belongs to, using that
      // stored policy, and release the other cohorts for their own run.
      const { policy, entries, deferredEntryIds } = selectSnapshotCohort(claimed, route.delivery.digest);
      if (deferredEntryIds.length > 0) {
        this.dependencies.jobs.releaseEntries(job.id, job.claimToken, deferredEntryIds);
      }

      const preview = this.dependencies.buildPreview(entries, policy, runKey);
      const rendered = new Set(preview.entryIds);
      const unrendered = entries.filter((entry) => !rendered.has(entry.id)).map((entry) => entry.id);
      if (unrendered.length > 0) {
        this.dependencies.jobs.releaseEntries(job.id, job.claimToken, unrendered);
      }
      if (preview.chunks.length === 0) throw new Error('Digest rendered no publishable content.');

      const session = await this.dependencies.delivery.createSession(mapping);
      if (!session) throw new Error('Bluesky login failed for digest delivery.');
      let checkpoints = this.dependencies.checkpoints.initialize(
        destination.id,
        runKey,
        preview.chunks.map((chunk, index) => ({
          contentHash: chunk.contentHash,
          createdAt: new Date(job.nextRunAt + index).toISOString(),
        })),
      );
      for (const chunk of preview.chunks) {
        const saved = checkpoints[chunk.index];
        if (saved?.completedAt && saved.uri && saved.cid) continue;
        const prior = checkpoints[chunk.index - 1];
        const root =
          prior?.root ??
          (checkpoints[0]?.uri && checkpoints[0]?.cid
            ? { uri: checkpoints[0].uri, cid: checkpoints[0].cid }
            : undefined);
        const parent =
          prior?.tail ??
          (prior?.uri && prior?.cid ? { uri: prior.uri, cid: prior.cid } : undefined);
        const response = await session.publish({
          destinationId: destination.id,
          runKey,
          chunk,
          createdAt: new Date(job.nextRunAt + chunk.index).toISOString(),
          ...(root && parent ? { reply: { root, parent } } : {}),
        });
        this.dependencies.checkpoints.recordSuccess({
          destinationId: destination.id,
          externalPostId: runKey,
          chunkIndex: chunk.index,
          uri: response.uri,
          cid: response.cid,
          root: root ?? response,
          parent,
          tail: response,
        });
        if (!this.dependencies.jobs.checkpoint(job.id, job.claimToken, chunk.index + 1, chunk.contentHash)) {
          throw new Error('Digest checkpoint claim was lost.');
        }
        checkpoints = this.dependencies.checkpoints.list(destination.id, runKey);
      }
      if (
        !this.dependencies.jobs.complete(
          job.id,
          job.claimToken,
          this.dependencies.nextRun(route.delivery.digest),
          preview.entryIds,
        )
      ) {
        throw new Error('Digest completion claim was lost.');
      }
      this.dependencies.metrics.increment('digestRuns');
    } catch (error) {
      this.dependencies.metrics.increment('digestFailures');
      this.dependencies.jobs.fail(job.id, job.claimToken, error);
    }
  }

  /** Caps a claim at the route's configured digest size. */
  private maxEntriesFor(job: DigestJob): number {
    const route = this.dependencies
      .getConfig()
      .routes.find((candidate) => candidate.id === job.routeId);
    return route?.delivery?.digest.maxEntries ?? 1;
  }

  scheduleNext(): boolean {
    const job = this.dependencies.jobs.claimNext(this.activeDestinations, (candidate) =>
      this.maxEntriesFor(candidate),
    );
    if (!job) return false;
    this.activeDestinations.add(job.destinationId);
    const running = this.execute(job)
      .catch((error) => this.dependencies.onWorkerError?.(error))
      .finally(() => {
        this.activeDestinations.delete(job.destinationId);
        this.running.delete(running);
      });
    this.running.add(running);
    return true;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.initialize();
    void this.runForever();
  }

  private async runForever(): Promise<never> {
    while (true) {
      this.scheduleNext();
      await this.dependencies.sleep(1_000);
    }
  }
}
