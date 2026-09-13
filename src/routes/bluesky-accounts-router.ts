import { Router, type RequestHandler, type Response } from 'express';
import type { AppConfig, BlueskyAccount } from '../config/schemas.js';
import type { ConfigVersion } from '../config-manager.js';

export interface BlueskyAccountView {
  id: string;
  label?: string;
  serviceUrl: string;
  loginIdentifier: string;
  did?: string;
  canonicalHandle?: string;
  createdAt: string;
  updatedAt: string;
  credentialConfigured: boolean;
  linkedDestinationId: string | null;
  health: {
    lastValidatedAt?: number;
    lastSuccessAt?: number;
    lastFailureAt?: number;
    lastErrorCategory?: string;
    consecutiveFailures: number;
    blockedReason?: 'AccountTakedown' | 'AccountDeactivated';
    blockedAt?: number;
    runtimeRevision: number;
  } | null;
  revision: number;
  updatedAtConfig: string;
}

export interface BlueskyAccountsRouterDependencies {
  authenticateToken: RequestHandler;
  requireManageMappings: RequestHandler;
  validationRateLimiter: RequestHandler;
  getConfig(): AppConfig;
  getConfigVersion(config: AppConfig): ConfigVersion;
  saveCanonicalConfig(config: AppConfig): void;
  rejectStaleConfigMutation(config: AppConfig, body: unknown, response: Response): boolean;
  listAccounts(requester: { id: string; isAdmin: boolean }): BlueskyAccountView[];
  canMutateAccount(requester: { id: string; isAdmin: boolean }, accountId: string): boolean;
  createAccount(
    config: AppConfig,
    input: {
      loginIdentifier: string;
      appPassword: string;
      serviceUrl?: string;
      label?: string;
      requesterId: string;
    },
  ): Promise<BlueskyAccountView>;
  validateAccount(config: AppConfig, accountId: string): Promise<BlueskyAccountView>;
  resumeAccount(
    config: AppConfig,
    accountId: string,
    runtimeRevision: number,
    assertCurrent: () => void,
  ): Promise<BlueskyAccountView>;
  isRestoreRestartRequired(): boolean;
  rotateCredentials(
    config: AppConfig,
    input: {
      accountId: string;
      appPassword: string;
      loginIdentifier?: string;
      serviceUrl?: string;
    },
  ): Promise<BlueskyAccountView>;
  deleteAccount(config: AppConfig, accountId: string): void;
  sendSafeError(response: Response, status: number, code: string, error: unknown): void;
}

export function createBlueskyAccountsRouter(dependencies: BlueskyAccountsRouterDependencies): Router {
  const router = Router();
  const auth = [dependencies.authenticateToken, dependencies.requireManageMappings];

  const requireAccountMutation = (
    request: { user?: { id: string; isAdmin: boolean }; params: { id?: string } },
    response: Response,
  ): boolean => {
    const user = request.user;
    const accountId = String(request.params.id ?? '');
    if (!user || !dependencies.canMutateAccount(user, accountId)) {
      response.status(403).json({ error: 'You do not have permission to modify this Bluesky account.' });
      return false;
    }
    return true;
  };

  router.get('/api/bluesky-accounts', ...auth, (request, response) => {
    const user = (request as typeof request & { user: { id: string; isAdmin: boolean } }).user;
    response.json(dependencies.listAccounts(user));
  });

  router.post('/api/bluesky-accounts', dependencies.validationRateLimiter, ...auth, async (request, response) => {
    try {
      const config = dependencies.getConfig();
      if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
      const user = (request as typeof request & { user: { id: string } }).user;
      const loginIdentifier = String(request.body?.loginIdentifier ?? request.body?.bskyIdentifier ?? '').trim();
      const appPassword =
        typeof request.body?.appPassword === 'string'
          ? request.body.appPassword
          : typeof request.body?.bskyPassword === 'string'
            ? request.body.bskyPassword
            : '';
      if (!loginIdentifier || !appPassword) {
        response.status(400).json({ error: 'Bluesky login identifier and app password are required.' });
        return;
      }
      const created = await dependencies.createAccount(config, {
        loginIdentifier,
        appPassword,
        serviceUrl: typeof request.body?.serviceUrl === 'string' ? request.body.serviceUrl : undefined,
        label: typeof request.body?.label === 'string' ? request.body.label : undefined,
        requesterId: user.id,
      });
      response.status(201).json(created);
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'BSKY_ACCOUNT_CREATE_FAILED', error);
    }
  });

  router.post(
    '/api/bluesky-accounts/:id/validate',
    dependencies.validationRateLimiter,
    ...auth,
    async (request, response) => {
      try {
        if (!requireAccountMutation(request as never, response)) return;
        const config = dependencies.getConfig();
        if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
        const validated = await dependencies.validateAccount(config, String(request.params.id));
        response.json({ success: true, account: validated, profileChanged: false });
      } catch (error) {
        dependencies.sendSafeError(response, 400, 'BSKY_ACCOUNT_VALIDATE_FAILED', error);
      }
    },
  );

  router.post(
    '/api/bluesky-accounts/:id/resume',
    dependencies.validationRateLimiter,
    ...auth,
    async (request, response) => {
      try {
        if (!requireAccountMutation(request as never, response)) return;
        const config = dependencies.getConfig();
        if (!Number.isInteger(request.body?.revision)) {
          response.status(428).json({ code: 'CONFIG_REVISION_REQUIRED', error: 'Configuration revision is required.' });
          return;
        }
        if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
        const runtimeRevision = request.body?.runtimeRevision;
        if (!Number.isInteger(runtimeRevision) || runtimeRevision < 0) {
          response.status(400).json({ error: 'runtimeRevision is required.' });
          return;
        }
        const version = dependencies.getConfigVersion(config).revision;
        const user = (request as typeof request & { user: { id: string; isAdmin: boolean } }).user;
        const accountId = String(request.params.id);
        const assertCurrent = () => {
          const fail = (status: number, code: string) => {
            throw Object.assign(new Error(code), { status, code });
          };
          if (dependencies.isRestoreRestartRequired()) fail(503, 'RESTORE_RESTART_REQUIRED');
          if (!dependencies.canMutateAccount(user, accountId)) fail(403, 'FORBIDDEN');
          if (dependencies.getConfigVersion(dependencies.getConfig()).revision !== version)
            fail(409, 'CONFIG_REVISION_CONFLICT');
        };
        assertCurrent();
        const account = await dependencies.resumeAccount(config, accountId, runtimeRevision, assertCurrent);
        response.json({ success: true, account, profileChanged: false });
      } catch (error) {
        const problem = error as { status?: number; code?: string };
        const code = problem.code ?? 'BSKY_ACCOUNT_RESUME_FAILED';
        if (code === 'BSKY_ACCOUNT_RUNTIME_CONFLICT' || code === 'CONFIG_REVISION_CONFLICT') {
          response
            .status(409)
            .json({
              code,
              error: 'Account state changed. Refresh before resuming.',
              current: dependencies.getConfigVersion(dependencies.getConfig()),
            });
          return;
        }
        dependencies.sendSafeError(
          response,
          code === 'BSKY_ACCOUNT_RUNTIME_CONFLICT' ? 409 : (problem.status ?? 400),
          code,
          error,
        );
      }
    },
  );

  router.patch(
    '/api/bluesky-accounts/:id/credentials',
    dependencies.validationRateLimiter,
    ...auth,
    async (request, response) => {
      try {
        if (!requireAccountMutation(request as never, response)) return;
        const config = dependencies.getConfig();
        if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
        const appPassword =
          typeof request.body?.appPassword === 'string'
            ? request.body.appPassword
            : typeof request.body?.bskyPassword === 'string'
              ? request.body.bskyPassword
              : '';
        if (!appPassword) {
          response.status(400).json({ error: 'A new app password is required.' });
          return;
        }
        const updated = await dependencies.rotateCredentials(config, {
          accountId: String(request.params.id),
          appPassword,
          loginIdentifier:
            typeof request.body?.loginIdentifier === 'string'
              ? request.body.loginIdentifier
              : typeof request.body?.bskyIdentifier === 'string'
                ? request.body.bskyIdentifier
                : undefined,
          serviceUrl: typeof request.body?.serviceUrl === 'string' ? request.body.serviceUrl : undefined,
        });
        response.json({ success: true, account: updated, profileChanged: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes('linked') || message.includes('DID') ? 409 : 400;
        dependencies.sendSafeError(response, status, 'BSKY_ACCOUNT_ROTATE_FAILED', error);
      }
    },
  );

  router.delete('/api/bluesky-accounts/:id', ...auth, (request, response) => {
    try {
      if (!requireAccountMutation(request as never, response)) return;
      const config = dependencies.getConfig();
      if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
      dependencies.deleteAccount(config, String(request.params.id));
      response.json({ success: true, ...dependencies.getConfigVersion(dependencies.getConfig()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('linked') ? 409 : 400;
      dependencies.sendSafeError(response, status, 'BSKY_ACCOUNT_DELETE_FAILED', error);
    }
  });

  return router;
}

export type { BlueskyAccount };
