import { describe, expect, test } from 'bun:test';
import axios from 'axios';
import { getApiErrorMessage } from '../../web/src/api/client.js';

describe('getApiErrorMessage', () => {
  test('unwraps object-shaped API error messages', () => {
    const error = new axios.AxiosError('Request failed with status code 401');
    error.response = {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: {} as never,
      data: { error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } },
    };
    expect(getApiErrorMessage(error, 'fallback')).toBe('Authentication required.');
  });

  test('keeps string error bodies', () => {
    const error = new axios.AxiosError('Request failed with status code 400');
    error.response = {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: {} as never,
      data: { error: 'Plain failure.' },
    };
    expect(getApiErrorMessage(error, 'fallback')).toBe('Plain failure.');
  });
});
