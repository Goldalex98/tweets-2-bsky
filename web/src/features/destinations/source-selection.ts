import { normalizeTwitterUsername } from '../../lib/dashboard-utils';

/** Pick which source username should be selected when the list or preferred focus changes. */
export function pickSelectedUsername(
  usernames: readonly string[],
  current: string | undefined,
  preferred?: string,
): string {
  const normalized = usernames.map((username) => normalizeTwitterUsername(username)).filter(Boolean);
  if (normalized.length === 0) return '';

  const preferredNorm = preferred ? normalizeTwitterUsername(preferred) : '';
  if (preferredNorm && normalized.includes(preferredNorm)) {
    return usernames.find((username) => normalizeTwitterUsername(username) === preferredNorm) || preferredNorm;
  }

  const currentNorm = current ? normalizeTwitterUsername(current) : '';
  if (currentNorm && normalized.includes(currentNorm)) {
    return usernames.find((username) => normalizeTwitterUsername(username) === currentNorm) || currentNorm;
  }

  return usernames[0] || '';
}

/** Fingerprint route filters for detecting server-side updates to the active source. */
export function filtersFingerprint(filters: unknown): string {
  return JSON.stringify(filters ?? null);
}
