export interface ConfigVersion {
  revision: number;
  updatedAt: string;
}

export interface ConfigConflictPayload {
  error: string;
  code: 'CONFIG_REVISION_CONFLICT';
  guidance: string;
  current: ConfigVersion;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type AuthView = 'login' | 'register';
export type DashboardTab = 'overview' | 'accounts' | 'posts' | 'activity' | 'settings';
export type SettingsSection =
  | 'account'
  | 'system'
  | 'scheduler'
  | 'users'
  | 'twitter'
  | 'ai'
  | 'notifications'
  | 'ingestion'
  | 'data';

export interface BootstrapStatus {
  bootstrapOpen: boolean;
}

export interface Notice {
  tone: 'success' | 'error' | 'info';
  message: string;
}
