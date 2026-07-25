import { expect, test } from 'bun:test';
import { normalizeConfigV3 } from '../../src/config/normalize.js';
import {
  createPolicySnapshot,
  diffPolicySnapshots,
  serializePolicySnapshot,
} from '../../src/policy-snapshot.js';

test('policy snapshots are deterministic, non-secret, and diffable', () => {
  const config = normalizeConfigV3({
    schemaVersion: 4,
    twitter: { authToken: 'secret-cookie', ct0: 'secret-csrf' },
    sources: [{ id: 'source', username: 'source' }],
    destinations: [
      {
        id: 'destination',
        bskyIdentifier: 'destination.example',
        bskyPassword: 'secret-password',
        storageKey: 'did:plc:test',
      },
    ],
    routes: [{ id: 'route', sourceId: 'source', destinationId: 'destination' }],
    ai: { provider: 'gemini', apiKey: 'secret-ai-key', enabled: true },
  });
  const destination = config.destinations[0];
  const route = config.routes[0];
  if (!destination || !route) throw new Error('expected destination and route');
  const first = createPolicySnapshot({ destination, route, ai: config.ai, capturedAt: new Date(0) });
  const second = createPolicySnapshot({ destination, route, ai: config.ai, capturedAt: new Date(1) });
  expect(first.hash).toBe(second.hash);
  expect(serializePolicySnapshot(first)).not.toContain('secret');
  destination.postingPolicy.appendOriginalPostLink = true;
  const current = createPolicySnapshot({ destination, route, ai: config.ai });
  expect(diffPolicySnapshots(first, current)).toMatchObject({ changed: true, fields: ['posting'] });
});
