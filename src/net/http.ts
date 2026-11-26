// HTTP transport for the Wildhaven API (api.md §1): fetch with AbortController timeouts (8 s small,
// 35 s uploads/downloads), Bearer token, X-App-Version / X-Client, typed failures, a server-time
// offset (display only) and fire-and-forget keepalive requests for page hide.
// No @capacitor/* imports and no DOM access at import time: the server's contract test imports this.
import type { ApiErrorBody, ApiErrorCode } from '../../shared/api-types';
import { utf8Length } from './codec';

export const SMALL_TIMEOUT_MS = 8_000;
export const LARGE_TIMEOUT_MS = 35_000;

export type FailureCode = ApiErrorCode | 'network' | 'timeout' | 'disabled';

/** Every failed call rejects with this. status 0 = no HTTP answer (network, timeout, disabled). */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: FailureCode;
  readonly details: Record<string, unknown> | undefined;
  /** From Retry-After (429) in ms, when given. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, code: FailureCode, message?: string, details?: Record<string, unknown>, retryAfterMs?: number) {
    super(message ?? code);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isApiFailure(e: unknown): e is ApiFailure {
  return e instanceof ApiFailure;
}

/** Any failure as an ApiFailure (unknown throwables become 'network'). */
export function asFailure(e: unknown): ApiFailure {
  if (e instanceof ApiFailure) return e;
  return new ApiFailure(0, 'network', e instanceof Error ? e.message : String(e));
}

/** No HTTP answer: offline, DNS, CORS, timeout. */
export function isOfflineFailure(e: unknown): boolean {
  const f = asFailure(e);
  return f.code === 'network' || f.code === 'timeout';
}

/** Retry later with backoff: network, timeout, 5xx, 429, 507. */
export function isTransientFailure(e: unknown): boolean {
  const f = asFailure(e);
  return f.code === 'network' || f.code === 'timeout' || f.status >= 500 || f.status === 429;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'not_allowed', 404: 'not_found', 409: 'conflict', 410: 'profile_deleted',
  412: 'conflict', 413: 'too_large', 415: 'unsupported_media_type', 422: 'invalid', 426: 'upgrade_required', 429: 'rate_limited',
  507: 'server_full',
};

export interface HttpClientOptions {
  /** API origin without a trailing slash, e.g. https://zoo-api.example.com ('' = same origin). */
  base: string;
  fetch: typeof fetch;
  token: () => string | null;
  appVersion: string;
  client: 'android' | 'web';
  now?: () => number;
}

export interface RequestOptions {
  /** Send the Bearer token (default true). */
  auth?: boolean;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  timeoutMs?: number;
}

export interface KeepaliveSent {
  /** UTF-8 bytes of the request body (what counts toward Chromium's 64 KiB keepalive budget). */
  bytes: number;
  /** Settles when (if) the answer arrives; never rejects. */
  done: Promise<{ ok: true; value: unknown } | { ok: false; failure: ApiFailure }>;
}

function buildUrl(base: string, path: string, query?: RequestOptions['query']): string {
  let url = base.replace(/\/+$/, '') + path;
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length) url += `?${parts.join('&')}`;
  }
  return url;
}

function retryAfterOf(res: Response, details: Record<string, unknown> | undefined): number | undefined {
  const h = res.headers.get('retry-after');
  const n = h !== null ? Number(h) : typeof details?.retryAfter === 'number' ? (details.retryAfter as number) : NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

export class HttpClient {
  private readonly opts: HttpClientOptions;
  private readonly now: () => number;
  private readonly offsets: number[] = [];

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Server clock − device clock in ms (median of the last 5 answers); display only. */
  get serverTimeOffset(): number {
    if (this.offsets.length === 0) return 0;
    const s = [...this.offsets].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  private headers(withBody: boolean, auth: boolean): Record<string, string> {
    const h: Record<string, string> = { 'X-App-Version': this.opts.appVersion, 'X-Client': this.opts.client };
    if (withBody) h['Content-Type'] = 'application/json';
    if (auth) {
      const t = this.opts.token();
      if (t) h.Authorization = `Bearer ${t}`;
    }
    return h;
  }

  private noteServerTime(body: unknown, t0: number, t1: number): void {
    const st = (body as { serverTime?: unknown } | null)?.serverTime;
    if (typeof st !== 'number' || !Number.isFinite(st)) return;
    this.offsets.push(st - (t0 + t1) / 2);
    if (this.offsets.length > 5) this.offsets.shift();
  }

  private async parse<T>(res: Response, t0: number): Promise<T> {
    const t1 = this.now();
    let text = '';
    try {
      text = res.status === 204 || res.status === 205 || res.status === 304 ? '' : await res.text();
    } catch {
      text = '';
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) {
      this.noteServerTime(json, t0, t1);
      return (json ?? undefined) as T;
    }
    const err = (json as Partial<ApiErrorBody> | null)?.error;
    const details = err?.details && typeof err.details === 'object' ? err.details : undefined;
    const code: ApiErrorCode = err?.code ?? (res.status >= 500 ? 'internal' : STATUS_CODES[res.status] ?? 'bad_request');
    throw new ApiFailure(res.status, code, err?.message ?? `HTTP ${res.status}`, details, retryAfterOf(res, details));
  }

  /** One JSON request. Rejects with ApiFailure. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const withBody = opts.body !== undefined;
    const init: RequestInit = {
      method,
      headers: this.headers(withBody, opts.auth !== false),
      body: withBody ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctl) init.signal = ctl.signal;
    let timedOut = false;
    const ms = opts.timeoutMs ?? SMALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          ctl?.abort();
        } catch {
          /* ignore */
        }
        reject(new ApiFailure(0, 'timeout', `No answer in ${Math.round(ms / 1000)} s`));
      }, ms);
    });
    const doFetch = this.opts.fetch;
    const t0 = this.now();
    try {
      const res = await Promise.race([
        (async () => {
          try {
            return await doFetch(buildUrl(this.opts.base, path, opts.query), init);
          } catch (e) {
            if (timedOut) throw new ApiFailure(0, 'timeout');
            throw new ApiFailure(0, 'network', e instanceof Error ? e.message : String(e));
          }
        })(),
        timeout,
      ]);
      return await Promise.race([this.parse<T>(res, t0), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Fire-and-forget request with `keepalive: true` (page hide). The body is serialised now; when it
   * is larger than maxBytes nothing is sent and null is returned. fetch() is called synchronously.
   */
  keepalive(method: string, path: string, body: unknown, maxBytes: number, auth = true): KeepaliveSent | null {
    const text = body === undefined ? '' : JSON.stringify(body);
    const bytes = utf8Length(text);
    if (bytes > maxBytes) return null;
    const init: RequestInit = {
      method,
      headers: this.headers(body !== undefined, auth),
      body: body === undefined ? undefined : text,
      keepalive: true,
      credentials: 'omit',
      cache: 'no-store',
    };
    const doFetch = this.opts.fetch;
    const t0 = this.now();
    let started: Promise<Response>;
    try {
      started = doFetch(buildUrl(this.opts.base, path), init);
    } catch (e) {
      started = Promise.reject(e);
    }
    const done = started.then(
      async (res) => {
        try {
          return { ok: true as const, value: await this.parse<unknown>(res, t0) };
        } catch (e) {
          return { ok: false as const, failure: asFailure(e) };
        }
      },
      (e: unknown) => ({ ok: false as const, failure: new ApiFailure(0, 'network', e instanceof Error ? e.message : String(e)) }),
    );
    return { bytes, done };
  }
}
