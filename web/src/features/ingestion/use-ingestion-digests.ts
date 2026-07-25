import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import type { DigestAdminView, IngestionCredentialView, IngestionSourceView } from './types';

interface UseIngestionDigestsOptions {
  enabled: boolean;
  onError(error: unknown, fallback: string): void;
}

export function useIngestionDigests({ enabled, onError }: UseIngestionDigestsOptions) {
  const [sources, setSources] = useState<IngestionSourceView[]>([]);
  const [credentials, setCredentials] = useState<IngestionCredentialView[]>([]);
  const [digests, setDigests] = useState<DigestAdminView>({ jobs: [], entries: [] });
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (enabled) return;
    setSources([]);
    setCredentials([]);
    setDigests({ jobs: [], entries: [] });
    setOneTimeSecret(null);
    setError(null);
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [sourcesResponse, credentialsResponse, digestsResponse] = await Promise.all([
        api.get<IngestionSourceView[]>('/api/sources'),
        api.get<IngestionCredentialView[]>('/api/admin/ingestion-credentials'),
        api.get<DigestAdminView>('/api/admin/digests'),
      ]);
      setSources(sourcesResponse.data);
      setCredentials(credentialsResponse.data);
      setDigests(digestsResponse.data);
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch ingestion and digest settings.');
      onError(requestError, 'Failed to fetch ingestion and digest settings.');
    } finally {
      setLoading(false);
    }
  }, [enabled, onError]);

  const createCredential = useCallback(
    async (payload: { sourceId: string; name: string; includeHmac: boolean }) => {
      const response = await api.post<{ token: string; hmacSecret?: string }>('/api/admin/ingestion-credentials', payload);
      setOneTimeSecret(
        response.data.hmacSecret ? `${response.data.token}\nHMAC: ${response.data.hmacSecret}` : response.data.token,
      );
      await refresh();
      return response.data;
    },
    [refresh],
  );

  const createSource = useCallback(
    async (payload: { type: 'webhook' | 'api'; name: string; destinationIds: string[] }) => {
      await api.post('/api/sources', payload);
      await refresh();
    },
    [refresh],
  );

  const setRouteDelivery = useCallback(
    async (
      routeId: string,
      payload:
        | { mode: 'immediate' }
        | { mode: 'digest'; digest: { timezone: string; cadence: string; hour: number; minute: number } },
    ) => {
      await api.patch(`/api/routes/${encodeURIComponent(routeId)}/delivery`, payload);
      await refresh();
    },
    [refresh],
  );

  const revokeCredential = useCallback(
    async (credentialId: string, confirmation: string) => {
      await api.delete(`/api/admin/ingestion-credentials/${encodeURIComponent(credentialId)}`, {
        data: { confirmation },
      });
      await refresh();
    },
    [refresh],
  );

  const retryDigest = useCallback(
    async (jobId: string) => {
      await api.post(`/api/admin/digest-jobs/${jobId}/retry`);
      await refresh();
    },
    [refresh],
  );

  const previewDigest = useCallback(async (routeId: string) => {
    const response = await api.post(`/api/admin/digests/${encodeURIComponent(routeId)}/preview`);
    return response.data;
  }, []);

  const publishDigest = useCallback(
    async (routeId: string) => {
      await api.post(`/api/admin/digests/${encodeURIComponent(routeId)}/publish`);
      await refresh();
    },
    [refresh],
  );

  const cancelDigest = useCallback(
    async (jobId: string, confirmation: string) => {
      await api.delete(`/api/admin/digest-jobs/${encodeURIComponent(jobId)}`, { data: { confirmation } });
      await refresh();
    },
    [refresh],
  );

  const reset = useCallback(() => {
    setSources([]);
    setCredentials([]);
    setDigests({ jobs: [], entries: [] });
    setOneTimeSecret(null);
    setError(null);
  }, []);

  return {
    sources,
    credentials,
    digests,
    oneTimeSecret,
    setOneTimeSecret,
    loading,
    error,
    refresh,
    createSource,
    setRouteDelivery,
    createCredential,
    revokeCredential,
    retryDigest,
    previewDigest,
    publishDigest,
    cancelDigest,
    reset,
  };
}
