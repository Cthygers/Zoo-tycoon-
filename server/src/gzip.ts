// gzip.ts — decode an uploaded gzip+base64 save: size limits, sha256, bounded gunzip, JSON sanity.
import { gunzipSync } from 'node:zlib';
import { ApiError } from './errors.js';
import { sha256Hex } from './ids.js';

export interface DecodedSave {
  gz: Buffer;
  sizeGz: number;
  sizeRaw: number;
  saveVersion: number;
  sha256: string;
}

export interface DecodeLimits {
  maxGz: number;
  maxRaw: number;
  /** Called when the inflated size goes over maxRaw (security log `zip_bomb`). */
  onZipBomb?: () => void;
}

/** Bounded gunzip: never allocates more than maxRaw bytes of output. */
export function gunzipBounded(gz: Buffer, maxRaw: number): Buffer {
  return gunzipSync(gz, { maxOutputLength: maxRaw });
}

/**
 * Order (api #15 step 1): base64 → size (413 too_large) → sha256 (422 checksum) →
 * bounded gunzip (413 too_large) → JSON with numeric `version` (422 bad_save).
 */
export function decodeSave(data: string, sha256: string, lim: DecodeLimits): DecodedSave {
  if (data.length % 4 !== 0) throw new ApiError('bad_save', 422, 'The upload is not valid base64.');
  const gz = Buffer.from(data, 'base64');
  if (gz.length > lim.maxGz) throw new ApiError('too_large', 413, 'This zoo is too big to save online.', { maxBytes: lim.maxGz });
  if (gz.length === 0) throw new ApiError('bad_save', 422);
  const hex = sha256Hex(gz);
  if (hex !== sha256.toLowerCase()) throw new ApiError('checksum', 422);
  let raw: Buffer;
  try {
    raw = gunzipBounded(gz, lim.maxRaw);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) {
      lim.onZipBomb?.();
      throw new ApiError('too_large', 413, 'This zoo is too big to save online.', { maxRawBytes: lim.maxRaw });
    }
    throw new ApiError('bad_save', 422, 'The upload is not gzip.');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError('bad_save', 422, 'The upload is not JSON.');
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (json === null || typeof json !== 'object' || Array.isArray(json) || typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new ApiError('bad_save', 422, 'The upload has no numeric version.');
  }
  return { gz, sizeGz: gz.length, sizeRaw: raw.length, saveVersion: version, sha256: hex };
}
