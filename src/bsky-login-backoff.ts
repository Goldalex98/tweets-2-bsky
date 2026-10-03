/**
 * Spaces out Bluesky logins for a credential that keeps failing. The PDS
 * limits createSession per account, so retrying a bad app password on every
 * sweep can lock the account out for the rest of the day. Keys include a
 * password fingerprint, so rotating the password retries immediately.
 */
export const LOGIN_BACKOFF_BASE_MS = 60_000;
export const LOGIN_BACKOFF_MAX_MS = 30 * 60_000;

export class LoginBackoff {
  private readonly failures = new Map<string, { count: number; retryAtMs: number }>();

  remainingMs(key: string, nowMs: number): number {
    const failure = this.failures.get(key);
    return failure ? Math.max(0, failure.retryAtMs - nowMs) : 0;
  }

  noteFailure(key: string, nowMs: number): number {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    const delayMs = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (count - 1), LOGIN_BACKOFF_MAX_MS);
    this.failures.set(key, { count, retryAtMs: nowMs + delayMs });
    return delayMs;
  }

  noteSuccess(key: string): void {
    this.failures.delete(key);
  }

  clearPrefix(prefix: string): void {
    for (const key of this.failures.keys()) {
      if (key.startsWith(prefix)) this.failures.delete(key);
    }
  }
}
