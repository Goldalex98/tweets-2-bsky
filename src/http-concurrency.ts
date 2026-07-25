import type { Response } from 'express';
import {
  CONFIG_REVISION_CONFLICT_CODE,
  type AppConfig,
  type ConfigVersion,
  getConfigVersion,
  hasConfigVersionConflict,
  isConfigRevisionConflictError,
} from './config-manager.js';

function sendConflict(res: Response, current: ConfigVersion): void {
  res.status(409).json({
    error: 'This configuration changed after you opened it.',
    code: CONFIG_REVISION_CONFLICT_CODE,
    guidance: 'Refresh the page, review the newer values, then apply your change again.',
    current,
  });
}

export function rejectStaleConfigMutation(
  config: AppConfig,
  body: { revision?: unknown; updatedAt?: unknown } | null | undefined,
  res: Response,
): boolean {
  if (!hasConfigVersionConflict(config, body)) return false;
  sendConflict(res, getConfigVersion(config));
  return true;
}

/**
 * Stricter guard for whole-document replacements. Import and restore rewrite
 * every entity, so they must name the revision they intend to replace instead
 * of relying on last-write-wins.
 */
export function rejectMissingOrStaleConfigRevision(
  config: AppConfig,
  body: { revision?: unknown; updatedAt?: unknown } | null | undefined,
  res: Response,
): boolean {
  if (!body || body.revision === undefined) {
    res.status(428).json({
      error: 'An expected configuration revision is required for this operation.',
      code: 'CONFIG_REVISION_REQUIRED',
      guidance: 'Reload the configuration, then resend the request with its current revision.',
      current: getConfigVersion(config),
    });
    return true;
  }
  return rejectStaleConfigMutation(config, body, res);
}

/**
 * Converts a persistence-layer compare-and-swap failure into the same 409
 * contract clients already handle for pre-flight revision checks.
 */
export function sendConfigConflictIfStale(error: unknown, res: Response): boolean {
  if (!isConfigRevisionConflictError(error)) return false;
  if (!res.headersSent) sendConflict(res, error.current);
  return true;
}
