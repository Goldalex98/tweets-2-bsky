export type PipelineRunMode = 'daemon' | 'scheduled' | 'run-once' | 'backfill' | 'pin-backfill' | 'preview' | 'dry-run';

export interface PipelineCandidate {
  externalPostId: string;
  sourceCreatedAt?: number;
  payload: unknown;
}

export interface PolicyDecision<T> {
  accepted: T[];
  skipped: Array<{ candidate: T; reason: string }>;
}

export interface EnqueueResult {
  inserted: number;
  queueIds: string[];
}

export interface RunRequest {
  mode: PipelineRunMode;
  sourceId: string;
  destinationId: string;
  routeId: string;
  limit?: number;
}

export interface RunResult<T> {
  mode: PipelineRunMode;
  dryRun: boolean;
  fetched: number;
  accepted: T[];
  skipped: Array<{ candidate: T; reason: string }>;
  enqueued: number;
  delivered: number;
}

export interface RunServiceDependencies<Raw, Normalized> {
  clock: { now(): number };
  fetch(request: RunRequest): Promise<Raw[]>;
  normalize(raw: Raw, request: RunRequest): Normalized;
  applyPolicy(
    candidates: Normalized[],
    request: RunRequest,
  ): Promise<PolicyDecision<Normalized>> | PolicyDecision<Normalized>;
  enqueue(candidates: Normalized[], request: RunRequest & { requestedAt: number }): Promise<EnqueueResult>;
  deliver(queueIds: string[], request: RunRequest): Promise<number>;
}

/**
 * Shared orchestration contract for every fetch-driven run mode. Delivery is
 * only allowed from queue identities returned by enqueue; preview and dry-run
 * stop before both persistence and external mutation.
 */
export class PipelineRunService<Raw, Normalized> {
  constructor(private readonly dependencies: RunServiceDependencies<Raw, Normalized>) {}

  async execute(request: RunRequest): Promise<RunResult<Normalized>> {
    const raw = await this.dependencies.fetch(request);
    const normalized = raw.map((candidate) => this.dependencies.normalize(candidate, request));
    const decision = await this.dependencies.applyPolicy(normalized, request);
    const dryRun = request.mode === 'dry-run' || request.mode === 'preview';
    if (dryRun) {
      return {
        mode: request.mode,
        dryRun: true,
        fetched: raw.length,
        accepted: decision.accepted,
        skipped: decision.skipped,
        enqueued: 0,
        delivered: 0,
      };
    }

    const enqueueResult = await this.dependencies.enqueue(decision.accepted, {
      ...request,
      requestedAt: this.dependencies.clock.now(),
    });
    const delivered = await this.dependencies.deliver(enqueueResult.queueIds, request);
    return {
      mode: request.mode,
      dryRun: false,
      fetched: raw.length,
      accepted: decision.accepted,
      skipped: decision.skipped,
      enqueued: enqueueResult.inserted,
      delivered,
    };
  }
}
