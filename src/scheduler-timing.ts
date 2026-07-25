export const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
export const MIN_CHECK_INTERVAL_MINUTES = 1;
export const MAX_CHECK_INTERVAL_MINUTES = 1440;

export function normalizeCheckIntervalMinutes(value: unknown): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= MIN_CHECK_INTERVAL_MINUTES
    ? Math.min(MAX_CHECK_INTERVAL_MINUTES, Math.round(candidate))
    : DEFAULT_CHECK_INTERVAL_MINUTES;
}

export function parseSchedulerIntervalMinutes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CHECK_INTERVAL_MINUTES ||
    value > MAX_CHECK_INTERVAL_MINUTES
  ) {
    throw new Error(
      `Scheduler intervalMinutes must be a whole number between ${MIN_CHECK_INTERVAL_MINUTES} and ${MAX_CHECK_INTERVAL_MINUTES}.`,
    );
  }
  return value;
}

export function getNextCheckTimestamp(nowMs: number, intervalMinutes: unknown): number {
  return nowMs + normalizeCheckIntervalMinutes(intervalMinutes) * 60 * 1000;
}

export function getSchedulerIntervalMinutes(config: {
  scheduler?: { intervalMinutes?: unknown };
  checkIntervalMinutes?: unknown;
}): number {
  return normalizeCheckIntervalMinutes(config.scheduler?.intervalMinutes ?? config.checkIntervalMinutes);
}

export function isScheduledSweepDue(args: {
  enabled: boolean;
  nowMs: number;
  nextCheckTime: number;
}): boolean {
  return args.enabled && args.nowMs >= args.nextCheckTime;
}
