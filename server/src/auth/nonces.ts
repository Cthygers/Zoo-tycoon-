// auth/nonces.ts — single-use sign-in nonces (sha256 stored, 10 minutes).
import { MINUTE_MS } from '../clock.js';
import type { DB } from '../db/sqlite.js';
import { newNonce, sha256 } from '../ids.js';

export const NONCE_TTL_MS = 10 * MINUTE_MS;

export function issueNonce(db: DB, now: number): { nonce: string; expiresAt: number } {
  const nonce = newNonce();
  const expiresAt = now + NONCE_TTL_MS;
  db.run('INSERT INTO auth_nonces (nonce_hash, expires_at) VALUES (?, ?)', sha256(nonce), expiresAt);
  return { nonce, expiresAt };
}

/**
 * True when `claimNonce` (from the verified ID token) equals `bodyNonce` and an unexpired row exists;
 * the row is deleted (single use). Must run inside a transaction.
 */
export function consumeNonce(db: DB, bodyNonce: string, claimNonce: string | undefined, now: number): boolean {
  if (typeof claimNonce !== 'string' || claimNonce.length === 0) return false;
  if (!sha256(claimNonce).equals(sha256(bodyNonce))) return false;
  return db.run('DELETE FROM auth_nonces WHERE nonce_hash = ? AND expires_at > ?', sha256(bodyNonce), now).changes === 1;
}
