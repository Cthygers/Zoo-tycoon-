// Kid-friendly failures (FriendlyError, spec §8.6): short sentences a child can act on.
import type { FriendlyError } from '../core/cloud-types';
import { asFailure, type FailureCode } from './http';

export class FriendlyErr extends Error implements FriendlyError {
  readonly code: FailureCode;
  constructor(message: string, code: FailureCode) {
    super(message);
    this.name = 'FriendlyError';
    this.code = code;
  }
}

export const MSG = {
  offline: 'Connect to the internet to do this.',
  server: "Can't reach the Wildhaven server right now. You can keep playing.",
  signin: 'Sign in again to keep your zoos safe online.',
  disabled: "Online play isn't switched on in this version of Wildhaven.",
  update: 'Update Wildhaven to do this.',
  busy: 'Too many tries. Wait a little and try again.',
  generic: 'Something went wrong. Try again.',
} as const;

/** Turn any failure into a FriendlyErr; `byCode` overrides messages for specific codes. */
export function friendly(e: unknown, byCode: Partial<Record<FailureCode, string>> = {}): FriendlyErr {
  if (e instanceof FriendlyErr) return e;
  const f = asFailure(e);
  const own = byCode[f.code];
  if (own) return new FriendlyErr(own, f.code);
  switch (f.code) {
    case 'network':
    case 'timeout':
      return new FriendlyErr(byCode.network ?? MSG.offline, f.code);
    case 'disabled':
      return new FriendlyErr(MSG.disabled, 'disabled');
    case 'unauthorized':
      return new FriendlyErr(MSG.signin, f.code);
    case 'upgrade_required':
      return new FriendlyErr(MSG.update, f.code);
    case 'rate_limited':
      return new FriendlyErr(MSG.busy, f.code);
    case 'internal':
    case 'server_full':
      return new FriendlyErr(MSG.server, f.code);
    default:
      if (f.status >= 500) return new FriendlyErr(MSG.server, f.code);
      return new FriendlyErr(MSG.generic, f.code);
  }
}
