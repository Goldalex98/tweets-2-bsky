import { randomUUID } from 'node:crypto';
import { isAuthError, isRateLimitError } from './x-rate-limit.js';

export type QueueErrorCategory =
  | 'twitter-auth'
  | 'twitter-rate-limit'
  | 'twitter-fetch'
  | 'bsky-auth'
  | 'bsky-rate-limit'
  | 'media-download'
  | 'media-upload'
  | 'text-processing'
  | 'unsupported-content'
  | 'timeout'
  | 'unknown';

const REDACTED = '[REDACTED]';
const SECRET_KEY =
  /password|passwd|(^|[_-])(cookie|secret|token|api[_-]?key|private[_-]?key|authorization|auth[_-]?header|webhook[_-]?(url|secret)|ct0)([_-]|$)/i;
const JWT = /\beyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]+/gi;
const COOKIE_PAIR = /\b(auth_token|ct0|session|cookie)=([^;\s]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;

function sanitizeText(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(COOKIE_PAIR, `$1=${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}

export function sanitizeForDiagnostics(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const errorRecord = value as Error & {
      cause?: unknown;
      code?: unknown;
      response?: unknown;
    };
    return {
      name: sanitizeText(value.name),
      message: sanitizeText(value.message),
      ...(errorRecord.code !== undefined
        ? { code: sanitizeForDiagnostics(errorRecord.code, seen) }
        : {}),
      ...(errorRecord.cause !== undefined
        ? { cause: sanitizeForDiagnostics(errorRecord.cause, seen) }
        : {}),
      ...(errorRecord.response !== undefined
        ? { response: sanitizeForDiagnostics(errorRecord.response, seen) }
        : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForDiagnostics(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : sanitizeForDiagnostics(entry, seen);
  }
  return output;
}

export function sanitizedErrorMessage(error: unknown, fallback = 'Operation failed'): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(sanitizeForDiagnostics(error));
  return sanitizeText(message || fallback).slice(0, 500);
}

export const BSKY_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'AuthenticationRequired',
  'AuthMissing',
  'ExpiredToken',
  'InvalidToken',
  'AuthFactorTokenRequired',
]);

/** An `XRPCError` from @atproto/api: its message rarely names Bluesky. */
function readXrpcError(error: unknown): { status: number; code?: string } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; error?: unknown; success?: unknown };
  if (candidate.success !== false || typeof candidate.status !== 'number') return undefined;
  return { status: candidate.status, ...(typeof candidate.error === 'string' ? { code: candidate.error } : {}) };
}

/** The scraper's `ApiError` keeps the X response; its message is "Response status: …". */
function readScraperStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

/**
 * `source` is the side the failing call talked to when the caller knows it
 * (an X fetch passes 'twitter'); otherwise the error's shape and wording decide.
 */
export function classifyQueueError(error: unknown, source?: 'twitter'): QueueErrorCategory {
  const candidate = `${error instanceof Error ? error.name : ''} ${sanitizedErrorMessage(error)}`.toLowerCase();
  if (candidate.includes('timeout') || candidate.includes('timed out') || candidate.includes('abort')) {
    return 'timeout';
  }
  const xrpc = source === 'twitter' ? undefined : readXrpcError(error);
  if (xrpc) {
    if (xrpc.status === 401 || (xrpc.code && BSKY_AUTH_ERROR_CODES.has(xrpc.code))) return 'bsky-auth';
    if (xrpc.status === 429 || xrpc.code === 'RateLimitExceeded') return 'bsky-rate-limit';
  }
  const scraperStatus = readScraperStatus(error);
  if (source === 'twitter' || scraperStatus !== undefined) {
    if (scraperStatus === 401 || scraperStatus === 403 || isAuthError(error)) return 'twitter-auth';
    if (scraperStatus === 429 || isRateLimitError(error)) return 'twitter-rate-limit';
    return 'twitter-fetch';
  }
  if (candidate.includes('twitter') || candidate.includes('x.com') || candidate.includes('scraper')) {
    if (candidate.includes('401') || candidate.includes('403') || candidate.includes('auth') || candidate.includes('cookie')) {
      return 'twitter-auth';
    }
    if (candidate.includes('429') || candidate.includes('rate limit')) return 'twitter-rate-limit';
    return 'twitter-fetch';
  }
  if (candidate.includes('bluesky') || candidate.includes('atproto') || candidate.includes('pds')) {
    if (candidate.includes('401') || candidate.includes('403') || candidate.includes('auth') || candidate.includes('login')) {
      return 'bsky-auth';
    }
    if (candidate.includes('429') || candidate.includes('rate limit')) return 'bsky-rate-limit';
  }
  if (candidate.includes('download')) return 'media-download';
  if (candidate.includes('upload') || candidate.includes('blob')) return 'media-upload';
  if (candidate.includes('facet') || candidate.includes('transform') || candidate.includes('text')) {
    return 'text-processing';
  }
  if (candidate.includes('unsupported') || candidate.includes('too long') || candidate.includes('too large')) {
    return 'unsupported-content';
  }
  return 'unknown';
}

export interface CorrelationContext {
  correlationId: string;
  sweepId?: string;
  requestId?: string;
  backfillId?: string;
  queueId?: string;
  destinationId?: string;
  sourceId?: string;
}

export interface StructuredLogger {
  child(context: Partial<CorrelationContext>): StructuredLogger;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createStructuredLogger(
  context: Partial<CorrelationContext> = {},
  options: {
    json?: boolean;
    sink?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
    clock?: { now(): number };
  } = {},
): StructuredLogger {
  const sink = options.sink ?? console;
  const clock = options.clock ?? Date;
  const resolvedContext: CorrelationContext = {
    correlationId: context.correlationId ?? randomUUID(),
    ...context,
  };
  const json = options.json ?? process.env.LOG_FORMAT?.toLowerCase() === 'json';

  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void => {
    const record = sanitizeForDiagnostics({
      timestamp: new Date(clock.now()).toISOString(),
      level,
      message,
      ...resolvedContext,
      ...(data === undefined ? {} : { data }),
    });
    if (json) {
      sink[level](JSON.stringify(record));
      return;
    }
    const suffix = data === undefined ? '' : ` ${JSON.stringify((record as Record<string, unknown>).data)}`;
    sink[level](`[${resolvedContext.correlationId}] ${message}${suffix}`);
  };

  return {
    child(next) {
      return createStructuredLogger(
        { ...resolvedContext, ...next, correlationId: next.correlationId ?? resolvedContext.correlationId },
        options,
      );
    },
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}
