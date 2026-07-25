import axios from 'axios';
import type { ConfigConflictPayload, ConfigVersion } from './types';

export type { ConfigConflictPayload, ConfigVersion } from './types';

axios.defaults.withCredentials = true;
axios.interceptors.request.use((config) => {
  const method = String(config.method || 'get').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfCookie = document.cookie
      .split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('t2b_csrf='));
    if (csrfCookie) {
      config.headers.set('X-CSRF-Token', decodeURIComponent(csrfCookie.slice('t2b_csrf='.length)));
    }
  }
  return config;
});

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const serverMessage = error.response?.data?.error;
    if (typeof serverMessage === 'string' && serverMessage.length > 0) {
      const guidance = error.response?.data?.guidance;
      return typeof guidance === 'string' && guidance.length > 0 ? `${serverMessage} ${guidance}` : serverMessage;
    }
    if (typeof error.message === 'string' && error.message.length > 0) return error.message;
  }
  return fallback;
}

export function isConfigConflict(error: unknown): error is { response: { data: ConfigConflictPayload } } {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 409 &&
    error.response.data?.code === 'CONFIG_REVISION_CONFLICT'
  );
}

export function withConfigVersion<T extends object>(payload: T, version: ConfigVersion): T & ConfigVersion {
  return { ...payload, revision: version.revision, updatedAt: version.updatedAt };
}

export default axios;
