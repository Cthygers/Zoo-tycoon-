// node --test scripts/play/ — the Play publisher against a fake Google (no network, throwaway key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { PlayEdits, TRACK, getAccessToken, internalRelease, nextVersionCode, parseServiceAccount, publishInternal } from './publish-internal.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_JSON = JSON.stringify({ type: 'service_account', client_email: 'publisher@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const API = 'https://androidpublisher.googleapis.com';

/** A fake Play: records every call and answers like the v3 API. */
function fakePlay({ trackCodes = ['15'], bundleCodes = [12, 13, 14, 15], readCode, fail = {} } = {}) {
  const calls = [];
  const edits = new Set();
  let nextEdit = 1;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const key = `${method} ${u.pathname}`;
    calls.push({ key, init });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (fail[key.replace(/edits\/\d+/, 'edits/:id')]) return json(fail[key.replace(/edits\/\d+/, 'edits/:id')], { error: { message: 'nope' } });
    const base = '/androidpublisher/v3/applications/com.wildhaven.zoo/edits';
    if (key === `POST ${base}`) {
      const id = String(nextEdit++);
      edits.add(id);
      return json(200, { id, expiryTimeSeconds: '9999999999' });
    }
    const m = u.pathname.match(/edits\/(\d+)(.*)$/);
    assert.ok(m && edits.has(m[1]), `unknown edit in ${key}`);
    const rest = m[2];
    if (method === 'GET' && rest === '/tracks') return json(200, { tracks: [{ track: 'internal', releases: [{ name: '15 (0.15.0)', versionCodes: trackCodes, status: 'completed' }] }, { track: 'production' }] });
    if (method === 'GET' && rest === '/bundles') return json(200, { bundles: bundleCodes.map((versionCode) => ({ versionCode, sha256: 'x' })) });
    if (method === 'POST' && u.pathname.startsWith(`/upload${base}`) && rest === '/bundles') {
      assert.equal(u.searchParams.get('uploadType'), 'media');
      return json(200, { versionCode: readCode, sha1: 'a', sha256: 'b' });
    }
    if (method === 'PUT' && rest === `/tracks/${TRACK}`) return json(200, JSON.parse(init.body));
    if (method === 'POST' && rest === ':commit') return json(200, { id: m[1] });
    if (method === 'DELETE' && rest === '') {
      edits.delete(m[1]);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { message: `no route ${key}` } });
  };
  return { fetchImpl, calls, edits };
}

test('the token request is a JWT signed with the service account key, for the publisher scope only', async () => {
  const sa = parseServiceAccount(SA_JSON);
  let form;
  const token = await getAccessToken(sa, {
    nowSeconds: 1_000_000,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      form = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(token, 'ya29.test');
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, s] = form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(claims, { iss: 'publisher@example.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: 1_000_000, exp: 1_003_600 });
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
});

test('a bad key or a refused sign-in fails without echoing the key', async () => {
  assert.throws(() => parseServiceAccount('{not json'), /not valid JSON/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user', private_key: 'SECRET' })), (e) => !e.message.includes('SECRET'));
  const sa = parseServiceAccount(SA_JSON);
  await assert.rejects(
    getAccessToken(sa, { fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 }) }),
    (e) => /HTTP 400: Invalid JWT Signature/.test(e.message) && !e.message.includes('PRIVATE KEY'),
  );
});

test('next version code is above everything Play has seen, never below the floor, and the edit is discarded', async () => {
  const p = fakePlay({ trackCodes: ['15'], bundleCodes: [12, 13, 14, 15] });
  const play = new PlayEdits('t', { fetchImpl: p.fetchImpl, apiRoot: API });
  assert.equal(await nextVersionCode(play, 16), 16);
  assert.equal(await nextVersionCode(play, 3), 16);
  assert.equal(await nextVersionCode(play, 40), 40);
  const q = fakePlay({ trackCodes: ['21'], bundleCodes: [12, 30] });
  assert.equal(await nextVersionCode(new PlayEdits('t', { fetchImpl: q.fetchImpl, apiRoot: API }), 16), 31);
  assert.equal(p.edits.size, 0, 'every throwaway edit deleted');
  assert.ok(p.calls.every((c) => c.key.startsWith('DELETE') || !c.key.includes(':commit')), 'nothing committed');
});

test('publish uploads, puts the bundle on the internal track only, commits once', async () => {
  const p = fakePlay({ readCode: 16 });
  const play = new PlayEdits('ya29.secret-token', { fetchImpl: p.fetchImpl, apiRoot: API });
  const res = await publishInternal(play, { aab: Buffer.from('PK fake'), versionCode: 16, releaseName: '16 (0.15.1)', notes: 'Louder animals' });
  assert.equal(res.versionCode, 16);
  const keys = p.calls.map((c) => c.key.replace(/edits\/\d+/, 'edits/:id'));
  const base = '/androidpublisher/v3/applications/com.wildhaven.zoo/edits';
  assert.deepEqual(keys, [`POST ${base}`, `GET ${base}/:id/tracks`, `GET ${base}/:id/bundles`, `POST /upload${base}/:id/bundles`, `PUT ${base}/:id/tracks/internal`, `POST ${base}/:id:commit`]);
  const put = p.calls.find((c) => c.key.startsWith('PUT'));
  assert.deepEqual(JSON.parse(put.init.body), { track: 'internal', releases: [{ name: '16 (0.15.1)', versionCodes: ['16'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Louder animals' }] }] });
  assert.ok(p.calls.filter((c) => c.key.includes('/tracks/')).every((c) => c.key.endsWith('/tracks/internal')), 'no other track is ever written');
  assert.equal(p.calls.find((c) => c.key.startsWith('POST /upload')).init.headers['content-type'], 'application/octet-stream');
  assert.ok(p.calls.every((c) => c.init.headers?.authorization === 'Bearer ya29.secret-token'));
});

test('the release body is internal-only and omits empty notes', () => {
  assert.deepEqual(internalRelease({ versionCode: 17, releaseName: '17 (0.15.2)', notes: '' }), { name: '17 (0.15.2)', versionCodes: ['17'], status: 'completed' });
  assert.equal(TRACK, 'internal');
});

test('a version code that is not above Play\'s highest is refused before uploading, and the edit is discarded', async () => {
  const p = fakePlay({ trackCodes: ['15'], readCode: 15 });
  const play = new PlayEdits('t', { fetchImpl: p.fetchImpl, apiRoot: API });
  await assert.rejects(publishInternal(play, { aab: Buffer.from('x'), versionCode: 15, releaseName: '15' }), /not above the highest Play has seen \(15\)/);
  assert.ok(!p.calls.some((c) => c.key.startsWith('POST /upload')));
  assert.equal(p.edits.size, 0);
});

test('a bundle whose manifest disagrees with the expected version code is never released', async () => {
  const p = fakePlay({ readCode: 99 });
  const play = new PlayEdits('t', { fetchImpl: p.fetchImpl, apiRoot: API });
  await assert.rejects(publishInternal(play, { aab: Buffer.from('x'), versionCode: 16, releaseName: '16' }), /read version code 99 .* expected 16/);
  assert.ok(!p.calls.some((c) => c.key.startsWith('PUT') || c.key.includes(':commit')));
  assert.equal(p.edits.size, 0);
});

test('a failed commit discards the edit and reports Google\'s message', async () => {
  const p = fakePlay({ readCode: 16, fail: { 'POST /androidpublisher/v3/applications/com.wildhaven.zoo/edits/:id:commit': 403 } });
  const play = new PlayEdits('t', { fetchImpl: p.fetchImpl, apiRoot: API });
  await assert.rejects(publishInternal(play, { aab: Buffer.from('x'), versionCode: 16, releaseName: '16' }), /:commit: HTTP 403: nope/);
  assert.equal(p.edits.size, 0);
});

test('release notes over Play\'s 500-character limit are refused before any call', async () => {
  const p = fakePlay({ readCode: 16 });
  const play = new PlayEdits('t', { fetchImpl: p.fetchImpl, apiRoot: API });
  await assert.rejects(publishInternal(play, { aab: Buffer.from('x'), versionCode: 16, releaseName: '16', notes: 'a'.repeat(501) }), /501 characters/);
  assert.equal(p.calls.length, 0);
});

test('reads are retried on 503, writes are not', async () => {
  let tracksCalls = 0;
  const p = fakePlay({ readCode: 16 });
  const flaky = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET' && url.endsWith('/tracks') && tracksCalls++ === 0) return new Response('{}', { status: 503 });
    return p.fetchImpl(url, init);
  };
  const play = new PlayEdits('t', { fetchImpl: flaky, apiRoot: API });
  assert.equal(await nextVersionCode(play, 1), 16);
  assert.equal(tracksCalls, 2);
});
