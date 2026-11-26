// test/support/injectFetch.ts — injectFetch(app): a `fetch` that maps each Request to app.inject (no sockets).
import type { FastifyInstance } from 'fastify';

export function injectFetch(app: FastifyInstance): typeof fetch {
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const base = 'http://localhost';
    const req = input instanceof Request && init === undefined ? input : new Request(typeof input === 'string' && !/^[a-z]+:/i.test(input) ? new URL(input, base) : input, init);
    if (req.signal?.aborted) throw req.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
    const injected = app.inject({
      method: req.method as 'GET',
      url: url.pathname + url.search,
      headers,
      ...(payload && payload.length > 0 ? { payload } : {}),
    });
    const res = await (req.signal
      ? Promise.race([
          injected,
          new Promise<never>((_, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')), { once: true });
          }),
        ])
      : injected);
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) out.append(k, String(x));
      else out.set(k, String(v));
    }
    const nullBody = res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD';
    return new Response(nullBody ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
  };
  return f as typeof fetch;
}
