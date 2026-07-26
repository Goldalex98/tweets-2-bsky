/**
 * SQLite's CURRENT_TIMESTAMP is UTC but formatted without a timezone marker
 * ("YYYY-MM-DD HH:MM:SS"), so Date.parse would otherwise interpret it as
 * local time. These helpers treat naive stamps as UTC for comparisons and API/UI.
 */

export function parseSqliteUtcTimestampMs(value?: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Already timezone-aware (Z or ±HH:MM / ±HHMM).
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // Naive SQLite / space-separated UTC wall clock → treat as UTC.
  const iso = trimmed.includes('T') ? `${trimmed}Z` : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Canonical ISO-8601 UTC for API/UI consumers (naive SQLite stamps included). */
export function toIsoUtcTimestamp(value?: string | null): string | undefined {
  const ms = parseSqliteUtcTimestampMs(value);
  return typeof ms === 'number' ? new Date(ms).toISOString() : undefined;
}
