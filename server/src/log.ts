// log.ts — pino options for Fastify: JSON to stdout, redaction, no request auto-logging.
// The request line (route template, status, time, request id, internal account id) is written
// by an onResponse hook in app.ts; tokens, emails, names, bodies and IPs are never logged.
import type { FastifyBaseLogger } from 'fastify';

export interface LogOptions {
  level?: string;
  /** Where JSON lines go (tests capture them). Default: stdout. */
  stream?: { write(line: string): void };
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'res.body',
  'headers.authorization',
  'headers.cookie',
  'body',
  'token',
  'idToken',
  'nonce',
  'email',
  'name',
  '*.token',
  '*.idToken',
  '*.email',
];

export function loggerOptions(opts: LogOptions | false | undefined): Record<string, unknown> | false {
  if (opts === false || opts === undefined) return false;
  return {
    level: opts.level ?? 'info',
    ...(opts.stream ? { stream: opts.stream } : {}),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      // Never log raw URLs, headers or remote addresses.
      req: (req: { method?: string; routeOptions?: { url?: string }; id?: string }) => ({
        method: req.method,
        route: req.routeOptions?.url,
        reqId: req.id,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error & { code?: string; statusCode?: number }) => ({
        type: err.name,
        code: err.code,
        statusCode: err.statusCode,
        message: scrub(err.message),
        stack: err.stack ? scrub(err.stack) : undefined,
      }),
    },
  };
}

/** Remove anything that looks like a session token, a JWT or an email address. */
export function scrub(s: string): string {
  return String(s)
    .replace(/whs_[A-Za-z0-9_-]+/g, 'whs_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, '[email]');
}

export type SecurityKind =
  | 'token_invalid'
  | 'nonce_invalid'
  | 'rate_limited'
  | 'idor_denied'
  | 'zip_bomb'
  | 'pace_flag'
  | 'server_full'
  | 'reauth_mismatch'
  | 'not_allowed';

export function securityEvent(log: FastifyBaseLogger, kind: SecurityKind, extra?: Record<string, unknown>): void {
  log.warn({ kind, ...extra }, 'security');
}
