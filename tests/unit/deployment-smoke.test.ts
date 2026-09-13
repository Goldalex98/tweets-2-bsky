import { describe, expect, test } from 'bun:test';
import {
  deploymentCookie,
  deploymentOrigin,
  identityFingerprint,
  queueCounts,
} from '../../scripts/deployment-smoke.js';

describe('deployment smoke safety and continuity', () => {
  const origin = new URL('https://app.example.test');
  const cookie = {
    name: 't2b_session',
    value: 'redacted-placeholder',
    domain: 'app.example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    expires: -1,
  };

  test('requires an explicit HTTPS origin without embedded credentials or parameters', () => {
    expect(deploymentOrigin(origin.href).origin).toBe(origin.origin);
    for (const invalid of [
      'http://app.example.test',
      'https://user:password@app.example.test',
      'https://app.example.test/path',
      'https://app.example.test?token=redacted',
      'https://app.example.test#token',
    ]) {
      expect(() => deploymentOrigin(invalid)).toThrow();
    }
  });

  test('uses only a matching unexpired secure HttpOnly session and rejects ambiguous cookies', () => {
    expect(deploymentCookie({ cookies: [cookie] }, origin)).toBe('t2b_session=redacted-placeholder');
    expect(deploymentCookie({ cookies: [{ ...cookie, domain: '.example.test' }] }, origin)).toContain(
      'redacted-placeholder',
    );
    for (const replacement of [
      { domain: 'evilapp.example.test' },
      { domain: 'example.test' },
      { secure: false },
      { httpOnly: false },
      { expires: 1 },
      { path: '/other' },
      { value: 'bad; extra=credential' },
    ]) {
      expect(() => deploymentCookie({ cookies: [{ ...cookie, ...replacement }] }, origin)).toThrow();
    }
    expect(() => deploymentCookie({ cookies: [cookie, cookie] }, origin)).toThrow();
  });

  test('fingerprints identity, enabled state, storage keys and route state, excluding credentials and transient health', () => {
    const destinations = [
      {
        id: 'd1',
        bskyAccountId: 'a1',
        storageKey: 'stable-d1',
        enabled: true,
        sources: [{ routeId: 'r1', username: 'fixture', state: 'enabled' }],
      },
    ];
    const accounts = [
      { id: 'a1', linkedDestinationId: 'd1', loginIdentifier: 'fixture.test', serviceUrl: 'https://bsky.social' },
    ];
    const baseline = identityFingerprint(destinations, accounts);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(
      identityFingerprint(
        destinations,
        accounts.map((account) => ({
          ...account,
          health: { consecutiveFailures: 1 },
          appPassword: 'redacted-placeholder',
        })),
      ),
    ).toBe(baseline);
    for (const replacement of [{ storageKey: 'changed' }, { enabled: false }, { sources: [] }]) {
      expect(
        identityFingerprint(
          destinations.map((destination) => ({ ...destination, ...replacement })),
          accounts,
        ),
      ).not.toBe(baseline);
    }
    expect(() => identityFingerprint(destinations, [])).toThrow();
    expect(() => identityFingerprint([...destinations, { ...destinations[0], id: 'd2' }], accounts)).toThrow();
    expect(() => identityFingerprint(destinations, [{ ...accounts[0], linkedDestinationId: 'd2' }])).toThrow();
  });

  test('captures numeric queue counters without copying payloads and rejects malformed results', () => {
    expect(queueCounts({ pending: 2, processing: 1, failed: 0, privatePayload: 'redacted-placeholder' })).toEqual({
      pending: 2,
      processing: 1,
      failed: 0,
    });
    for (const invalid of [
      null,
      {},
      { pending: -1, processing: 0, failed: 0 },
      { pending: 0, processing: 0, failed: '0' },
    ]) {
      expect(() => queueCounts(invalid)).toThrow();
    }
  });
});
