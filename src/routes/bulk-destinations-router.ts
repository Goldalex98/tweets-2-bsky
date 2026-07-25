import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { AppConfig } from '../config/schemas.js';
import type { ConfigVersion } from '../config-manager.js';

type AuthenticatedRequest = Request & {
  user: { id: string; isAdmin: boolean; permissions?: { queueBackfills?: boolean } };
};

export interface BulkDestinationsRouterDependencies {
  authenticateToken: RequestHandler;
  backfillRateLimiter?: RequestHandler;
  getConfig(): AppConfig;
  getConfigVersion(config: AppConfig): ConfigVersion;
  saveCanonicalConfig(config: AppConfig): void;
  rejectStaleConfigMutation(config: AppConfig, body: unknown, response: Response): boolean;
  canManageDestination(user: { id: string; isAdmin: boolean }, destinationId: string): boolean;
  canQueueBackfills(user: { id: string; isAdmin: boolean; permissions?: { queueBackfills?: boolean } }): boolean;
  queueBackfill(destinationIds: string[]): { queued: number; skipped: number };
  sendSafeError(response: Response, status: number, code: string, error: unknown): void;
}

const MAX_BULK = 50;

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))];
}

function authedUser(request: Request): AuthenticatedRequest['user'] {
  return (request as AuthenticatedRequest).user;
}

export function createBulkDestinationsRouter(dependencies: BulkDestinationsRouterDependencies): Router {
  const router = Router();

  router.post('/api/destinations/bulk/state', dependencies.authenticateToken, (request, response) => {
    try {
      const config = dependencies.getConfig();
      if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
      const ids = parseIds(request.body?.destinationIds);
      const state = request.body?.state === 'paused' ? 'paused' : request.body?.state === 'enabled' ? 'enabled' : null;
      if (!state || ids.length === 0) {
        response.status(400).json({ error: 'destinationIds and state (enabled|paused) are required.' });
        return;
      }
      if (ids.length > MAX_BULK) {
        response.status(400).json({ error: `Bulk updates are limited to ${MAX_BULK} destinations.` });
        return;
      }
      for (const id of ids) {
        if (!dependencies.canManageDestination(authedUser(request), id)) {
          response.status(403).json({ error: `You cannot manage destination ${id}.` });
          return;
        }
        const destination = config.destinations.find((entry) => entry.id === id);
        if (!destination) {
          response.status(404).json({ error: `Destination ${id} was not found.` });
          return;
        }
      }
      for (const id of ids) {
        const destination = config.destinations.find((entry) => entry.id === id);
        if (destination) destination.enabled = state === 'enabled';
      }
      dependencies.saveCanonicalConfig(config);
      response.json({ success: true, updated: ids.length, ...dependencies.getConfigVersion(config) });
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'BULK_STATE_FAILED', error);
    }
  });

  router.post('/api/destinations/bulk/folder', dependencies.authenticateToken, (request, response) => {
    try {
      const config = dependencies.getConfig();
      if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
      const ids = parseIds(request.body?.destinationIds);
      const groupName = typeof request.body?.groupName === 'string' ? request.body.groupName.trim() : '';
      const groupEmoji = typeof request.body?.groupEmoji === 'string' ? request.body.groupEmoji.trim() : '📁';
      if (!groupName || ids.length === 0) {
        response.status(400).json({ error: 'destinationIds and groupName are required.' });
        return;
      }
      if (ids.length > MAX_BULK) {
        response.status(400).json({ error: `Bulk updates are limited to ${MAX_BULK} destinations.` });
        return;
      }
      for (const id of ids) {
        if (!dependencies.canManageDestination(authedUser(request), id)) {
          response.status(403).json({ error: `You cannot manage destination ${id}.` });
          return;
        }
        const destination = config.destinations.find((entry) => entry.id === id);
        if (!destination) {
          response.status(404).json({ error: `Destination ${id} was not found.` });
          return;
        }
      }
      for (const id of ids) {
        const destination = config.destinations.find((entry) => entry.id === id);
        if (destination) {
          destination.groupName = groupName;
          destination.groupEmoji = groupEmoji || '📁';
        }
      }
      dependencies.saveCanonicalConfig(config);
      response.json({ success: true, updated: ids.length, ...dependencies.getConfigVersion(config) });
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'BULK_FOLDER_FAILED', error);
    }
  });

  router.post(
    '/api/destinations/bulk/backfill',
    ...(dependencies.backfillRateLimiter ? [dependencies.backfillRateLimiter] : []),
    dependencies.authenticateToken,
    (request, response) => {
    try {
      const user = authedUser(request);
      if (!dependencies.canQueueBackfills(user)) {
        response.status(403).json({ error: 'You do not have permission to queue backfills.' });
        return;
      }
      const ids = parseIds(request.body?.destinationIds);
      if (ids.length === 0) {
        response.status(400).json({ error: 'destinationIds are required.' });
        return;
      }
      if (ids.length > MAX_BULK) {
        response.status(400).json({ error: `Bulk backfills are limited to ${MAX_BULK} destinations.` });
        return;
      }
      if (request.body?.confirmation !== `BACKFILL ${ids.length}`) {
        response.status(400).json({ error: `Typed confirmation BACKFILL ${ids.length} is required.` });
        return;
      }
      const config = dependencies.getConfig();
      for (const id of ids) {
        if (!config.destinations.some((entry) => entry.id === id)) {
          response.status(404).json({ error: `Destination ${id} was not found.` });
          return;
        }
        if (!dependencies.canManageDestination(user, id)) {
          response.status(403).json({ error: `You cannot manage destination ${id}.` });
          return;
        }
      }
      const result = dependencies.queueBackfill(ids);
      response.json({ success: true, ...result });
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'BULK_BACKFILL_FAILED', error);
    }
  });

  return router;
}
