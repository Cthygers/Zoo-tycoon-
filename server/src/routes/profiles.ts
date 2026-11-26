// routes/profiles.ts — profiles CRUD (#8–#12): soft delete for 30 days, restore, prefs.
import type { FastifyInstance } from 'fastify';
import type { ProfileResponse, ProfilesResponse, RemoveProfileResponse } from '../../../shared/api-types.js';
import { checkName, nameKey } from '../../../shared/names.js';
import { authOf, type Limiter } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import {
  SOFT_DELETE_MS, countActive, insertProfile, listForAccount, nameTaken, profileDto, profileOfAccount, removedDto,
} from '../db/profiles.js';
import type { DB } from '../db/sqlite.js';
import { ApiError, notFound } from '../errors.js';
import { CreateProfileSchema, EmptyBody, PatchProfileSchema, parse } from '../validate.js';
import { assertNotFull, ownProfile, send } from './common.js';

function checkedName(raw: string): { name: string; key: string } {
  const r = checkName(raw);
  if (!r.ok) throw new ApiError('bad_name', 422, r.message, { problem: r.problem });
  return { name: r.name, key: nameKey(r.name) };
}

function releaseLease(db: DB, pid: string): void {
  db.run('UPDATE saves SET lease_device_id = NULL, lease_device_name = NULL, lease_until = NULL WHERE profile_id = ?', pid);
}

export function registerProfiles(app: FastifyInstance, ctx: Ctx, writeLimit: Limiter): void {
  const { db, clock } = ctx;

  app.get('/v1/profiles', { config: { auth: true } }, async (req, reply) => {
    const auth = authOf(req);
    const lists = listForAccount(db, auth.accountId, auth.deviceId, clock.now());
    return send<Omit<ProfilesResponse, 'serverTime'>>(ctx, reply, 200, lists);
  });

  app.post('/v1/profiles', { config: { auth: true }, preHandler: [writeLimit] }, async (req, reply) => {
    const auth = authOf(req);
    const body = parse(CreateProfileSchema, req.body);
    const { name, key } = checkedName(body.name);
    assertNotFull(ctx, req);
    const profile = db.tx(() => {
      const now = clock.now();
      if (nameTaken(db, auth.accountId, key, null)) throw new ApiError('name_taken', 409);
      if (countActive(db, auth.accountId) >= ctx.config.maxProfiles) throw new ApiError('profile_limit', 409, undefined, { max: ctx.config.maxProfiles });
      const p = insertProfile(db, auth.accountId, name, key, body.avatar, now);
      return profileDto(db, p, auth.deviceId, now);
    });
    return send<Omit<ProfileResponse, 'serverTime'>>(ctx, reply, 201, { profile });
  });

  app.patch('/v1/profiles/:pid', { config: { auth: true }, preHandler: [writeLimit] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = (req.params as { pid?: string }).pid;
    ownProfile(ctx, req, pid);
    const body = parse(PatchProfileSchema, req.body);
    const nm = body.name !== undefined ? checkedName(body.name) : null;
    assertNotFull(ctx, req);
    const profile = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid);
      if (nm && nameTaken(db, auth.accountId, nm.key, p.id)) throw new ApiError('name_taken', 409);
      db.run(
        'UPDATE profiles SET name = ?, name_key = ?, avatar = ?, prefs = ?, updated_at = ? WHERE id = ?',
        nm ? nm.name : p.name,
        nm ? nm.key : p.name_key,
        body.avatar ? JSON.stringify({ animal: body.avatar.animal, color: body.avatar.color }) : p.avatar,
        body.prefs !== undefined ? JSON.stringify(body.prefs) : p.prefs,
        now,
        p.id,
      );
      return profileDto(db, profileOfAccount(db, auth.accountId, p.id)!, auth.deviceId, now);
    });
    return send<Omit<ProfileResponse, 'serverTime'>>(ctx, reply, 200, { profile });
  });

  app.delete('/v1/profiles/:pid', { config: { auth: true }, preHandler: [writeLimit] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = (req.params as { pid?: string }).pid;
    const removed = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid);
      db.run('UPDATE profiles SET deleted_at = ?, purge_at = ?, updated_at = ? WHERE id = ?', now, now + SOFT_DELETE_MS, now, p.id);
      releaseLease(db, p.id);
      return removedDto(profileOfAccount(db, auth.accountId, p.id)!);
    });
    return send<Omit<RemoveProfileResponse, 'serverTime'>>(ctx, reply, 200, { removed });
  });

  app.post('/v1/profiles/:pid/restore', { config: { auth: true }, preHandler: [writeLimit] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = (req.params as { pid?: string }).pid;
    parse(EmptyBody, req.body);
    const profile = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid, { allowDeleted: true });
      if (p.deleted_at !== null) {
        if (p.purge_at === null || now >= p.purge_at) throw notFound();
        if (nameTaken(db, auth.accountId, p.name_key, p.id)) throw new ApiError('name_taken', 409);
        if (countActive(db, auth.accountId) >= ctx.config.maxProfiles) throw new ApiError('profile_limit', 409, undefined, { max: ctx.config.maxProfiles });
        db.run('UPDATE profiles SET deleted_at = NULL, purge_at = NULL, updated_at = ? WHERE id = ?', now, p.id);
      }
      return profileDto(db, profileOfAccount(db, auth.accountId, p.id)!, auth.deviceId, now);
    });
    return send<Omit<ProfileResponse, 'serverTime'>>(ctx, reply, 200, { profile });
  });
}
