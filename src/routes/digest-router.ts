import { Router, type RequestHandler } from 'express';

interface DigestRoute {
  id: string;
  destinationId: string;
  delivery?: {
    mode: 'immediate' | 'digest';
    digest: {
      maxEntries: number;
    };
  };
}

export interface DigestRouterDependencies {
  authenticateToken: RequestHandler;
  requireAdmin: RequestHandler;
  listJobs(): unknown[];
  listEntries(query: { routeId?: string; status?: string; limit: number }): unknown[];
  findRoute(routeId: string): DigestRoute | undefined;
  buildPreview(entries: unknown[], policy: object): unknown;
  arm(destinationId: string, routeId: string, nextRunAt: number): unknown;
  retry(jobId: string): boolean;
  cancel(jobId: string): boolean;
}

export function createDigestRouter(dependencies: DigestRouterDependencies): Router {
  const router = Router();
  const admin = [dependencies.authenticateToken, dependencies.requireAdmin];

  router.get('/api/admin/digests', ...admin, (_request, response) => {
    response.json({ jobs: dependencies.listJobs(), entries: dependencies.listEntries({ limit: 500 }) });
  });

  router.post('/api/admin/digests/:routeId/preview', ...admin, (request, response) => {
    const route = dependencies.findRoute(request.params.routeId as string);
    if (!route?.delivery || route.delivery.mode !== 'digest') {
      response.status(404).json({ error: 'Digest route not found.' });
      return;
    }
    response.json(
      dependencies.buildPreview(
        dependencies.listEntries({ routeId: route.id, status: 'pending', limit: route.delivery.digest.maxEntries }),
        route.delivery.digest,
      ),
    );
  });

  router.post('/api/admin/digests/:routeId/publish', ...admin, (request, response) => {
    const route = dependencies.findRoute(request.params.routeId as string);
    if (!route?.delivery || route.delivery.mode !== 'digest') {
      response.status(404).json({ error: 'Digest route not found.' });
      return;
    }
    response.json(dependencies.arm(route.destinationId, route.id, Date.now()));
  });

  router.post('/api/admin/digest-jobs/:id/retry', ...admin, (request, response) => {
    response.json({ retried: dependencies.retry(request.params.id as string) });
  });

  router.delete('/api/admin/digest-jobs/:id', ...admin, (request, response) => {
    if (request.body?.confirmation !== `CANCEL ${request.params.id}`) {
      response.status(400).json({ error: 'Typed confirmation is required.' });
      return;
    }
    response.json({ cancelled: dependencies.cancel(request.params.id as string) });
  });

  return router;
}
