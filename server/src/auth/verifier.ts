// auth/verifier.ts — Google ID token verification with jose (injectable; tests use a local JWKS).
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Clock } from '../clock.js';
import { ApiError } from '../errors.js';

export interface VerifiedIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  nonce?: string;
}

export interface IdTokenVerifier {
  /** Throws ApiError('token_invalid', 401) for any token that does not verify. */
  verify(idToken: string): Promise<VerifiedIdentity>;
}

export const MAX_ID_TOKEN_CHARS = 4096;

export interface GoogleVerifierConfig {
  audiences: string[];
  issuers: string[];
  keys: JWTVerifyGetKey;
  /** Source of "now" for exp/iat checks (default: the real clock). */
  clock?: Clock;
}

export function googleVerifier(cfg: GoogleVerifierConfig): IdTokenVerifier {
  return {
    async verify(idToken: string): Promise<VerifiedIdentity> {
      if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_CHARS) {
        throw new ApiError('token_invalid', 401);
      }
      let payload: Record<string, unknown>;
      try {
        const r = await jwtVerify(idToken, cfg.keys, {
          issuer: cfg.issuers,
          audience: cfg.audiences,
          algorithms: ['RS256'],
          clockTolerance: 60,
          maxTokenAge: '15m',
          ...(cfg.clock ? { currentDate: new Date(cfg.clock.now()) } : {}),
        });
        payload = r.payload as Record<string, unknown>;
      } catch (e) {
        // The key set could not be fetched: a server-side problem, not a bad token.
        if (e instanceof joseErrors.JWKSTimeout || !(e instanceof joseErrors.JOSEError)) {
          throw new ApiError('internal', 503, 'Cannot reach Google to check the sign-in. Try again soon.');
        }
        throw new ApiError('token_invalid', 401);
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) throw new ApiError('token_invalid', 401);
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : null,
        emailVerified: payload.email_verified === true,
        ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}),
      };
    },
  };
}

/** Production: Google's JWKS over HTTPS with jose's cache. */
export function remoteGoogleVerifier(cfg: { audiences: string[]; issuers: string[]; jwksUrl: string; clock?: Clock }): IdTokenVerifier {
  const keys = createRemoteJWKSet(new URL(cfg.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000, timeoutDuration: 5_000 });
  return googleVerifier({ audiences: cfg.audiences, issuers: cfg.issuers, keys, ...(cfg.clock ? { clock: cfg.clock } : {}) });
}
