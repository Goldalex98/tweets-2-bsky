/**
 * Guards against out-of-order responses when refreshes and saves overlap: a request
 * may only write state while it is still the most recently started one.
 */
export interface LatestRequestTracker {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createLatestRequestTracker(): LatestRequestTracker {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token: number) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
