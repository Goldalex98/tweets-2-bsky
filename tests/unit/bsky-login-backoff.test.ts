import { describe, expect, test } from 'bun:test';
import { LOGIN_BACKOFF_BASE_MS, LOGIN_BACKOFF_MAX_MS, LoginBackoff } from '../../src/bsky-login-backoff.js';

describe('Bluesky login backoff', () => {
  test('doubles after each failure up to the cap and resets on success', () => {
    const backoff = new LoginBackoff();
    expect(backoff.remainingMs('a#1', 0)).toBe(0);
    expect(backoff.noteFailure('a#1', 0)).toBe(LOGIN_BACKOFF_BASE_MS);
    expect(backoff.remainingMs('a#1', 1_000)).toBe(LOGIN_BACKOFF_BASE_MS - 1_000);
    expect(backoff.noteFailure('a#1', 0)).toBe(LOGIN_BACKOFF_BASE_MS * 2);
    for (let index = 0; index < 10; index += 1) backoff.noteFailure('a#1', 0);
    expect(backoff.remainingMs('a#1', 0)).toBe(LOGIN_BACKOFF_MAX_MS);
    backoff.noteSuccess('a#1');
    expect(backoff.remainingMs('a#1', 0)).toBe(0);
  });

  test('keys are independent and a prefix clear drops every credential for an identity', () => {
    const backoff = new LoginBackoff();
    backoff.noteFailure('a#old', 0);
    backoff.noteFailure('b#1', 0);
    expect(backoff.remainingMs('a#new', 0)).toBe(0);
    backoff.clearPrefix('a#');
    expect(backoff.remainingMs('a#old', 0)).toBe(0);
    expect(backoff.remainingMs('b#1', 0)).toBe(LOGIN_BACKOFF_BASE_MS);
  });
});
