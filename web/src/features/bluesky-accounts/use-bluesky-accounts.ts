import { useCallback, useEffect, useRef, useState } from 'react';
import api, { type ConfigVersion, isConfigConflict, withConfigVersion } from '../../api/client';
import { createLatestRequestTracker } from '../../lib/latest-request';
import type { BlueskyAccountFormState, BlueskyAccountView } from './types';

interface UseBlueskyAccountsOptions {
  authenticated: boolean;
  onError(error: unknown, fallback: string): void;
}

function normalizeAccount(raw: BlueskyAccountView): BlueskyAccountView {
  return {
    ...raw,
    updatedAtConfig: raw.updatedAtConfig ?? raw.updatedAt,
  };
}

function configVersionFromAccount(account: BlueskyAccountView): ConfigVersion {
  return {
    revision: account.revision,
    updatedAt: account.updatedAtConfig,
  };
}

export function useBlueskyAccounts({ authenticated, onError }: UseBlueskyAccountsOptions) {
  const [accounts, setAccounts] = useState<BlueskyAccountView[]>([]);
  const [configVersion, setConfigVersion] = useState<ConfigVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchTracker = useRef(createLatestRequestTracker()).current;

  const rememberVersion = useCallback((account: BlueskyAccountView) => {
    setConfigVersion(configVersionFromAccount(account));
  }, []);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    const token = fetchTracker.begin();
    setLoading(true);
    try {
      const response = await api.get<BlueskyAccountView[]>('/api/bluesky-accounts');
      if (!fetchTracker.isCurrent(token)) return;
      const next = Array.isArray(response.data) ? response.data.map(normalizeAccount) : [];
      setAccounts(next);
      if (next[0]) rememberVersion(next[0]);
      setError(null);
    } catch (requestError) {
      if (!fetchTracker.isCurrent(token)) return;
      setError('Failed to load Bluesky accounts.');
      onError(requestError, 'Failed to load Bluesky accounts.');
    } finally {
      if (fetchTracker.isCurrent(token)) setLoading(false);
    }
  }, [authenticated, fetchTracker, onError, rememberVersion]);

  useEffect(() => {
    if (!authenticated) {
      fetchTracker.invalidate();
      setAccounts([]);
      setConfigVersion(null);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [authenticated, fetchTracker, refresh]);

  const withConflictRefresh = useCallback(
    async <T>(mutation: () => Promise<T>): Promise<T> => {
      try {
        return await mutation();
      } catch (mutationError) {
        if (isConfigConflict(mutationError)) await refresh();
        throw mutationError;
      }
    },
    [refresh],
  );

  const createAccount = useCallback(
    async (form: BlueskyAccountFormState) => {
      setBusy(true);
      try {
        const body = {
          loginIdentifier: form.loginIdentifier.trim(),
          appPassword: form.appPassword,
          serviceUrl: form.serviceUrl.trim() || undefined,
          label: form.label.trim() || undefined,
        };
        const response = await withConflictRefresh(() =>
          api.post<BlueskyAccountView>(
            '/api/bluesky-accounts',
            configVersion ? withConfigVersion(body, configVersion) : body,
          ),
        );
        const created = normalizeAccount(response.data);
        rememberVersion(created);
        setAccounts((current) =>
          [...current, created].sort((a, b) => a.loginIdentifier.localeCompare(b.loginIdentifier)),
        );
        return created;
      } finally {
        setBusy(false);
      }
    },
    [configVersion, rememberVersion, withConflictRefresh],
  );

  const validateAccount = useCallback(
    async (account: BlueskyAccountView) => {
      setBusy(true);
      try {
        const response = await withConflictRefresh(() =>
          api.post<{ account: BlueskyAccountView }>(
            `/api/bluesky-accounts/${account.id}/validate`,
            withConfigVersion({}, configVersionFromAccount(account)),
          ),
        );
        const updated = normalizeAccount(response.data.account);
        rememberVersion(updated);
        setAccounts((current) => current.map((entry) => (entry.id === account.id ? updated : entry)));
        return updated;
      } finally {
        setBusy(false);
      }
    },
    [rememberVersion, withConflictRefresh],
  );

  const rotateCredentials = useCallback(
    async (account: BlueskyAccountView, appPassword: string) => {
      setBusy(true);
      try {
        const response = await withConflictRefresh(() =>
          api.patch<{ account: BlueskyAccountView }>(
            `/api/bluesky-accounts/${account.id}/credentials`,
            withConfigVersion({ appPassword }, configVersionFromAccount(account)),
          ),
        );
        const updated = normalizeAccount(response.data.account);
        rememberVersion(updated);
        setAccounts((current) => current.map((entry) => (entry.id === account.id ? updated : entry)));
        return updated;
      } finally {
        setBusy(false);
      }
    },
    [rememberVersion, withConflictRefresh],
  );

  const deleteAccount = useCallback(
    async (account: BlueskyAccountView) => {
      setBusy(true);
      try {
        const response = await withConflictRefresh(() =>
          api.delete<ConfigVersion>(`/api/bluesky-accounts/${account.id}`, {
            data: withConfigVersion({}, configVersionFromAccount(account)),
          }),
        );
        if (response.data?.revision != null) {
          setConfigVersion({ revision: response.data.revision, updatedAt: response.data.updatedAt });
        }
        setAccounts((current) => current.filter((entry) => entry.id !== account.id));
      } finally {
        setBusy(false);
      }
    },
    [withConflictRefresh],
  );

  return {
    accounts,
    loading,
    error,
    busy,
    refresh,
    createAccount,
    validateAccount,
    rotateCredentials,
    deleteAccount,
  };
}
