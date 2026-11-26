// validate.ts — zod schemas for every request body/query and the zod → 422 helper.
import { z } from 'zod';
import { AVATAR_ANIMALS, AVATAR_COLORS, META_MAX_BYTES, PREFS_MAX_BYTES, SNAPSHOTS_PER_CALL } from '../../shared/limits.js';
import { invalid, notFound } from './errors.js';
import { ID_RE } from './ids.js';

/** Parse or throw 422 invalid with `details.issues: string[]`. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw invalid(r.error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`));
}

/** A path id that cannot exist is simply not found. */
export function pathId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw notFound();
  return raw;
}

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

export const zId = z.string().regex(ID_RE, 'not a valid id');
/** uuid v4 (or any similar opaque client id). */
export const zClientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'not a valid id');
export const zVersion = z.string().regex(/^[0-9A-Za-z.+_-]{1,32}$/, 'not a valid version');
const zMillis = z.number().int().min(0).max(8.64e15);

export const DeviceSchema = z.strictObject({
  id: zClientId,
  name: z.string().trim().min(1).max(40).regex(NO_CONTROL, 'control characters'),
  platform: z.enum(['android', 'web']),
  appVersion: zVersion,
});

export const EmptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

export const GoogleSignInSchema = z.strictObject({
  idToken: z.string().min(1).max(16_384),
  nonce: z.string().min(1).max(256),
  device: DeviceSchema,
});

export const DeleteAccountSchema = z.strictObject({
  idToken: z.string().min(1).max(16_384),
  nonce: z.string().min(1).max(256),
});

export const AvatarSchema = z.strictObject({
  animal: z.enum(AVATAR_ANIMALS),
  color: z.number().int().min(0).max(AVATAR_COLORS - 1),
});

const TutorialPrefsSchema = z.strictObject({
  v: z.literal(1),
  status: z.enum(['never', 'running', 'done', 'skipped']),
  readAloud: z.boolean().nullable(),
  updatedAt: zMillis,
});

/** prefs: known members are checked; unknown members are kept (the client owns them). ≤ 4 KiB as JSON. */
export const PrefsSchema = z
  .looseObject({ tutorial: TutorialPrefsSchema.optional() })
  .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= PREFS_MAX_BYTES, `prefs larger than ${PREFS_MAX_BYTES} bytes`);

export const CreateProfileSchema = z.strictObject({
  name: z.string().max(200),
  avatar: AvatarSchema,
});

export const PatchProfileSchema = z
  .strictObject({
    name: z.string().max(200).optional(),
    avatar: AvatarSchema.optional(),
    prefs: PrefsSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.avatar !== undefined || b.prefs !== undefined, 'at least one of name, avatar, prefs');

const num = (min: number, max: number) => z.number().min(min).max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const MetaSchema = z
  .strictObject({
    day: int(1, 100_000),
    minute: num(0, 1440),
    money: num(-1e9, 1e10),
    rating: num(0, 100),
    animals: int(0, 100_000),
    species: int(0, 1000),
    visitors: num(0, 1e9),
    playSeconds: num(0, 1e9),
  })
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= META_MAX_BYTES, `meta larger than ${META_MAX_BYTES} bytes`);

const zSha = z.string().regex(/^[0-9a-fA-F]{64}$/, 'not a sha256 hex').transform((s) => s.toLowerCase());
const zB64 = (maxChars: number) =>
  z.string().max(maxChars).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64');

export const SaveRefSchema = z.strictObject({ epoch: z.string().min(1).max(32), rev: z.number().int().min(1) });

export const PutSaveSchema = z.strictObject({
  base: SaveRefSchema.nullable(),
  pushId: zClientId,
  saveVersion: z.number().int().min(0).max(1_000_000),
  meta: MetaSchema,
  clientSavedAt: zMillis,
  encoding: z.literal('gzip+base64'),
  data: zB64(2_000_000),
  sha256: zSha,
  resolution: z.literal('keep_local').optional(),
});

export const StashSchema = z.strictObject({
  stashId: zClientId,
  reason: z.enum(['lease_lost', 'chose_other', 'auto_pull', 'replaced']),
  saveVersion: z.number().int().min(0).max(1_000_000),
  meta: MetaSchema,
  clientSavedAt: zMillis,
  encoding: z.literal('gzip+base64'),
  data: zB64(2_000_000),
  sha256: zSha,
});

export const LeaseSchema = z.strictObject({
  action: z.enum(['acquire', 'renew', 'release']),
  takeover: z.boolean().optional(),
});

export const PushIdsQuery = z.object({
  pushIds: z
    .string()
    .max(400)
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s === '') return [] as string[];
      const ids = s.split(',').map((x) => x.trim()).filter(Boolean);
      if (ids.length > 4) ctx.addIssue({ code: 'custom', message: 'at most 4 pushIds' });
      for (const id of ids) if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) ctx.addIssue({ code: 'custom', message: 'bad pushId' });
      return ids;
    }),
});

// ------------------------------------------------------------------ versus
const zLength = z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(120), z.literal(4)]);

export const CreateMatchSchema = z.strictObject({
  profileId: zId,
  lengthMin: z.number(),
  opponentProfileId: zId.optional(),
  rulesVersion: z.number().int(),
});
export { zLength };

export const JoinMatchSchema = z.strictObject({
  profileId: zId,
  code: z.string().max(32).optional(),
  rulesVersion: z.number().int(),
});

export const ProfileOnlySchema = z.strictObject({ profileId: zId });
export const ProfileQuery = z.object({ profileId: zId });
export const ListQuery = z.object({
  profileId: zId,
  state: z.enum(['active', 'finished', 'all']).optional(),
});
export const SeriesQuery = z.object({
  profileId: zId,
  since: z.coerce.number().int().min(0).max(100_000).optional(),
});

// Bounded numbers: wide enough that every real value (and every value checkSnapshotStep should answer with
// 422 bad_snapshot: negative, fractional, h not a multiple of 6 …) passes zod, small enough that totals stay
// safe integers for the STRICT INTEGER columns and no absurd score is ever stored or shown. A 60-day match at
// every daily rate cap scores about 37 000 points.
const fin = z.number().min(-1e10).max(1e10);
const part = z.number().min(-1e7).max(1e7);
export const PartsSchema = z.strictObject({ v: part, a: part, s: part, b: part, m: part, l: part });
export const SnapshotSchema = z.strictObject({
  h: z.number().min(-1e6).max(1e6),
  day: fin,
  min: fin,
  parts: PartsSchema,
  total: z.number().min(-1e8).max(1e8),
  run: fin,
  cash: fin,
  guests: fin,
  visitors: fin,
  animals: fin,
  species: fin,
  habitats: fin,
  stars: fin,
});

export const SnapshotsSchema = z.strictObject({
  profileId: zId,
  snapshots: z.array(SnapshotSchema).min(1).max(SNAPSHOTS_PER_CALL),
});

export const FinishSchema = z.strictObject({
  profileId: zId,
  final: SnapshotSchema,
  endReason: z.enum(['complete', 'budget']),
  save: z.strictObject({
    encoding: z.literal('gzip+base64'),
    data: zB64(600_000),
    sha256: zSha,
  }),
});
