import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import type { DashboardTab } from '../../api/types';
import type { StatusResponse } from '../status/types';
import type { ActivityLog, EnrichedPost, QueueItemView } from './types';

interface UseActivityPollingOptions {
  authenticated: boolean;
  activeTab: DashboardTab;
  onError(error: unknown, fallback: string): void;
}

export function useActivityPolling({ authenticated, activeTab, onError }: UseActivityPollingOptions) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityLog[]>([]);
  const [queueItems, setQueueItems] = useState<QueueItemView[]>([]);
  const [enrichedPosts, setEnrichedPosts] = useState<EnrichedPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const statusRequestRef = useRef(0);
  const statusMutationRef = useRef(0);
  const activityRequestRef = useRef(0);
  const activityMutationRef = useRef(0);
  const queueRequestRef = useRef(0);
  const queueMutationRef = useRef(0);
  const postsRequestRef = useRef(0);
  const postsMutationRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    if (!authenticated) return;
    const requestToken = ++statusRequestRef.current;
    const mutationTokenAtStart = statusMutationRef.current;
    try {
      const response = await api.get<StatusResponse>('/api/status');
      if (requestToken === statusRequestRef.current && mutationTokenAtStart === statusMutationRef.current) {
        setStatus(response.data);
      }
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch status.');
      onError(requestError, 'Failed to fetch status.');
    }
  }, [authenticated, onError]);

  const fetchRecentActivity = useCallback(async () => {
    if (!authenticated) return;
    const requestToken = ++activityRequestRef.current;
    const mutationTokenAtStart = activityMutationRef.current;
    try {
      const response = await api.get<ActivityLog[]>('/api/recent-activity?limit=20');
      if (requestToken === activityRequestRef.current && mutationTokenAtStart === activityMutationRef.current) {
        setRecentActivity(response.data);
      }
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch activity.');
      onError(requestError, 'Failed to fetch activity.');
    }
  }, [authenticated, onError]);

  const fetchQueueItems = useCallback(async () => {
    if (!authenticated) return;
    const requestToken = ++queueRequestRef.current;
    const mutationTokenAtStart = queueMutationRef.current;
    try {
      const response = await api.get<{ items: QueueItemView[] }>('/api/queue?limit=200');
      if (requestToken === queueRequestRef.current && mutationTokenAtStart === queueMutationRef.current) {
        setQueueItems(response.data.items ?? []);
      }
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch queue details.');
      onError(requestError, 'Failed to fetch queue details.');
    }
  }, [authenticated, onError]);

  const fetchEnrichedPosts = useCallback(async () => {
    if (!authenticated) return;
    const requestToken = ++postsRequestRef.current;
    const mutationTokenAtStart = postsMutationRef.current;
    try {
      const response = await api.get<EnrichedPost[]>('/api/posts/enriched?limit=36');
      if (requestToken === postsRequestRef.current && mutationTokenAtStart === postsMutationRef.current) {
        setEnrichedPosts(response.data);
      }
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch Bluesky posts.');
      onError(requestError, 'Failed to fetch Bluesky posts.');
    }
  }, [authenticated, onError]);

  useEffect(() => {
    if (authenticated) return;
    statusRequestRef.current += 1;
    statusMutationRef.current += 1;
    activityRequestRef.current += 1;
    activityMutationRef.current += 1;
    queueRequestRef.current += 1;
    queueMutationRef.current += 1;
    postsRequestRef.current += 1;
    postsMutationRef.current += 1;
    setStatus(null);
    setRecentActivity([]);
    setQueueItems([]);
    setEnrichedPosts([]);
    setError(null);
  }, [authenticated]);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setIsLoading(true);
    try {
      await Promise.all([fetchStatus(), fetchRecentActivity(), fetchQueueItems(), fetchEnrichedPosts()]);
    } finally {
      setIsLoading(false);
    }
  }, [authenticated, fetchEnrichedPosts, fetchQueueItems, fetchRecentActivity, fetchStatus]);

  useEffect(() => {
    if (!authenticated) return;
    const statusIntervalMs = activeTab === 'accounts' ? 7000 : 3000;
    const statusInterval = window.setInterval(() => void fetchStatus(), statusIntervalMs);
    const activityInterval =
      activeTab === 'overview' || activeTab === 'activity'
        ? window.setInterval(() => {
            void fetchRecentActivity();
            void fetchQueueItems();
          }, 7000)
        : null;
    const postsInterval =
      activeTab === 'overview' || activeTab === 'posts'
        ? window.setInterval(() => void fetchEnrichedPosts(), 12000)
        : null;
    return () => {
      window.clearInterval(statusInterval);
      if (activityInterval !== null) window.clearInterval(activityInterval);
      if (postsInterval !== null) window.clearInterval(postsInterval);
    };
  }, [activeTab, authenticated, fetchEnrichedPosts, fetchQueueItems, fetchRecentActivity, fetchStatus]);

  useEffect(() => {
    if (activeTab !== 'overview' || !status?.nextCheckTime) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTab, status?.nextCheckTime]);

  const countdown = useMemo(() => {
    if (activeTab !== 'overview' || !status?.nextCheckTime) return '--';
    const seconds = Math.max(0, Math.floor((status.nextCheckTime - clock) / 1000));
    return seconds === 0 ? 'Checking...' : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }, [activeTab, clock, status?.nextCheckTime]);

  const markStatusMutation = useCallback(() => {
    statusMutationRef.current += 1;
  }, []);

  const markQueueMutation = useCallback(() => {
    queueMutationRef.current += 1;
    statusMutationRef.current += 1;
  }, []);

  const markActivityMutation = useCallback(() => {
    activityMutationRef.current += 1;
    queueMutationRef.current += 1;
    statusMutationRef.current += 1;
  }, []);

  const runNow = useCallback(async () => {
    markStatusMutation();
    await api.post('/api/run-now');
    await fetchStatus();
  }, [fetchStatus, markStatusMutation]);

  const retryFailed = useCallback(async () => {
    markQueueMutation();
    await api.post('/api/queue/retry-failed');
    await Promise.all([fetchStatus(), fetchQueueItems()]);
  }, [fetchQueueItems, fetchStatus, markQueueMutation]);

  const clearFailed = useCallback(async () => {
    markQueueMutation();
    await api.delete('/api/queue/failed');
    await Promise.all([fetchStatus(), fetchQueueItems()]);
  }, [fetchQueueItems, fetchStatus, markQueueMutation]);

  const operateQueueItem = useCallback(
    async (item: QueueItemView, action: 'retry' | 'cancel') => {
      markQueueMutation();
      const path = `/api/queue/items/${encodeURIComponent(item.bsky_identifier)}/${encodeURIComponent(item.twitter_id)}`;
      if (action === 'retry') await api.post(`${path}/retry`);
      else await api.delete(path);
      await Promise.all([fetchStatus(), fetchQueueItems()]);
    },
    [fetchQueueItems, fetchStatus, markQueueMutation],
  );

  const reevaluateQueueItem = useCallback(
    async (item: QueueItemView) => {
      markQueueMutation();
      await api.post(
        `/api/queue/items/${encodeURIComponent(item.bsky_identifier)}/${encodeURIComponent(item.twitter_id)}/reevaluate-policy`,
        { reason: 'Dashboard-confirmed current policy re-evaluation' },
        { headers: { 'x-queue-confirmation': 'REEVALUATE_POLICY' } },
      );
      await fetchQueueItems();
    },
    [fetchQueueItems, markQueueMutation],
  );

  const overrideSkipped = useCallback(
    async (activity: ActivityLog) => {
      if (!activity.destination_id) return;
      markActivityMutation();
      await api.post(
        `/api/activity/${encodeURIComponent(activity.destination_id)}/${encodeURIComponent(activity.twitter_id)}/override-requeue`,
        { override: true },
        { headers: { 'x-queue-confirmation': 'OVERRIDE_POLICY_SKIP' } },
      );
      await Promise.all([fetchRecentActivity(), fetchQueueItems(), fetchStatus()]);
    },
    [fetchQueueItems, fetchRecentActivity, fetchStatus, markActivityMutation],
  );

  const requestBackfill = useCallback(
    async (mappingId: string) => {
      markStatusMutation();
      await api.post(`/api/backfill/${mappingId}`, { limit: 15 });
      await fetchStatus();
    },
    [fetchStatus, markStatusMutation],
  );

  const cancelBackfill = useCallback(
    async (mappingId: string) => {
      markStatusMutation();
      await api.delete(`/api/backfill/${mappingId}`);
      await fetchStatus();
    },
    [fetchStatus, markStatusMutation],
  );

  const reset = useCallback(() => {
    statusRequestRef.current += 1;
    statusMutationRef.current += 1;
    activityRequestRef.current += 1;
    activityMutationRef.current += 1;
    queueRequestRef.current += 1;
    queueMutationRef.current += 1;
    postsRequestRef.current += 1;
    postsMutationRef.current += 1;
    setStatus(null);
    setRecentActivity([]);
    setQueueItems([]);
    setEnrichedPosts([]);
    setError(null);
  }, []);

  return {
    status,
    setStatus,
    recentActivity,
    queueItems,
    enrichedPosts,
    countdown,
    isLoading,
    error,
    fetchStatus,
    fetchRecentActivity,
    fetchQueueItems,
    fetchEnrichedPosts,
    refresh,
    markStatusMutation,
    runNow,
    retryFailed,
    clearFailed,
    operateQueueItem,
    reevaluateQueueItem,
    overrideSkipped,
    requestBackfill,
    cancelBackfill,
    reset,
  };
}
