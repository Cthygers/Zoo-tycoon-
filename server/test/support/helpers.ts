// test/support/helpers.ts — small builders shared by the server suites (not pinned).
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { PutSaveBody, SaveMeta, VersusParts, VersusSnapshot } from '../../../shared/api-types.js';
import { scoreRounded } from '../../../shared/versus-rules.js';
import type { TestApp } from './testApp.js';

export const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function meta(over: Partial<SaveMeta> = {}): SaveMeta {
  return { day: 3, minute: 600, money: 40_000, rating: 55, animals: 4, species: 2, visitors: 120, playSeconds: 300, ...over };
}

export function gz(obj: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(obj)));
}

/** A save upload: gzip+base64 of `{ version, ...content }` with its sha256. */
export function encodeSave(content: Record<string, unknown> = {}, version = 1): { data: string; sha256: string; bytes: Buffer } {
  const bytes = gz({ version, ...content });
  return { data: bytes.toString('base64'), sha256: sha256hex(bytes), bytes };
}

let pushSeq = 0;
export function pushId(): string {
  pushSeq++;
  return `00000000-0000-4000-8000-${String(pushSeq).padStart(12, '0')}`;
}

export function putBody(base: { epoch: string; rev: number } | null, over: Partial<PutSaveBody> & { content?: Record<string, unknown> } = {}): PutSaveBody {
  const { content, ...rest } = over;
  const enc = encodeSave(content ?? { zoo: 'x', n: Math.random() });
  return {
    base,
    pushId: pushId(),
    saveVersion: 1,
    meta: meta(),
    clientSavedAt: 1_700_000_000_000,
    encoding: 'gzip+base64',
    data: enc.data,
    sha256: enc.sha256,
    ...rest,
  };
}

export async function makeProfile(t: TestApp, token: string, name: string, animal = 'lion', color = 0): Promise<string> {
  const r = await t.call('POST', '/v1/profiles', { token, body: { name, avatar: { animal, color } } });
  if (r.status !== 201) throw new Error(`create profile ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.profile.id as string;
}

/** A plausible snapshot at hour h: parts grow slowly with h (well under every cap). */
export function snap(h: number, over: Partial<VersusParts> = {}, extra: Partial<VersusSnapshot> = {}): VersusSnapshot {
  const parts: VersusParts = { v: h * 2, a: h * 1.5, s: h, b: 0, m: h * 3, l: 0, ...over };
  return {
    h,
    day: 1 + Math.floor(h / 24),
    min: 510,
    parts,
    total: scoreRounded(parts),
    run: h * 300,
    cash: 100_000,
    guests: 20,
    visitors: h * 4,
    animals: 6,
    species: 3,
    habitats: 2,
    stars: 50,
    ...extra,
  };
}

/** Every object key and every string value in a JSON value (deep). */
export function deepScan(v: unknown, keys: Set<string> = new Set(), strings: Set<string> = new Set()): { keys: Set<string>; strings: Set<string> } {
  if (Array.isArray(v)) for (const x of v) deepScan(x, keys, strings);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      deepScan(x, keys, strings);
    }
  } else if (typeof v === 'string') strings.add(v);
  return { keys, strings };
}
