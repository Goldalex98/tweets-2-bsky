import { Router, type Request, type RequestHandler, type Response } from 'express';

type BackupMode = 'redacted' | 'full';

export interface BackupRouterDependencies {
  authenticateToken: RequestHandler;
  requireAdmin: RequestHandler;
  importRestoreRateLimiter: RequestHandler;
  requireJsonObject: RequestHandler;
  getBackupStorageStatus(): unknown;
  createBackupBundle(mode: BackupMode): Buffer;
  validateBackupBundle(bundle: Buffer): { report: unknown };
  applyRestoreBundle(bundle: Buffer, options: { confirmation: string }): object;
  verifyCurrentAdminPassword(request: unknown): Promise<boolean>;
  /** Rejects a restore that does not name the configuration revision it replaces. */
  rejectMissingOrStaleRevision(request: Request, response: Response): boolean;
  /** Translates a persistence-layer compare-and-swap failure into HTTP 409. */
  handleConfigConflict(error: unknown, response: Response): boolean;
  sendSafeError(response: Response, status: number, code: string, error: unknown): void;
}

export function createBackupRouter(dependencies: BackupRouterDependencies): Router {
  const router = Router();
  const protectedMutation = [
    dependencies.importRestoreRateLimiter,
    dependencies.authenticateToken,
    dependencies.requireAdmin,
    dependencies.requireJsonObject,
  ];

  router.get('/status', dependencies.authenticateToken, dependencies.requireAdmin, (_request, response) => {
    response.json(dependencies.getBackupStorageStatus());
  });

  router.post('/create', ...protectedMutation, async (request, response) => {
    const mode = request.body?.mode ?? 'redacted';
    if (mode !== 'redacted' && mode !== 'full') {
      dependencies.sendSafeError(response, 400, 'INVALID_BACKUP_MODE', 'Backup mode must be redacted or full.');
      return;
    }
    if (mode === 'full') {
      if (request.body?.confirmation !== 'BACKUP_WITH_SECRETS') {
        dependencies.sendSafeError(
          response,
          403,
          'CONFIRMATION_REQUIRED',
          'Type BACKUP_WITH_SECRETS to create a full backup.',
        );
        return;
      }
      if (!(await dependencies.verifyCurrentAdminPassword(request))) {
        dependencies.sendSafeError(
          response,
          401,
          'REAUTHENTICATION_FAILED',
          'Current admin password verification failed.',
        );
        return;
      }
    }
    try {
      const bundle = dependencies.createBackupBundle(mode);
      response.setHeader('Content-Type', 'application/vnd.tweets-2-bsky.backup+json');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename=tweets-2-bsky-${mode}-${new Date().toISOString().replaceAll(':', '-')}.t2b-backup`,
      );
      response.send(bundle);
    } catch (error) {
      dependencies.sendSafeError(response, 500, 'BACKUP_FAILED', error);
    }
  });

  router.post('/restore/validate', ...protectedMutation, (request, response) => {
    try {
      if (typeof request.body?.bundle !== 'string') throw new Error('A base64 backup bundle is required.');
      const validated = dependencies.validateBackupBundle(Buffer.from(request.body.bundle, 'base64'));
      response.json(validated.report);
    } catch (error) {
      dependencies.sendSafeError(response, 400, 'INVALID_BACKUP', error);
    }
  });

  router.post('/restore/apply', ...protectedMutation, async (request, response) => {
    if (!(await dependencies.verifyCurrentAdminPassword(request))) {
      dependencies.sendSafeError(
        response,
        401,
        'REAUTHENTICATION_FAILED',
        'Current admin password verification failed.',
      );
      return;
    }
    if (dependencies.rejectMissingOrStaleRevision(request, response)) return;
    try {
      if (typeof request.body?.bundle !== 'string') throw new Error('A base64 backup bundle is required.');
      const report = dependencies.applyRestoreBundle(Buffer.from(request.body.bundle, 'base64'), {
        confirmation: request.body?.confirmation,
      });
      response.json({
        ...report,
        restartRequired: true,
        message:
          'Restore applied. Configuration was replaced and sessions were revoked. Restart the service now to swap the staged database; mutating APIs stay blocked until then.',
      });
    } catch (error) {
      if (dependencies.handleConfigConflict(error, response)) return;
      dependencies.sendSafeError(response, 400, 'RESTORE_FAILED', error);
    }
  });

  return router;
}
