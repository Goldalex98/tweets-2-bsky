export const HISTORY_RETENTION_MAX_DAYS = 3650;

/** `HISTORY_RETENTION_DAYS`, default 90, clamped to 0..3650; 0 turns automatic pruning off. */
export function historyRetentionDays(raw = process.env.HISTORY_RETENTION_DAYS): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 90;
  return Math.min(HISTORY_RETENTION_MAX_DAYS, Math.max(0, Math.round(value)));
}
