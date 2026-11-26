// test/support/fakeGoogle.ts — a local stand-in for Google sign-in (pinned: the integrator's contract
// test and the e2e harness use it). RS256 key pair, local JWKS, mintIdToken(), the REAL googleVerifier
// over createLocalJWKSet, and startFakeGoogle(port) serving GET /jwks and GET /token for e2e.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK } from 'jose';
import { googleVerifier, type IdTokenVerifier } from '../../src/auth/verifier.js';
import type { Clock } from '../../src/clock.js';

export const FAKE_ISSUER = 'https://accounts.google.com';
export const FAKE_AUDIENCE = 'test-web-client';

export interface MintClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  nonce?: string;
  aud?: string;
  iss?: string;
  /** Seconds since the epoch (JWT style). Default: now. */
  iat?: number;
  /** Seconds since the epoch. Default: iat + 3600. */
  exp?: number;
  /** Header kid. Default: the fake's key id. */
  kid?: string;
}

export interface FakeGoogle {
  issuer: string;
  audience: string;
  jwks: JSONWebKeySet;
  mintIdToken(claims: MintClaims): Promise<string>;
  /** Signed with a different private key but the same kid (bad signature). */
  mintForged(claims: MintClaims): Promise<string>;
  /** The production verification code path over this fake's JWKS. */
  verifier(opts?: { audiences?: string[]; issuers?: string[] }): IdTokenVerifier;
}

export interface FakeGoogleOptions {
  issuer?: string;
  audience?: string;
  /** "now" for minted iat/exp and for the verifier (default: the real clock). */
  clock?: Clock;
}

export async function createFakeGoogle(opts: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const issuer = opts.issuer ?? FAKE_ISSUER;
  const audience = opts.audience ?? FAKE_AUDIENCE;
  const kid = 'fake-key-1';
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  const pub: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [pub] };
  const nowS = () => Math.floor((opts.clock ? opts.clock.now() : Date.now()) / 1000);

  const mint = async (c: MintClaims, key: CryptoKey | Uint8Array | object): Promise<string> => {
    const iat = c.iat ?? nowS();
    const payload: Record<string, unknown> = { sub: c.sub };
    if (c.email !== undefined) {
      payload.email = c.email;
      payload.email_verified = c.emailVerified ?? true;
    } else if (c.emailVerified !== undefined) payload.email_verified = c.emailVerified;
    if (c.nonce !== undefined) payload.nonce = c.nonce;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: c.kid ?? kid, typ: 'JWT' })
      .setIssuer(c.iss ?? issuer)
      .setAudience(c.aud ?? audience)
      .setIssuedAt(iat)
      .setExpirationTime(c.exp ?? iat + 3600)
      .sign(key as CryptoKey);
  };

  return {
    issuer,
    audience,
    jwks,
    mintIdToken: (c) => mint(c, privateKey),
    mintForged: (c) => mint(c, other.privateKey),
    verifier: (v = {}) =>
      googleVerifier({
        audiences: v.audiences ?? [audience],
        issuers: v.issuers ?? [issuer, 'accounts.google.com', 'https://accounts.google.com'],
        keys: createLocalJWKSet(jwks),
        ...(opts.clock ? { clock: opts.clock } : {}),
      }),
  };
}

export interface FakeGoogleServer {
  url: string;
  issuer: string;
  close(): Promise<void>;
}

/**
 * e2e: serve GET /jwks and GET /token?sub&email&aud&nonce → { idToken } on 127.0.0.1:port (0 = any free port).
 * The issuer defaults to the server URL; run the API with NODE_ENV=test GOOGLE_JWKS_URL=<url>/jwks GOOGLE_ISSUERS=<issuer>.
 */
export async function startFakeGoogle(port: number, issuer?: string): Promise<FakeGoogleServer> {
  let fake: FakeGoogle | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': '*' });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, headers);
        res.end(JSON.stringify(fake!.jwks));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/token') {
        const sub = url.searchParams.get('sub') || 'parent1';
        const email = url.searchParams.get('email') || `${sub}@example.com`;
        const aud = url.searchParams.get('aud') || 'e2e-web-client';
        const nonce = url.searchParams.get('nonce') ?? undefined;
        const idToken = await fake!.mintIdToken({ sub, email, aud, ...(nonce ? { nonce } : {}) });
        res.writeHead(200, headers);
        res.end(JSON.stringify({ idToken }));
        return;
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: 'not found' }));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${actual}`;
  const iss = issuer ?? url;
  fake = await createFakeGoogle({ issuer: iss, audience: 'e2e-web-client' });
  return {
    url,
    issuer: iss,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
