const FIELD_LABELS: Record<string, string> = {
  posting: 'Posting / attribution',
  ai: 'AI overrides',
  routing: 'Routing filters',
  filters: 'Source filters',
  moderation: 'Moderation',
  duplicateSuppression: 'Duplicate suppression',
  routeDelivery: 'Delivery mode',
};

export function labelPolicySnapshotField(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function describePolicyDifference(fields: string[] | undefined): string {
  if (!fields || fields.length === 0) return 'Matches current policy';
  return `Differs now: ${fields.map(labelPolicySnapshotField).join(', ')}`;
}
