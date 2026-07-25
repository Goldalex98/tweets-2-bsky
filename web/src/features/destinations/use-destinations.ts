import { useCallback, useEffect, useRef, useState } from 'react';
import api, { type ConfigVersion, isConfigConflict, withConfigVersion } from '../../api/client';
import { createLatestRequestTracker } from '../../lib/latest-request';
import type { AccountGroup, AccountMapping, BskyProfileView } from './types';

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

  const fetchDestinations = useCallback(async () => {
    if (!authenticated) return;
    const token = fetchTracker.begin();
    setLoading(true);
    try {
      const [destinationsResponse, groupsResponse] = await Promise.all([
        api.get<AccountMapping[]>('/api/destinations'),
        api.get<AccountGroup[]>('/api/groups'),
      ]);
      if (!fetchTracker.isCurrent(token)) return;
      const loadedMappings = Array.isArray(destinationsResponse.data) ? destinationsResponse.data : [];
      setMappings(loadedMappings);
      setGroups(Array.isArray(groupsResponse.data) ? groupsResponse.data : []);
      setError(null);
      const actors = loadedMappings.map((mapping) => mapping.bskyIdentifier);
      if (actors.length === 0) {
        setProfiles({});
        return;
      }
      try {
        const profileResponse = await api.post<Record<string, BskyProfileView>>('/api/bsky/profiles', { actors });
        if (!fetchTracker.isCurrent(token)) return;
        setProfiles(profileResponse.data || {});
      } catch (profileError) {
        // Avatars are decorative: a Bluesky outage must not blank the destination list.
        if (!fetchTracker.isCurrent(token)) return;
        onError(profileError, 'Failed to load Bluesky profile previews.');
      }
    } catch (requestError) {
      if (!fetchTracker.isCurrent(token)) return;
      setError('Failed to load destinations.');
      onError(requestError, 'Failed to load destinations.');
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
    async (payload: object) => {
      const response = await api.post<AccountMapping>('/api/destinations', payload);
      setMappings((current) => [...current, response.data]);
      return response.data;
    },
    [],
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
    async (mapping: AccountMapping, nextSources: string[]) => {
      let version: ConfigVersion = mapping;
      const current = new Set(mapping.twitterUsernames.map((username) => username.toLowerCase()));
      const next = new Set(nextSources.map((username) => username.toLowerCase()));
      const added = [...next].filter((username) => !current.has(username));
      const removed = [...current].filter((username) => !next.has(username));
      return withConflictRefresh(async () => {
        if (added.length > 0) {
          const response = await api.post<ConfigVersion>(
            `/api/destinations/${mapping.id}/sources`,
            withConfigVersion({ sources: added }, version),
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
        await fetchDestinations();
        return version;
      });
    },
    [fetchDestinations, withConflictRefresh],
  );

  const testCredentials = useCallback(async (mapping: AccountMapping, password: string) => {
    return api.post(`/api/destinations/${mapping.id}/credentials/test`, {
      bskyPassword: password,
      bskyServiceUrl: mapping.bskyServiceUrl,
    });
  }, []);

  const saveCredentials = useCallback(
    async (mapping: AccountMapping, password: string) => {
      await withConflictRefresh(() =>
        api.put(
          `/api/destinations/${mapping.id}/credentials`,
          withConfigVersion({ bskyPassword: password, bskyServiceUrl: mapping.bskyServiceUrl }, mapping),
        ),
      );
      await fetchDestinations();
    },
    [fetchDestinations, withConflictRefresh],
  );

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
    updateDestination,
    syncSources,
    testCredentials,
    saveCredentials,
    deleteDestination,
    createGroup,
    assignGroup,
    reset,
  };
}
