export interface BlueskyAccountHealth {
  lastValidatedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorCategory?: string;
  consecutiveFailures: number;
}

/**
 * Sanitized API view of a managed Bluesky account.
 * `updatedAt` is the account record timestamp; `updatedAtConfig` + `revision`
 * are the config optimistic-concurrency token.
 */
export interface BlueskyAccountView {
  id: string;
  label?: string;
  serviceUrl: string;
  loginIdentifier: string;
  did?: string;
  canonicalHandle?: string;
  createdAt: string;
  updatedAt: string;
  credentialConfigured: boolean;
  linkedDestinationId: string | null;
  health: BlueskyAccountHealth | null;
  revision: number;
  updatedAtConfig: string;
}

export interface BlueskyAccountFormState {
  loginIdentifier: string;
  appPassword: string;
  serviceUrl: string;
  label: string;
}
