import { Router, type RequestHandler, type Response } from 'express';
import { parseIngestionScopes } from '../ingestion-security.js';

interface IngestionSource {
  id: string;
  type: 'x' | 'webhook' | 'api';
  username: string;
  name?: string;
}

interface CredentialView {
  id: string;
  hmacEnabled: boolean;
}

interface CredentialInput {
  name: string;
  sourceId: string;
  scopes: ReturnType<typeof parseIngestionScopes>;
  createdBy: string;
  includeHmac: boolean;
  expiresAt?: number;
}

export interface IngestionAdminRouterDependencies {
  authenticateToken: RequestHandler;
  requireAdmin: RequestHandler;
  credentialRateLimiter: RequestHandler;
  findSource(sourceId: string): IngestionSource | undefined;
  listCredentials(): CredentialView[];
  createCredential(input: CredentialInput): object;
  rotateCredential(id: string, userId: string): object;
  revokeCredential(id: string): boolean;
  listAudit(limit: number): unknown[];
  sendSafeError(response: Response, status: number, code: string, error: unknown): void;
}

export function createIngestionAdminRouter(dependencies: IngestionAdminRouterDependencies): Router {
  const router = Router();
  const admin = [dependencies.authenticateToken, dependencies.requireAdmin];

  router.get('/api/admin/ingestion-credentials', ...admin, (_request, response) => {
    response.json(dependencies.listCredentials());
  });

  router.post('/api/admin/ingestion-credentials', dependencies.credentialRateLimiter, ...admin, (request, response) => {
    try {
      const source = dependencies.findSource(request.body?.sourceId);
      if (!source || source.type === 'x') throw new Error('Credential source must be a webhook or api source.');
      const created = dependencies.createCredential({
        name: String(request.body?.name ?? '').trim() || `${source.name ?? source.username} credential`,
        sourceId: source.id,
        scopes: parseIngestionScopes(request.body?.scopes),
        createdBy: (request as typeof request & { user: { id: string } }).user.id,
        includeHmac: request.body?.includeHmac === true,
        expiresAt:
          typeof request.body?.expiresAt === 'string' && Number.isFinite(Date.parse(request.body.expiresAt))
            ? Date.parse(request.body.expiresAt)
            : undefined,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.status(201).json({ ...created, warning: 'Copy these secrets now. They cannot be retrieved again.' });
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'CREDENTIAL_CREATE_FAILED', error);
    }
  });

  router.post('/api/admin/ingestion-credentials/:id/rotate', dependencies.credentialRateLimiter, ...admin, (request, response) => {
    if (request.body?.confirmation !== `ROTATE ${request.params.id}`) {
      response.status(400).json({ error: 'Typed confirmation is required.' });
      return;
    }
    try {
      const userId = (request as typeof request & { user: { id: string } }).user.id;
      const rotated = dependencies.rotateCredential(request.params.id as string, userId);
      response.setHeader('Cache-Control', 'no-store');
      response.json({ ...rotated, warning: 'Copy these secrets now. They cannot be retrieved again.' });
    } catch (error) {
      dependencies.sendSafeError(response, 404, 'CREDENTIAL_ROTATE_FAILED', error);
    }
  });

  router.delete('/api/admin/ingestion-credentials/:id', ...admin, (request, response) => {
    if (request.body?.confirmation !== `REVOKE ${request.params.id}`) {
      response.status(400).json({ error: 'Typed confirmation is required.' });
      return;
    }
    response.json({ revoked: dependencies.revokeCredential(request.params.id as string) });
  });

  router.get('/api/admin/ingestion-credentials/:id/sample', ...admin, (request, response) => {
    const credential = dependencies.listCredentials().find((entry) => entry.id === request.params.id);
    if (!credential) {
      response.status(404).json({ error: 'Credential not found.' });
      return;
    }
    response.json({
      endpoint: '/api/ingest/v1/posts',
      headers: {
        Authorization: 'Bearer <secret-shown-at-creation>',
        'Idempotency-Key': '<unique-id>',
        ...(credential.hmacEnabled
          ? {
              'X-T2B-Timestamp': '<unix-seconds>',
              'X-T2B-Nonce': '<random-16+-character-value>',
              'X-T2B-Signature': 'sha256=<hmac(timestamp.nonce.raw-body)>',
            }
          : {}),
      },
      guidance:
        'Expose this endpoint only through HTTPS. Configure TRUST_PROXY only when the reverse proxy overwrites forwarding headers.',
    });
  });

  router.get('/api/admin/ingestion-audit', ...admin, (request, response) => {
    response.json(dependencies.listAudit(Number(request.query.limit) || 100));
  });

  return router;
}
