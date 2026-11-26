// errors.ts — ApiError and the mapping of every thrown error to the api.md §1.1 error body.
import type { ApiErrorCode } from '../../shared/api-types.js';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  /** Extra response headers (e.g. Retry-After). */
  readonly headers: Record<string, string> | undefined;
  constructor(
    code: ApiErrorCode,
    statusCode: number,
    message?: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.headers = headers;
  }
}

const DEFAULT_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  bad_request: 'Malformed request.',
  invalid: 'The request is not valid.',
  unsupported_media_type: 'Send JSON with Content-Type: application/json.',
  unauthorized: 'Sign in again.',
  token_invalid: 'The Google sign-in could not be verified.',
  nonce_invalid: 'The sign-in attempt expired. Try again.',
  not_allowed: 'This Google account cannot use Wildhaven online.',
  reauth_mismatch: 'That is a different Google account.',
  not_found: 'Not found.',
  profile_deleted: 'This player was removed.',
  conflict: 'The cloud save changed.',
  leased_elsewhere: 'This zoo is open on another device.',
  lease_lost: 'Another device took over this zoo.',
  in_use: 'This zoo is open on another device.',
  profile_limit: 'This account already has the most players allowed.',
  name_taken: 'Another player already has this name.',
  bad_name: 'Pick a different name.',
  own_match: 'That is your own match.',
  match_full: 'Someone already joined this match.',
  match_state: 'The match cannot do that now.',
  match_over: 'This match is over.',
  code_expired: 'This challenge has ended.',
  other_device: 'This match is played on another device.',
  open_limit: 'Finish or cancel your open challenge first.',
  active_limit: 'Too many matches at once.',
  bad_snapshot: 'The match progress is not valid.',
  too_fast: 'The match progress is too fast.',
  too_large: 'Too large.',
  quota: 'Online storage for this account is full.',
  checksum: 'The upload was damaged.',
  bad_save: 'The upload is not a Wildhaven save.',
  upgrade_required: 'Update Wildhaven to continue.',
  rate_limited: 'Too many requests. Try again later.',
  server_full: 'The server is full.',
  internal: 'Something went wrong on the server.',
};

export const notFound = (): ApiError => new ApiError('not_found', 404);
export const invalid = (issues: string[]): ApiError => new ApiError('invalid', 422, undefined, { issues });
