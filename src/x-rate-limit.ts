/**
 * Global governor for outbound X (Twitter) requests.
 *
 * X's frontend API applies dynamic, undocumented, per-token limits, and it
 * treats a client that keeps retrying through a 429 as abusive — which
 * escalates from throttling to suspension of the scraping account. Every X
 * request in this process therefore passes through one governor, so a limit
 * observed on any code path pauses all of them until the advertised reset.
 */

export interface RateLimitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemRateLimitClock: RateLimitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface XRateGovernorOptions {
  /** Minimum spacing between consecutive requests. */
  minGapMs: number;
  /** Upper bound of extra random spacing, so traffic is not metronomic. */
  jitterMs: number;
  /** Ceiling on requests started within `windowMs`. */
  maxRequestsPerWindow: number;
  windowMs: number;
  /** Cooldown for the first limit reported without an explicit reset time. */
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  clock?: RateLimitClock;
  random?: () => number;
  onCooldown?(details: { untilMs: number; consecutiveHits: number; fromHeader: boolean }): void;
}

export interface XRateGovernorSnapshot {
  cooldownUntilMs: number;
  consecutiveLimitHits: number;
  requestsInWindow: number;
  maxRequestsPerWindow: number;
  limitEvents: number;
  throttledWaits: number;
}

export class XRateGovernor {
  private readonly clock: RateLimitClock;
  private readonly random: () => number;
  private nextSlotMs = 0;
  private cooldownUntilMs = 0;
  private consecutiveLimitHits = 0;
  private limitEvents = 0;
  private throttledWaits = 0;
  private readonly recentRequests: number[] = [];

  constructor(private readonly options: XRateGovernorOptions) {
    this.clock = options.clock ?? systemRateLimitClock;
    this.random = options.random ?? Math.random;
  }

  /**
   * Blocks until this caller may issue one X request. Re-checks after every
   * wait because a cooldown can begin while we are already queued.
   */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();

      const cooldownWait = this.cooldownUntilMs - now;
      if (cooldownWait > 0) {
        this.throttledWaits += 1;
        await this.clock.sleep(cooldownWait);
        continue;
      }

      const windowWait = this.windowWaitMs(now);
      if (windowWait > 0) {
        this.throttledWaits += 1;
        await this.clock.sleep(windowWait);
        continue;
      }

      const gap =
        this.options.minGapMs + Math.floor(this.random() * (this.options.jitterMs + 1));
      const slot = Math.max(now, this.nextSlotMs);
      this.nextSlotMs = slot + gap;
      this.recentRequests.push(slot);
      this.forgetExpired(slot);
      if (slot > now) await this.clock.sleep(slot - now);
      return;
    }
  }

  /**
   * Records a limit reported by X. `resetAtMs` comes from the response headers
   * when X supplies one; otherwise the cooldown backs off exponentially.
   * Returns the timestamp until which all X traffic is paused.
   */
  noteRateLimited(resetAtMs?: number): number {
    const now = this.clock.now();
    this.limitEvents += 1;
    this.consecutiveLimitHits += 1;

    const backoffMs = Math.min(
      this.options.cooldownBaseMs * 2 ** (this.consecutiveLimitHits - 1),
      this.options.cooldownMaxMs,
    );
    const fromHeader = typeof resetAtMs === 'number' && resetAtMs > now;
    const until = fromHeader
      ? Math.min(resetAtMs as number, now + this.options.cooldownMaxMs)
      : now + backoffMs;

    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, until);
    // No reservation made before the limit may fire during the cooldown.
    this.nextSlotMs = Math.max(this.nextSlotMs, this.cooldownUntilMs);
    this.options.onCooldown?.({
      untilMs: this.cooldownUntilMs,
      consecutiveHits: this.consecutiveLimitHits,
      fromHeader,
    });
    return this.cooldownUntilMs;
  }

  /** Clears the escalating backoff after a request completes normally. */
  noteSuccess(): void {
    this.consecutiveLimitHits = 0;
  }

  snapshot(): XRateGovernorSnapshot {
    const now = this.clock.now();
    this.forgetExpired(now);
    return {
      cooldownUntilMs: this.cooldownUntilMs,
      consecutiveLimitHits: this.consecutiveLimitHits,
      requestsInWindow: this.recentRequests.length,
      maxRequestsPerWindow: this.options.maxRequestsPerWindow,
      limitEvents: this.limitEvents,
      throttledWaits: this.throttledWaits,
    };
  }

  private windowWaitMs(now: number): number {
    this.forgetExpired(now);
    if (this.recentRequests.length < this.options.maxRequestsPerWindow) return 0;
    const oldest = this.recentRequests[0];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + this.options.windowMs - now);
  }

  private forgetExpired(now: number): void {
    const cutoff = now - this.options.windowMs;
    while (this.recentRequests.length > 0 && (this.recentRequests[0] as number) <= cutoff) {
      this.recentRequests.shift();
    }
  }
}

function readHeader(source: unknown, name: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const getter = (source as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(source, name);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function headerSources(error: unknown): unknown[] {
  if (!error || typeof error !== 'object') return [];
  const candidate = error as { headers?: unknown; response?: { headers?: unknown } };
  return [candidate.headers, candidate.response?.headers].filter(Boolean);
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

export function isRateLimitError(error: unknown): boolean {
  if (readStatus(error) === 429) return true;
  return /\b429\b|rate ?limit|too many requests/i.test(readMessage(error));
}

export function isAuthError(error: unknown): boolean {
  const status = readStatus(error);
  if (status === 401 || status === 403) return true;
  return /\b401\b|\b403\b|unauthor|forbidden|could not authenticate|bad ?token|invalid ?token|expired ?token/i.test(
    readMessage(error),
  );
}

/**
 * Extracts the moment a limit lifts. X sends `x-rate-limit-reset` as epoch
 * seconds; atproto sends `ratelimit-reset`; both may instead send
 * `retry-after` as a delta in seconds.
 */
export function parseRateLimitResetMs(error: unknown, nowMs: number): number | undefined {
  for (const source of headerSources(error)) {
    for (const name of ['x-rate-limit-reset', 'ratelimit-reset']) {
      const epochSeconds = Number(readHeader(source, name));
      if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
        return epochSeconds * 1000;
      }
    }
    const retryAfterSeconds = Number(readHeader(source, 'retry-after'));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return nowMs + retryAfterSeconds * 1000;
    }
  }
  return undefined;
}
