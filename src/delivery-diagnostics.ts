export type DeliveryFallbackKind =
  | 'quote-screenshot'
  | 'quote-link'
  | 'video-link'
  | 'poll-note'
  | 'poll-card';

export interface DeliveryFallbackEvent {
  kind: DeliveryFallbackKind;
  reason: string;
}

export function serializeDeliveryDiagnostics(events: DeliveryFallbackEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  return JSON.stringify(events);
}

export function parseDeliveryDiagnostics(raw?: string | null): DeliveryFallbackEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DeliveryFallbackEvent => {
      if (!entry || typeof entry !== 'object') return false;
      const kind = (entry as DeliveryFallbackEvent).kind;
      const reason = (entry as DeliveryFallbackEvent).reason;
      return typeof kind === 'string' && typeof reason === 'string';
    });
  } catch {
    return [];
  }
}

export function describeDeliveryFallback(event: DeliveryFallbackEvent): string {
  switch (event.kind) {
    case 'quote-screenshot':
      return 'Quote screenshot attached';
    case 'quote-link':
      return 'Quote link fallback';
    case 'video-link':
      return 'Video link fallback';
    case 'poll-note':
      return 'Poll note appended';
    case 'poll-card':
      return 'Poll link card attached';
    default:
      return event.reason;
  }
}
