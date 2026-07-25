import { useCallback, useState } from 'react';
import api, { getApiErrorMessage } from '../../api/client';
import type { AuthView, BootstrapStatus } from '../../api/types';
import type { AuthUser } from '../settings/types';
import { normalizePermissions } from '../settings/utils';

export function useSessionBootstrap() {
  const [token, setToken] = useState<string | null>('cookie-session');
  const [authView, setAuthView] = useState<AuthView>('login');
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchBootstrapStatus = useCallback(async () => {
    try {
      const response = await api.get<BootstrapStatus>('/api/auth/bootstrap-status');
      setBootstrapOpen(Boolean(response.data?.bootstrapOpen));
    } catch {
      setBootstrapOpen(false);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const response = await api.get<AuthUser>('/api/me');
      setUser({ ...response.data, permissions: normalizePermissions(response.data.permissions) });
      setToken('cookie-session');
      setError('');
      return response.data;
    } catch (requestError) {
      setToken(null);
      setUser(null);
      setError(getApiErrorMessage(requestError, 'Your session has expired.'));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    setLoading(true);
    try {
      await api.post('/api/login', { identifier, password });
      await refreshUser();
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Login failed.'));
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, [refreshUser]);

  const register = useCallback(async (username: string, email: string, password: string) => {
    setLoading(true);
    try {
      await api.post('/api/register', { username, email, password });
      await refreshUser();
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Registration failed.'));
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, [refreshUser]);

  const logout = useCallback(async () => {
    await api.post('/api/logout').catch(() => undefined);
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setAuthView('login');
  }, []);

  return {
    token,
    setToken,
    authView,
    setAuthView,
    bootstrapOpen,
    setBootstrapOpen,
    user,
    setUser,
    loading,
    error,
    setError,
    fetchBootstrapStatus,
    refreshUser,
    login,
    register,
    logout,
  };
}
