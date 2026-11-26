// routes/saves.ts — slot 'main' only (#13–#17): head + pushIds, data, CAS push, lease, stash.
import type { FastifyInstance } from 'fastify';
import type { GetHeadResponse, LeaseResponse, PutSaveResponse, SaveDataResponse, StashResponse } from '../../../shared/api-types.js';
import { SAVE_MAX_GZ_BYTES, SAVE_MAX_RAW_BYTES } from '../../../shared/limits.js';
import { authOf, type Limiter } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { currentEpoch } from '../db/migrate.js';
import {
  PIN_MS, accountBlobBytes, applyRetention, currentHead, ensureSave, getSave, getStash, headBlob, headRow, insertRevision,
  insertStash, leaseConflict, leaseInfo, leaseLive, pinRevision, pushedLookup, revisionByPushId, sameRef, toHead,
} from '../db/saves.js';
import { ApiError, notFound } from '../errors.js';
import { decodeSave } from '../gzip.js';
import { securityEvent } from '../log.js';
import { LeaseSchema, PushIdsQuery, PutSaveSchema, StashSchema, parse } from '../validate.js';
import { appVersionOf, assertNotFull, ownProfile, send } from './common.js';

export const SAVE_BODY_LIMIT = 1_572_864; // 1.5 MiB

export interface SaveLimiters {
  put: Limiter;
  lease: Limiter;
  stash: Limiter;
}

export function registerSaves(app: FastifyInstance, ctx: Ctx, lim: SaveLimiters): void {
  const { db, clock } = ctx;
  const base = '/v1/profiles/:pid/saves/main';
  const pidOf = (req: { params: unknown }) => (req.params as { pid?: string }).pid;

  app.get(base, { config: { auth: true } }, async (req, reply) => {
    const auth = authOf(req);
    const p = ownProfile(ctx, req, pidOf(req));
    const q = parse(PushIdsQuery, req.query ?? {});
    const now = clock.now();
    const save = getSave(db, p.id);
    const res: Omit<GetHeadResponse, 'serverTime'> = {
      head: currentHead(db, save),
      lease: leaseInfo(save, now, auth.deviceId),
      pushed: save && q.pushIds.length > 0 ? pushedLookup(db, save.id, q.pushIds) : null,
    };
    return send(ctx, reply, 200, res);
  });

  app.get(`${base}/data`, { config: { auth: true } }, async (req, reply) => {
    const p = ownProfile(ctx, req, pidOf(req));
    const save = getSave(db, p.id);
    const row = headRow(db, save);
    const blob = save && row ? headBlob(db, save) : null;
    if (!save || !row || !blob) throw notFound();
    const res: Omit<SaveDataResponse, 'serverTime'> = { head: toHead(row), encoding: 'gzip+base64', data: Buffer.from(blob).toString('base64') };
    return send(ctx, reply, 200, res);
  });

  app.put(base, { config: { auth: true }, bodyLimit: SAVE_BODY_LIMIT, preHandler: [lim.put] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = pidOf(req);
    ownProfile(ctx, req, pid);
    const body = parse(PutSaveSchema, req.body);
    const dec = decodeSave(body.data, body.sha256, {
      maxGz: SAVE_MAX_GZ_BYTES,
      maxRaw: SAVE_MAX_RAW_BYTES,
      onZipBomb: () => securityEvent(req.log, 'zip_bomb', { accountId: auth.accountId }),
    });
    if (dec.saveVersion !== body.saveVersion) throw new ApiError('bad_save', 422, 'saveVersion does not match the save.');
    const appVersion = appVersionOf(req);
    const out = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid);
      assertNotFull(ctx, req);
      const save = ensureSave(db, p.id, now);
      if (leaseLive(save, now) && save.lease_device_id !== auth.deviceId) {
        throw new ApiError('leased_elsewhere', 409, undefined, { ...leaseConflict(db, save) });
      }
      const replayed = revisionByPushId(db, save.id, body.pushId);
      if (replayed) {
        const isHead = replayed.epoch === save.head_epoch && replayed.rev === save.head_rev;
        return { head: isHead ? toHead(replayed) : currentHead(db, save)!, replay: true };
      }
      const head = currentHead(db, save);
      const headRef = head ? { epoch: head.epoch, rev: head.rev } : null;
      if (!sameRef(body.base, headRef)) throw new ApiError('conflict', 412, 'The cloud save changed.', { head });
      insertRevision(db, save, {
        epoch: currentEpoch(db),
        rev: (head?.rev ?? 0) + 1,
        pushId: body.pushId,
        deviceId: auth.deviceId,
        deviceName: auth.deviceName,
        appVersion,
        saveVersion: dec.saveVersion,
        meta: body.meta,
        clientSavedAt: body.clientSavedAt,
        sizeRaw: dec.sizeRaw,
        sizeGz: dec.sizeGz,
        sha256: dec.sha256,
        blob: dec.gz,
        pinnedUntil: null,
      }, now);
      if (leaseLive(save, now) && save.lease_device_id === auth.deviceId) {
        db.run('UPDATE saves SET lease_until = ?, lease_seen_at = ? WHERE id = ?', now + ctx.config.leaseSeconds * 1000, now, save.id);
      }
      if (body.resolution === 'keep_local' && headRef) pinRevision(db, save.id, headRef, now + PIN_MS);
      applyRetention(db, save.id, now);
      // The quota measures what stays stored once retention has dropped the oldest blob, so a full account
      // can keep saving zoos of the same size. Throwing inside db.tx rolls the new revision back.
      if (accountBlobBytes(db, auth.accountId) > ctx.config.maxAccountBytes) {
        throw new ApiError('quota', 413, 'Online storage for this account is full.', { maxBytes: ctx.config.maxAccountBytes });
      }
      return { head: currentHead(db, getSave(db, p.id))!, replay: false };
    });
    return send<Omit<PutSaveResponse, 'serverTime'>>(ctx, reply, 200, out);
  });

  app.post(`${base}/lease`, { config: { auth: true }, preHandler: [lim.lease] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = pidOf(req);
    ownProfile(ctx, req, pid);
    const body = parse(LeaseSchema, req.body);
    const out = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid);
      const until = now + ctx.config.leaseSeconds * 1000;
      if (body.action === 'release') {
        const save = getSave(db, p.id);
        if (save && save.lease_device_id === auth.deviceId) {
          db.run('UPDATE saves SET lease_device_id = NULL, lease_device_name = NULL, lease_until = NULL WHERE id = ?', save.id);
        }
        const fresh = getSave(db, p.id);
        return { lease: leaseInfo(fresh, now, auth.deviceId), head: currentHead(db, fresh) };
      }
      const save = ensureSave(db, p.id, now);
      const heldElsewhere = leaseLive(save, now) && save.lease_device_id !== auth.deviceId;
      if (heldElsewhere && (body.action === 'renew' || !body.takeover)) {
        throw new ApiError(body.action === 'renew' ? 'lease_lost' : 'in_use', 409, undefined, { ...leaseConflict(db, save) });
      }
      db.run(
        'UPDATE saves SET lease_device_id = ?, lease_device_name = ?, lease_until = ?, lease_seen_at = ? WHERE id = ?',
        auth.deviceId, auth.deviceName, until, now, save.id,
      );
      const fresh = getSave(db, p.id);
      return { lease: leaseInfo(fresh, now, auth.deviceId), head: currentHead(db, fresh) };
    });
    return send<Omit<LeaseResponse, 'serverTime'>>(ctx, reply, 200, out);
  });

  app.post(`${base}/stash`, { config: { auth: true }, bodyLimit: SAVE_BODY_LIMIT, preHandler: [lim.stash] }, async (req, reply) => {
    const auth = authOf(req);
    const pid = pidOf(req);
    ownProfile(ctx, req, pid);
    const body = parse(StashSchema, req.body);
    const dec = decodeSave(body.data, body.sha256, {
      maxGz: SAVE_MAX_GZ_BYTES,
      maxRaw: SAVE_MAX_RAW_BYTES,
      onZipBomb: () => securityEvent(req.log, 'zip_bomb', { accountId: auth.accountId }),
    });
    if (dec.saveVersion !== body.saveVersion) throw new ApiError('bad_save', 422, 'saveVersion does not match the save.');
    const out = db.tx(() => {
      const now = clock.now();
      const p = ownProfile(ctx, req, pid);
      const save = ensureSave(db, p.id, now);
      const existing = getStash(db, body.stashId);
      if (existing) {
        if (existing.save_id !== save.id) throw new ApiError('invalid', 422, 'stashId already used.', { issues: ['stashId: already used'] });
        return { status: 200, res: { stashId: existing.stash_id, pinnedUntil: existing.pinned_until } };
      }
      assertNotFull(ctx, req);
      if (accountBlobBytes(db, auth.accountId) + dec.sizeGz > ctx.config.maxAccountBytes) {
        throw new ApiError('quota', 413, 'Online storage for this account is full.', { maxBytes: ctx.config.maxAccountBytes });
      }
      const pinnedUntil = insertStash(db, save.id, {
        stashId: body.stashId,
        reason: body.reason,
        deviceName: auth.deviceName,
        saveVersion: dec.saveVersion,
        meta: body.meta,
        clientSavedAt: body.clientSavedAt,
        sizeRaw: dec.sizeRaw,
        sizeGz: dec.sizeGz,
        sha256: dec.sha256,
        blob: dec.gz,
      }, now);
      return { status: 201, res: { stashId: body.stashId, pinnedUntil } };
    });
    return send<Omit<StashResponse, 'serverTime'>>(ctx, reply, out.status, out.res);
  });
}
