import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { sanitizeForDiagnostics } from './observability.js';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  scope: string;
  key?: (request: Request) => string;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function createRateLimiter(options: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
    }
    const identity = options.key?.(request) ?? request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const key = `${options.scope}:${identity}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (current.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      response.setHeader('Retry-After', String(retryAfter));
      response.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
      });
      return;
    }
    current.count += 1;
    next();
  };
}

export function applySecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://cdn.bsky.app https://*.bsky.social https://*.bsky.network",
      "font-src 'self' data:",
      "connect-src 'self' https://bsky.social https://*.bsky.social https://*.bsky.network https://cdn.bsky.app",
    ].join('; '),
  );
  next();
}

export function noStore(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  next();
}

export function requireJsonObject(request: Request, response: Response, next: NextFunction): void {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Request body must be a JSON object.' },
    });
    return;
  }
  next();
}

export function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

const SECRET_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/=-]+|auth(?:orization|_token)?["'=:\s]+[^\s,;}]+|ct0["'=:\s]+[^\s,;}]+|password["'=:\s]+[^\s,;}]+|api[_-]?key["'=:\s]+[^\s,;}]+)/gi;

export function sanitizeErrorMessage(error: unknown, fallback = 'Request failed.'): string {
  const sanitized = sanitizeForDiagnostics(error) as { message?: unknown };
  const message = typeof sanitized?.message === 'string' ? sanitized.message : fallback;
  return message.replace(SECRET_PATTERN, '[REDACTED]').slice(0, 500);
}

export function sendSafeError(response: Response, status: number, code: string, error: unknown): void {
  const expose = status >= 400 && status < 500;
  response.status(status).json({
    error: {
      code,
      message: expose ? sanitizeErrorMessage(error) : 'The request could not be completed.',
    },
  });
}
