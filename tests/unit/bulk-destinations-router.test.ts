import { afterAll, describe, expect, test } from 'bun:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { createBulkDestinationsRouter } from '../../src/routes/bulk-destinations-router.js';
import type { AppConfig } from '../../src/config/schemas.js';

async function withServer(
  overrides: {
    canManage?: boolean;
    destinations?: Array<{ id: string; enabled: boolean; groupName?: string; groupEmoji?: string }>;
  },
  run: (baseUrl: string, helpers: { getConfig(): AppConfig; queued: string[] }) => Promise<void>,
) {
  let config = {
    revision: 1,
    updatedAt: new Date().toISOString(),
    destinations: overrides.destinations ?? [
      { id: 'd1', enabled: true, groupName: 'A', groupEmoji: '📁' },
      { id: 'd2', enabled: true, groupName: 'A', groupEmoji: '📁' },
    ],
  } as unknown as AppConfig;
  const queued: string[] = [];
  type TestAuthedRequest = Request & { user: { id: string; isAdmin: boolean } };
  const app = express();
  app.use(express.json());
  app.use((req: TestAuthedRequest, _res: Response, next: NextFunction) => {
    req.user = { id: 'u1', isAdmin: true };
    next();
  });
  app.use(
    createBulkDestinationsRouter({
      authenticateToken: (_req, _res, next) => next(),
      getConfig: () => config,
      getConfigVersion: (value) => ({ revision: value.revision, updatedAt: value.updatedAt }),
      saveCanonicalConfig: (value) => {
        config = value;
      },
      rejectStaleConfigMutation: () => false,
      canManageDestination: () => overrides.canManage !== false,
      queueBackfill: (ids) => {
        queued.push(...ids);
        return { queued: ids.length, skipped: 0 };
      },
      sendSafeError: (response, status, code, error) => {
        response.status(status).json({ code, error: String(error) });
      },
    }),
  );

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`, {
      getConfig: () => config,
      queued,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('bulk destinations router', () => {
  test('pauses selected destinations atomically', async () => {
    await withServer({}, async (baseUrl, { getConfig }) => {
      const response = await fetch(`${baseUrl}/api/destinations/bulk/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destinationIds: ['d1', 'd2'],
          state: 'paused',
          revision: 1,
          updatedAt: getConfig().updatedAt,
        }),
      });
      expect(response.status).toBe(200);
      expect(getConfig().destinations.every((entry) => entry.enabled === false)).toBe(true);
    });
  });

  test('rejects unauthorized bulk updates before mutating', async () => {
    await withServer({ canManage: false }, async (baseUrl, { getConfig }) => {
      const before = getConfig().destinations.map((entry) => entry.enabled);
      const response = await fetch(`${baseUrl}/api/destinations/bulk/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destinationIds: ['d1'],
          state: 'paused',
          revision: 1,
          updatedAt: getConfig().updatedAt,
        }),
      });
      expect(response.status).toBe(403);
      expect(getConfig().destinations.map((entry) => entry.enabled)).toEqual(before);
    });
  });

  test('rejects missing destinations for bulk folder before saving', async () => {
    await withServer({}, async (baseUrl, { getConfig }) => {
      const beforeRevision = getConfig().revision;
      const beforeGroups = getConfig().destinations.map((entry) => entry.groupName);
      const response = await fetch(`${baseUrl}/api/destinations/bulk/folder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destinationIds: ['d1', 'missing'],
          groupName: 'Moved',
          revision: 1,
          updatedAt: getConfig().updatedAt,
        }),
      });
      expect(response.status).toBe(404);
      expect(getConfig().revision).toBe(beforeRevision);
      expect(getConfig().destinations.map((entry) => entry.groupName)).toEqual(beforeGroups);
    });
  });

  test('requires typed confirmation for bulk backfill', async () => {
    await withServer({}, async (baseUrl, { queued }) => {
      const bad = await fetch(`${baseUrl}/api/destinations/bulk/backfill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationIds: ['d1', 'd2'], confirmation: 'BACKFILL 1' }),
      });
      expect(bad.status).toBe(400);
      expect(queued).toEqual([]);
      const ok = await fetch(`${baseUrl}/api/destinations/bulk/backfill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationIds: ['d1', 'd2'], confirmation: 'BACKFILL 2' }),
      });
      expect(ok.status).toBe(200);
      expect(queued).toEqual(['d1', 'd2']);
    });
  });
});

afterAll(() => {
  // no-op: servers are closed per test
});
