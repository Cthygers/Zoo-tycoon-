#!/usr/bin/env node
// Uploads a signed release bundle to the Google Play INTERNAL testing track through the Android
// Publisher API (v3), authenticated as the service account in PLAY_SERVICE_ACCOUNT_JSON.
//
// The track is fixed: nothing in this script can release to alpha, beta or production.
//
// Commands (used by .github/workflows/play-internal.yml):
//   next-version-code --min <n>
//       Prints max(n, highest version code Play has seen + 1) on stdout.
//   upload --aab <file> --version-code <n> --release-name <text> [--notes-file <file>]
//       One edit: refuses a version code that is not above Play's highest, uploads the bundle,
//       sets it as the internal track's only release (status completed) and commits.
//
// The service account key and the access token are never printed. Progress goes to stderr.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'com.wildhaven.zoo';
export const TRACK = 'internal';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://androidpublisher.googleapis.com';
/** Play's limit for a release note per language. */
export const MAX_NOTES = 500;

const log = (msg) => process.stderr.write(`[play] ${msg}\n`);

/** Parses the service account key JSON; errors never echo its content. */
export function parseServiceAccount(json) {
  let sa;
  try {
    sa = JSON.parse(json);
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!sa || sa.type !== 'service_account' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not a service account key (needs type, client_email, private_key)');
  }
  return { clientEmail: sa.client_email, privateKey: sa.private_key };
}

const b64url = (data) => Buffer.from(data).toString('base64url');

/** A signed RS256 JWT asking Google's token endpoint for an Android Publisher access token. */
export function signJwt(sa, nowSeconds) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(sa.privateKey).toString('base64url')}`;
}

/** Google API error text without request bodies or credentials. */
async function describe(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.error_description ?? (typeof body?.error === 'string' ? body.error : '');
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
}

const transient = (status) => status === 429 || status >= 500;

/** fetch with a timeout and, for idempotent calls, up to 3 attempts on network errors, 429 and 5xx. */
async function call(fetchImpl, url, init, { retry, timeoutMs }) {
  const attempts = retry ? 3 : 1;
  for (let i = 1; ; i++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!transient(res.status) || i >= attempts) return res;
    } catch (e) {
      if (i >= attempts) throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname}: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
}

export async function getAccessToken(sa, { fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, nowSeconds) });
  const res = await call(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, { retry: true, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Google sign-in for ${sa.clientEmail} failed: ${await describe(res)}`);
  const token = (await res.json())?.access_token;
  if (typeof token !== 'string' || !token) throw new Error('Google sign-in returned no access token');
  return token;
}

/** The handful of Android Publisher edit calls this release needs. */
export class PlayEdits {
  constructor(token, { fetchImpl = fetch, apiRoot = API_ROOT, packageName = PACKAGE_NAME } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.base = `${apiRoot}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`;
    this.uploadBase = `${apiRoot}/upload/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`;
  }

  async request(method, url, { json, bytes, retry = false, timeoutMs = 60_000 } = {}) {
    const headers = { authorization: `Bearer ${this.token}` };
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = bytes;
    }
    const res = await call(this.fetchImpl, url, { method, headers, body }, { retry, timeoutMs });
    if (!res.ok) throw new Error(`${method} ${new URL(url).pathname}: ${await describe(res)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async insert() {
    const edit = await this.request('POST', this.base, { json: {} });
    if (!edit?.id) throw new Error('Play did not return an edit id');
    return edit.id;
  }
  tracks(editId) {
    return this.request('GET', `${this.base}/${editId}/tracks`, { retry: true });
  }
  bundles(editId) {
    return this.request('GET', `${this.base}/${editId}/bundles`, { retry: true });
  }
  uploadBundle(editId, bytes) {
    return this.request('POST', `${this.uploadBase}/${editId}/bundles?uploadType=media`, { bytes, timeoutMs: 600_000 });
  }
  setTrack(editId, release) {
    return this.request('PUT', `${this.base}/${editId}/tracks/${TRACK}`, { json: { track: TRACK, releases: [release] } });
  }
  commit(editId) {
    return this.request('POST', `${this.base}/${editId}:commit`);
  }
  async discard(editId) {
    try {
      await this.request('DELETE', `${this.base}/${editId}`);
    } catch (e) {
      log(`could not delete edit ${editId}: ${e.message}`);
    }
  }

  /** The highest version code in any track or among the uploaded bundles (0 if none). */
  async highestVersionCode(editId) {
    const [t, b] = await Promise.all([this.tracks(editId), this.bundles(editId)]);
    const codes = [
      ...(t?.tracks ?? []).flatMap((tr) => (tr.releases ?? []).flatMap((r) => r.versionCodes ?? [])),
      ...(b?.bundles ?? []).map((x) => x.versionCode),
    ]
      .map(Number)
      .filter(Number.isSafeInteger);
    return codes.length ? Math.max(...codes) : 0;
  }
}

/** max(min, Play's highest + 1), from a throwaway edit. */
export async function nextVersionCode(play, min) {
  const editId = await play.insert();
  try {
    return Math.max(min, (await play.highestVersionCode(editId)) + 1);
  } finally {
    await play.discard(editId);
  }
}

/** Builds the internal-track release body; only the internal track exists in this module. */
export function internalRelease({ versionCode, releaseName, notes }) {
  const release = { name: releaseName, versionCodes: [String(versionCode)], status: 'completed' };
  if (notes) release.releaseNotes = [{ language: 'en-US', text: notes }];
  return release;
}

export async function publishInternal(play, { aab, versionCode, releaseName, notes }) {
  if (notes && notes.length > MAX_NOTES) throw new Error(`release notes are ${notes.length} characters; Play allows ${MAX_NOTES}`);
  const editId = await play.insert();
  let committed = false;
  try {
    const highest = await play.highestVersionCode(editId);
    if (versionCode <= highest) throw new Error(`version code ${versionCode} is not above the highest Play has seen (${highest})`);
    log(`uploading ${aab.length} bytes as version code ${versionCode}`);
    const uploaded = await play.uploadBundle(editId, aab);
    if (Number(uploaded?.versionCode) !== versionCode) {
      throw new Error(`Play read version code ${uploaded?.versionCode} from the bundle, expected ${versionCode}`);
    }
    await play.setTrack(editId, internalRelease({ versionCode, releaseName, notes }));
    await play.commit(editId);
    committed = true;
    log(`released version code ${versionCode} ("${releaseName}") to the ${TRACK} track`);
    return { editId, versionCode, sha256: uploaded.sha256 };
  } finally {
    if (!committed) await play.discard(editId);
  }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument near "${argv[i]}"`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 2_100_000_000) throw new Error(`${name} must be a whole number from 1 to 2100000000`);
  return n;
}

async function main([command, ...rest]) {
  const opts = args(rest);
  const sa = parseServiceAccount(process.env.PLAY_SERVICE_ACCOUNT_JSON ?? '');
  const play = new PlayEdits(await getAccessToken(sa));
  if (command === 'next-version-code') {
    process.stdout.write(`${await nextVersionCode(play, positiveInt(opts.min, '--min'))}\n`);
  } else if (command === 'upload') {
    if (!opts.aab || !opts['release-name']) throw new Error('upload needs --aab and --release-name');
    const notes = opts['notes-file'] ? readFileSync(opts['notes-file'], 'utf8').trim() : '';
    await publishInternal(play, { aab: readFileSync(opts.aab), versionCode: positiveInt(opts['version-code'], '--version-code'), releaseName: opts['release-name'], notes });
  } else {
    throw new Error('usage: publish-internal.mjs next-version-code --min <n> | upload --aab <file> --version-code <n> --release-name <text> [--notes-file <file>]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`[play] ${e.message}\n`);
    process.exit(1);
  });
}
