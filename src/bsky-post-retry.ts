import { classifyQueueError } from './observability.js';
import { parseRateLimitResetMs } from './x-rate-limit.js';

/** Pause between inline retries of a transient post failure (network, 5xx). */
export const BSKY_POST_RETRY_DELAY_MS = 5_000;
/** Total rate-limit wait worth holding the destination lane for, per post. */
export const BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS = 60_000;

function xrpcStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; success?: unknown };
  return candidate.success === false && typeof candidate.status === 'number' ? candidate.status : undefined;
}

/**
 * How long to wait before retrying a failed Bluesky post inline, or undefined
 * to stop and let the queue reschedule. A dead session or a rejected request
 * never recovers by retrying (the worker evicts the agent instead), and a
 * rate limit longer than the remaining inline budget is better waited out by
 * the queue than by holding the destination lane.
 */
export function blueskyPostRetryDelayMs(
  error: unknown,
  nowMs: number,
  inlineRateLimitBudgetMs = BSKY_MAX_INLINE_RATE_LIMIT_WAIT_MS,
): number | undefined {
  const category = classifyQueueError(error);
  if (category === 'bsky-auth') return undefined;
  if (category === 'bsky-rate-limit') {
    const resetAtMs = parseRateLimitResetMs(error, nowMs);
    if (resetAtMs === undefined) return undefined;
    const waitMs = Math.max(Math.max(0, resetAtMs - nowMs) + 1_000, BSKY_POST_RETRY_DELAY_MS);
    return waitMs <= inlineRateLimitBudgetMs ? waitMs : undefined;
  }
  const status = xrpcStatus(error);
  if (status !== undefined && status >= 400 && status < 500) return undefined;
  return BSKY_POST_RETRY_DELAY_MS;
}
