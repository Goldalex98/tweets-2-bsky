import type { BackfillJob } from '../db.js';

export interface BackfillRequestSummary {
  id: string;
  requestId: string;
}

/**
 * Whether a running backfill is still wanted.
 *
 * Backfill requests used to live only in the web process's memory, so the
 * cancellation check consulted that list alone. A durable job counts as wanted
 * even while claimed (it is no longer "due"), and a job recovered after a
 * restart has no in-memory request behind it at all — checking memory alone
 * cancelled the very jobs durability was added to save. Only an explicitly
 * parked job, or an unknown request with nothing pending, stops the run.
 */
export function isBackfillStillRequested(input: {
  destinationId: string;
  requestId?: string;
  durableJob?: Pick<BackfillJob, 'status'> | null;
  pending: readonly BackfillRequestSummary[];
}): boolean {
  if (input.requestId && input.durableJob) return input.durableJob.status !== 'failed';
  return input.pending.some(
    (pending) =>
      pending.id === input.destinationId &&
      (!input.requestId || pending.requestId === input.requestId),
  );
}
