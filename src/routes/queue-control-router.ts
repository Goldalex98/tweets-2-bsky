import { Router, type RequestHandler } from 'express';

export interface QueueScope {
  destinationId?: string;
  routeId?: string;
  sourceId?: string;
  requestId?: string;
  bskyIdentifier?: string;
  twitterId?: string;
}

interface QueueControlDependencies {
  authenticateToken: RequestHandler;
  requireAdmin: RequestHandler;
  scopeForPath(kind: string, id: string): QueueScope | null;
  canOperate(user: unknown, scope: QueueScope): boolean;
  inspect(scope: QueueScope): Array<{ status: string }>;
  retryFailed(scope?: QueueScope): number;
  clearFailed(scope?: QueueScope): number;
  cancelPending(scope: QueueScope): number;
}

export function createQueueControlRouter(dependencies: QueueControlDependencies): Router {
  const router = Router();
  const user = (request: unknown) => (request as { user?: unknown }).user;

  router.delete('/api/queue/items/:bskyIdentifier/:tweetId', dependencies.authenticateToken, (request, response) => {
    const scope = {
      bskyIdentifier: request.params.bskyIdentifier as string,
      twitterId: request.params.tweetId as string,
    };
    if (!dependencies.canOperate(user(request), scope)) {
      response.status(403).json({ error: 'You do not have permission to cancel this queue item.' });
      return;
    }
    const item = dependencies.inspect(scope)[0];
    if (!item) {
      response.status(404).json({ error: 'Queue item not found.' });
      return;
    }
    if (item.status === 'processing') {
      response.status(409).json({ error: 'Active queue items cannot be deleted without coordinated worker cancellation.' });
      return;
    }
    if (item.status !== 'pending') {
      response.status(409).json({ error: 'Only pending queue items can be cancelled.' });
      return;
    }
    response.json({ success: true, affected: dependencies.cancelPending(scope) });
  });

  router.get('/api/queue/scopes/:kind/:id', dependencies.authenticateToken, (request, response) => {
    const scope = dependencies.scopeForPath(request.params.kind as string, request.params.id as string);
    if (!scope) {
      response.status(400).json({ error: 'Queue scope must be destination, route, source, or request.' });
      return;
    }
    if (!dependencies.canOperate(user(request), scope)) {
      response.status(403).json({ error: 'You do not have permission to inspect this queue scope.' });
      return;
    }
    response.json({ items: dependencies.inspect(scope) });
  });

  router.post('/api/queue/scopes/:kind/:id/:action', dependencies.authenticateToken, (request, response) => {
    const action = request.params.action as string;
    if (!['retry-failed', 'clear-failed', 'cancel-pending'].includes(action)) {
      response.status(400).json({ error: 'Unknown queue action.' });
      return;
    }
    const scope = dependencies.scopeForPath(request.params.kind as string, request.params.id as string);
    if (!scope) {
      response.status(400).json({ error: 'Queue scope must be destination, route, source, or request.' });
      return;
    }
    if (!dependencies.canOperate(user(request), scope)) {
      response.status(403).json({ error: 'You do not have permission to operate on this queue scope.' });
      return;
    }
    if (action === 'cancel-pending' && request.body?.confirmation !== 'CLEAR_PENDING') {
      response.status(400).json({ error: 'Bulk pending cancellation requires confirmation CLEAR_PENDING.' });
      return;
    }
    const affected =
      action === 'retry-failed'
        ? dependencies.retryFailed(scope)
        : action === 'clear-failed'
          ? dependencies.clearFailed(scope)
          : dependencies.cancelPending(scope);
    response.json({ success: true, affected });
  });

  router.post('/api/queue/retry-failed', dependencies.authenticateToken, dependencies.requireAdmin, (_request, response) => {
    const retried = dependencies.retryFailed();
    response.json({ success: true, message: `${retried} failed tweet(s) requeued.` });
  });

  router.delete('/api/queue/failed', dependencies.authenticateToken, dependencies.requireAdmin, (_request, response) => {
    const cleared = dependencies.clearFailed();
    response.json({ success: true, message: `${cleared} failed tweet(s) removed from the queue.` });
  });

  return router;
}
