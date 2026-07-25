import { describe, expect, test } from 'bun:test';
import axios from 'axios';
import { isAnonymousSessionError } from '../../web/src/features/session/use-session-bootstrap.js';

describe('anonymous session probe errors', () => {
  test('401 AUTH_REQUIRED is treated as silent anonymous state', () => {
    const error = new axios.AxiosError('Request failed with status code 401');
    error.response = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as never,
      data: { error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } },
    };
    expect(isAnonymousSessionError(error)).toBe(true);
  });

  test('non-auth failures are not silent', () => {
    const error = new axios.AxiosError('Request failed with status code 500');
    error.response = {
      status: 500,
      statusText: 'Server Error',
      headers: {},
      config: {} as never,
      data: { error: { code: 'INTERNAL', message: 'Boom' } },
    };
    expect(isAnonymousSessionError(error)).toBe(false);
  });
});
