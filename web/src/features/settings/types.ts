import type { ConfigVersion } from '../../api/types';
import type { AccountMapping } from '../destinations/types';

export interface TwitterConfig extends ConfigVersion {
  authToken: string;
  ct0: string;
  backupAuthToken?: string;
  backupCt0?: string;
  hasAuthToken?: boolean;
  hasCt0?: boolean;
  hasBackupAuthToken?: boolean;
  hasBackupCt0?: boolean;
}

export interface AIConfig extends ConfigVersion {
  enabled: boolean;
  purpose: 'image-alt-text';
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  maxAltTextChars: number;
  privacyDescription: string;
  textCapabilities: Record<
    'translation' | 'summarization' | 'cleanup' | 'hashtags',
    { enabled: boolean; purpose: string; privacyDescription: string }
  >;
}

export interface NotificationSettings extends ConfigVersion {
  enabled: boolean;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  webhookUrl: string;
  webhookSecret: string;
  allowPrivate: boolean;
  events: Record<
    'twitter-auth-failure' | 'bsky-auth-failure' | 'queue-parked' | 'queue-age' | 'update-failure',
    boolean
  >;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
}

export interface UserPermissions {
  viewAllMappings: boolean;
  manageOwnMappings: boolean;
  manageAllMappings: boolean;
  manageGroups: boolean;
  queueBackfills: boolean;
  runNow: boolean;
  reevaluateQueuePolicies: boolean;
}

export interface AuthUser {
  id: string;
  username?: string;
  email?: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

export interface ManagedUser {
  id: string;
  username?: string;
  email?: string;
  role: 'admin' | 'user';
  isAdmin: boolean;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  mappingCount: number;
  activeMappingCount: number;
  mappings: AccountMapping[];
}

export interface RuntimeVersionInfo {
  version: string;
  commit?: string;
  branch?: string;
  startedAt: number;
}

export interface UpdateStatusInfo {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  logFile?: string;
  logTail?: string[];
}

export interface UserFormState {
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

export interface AccountSecurityEmailState {
  currentEmail: string;
  newEmail: string;
  password: string;
}

export interface AccountSecurityPasswordState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}
