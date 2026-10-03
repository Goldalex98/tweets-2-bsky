import { classifyQueueError } from './observability.js';
import { parseRateLimitResetMs } from './x-rate-limit.js';

/** Pause between inline retries of a transient post failure (network, 5xx). */
export const BSKY_POST_RETRY_DELAY_MS = 5_000;
/** Longest rate-limit wait worth holding the destination lane for. */
export const BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * How long to wait before retrying a failed Bluesky post inline, or undefined
 * to stop and let the queue reschedule. A dead session never recovers by
 * retrying (the worker evicts the agent instead), and a long rate limit is
 * better waited out by the queue than by holding the destination lane.
 */
export function blueskyPostRetryDelayMs(error: unknown, nowMs: number): number | undefined {
  const category = classifyQueueError(error);
  if (category === 'bsky-auth') return undefined;
  if (category !== 'bsky-rate-limit') return BSKY_POST_RETRY_DELAY_MS;
  const resetAtMs = parseRateLimitResetMs(error, nowMs);
  const waitMs = resetAtMs === undefined ? BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS : Math.max(0, resetAtMs - nowMs) + 1_000;
  return waitMs <= BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS ? Math.max(waitMs, BSKY_POST_RETRY_DELAY_MS) : undefined;
}
