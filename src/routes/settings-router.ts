import { Router, type RequestHandler, type Response } from 'express';
import type { AppConfig } from '../config/schemas.js';

type ConfigVersion = { revision: number; updatedAt: string };

export interface SettingsRouterDependencies {
  authenticateToken: RequestHandler;
  requireAdmin: RequestHandler;
  webhookRateLimiter: RequestHandler;
  getConfig(): AppConfig;
  saveConfig(config: AppConfig): void;
  getConfigVersion(config: AppConfig): ConfigVersion;
  rejectStaleConfigMutation(config: AppConfig, body: unknown, response: Response): boolean;
  parseSchedulerIntervalMinutes(value: unknown): number;
  getSchedulerIntervalMinutes(config: AppConfig): number;
  getActiveTwitterUsernames(mapping: AppConfig['mappings'][number]): string[];
  getSchedulerRuntime(): { lastCheckTime: number; nextCheckTime: number };
  setNextCheckTime(value: number): void;
  getNextCheckTimestamp(now: number, intervalMinutes: number): number;
  signalSchedulerWake(reason: 'reschedule'): void;
  getErrorMessage(error: unknown, fallback: string): string;
  validateWebhookTarget(url: string, allowPrivate: boolean): Promise<unknown>;
  sanitizeError(error: unknown): string;
  listWebhookDeliveries(limit: number): unknown[];
  notifyOperationsEvent(event: {
    event: 'queue-age';
    occurredAt: string;
    message: string;
    details: { test: true };
  }): void;
}

export function buildSchedulerSettingsResponse(dependencies: SettingsRouterDependencies, config: AppConfig) {
  const enabledSourceCount = config.mappings
    .filter((mapping) => mapping.enabled)
    .reduce((total, mapping) => total + dependencies.getActiveTwitterUsernames(mapping).length, 0);
  const intervalMinutes = dependencies.getSchedulerIntervalMinutes(config);
  const runtime = dependencies.getSchedulerRuntime();
  const envDiagnostic = (name: string) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    ...dependencies.getConfigVersion(config),
    enabled: config.scheduler.enabled,
    intervalMinutes,
    runOnStartup: config.scheduler.runOnStartup,
    lastCheckTime: runtime.lastCheckTime || null,
    nextCheckTime: config.scheduler.enabled ? runtime.nextCheckTime : null,
    enabledSourceCount,
    estimatedChecksPerHour: config.scheduler.enabled
      ? Math.round((enabledSourceCount * 60) / intervalMinutes)
      : 0,
    diagnostics: {
      scraperMinGapMs: envDiagnostic('SCRAPER_MIN_GAP_MS'),
      scraperJitterMs: envDiagnostic('SCRAPER_JITTER_MS'),
      fetchConcurrency: envDiagnostic('FETCH_CONCURRENCY'),
      postWorkerConcurrency: envDiagnostic('POST_WORKER_CONCURRENCY'),
      postPacingMinMs: envDiagnostic('POST_PACING_MIN_MS'),
      postPacingMaxMs: envDiagnostic('POST_PACING_MAX_MS'),
      queueMaxAttempts: envDiagnostic('QUEUE_MAX_ATTEMPTS'),
      sweepFetchTimeoutMs: envDiagnostic('SWEEP_FETCH_TIMEOUT_MS'),
    },
  };
}

export function createSettingsRouter(dependencies: SettingsRouterDependencies): Router {
  const router = Router();
  const admin = [dependencies.authenticateToken, dependencies.requireAdmin];

  router.get('/scheduler', ...admin, (_request, response) => {
    response.json(buildSchedulerSettingsResponse(dependencies, dependencies.getConfig()));
  });

  router.patch('/scheduler', ...admin, (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      response.status(400).json({ error: 'Scheduler settings must be an object.' });
      return;
    }
    if (request.body.intervalMinutes === undefined) {
      response.status(400).json({ error: 'Scheduler intervalMinutes is required.' });
      return;
    }
    const config = dependencies.getConfig();
    if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
    try {
      const intervalMinutes = dependencies.parseSchedulerIntervalMinutes(request.body.intervalMinutes);
      if (request.body.enabled !== undefined && typeof request.body.enabled !== 'boolean') {
        throw new Error('Scheduler enabled must be a boolean.');
      }
      if (request.body.runOnStartup !== undefined && typeof request.body.runOnStartup !== 'boolean') {
        throw new Error('Scheduler runOnStartup must be a boolean.');
      }
      config.scheduler = {
        enabled: request.body.enabled ?? config.scheduler.enabled,
        intervalMinutes,
        runOnStartup: request.body.runOnStartup ?? config.scheduler.runOnStartup,
      };
      dependencies.saveConfig(config);
      const nextCheckTime = dependencies.getNextCheckTimestamp(Date.now(), intervalMinutes);
      dependencies.setNextCheckTime(nextCheckTime);
      dependencies.signalSchedulerWake('reschedule');
      response.json(buildSchedulerSettingsResponse(dependencies, config));
    } catch (error) {
      response.status(400).json({ error: dependencies.getErrorMessage(error, 'Invalid scheduler settings.') });
    }
  });

  router.get('/notifications', ...admin, (_request, response) => {
    const config = dependencies.getConfig();
    const notifications = config.notifications;
    response.json({
      ...dependencies.getConfigVersion(config),
      enabled: notifications.enabled,
      webhookConfigured: Boolean(notifications.webhookUrl),
      secretConfigured: Boolean(notifications.webhookSecret),
      allowPrivate: notifications.allowPrivate,
      events: notifications.events,
      maxAttempts: notifications.maxAttempts,
      backoffMs: notifications.backoffMs,
      timeoutMs: notifications.timeoutMs,
      deliveries: dependencies.listWebhookDeliveries(25),
    });
  });

  router.put('/notifications', ...admin, async (request, response) => {
    const config = dependencies.getConfig();
    if (dependencies.rejectStaleConfigMutation(config, request.body, response)) return;
    const current = config.notifications;
    const webhookUrl =
      typeof request.body?.webhookUrl === 'string' && request.body.webhookUrl.length > 0
        ? request.body.webhookUrl
        : request.body?.clearWebhookUrl === true
          ? undefined
          : current.webhookUrl;
    const webhookSecret =
      typeof request.body?.webhookSecret === 'string' && request.body.webhookSecret.length > 0
        ? request.body.webhookSecret
        : request.body?.clearWebhookSecret === true
          ? undefined
          : current.webhookSecret;
    const allowPrivate = request.body?.allowPrivate === true;
    try {
      if (webhookUrl) await dependencies.validateWebhookTarget(webhookUrl, allowPrivate);
    } catch (error) {
      response.status(400).json({ error: dependencies.sanitizeError(error) });
      return;
    }
    const eventInput = request.body?.events && typeof request.body.events === 'object' ? request.body.events : {};
    config.notifications = {
      enabled: request.body?.enabled === true,
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      allowPrivate,
      events: {
        'twitter-auth-failure': eventInput['twitter-auth-failure'] === true,
        'bsky-auth-failure': eventInput['bsky-auth-failure'] === true,
        'queue-parked': eventInput['queue-parked'] === true,
        'queue-age': eventInput['queue-age'] === true,
        'update-failure': eventInput['update-failure'] === true,
      },
      maxAttempts: Math.max(1, Math.min(10, Number(request.body?.maxAttempts) || current.maxAttempts)),
      backoffMs: Math.max(100, Math.min(60_000, Number(request.body?.backoffMs) || current.backoffMs)),
      timeoutMs: Math.max(1000, Math.min(120_000, Number(request.body?.timeoutMs) || current.timeoutMs)),
    };
    dependencies.saveConfig(config);
    response.json({
      success: true,
      webhookConfigured: Boolean(config.notifications.webhookUrl),
      secretConfigured: Boolean(config.notifications.webhookSecret),
      ...dependencies.getConfigVersion(config),
    });
  });

  router.post(
    '/notifications/test',
    dependencies.webhookRateLimiter,
    ...admin,
    (_request, response) => {
      dependencies.notifyOperationsEvent({
        event: 'queue-age',
        occurredAt: new Date().toISOString(),
        message: 'Test operations notification.',
        details: { test: true },
      });
      response.status(202).json({ success: true, message: 'Notification delivery queued.' });
    },
  );

  return router;
}
