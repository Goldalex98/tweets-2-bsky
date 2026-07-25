import type { ConfigVersion } from '../../api/types';

export interface IngestionSourceView extends ConfigVersion {
  id: string;
  type: 'x' | 'webhook' | 'api';
  username: string;
  name?: string;
  routes: Array<{ id: string; destinationId: string; delivery?: { mode: 'immediate' | 'digest' } }>;
}

export interface IngestionCredentialView {
  id: string;
  name: string;
  sourceId: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  hmacEnabled: boolean;
}

export interface DigestAdminView {
  jobs: Array<{ id: string; routeId: string; status: string; nextRunAt: number; attempts: number }>;
  entries: Array<{ id: number; routeId: string; status: string; externalPostId: string }>;
}
