import { useCallback, useEffect, useRef, useState } from 'react';
import api, { withConfigVersion } from '../../api/client';
import type { ConfigVersion } from '../../api/types';
import { INITIAL_CONFIG_VERSION } from '../../lib/dashboard-utils';
import { createLatestRequestTracker } from '../../lib/latest-request';
import type { SchedulerSettings } from '../status/types';
import type {
  AIConfig,
  CookieHealthStatus,
  ManagedUser,
  NotificationSettings,
  RuntimeVersionInfo,
  TwitterConfig,
  UpdateStatusInfo,
} from './types';

interface UseSettingsSecurityOptions {
  enabled: boolean;
  onError(error: unknown, fallback: string): void;
}

const initialTwitterConfig: TwitterConfig = {
  ...INITIAL_CONFIG_VERSION,
  authToken: '',
  ct0: '',
};

const initialAiConfig: AIConfig = {
  ...INITIAL_CONFIG_VERSION,
  enabled: false,
  purpose: 'image-alt-text',
  provider: 'gemini',
  apiKey: '',
  model: '',
  baseUrl: '',
  maxAltTextChars: 1000,
  privacyDescription: 'Image bytes and limited post context are sent only for Image Alt Text.',
  textCapabilities: {
    translation: { enabled: false, purpose: 'translation', privacyDescription: 'Post text is sent only for this capability.' },
    summarization: { enabled: false, purpose: 'summarization', privacyDescription: 'Post text is sent only for this capability.' },
    cleanup: { enabled: false, purpose: 'cleanup', privacyDescription: 'Post text is sent only for this capability.' },
    hashtags: { enabled: false, purpose: 'hashtags', privacyDescription: 'Post text is sent only for this capability.' },
  },
};

const initialNotifications: NotificationSettings = {
  ...INITIAL_CONFIG_VERSION,
  enabled: false,
  webhookConfigured: false,
  secretConfigured: false,
  webhookUrl: '',
  webhookSecret: '',
  allowPrivate: false,
  events: {
    'twitter-auth-failure': true,
    'bsky-auth-failure': true,
    'queue-parked': true,
    'queue-age': false,
    'update-failure': true,
  },
  maxAttempts: 3,
  backoffMs: 1000,
  timeoutMs: 10000,
};

/**
 * Save endpoints answer with `{ success, revision, updatedAt }` only, so state has to be
 * merged. Replacing it would drop `events`/`textCapabilities` and crash the settings page.
 */
export type SaveAck = ConfigVersion & { success?: boolean; webhookConfigured?: boolean; secretConfigured?: boolean };

export function mergeConfigVersion<T extends ConfigVersion>(current: T, ack: SaveAck): T {
  return { ...current, revision: ack.revision ?? current.revision, updatedAt: ack.updatedAt ?? current.updatedAt };
}

export function useSettingsSecurity({ enabled, onError }: UseSettingsSecurityOptions) {
  const [twitterConfig, setTwitterConfig] = useState<TwitterConfig>(initialTwitterConfig);
  const [aiConfig, setAiConfig] = useState<AIConfig>(initialAiConfig);
  const [notifications, setNotifications] = useState<NotificationSettings>(initialNotifications);
  const [cookieHealth, setCookieHealth] = useState<CookieHealthStatus | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerSettings | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersionInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTracker = useRef(createLatestRequestTracker()).current;

  useEffect(() => {
    if (enabled) return;
    refreshTracker.invalidate();
    setTwitterConfig(initialTwitterConfig);
    setAiConfig(initialAiConfig);
    setNotifications(initialNotifications);
    setCookieHealth(null);
    setScheduler(null);
    setUsers([]);
    setUpdateStatus(null);
    setError(null);
  }, [enabled, refreshTracker]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const token = refreshTracker.begin();
    setLoading(true);
    try {
      const [
        twitter,
        ai,
        notificationResponse,
        schedulerResponse,
        usersResponse,
        versionResponse,
        updateResponse,
        healthResponse,
      ] = await Promise.all([
        api.get<TwitterConfig>('/api/twitter-config'),
        api.get<AIConfig>('/api/ai-config'),
        api.get<NotificationSettings>('/api/settings/notifications'),
        api.get<SchedulerSettings>('/api/settings/scheduler'),
        api.get<ManagedUser[]>('/api/admin/users'),
        api.get<RuntimeVersionInfo>('/api/version'),
        api.get<UpdateStatusInfo>('/api/update-status'),
        api.get<{ cookies: CookieHealthStatus }>('/api/health/details'),
      ]);
      if (!refreshTracker.isCurrent(token)) return;
      setTwitterConfig({ ...initialTwitterConfig, ...twitter.data, authToken: '', ct0: '', backupAuthToken: '', backupCt0: '' });
      setAiConfig({ ...initialAiConfig, ...ai.data, apiKey: '' });
      setNotifications({
        ...initialNotifications,
        ...notificationResponse.data,
        events: { ...initialNotifications.events, ...(notificationResponse.data.events ?? {}) },
        webhookUrl: '',
        webhookSecret: '',
      });
      setCookieHealth(healthResponse.data.cookies ?? null);
      setScheduler(schedulerResponse.data);
      setUsers(Array.isArray(usersResponse.data) ? usersResponse.data : []);
      setRuntimeVersion(versionResponse.data);
      setUpdateStatus(updateResponse.data);
      setError(null);
    } catch (requestError) {
      if (!refreshTracker.isCurrent(token)) return;
      setError('Failed to load settings.');
      onError(requestError, 'Failed to load settings.');
    } finally {
      if (refreshTracker.isCurrent(token)) setLoading(false);
    }
  }, [enabled, onError, refreshTracker]);

  const saveScheduler = useCallback(async () => {
    if (!scheduler) return null;
    const response = await api.patch<SchedulerSettings>(
      '/api/settings/scheduler',
      withConfigVersion(
        {
          enabled: scheduler.enabled,
          intervalMinutes: scheduler.intervalMinutes,
          runOnStartup: scheduler.runOnStartup,
        },
        scheduler,
      ),
    );
    setScheduler(response.data);
    return response.data;
  }, [scheduler]);

  const saveTwitter = useCallback(async () => {
    const response = await api.post<SaveAck>(
      '/api/twitter-config',
      withConfigVersion(
        {
          authToken: twitterConfig.authToken,
          ct0: twitterConfig.ct0,
          backupAuthToken: twitterConfig.backupAuthToken,
          backupCt0: twitterConfig.backupCt0,
        },
        twitterConfig,
      ),
    );
    const saved = response.data;
    setTwitterConfig((current) => ({
      ...mergeConfigVersion(current, saved),
      authToken: '',
      ct0: '',
      backupAuthToken: '',
      backupCt0: '',
      hasAuthToken: current.hasAuthToken || current.authToken.length > 0,
      hasCt0: current.hasCt0 || current.ct0.length > 0,
      hasBackupAuthToken: current.hasBackupAuthToken || (current.backupAuthToken?.length ?? 0) > 0,
      hasBackupCt0: current.hasBackupCt0 || (current.backupCt0?.length ?? 0) > 0,
    }));
    return saved;
  }, [twitterConfig]);

  const saveAi = useCallback(async () => {
    const response = await api.post<SaveAck>('/api/ai-config', withConfigVersion(aiConfig, aiConfig));
    const saved = response.data;
    setAiConfig((current) => ({
      ...mergeConfigVersion(current, saved),
      apiKey: '',
      hasApiKey: current.hasApiKey || (current.apiKey?.length ?? 0) > 0,
    }));
    return saved;
  }, [aiConfig]);

  const saveNotifications = useCallback(async () => {
    const response = await api.put<SaveAck>(
      '/api/settings/notifications',
      withConfigVersion(notifications, notifications),
    );
    const saved = response.data;
    setNotifications((current) => ({
      ...mergeConfigVersion(current, saved),
      webhookUrl: '',
      webhookSecret: '',
      webhookConfigured: saved.webhookConfigured ?? current.webhookConfigured,
      secretConfigured: saved.secretConfigured ?? current.secretConfigured,
    }));
    return saved;
  }, [notifications]);

  const testNotifications = useCallback(async () => {
    await api.post('/api/settings/notifications/test');
  }, []);

  const previewAiText = useCallback(
    async (capability: 'translation' | 'summarization' | 'cleanup' | 'hashtags', text: string) => {
      const response = await api.post<{ enabled: boolean; output?: string }>('/api/ai/preview-text', {
        capability,
        text,
      });
      return response.data;
    },
    [],
  );

  const createUser = useCallback(
    async (payload: { username?: string; email?: string; password: string; isAdmin: boolean; permissions: object }) => {
      await api.post('/api/admin/users', payload);
      const response = await api.get<ManagedUser[]>('/api/admin/users');
      setUsers(Array.isArray(response.data) ? response.data : []);
    },
    [],
  );

  const deleteUser = useCallback(async (userId: string) => {
    await api.delete(`/api/admin/users/${userId}`);
    setUsers((current) => current.filter((user) => user.id !== userId));
  }, []);

  const changeEmail = useCallback(async (payload: { currentEmail: string; newEmail: string; password: string }) => {
    await api.post('/api/me/change-email', payload);
  }, []);

  const changePassword = useCallback(
    async (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
      await api.post('/api/me/change-password', payload);
    },
    [],
  );

  const reset = useCallback(() => {
    setTwitterConfig(initialTwitterConfig);
    setAiConfig(initialAiConfig);
    setNotifications(initialNotifications);
    setCookieHealth(null);
    setScheduler(null);
    setUsers([]);
    setRuntimeVersion(null);
    setUpdateStatus(null);
    setError(null);
  }, []);

  return {
    twitterConfig,
    setTwitterConfig,
    aiConfig,
    setAiConfig,
    notifications,
    setNotifications,
    cookieHealth,
    scheduler,
    setScheduler,
    users,
    setUsers,
    runtimeVersion,
    setRuntimeVersion,
    updateStatus,
    setUpdateStatus,
    loading,
    error,
    refresh,
    saveScheduler,
    saveTwitter,
    saveAi,
    saveNotifications,
    testNotifications,
    previewAiText,
    createUser,
    deleteUser,
    changeEmail,
    changePassword,
    reset,
  };
}
