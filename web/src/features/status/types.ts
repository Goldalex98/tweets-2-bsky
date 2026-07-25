import type { ConfigVersion } from '../../api/types';
import type { QueueMappingCounts } from '../destinations/types';

export type AppState = 'idle' | 'checking' | 'backfilling' | 'pacing' | 'processing';
export type ActiveJobKind = 'checking' | 'mirroring' | 'backfilling' | 'profile-sync' | 'pin-sync';

export interface PendingBackfill {
  id: string;
  limit?: number;
  queuedAt: number;
  sequence: number;
  requestId: string;
  position: number;
}

export interface StatusState {
  state: AppState;
  currentAccount?: string;
  processedCount?: number;
  totalCount?: number;
  message?: string;
  backfillMappingId?: string;
  backfillRequestId?: string;
  lastUpdate: number;
}

export interface ActiveJobView {
  id: string;
  kind: ActiveJobKind;
  account?: string;
  target?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
  startedAt: number;
  updatedAt: number;
}

export interface QueueSummary {
  pending: number;
  processing: number;
  failed: number;
  oldestEnqueuedAt: number | null;
  perMapping: QueueMappingCounts[];
}

export interface SchedulerSettings extends ConfigVersion {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
  lastCheckTime: number | null;
  nextCheckTime: number | null;
  restartRequired?: boolean;
  enabledSourceCount: number;
  estimatedChecksPerHour: number;
  diagnostics?: Record<string, number | undefined>;
}

export interface StatusResponse {
  lastCheckTime: number;
  nextCheckTime: number | null;
  nextCheckMinutes: number;
  checkIntervalMinutes: number;
  pendingBackfills: PendingBackfill[];
  currentStatus: StatusState;
  activeJobs?: ActiveJobView[];
  queue?: QueueSummary;
  scheduler?: SchedulerSettings;
}
