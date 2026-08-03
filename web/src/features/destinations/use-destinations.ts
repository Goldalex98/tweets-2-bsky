import { useCallback, useEffect, useRef, useState } from 'react';
import api, { type ConfigVersion, isConfigConflict, withConfigVersion } from '../../api/client';
import { createLatestRequestTracker } from '../../lib/latest-request';
import type {
  AccountGroup,
  AccountMapping,
  BskyProfileView,
  InitialImportMode,
  SourceFilterPolicy,
  SourceSchedulePolicy,
} from './types';

interface UseDestinationsOptions {
  authenticated: boolean;
  onError(error: unknown, fallback: string): void;
}

export function useDestinations({ authenticated, onError }: UseDestinationsOptions) {
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [profiles, setProfiles] = useState<Record<string, BskyProfileView>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saves and manual refreshes can overlap; only the newest response may write state.
  const fetchTracker = useRef(createLatestRequestTracker()).current;

  useEffect(() => {
    if (authenticated) return;
    fetchTracker.invalidate();
    setMappings([]);
    setGroups([]);
    setProfiles({});
    setError(null);
    setLoading(false);
  }, [authenticated, fetchTracker]);

  const fetchDestinations = useCallback(async (): Promise<AccountMapping[] | undefined> => {
    if (!authenticated) return undefined;
    const token = fetchTracker.begin();
    setLoading(true);
    try {
      const [destinationsResponse, groupsResponse] = await Promise.all([
        api.get<AccountMapping[]>('/api/destinations'),
        api.get<AccountGroup[]>('/api/groups'),
      ]);
      if (!fetchTracker.isCurrent(token)) return undefined;
      const loadedMappings = Array.isArray(destinationsResponse.data) ? destinationsResponse.data : [];
      setMappings(loadedMappings);
      setGroups(Array.isArray(groupsResponse.data) ? groupsResponse.data : []);
      setError(null);
      const actors = loadedMappings.map((mapping) => mapping.bskyIdentifier);
      if (actors.length === 0) {
        setProfiles({});
        return loadedMappings;
      }
      try {
        const profileResponse = await api.post<Record<string, BskyProfileView>>('/api/bsky/profiles', { actors });
        if (!fetchTracker.isCurrent(token)) return loadedMappings;
        setProfiles(profileResponse.data || {});
      } catch (profileError) {
        // Avatars are decorative: a Bluesky outage must not blank the destination list.
        if (!fetchTracker.isCurrent(token)) return loadedMappings;
        onError(profileError, 'Failed to load Bluesky profile previews.');
      }
      return loadedMappings;
    } catch (requestError) {
      if (!fetchTracker.isCurrent(token)) return undefined;
      setError('Failed to load destinations.');
      onError(requestError, 'Failed to load destinations.');
      return undefined;
    } finally {
      if (fetchTracker.isCurrent(token)) setLoading(false);
    }
  }, [authenticated, onError, fetchTracker]);

  const fetchGroups = useCallback(async () => {
    if (!authenticated) return;
    try {
      const response = await api.get<AccountGroup[]>('/api/groups');
      setGroups(Array.isArray(response.data) ? response.data : []);
      setError(null);
    } catch (requestError) {
      setError('Failed to fetch account groups.');
      onError(requestError, 'Failed to fetch account groups.');
    }
  }, [authenticated, onError]);

  /**
   * A stale-revision rejection means the local copy no longer matches the
   * stored config, so reload before the operator reapplies the change.
   */
  const withConflictRefresh = useCallback(
    async <T>(mutation: () => Promise<T>): Promise<T> => {
      try {
        return await mutation();
      } catch (mutationError) {
        if (isConfigConflict(mutationError)) await fetchDestinations();
        throw mutationError;
      }
    },
    [fetchDestinations],
  );

  const createDestination = useCallback(
    async (payload: object, version?: ConfigVersion) => {
      const response = await withConflictRefresh(() =>
        api.post<AccountMapping>('/api/destinations', version ? withConfigVersion(payload, version) : payload),
      );
      setMappings((current) => [...current, response.data]);
      return response.data;
    },
    [withConflictRefresh],
  );

  /**
   * Repoint a destination at a managed Bluesky account. Mirror history stays
   * with the destination, so the new account only receives future posts.
   */
  const linkBlueskyAccount = useCallback(
    async (mapping: AccountMapping, bskyAccountId: string) => {
      const response = await withConflictRefresh(() =>
        api.patch<{ destination: AccountMapping }>(
          `/api/destinations/${mapping.id}/bluesky-account`,
          withConfigVersion({ bskyAccountId }, mapping),
        ),
      );
      const updated = response.data.destination;
      setMappings((current) => current.map((entry) => (entry.id === mapping.id ? updated : entry)));
      return updated;
    },
    [withConflictRefresh],
  );

  const updateDestination = useCallback(
    async (mapping: AccountMapping, payload: object) => {
      const response = await withConflictRefresh(() =>
        api.put<AccountMapping>(`/api/destinations/${mapping.id}`, withConfigVersion(payload, mapping)),
      );
      setMappings((current) => current.map((entry) => (entry.id === mapping.id ? response.data : entry)));
      return response.data;
    },
    [withConflictRefresh],
  );

  const syncSources = useCallback(
    async (mapping: AccountMapping, nextSources: string[], initialImportMode: InitialImportMode = 'inherit') => {
      let version: ConfigVersion = mapping;
      const current = new Set(mapping.twitterUsernames.map((username) => username.toLowerCase()));
      const next = new Set(nextSources.map((username) => username.toLowerCase()));
      const added = [...next].filter((username) => !current.has(username));
      const removed = [...current].filter((username) => !next.has(username));
      return withConflictRefresh(async () => {
        if (added.length > 0) {
          const response = await api.post<ConfigVersion>(
            `/api/destinations/${mapping.id}/sources`,
            withConfigVersion({ sources: added, initialImportMode }, version),
          );
          version = response.data;
        }
        for (const username of removed) {
          const response = await api.delete<ConfigVersion>(
            `/api/destinations/${mapping.id}/sources/${encodeURIComponent(username)}`,
            { data: withConfigVersion({ cancelPendingQueue: false, deleteHistory: false }, version) },
          );
          version = response.data;
        }
        const loaded = await fetchDestinations();
        const latest = loaded?.find((entry) => entry.id === mapping.id);
        if (!latest) {
          // Never synthesize sources without routeId — content/delivery panels
          // key off route metadata and would hide the newly added source.
          throw new Error('Destination list refresh failed after updating sources. Reload and try again.');
        }
        return latest;
      });
    },
    [fetchDestinations, withConflictRefresh],
  );

  const patchSource = useCallback(
    async (
      mapping: AccountMapping,
      username: string,
      payload: {
        filters?: SourceFilterPolicy;
        schedule?: SourceSchedulePolicy;
        state?: 'enabled' | 'paused';
        initialImportMode?: InitialImportMode;
      },
    ) => {
      await withConflictRefresh(() =>
        api.patch(
          `/api/destinations/${mapping.id}/sources/${encodeURIComponent(username)}`,
          withConfigVersion(payload, mapping),
        ),
      );
      const loaded = await fetchDestinations();
      const latest = loaded?.find((entry) => entry.id === mapping.id);
      if (!latest) throw new Error('Destination refresh failed after saving the source. Reload and try again.');
      return latest;
    },
    [fetchDestinations, withConflictRefresh],
  );

  const previewSourceFilter = useCallback(
    async (
      mapping: AccountMapping,
      username: string,
      filters: SourceFilterPolicy,
      metadata: Record<string, unknown>,
    ) => {
      const response = await api.post<{ allowed: boolean; reason: string }>(
        `/api/destinations/${mapping.id}/sources/${encodeURIComponent(username)}/filter-preview`,
        { filters, metadata },
      );
      return response.data;
    },
    [],
  );

  const previewPostingPolicy = useCallback(
    async (
      mapping: AccountMapping,
      payload: {
        text: string;
        twitterUsername?: string;
        postingPolicy?: AccountMapping['postingPolicy'];
        isReply?: boolean;
        isThreadRoot?: boolean;
      },
    ) => {
      const response = await api.post<{
        text: string;
        attributionApplied: boolean;
        originalLinkApplied: boolean;
      }>(`/api/mappings/${mapping.id}/posting/preview`, payload);
      return response.data;
    },
    [],
  );

  const previewProfileSync = useCallback(async (mapping: AccountMapping, sourceUsername?: string) => {
    const response = await api.post(`/api/mappings/${mapping.id}/profile/preview`, {
      sourceUsername: sourceUsername || undefined,
    });
    return response.data;
  }, []);

  const applyProfileSync = useCallback(
    async (mapping: AccountMapping, sourceUsername?: string) => {
      const response = await withConflictRefresh(() =>
        api.post(`/api/mappings/${mapping.id}/profile/apply`, {
          sourceUsername: sourceUsername || undefined,
        }),
      );
      await fetchDestinations();
      return response.data;
    },
    [fetchDestinations, withConflictRefresh],
  );

  const queuePinSync = useCallback(async (mapping: AccountMapping, sourceUsername?: string) => {
    const response = await api.post(`/api/pin-sync/${mapping.id}`, {
      sourceUsername: sourceUsername || undefined,
    });
    return response.data;
  }, []);

  const deleteDestination = useCallback(
    async (mapping: Pick<AccountMapping, 'id'> & ConfigVersion) => {
      await withConflictRefresh(() => api.delete(`/api/mappings/${mapping.id}`, { data: mapping }));
      setMappings((current) => current.filter((entry) => entry.id !== mapping.id));
    },
    [withConflictRefresh],
  );

  const createGroup = useCallback(async (group: AccountGroup) => {
    const response = await api.post<AccountGroup[]>('/api/groups', group);
    setGroups(Array.isArray(response.data) ? response.data : []);
  }, []);

  const assignGroup = useCallback(
    async (mapping: AccountMapping, group: AccountGroup) => {
      const response = await withConflictRefresh(() =>
        api.patch<AccountMapping>(
          `/api/mappings/${mapping.id}/group`,
          withConfigVersion({ groupName: group.name, groupEmoji: group.emoji || '📁' }, mapping),
        ),
      );
      setMappings((current) => current.map((entry) => (entry.id === mapping.id ? response.data : entry)));
    },
    [withConflictRefresh],
  );

  const reset = useCallback(() => {
    setMappings([]);
    setGroups([]);
    setProfiles({});
    setError(null);
  }, []);

  return {
    mappings,
    setMappings,
    groups,
    setGroups,
    profiles,
    loading,
    error,
    fetchDestinations,
    fetchGroups,
    createDestination,
    linkBlueskyAccount,
    updateDestination,
    syncSources,
    patchSource,
    previewSourceFilter,
    previewPostingPolicy,
    previewProfileSync,
    applyProfileSync,
    queuePinSync,
    deleteDestination,
    createGroup,
    assignGroup,
    reset,
  };
}
