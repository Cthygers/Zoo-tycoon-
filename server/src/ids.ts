// ids.ts — random ids, session tokens, hashes and match codes.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH } from '../../shared/versus-rules.js';

/** Ids match ^[A-Za-z0-9_-]{16,32}$ (api §1). */
export const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;

/** Random 128-bit id, base64url (22 chars). */
export function randomId(): string {
  return randomBytes(16).toString('base64url');
}

/** Session token: 'whs_' + 32 random bytes base64url (43 chars). */
export function newSessionToken(): string {
  return 'whs_' + randomBytes(32).toString('base64url');
}

export const SESSION_TOKEN_RE = /^whs_[A-Za-z0-9_-]{43}$/;

/** Sign-in nonce: 32 random bytes base64url. */
export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** Server epoch: random 8-char base64url id. */
export function newEpoch(): string {
  return randomBytes(6).toString('base64url');
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 6 chars from CODE_ALPHABET (no 0 O 1 I L). */
export function newMatchCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** uint31 seed for a match. */
export function newSeed(): number {
  return randomInt(0x7fffffff);
}
