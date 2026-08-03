import { useCallback, useEffect, useState } from 'react';
import api, { type ConfigVersion, isConfigConflict, withConfigVersion } from '../../api/client';
import type { DefaultInitialImportMode } from '../destinations/types';

export interface SourceDefaultsSettings extends ConfigVersion {
  defaultInitialImportMode: DefaultInitialImportMode;
}

interface UseSourceDefaultsOptions {
  authenticated: boolean;
  onError(error: unknown, fallback: string): void;
}

export function useSourceDefaults({ authenticated, onError }: UseSourceDefaultsOptions) {
  const [value, setValue] = useState<SourceDefaultsSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!authenticated) return null;
    try {
      const response = await api.get<SourceDefaultsSettings>('/api/settings/source-defaults');
      setValue(response.data);
      return response.data;
    } catch (error) {
      onError(error, 'Failed to load X source defaults.');
      return null;
    }
  }, [authenticated, onError]);

  useEffect(() => {
    if (!authenticated) {
      setValue(null);
      return;
    }
    void refresh();
  }, [authenticated, refresh]);

  const save = useCallback(async () => {
    if (!value) return null;
    setSaving(true);
    try {
      const response = await api.patch<SourceDefaultsSettings>(
        '/api/settings/source-defaults',
        withConfigVersion({ defaultInitialImportMode: value.defaultInitialImportMode }, value),
      );
      setValue(response.data);
      return response.data;
    } catch (error) {
      if (isConfigConflict(error)) await refresh();
      throw error;
    } finally {
      setSaving(false);
    }
  }, [refresh, value]);

  return {
    value,
    setValue,
    saving,
    refresh,
    save,
    effectiveDefault: value?.defaultInitialImportMode ?? ('new-only' as const),
  };
}
