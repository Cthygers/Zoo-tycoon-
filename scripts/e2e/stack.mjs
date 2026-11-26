// The local e2e stack (spec §10.2): the fake Google issuer, the built API server on a temp DB and the
// game served by Vite. Every process this module starts is tracked and stopped by stopAll().
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SERVER_DIR = join(REPO, 'server');
export const PORTS = { vite: 5199, api: 8787, google: 8799 };
export const ORIGIN = `http://127.0.0.1:${PORTS.vite}`;
export const API = `http://127.0.0.1:${PORTS.api}`;
export const GOOGLE = `http://127.0.0.1:${PORTS.google}`;
export const WEB_CLIENT_ID = 'e2e-web-client';

const stoppers = [];
export function onStop(fn) {
  stoppers.push(fn);
}
export async function stopAll() {
  while (stoppers.length) {
    const fn = stoppers.pop();
    try {
      await fn();
    } catch (e) {
      console.warn('[stack] stop failed', e?.message ?? e);
    }
  }
}

const log = (...a) => console.log('[stack]', ...a);

/** `npm run build` + `npm run build:support` in server/ (dist/ and dist-test/, both git-ignored). */
export function buildServer() {
  for (const script of ['build', 'build:support']) {
    const r = spawnSync('npm', ['run', script], { cwd: SERVER_DIR, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`server ${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
}

export async function startFakeGoogle() {
  const mod = await import(pathToFileURL(join(SERVER_DIR, 'dist-test/server/test/support/fakeGoogle.js')).href);
  const g = await mod.startFakeGoogle(PORTS.google);
  onStop(() => g.close());
  log('fake Google', g.url, 'issuer', g.issuer);
  return g;
}

function waitHttp(url, ms, proc) {
  const until = Date.now() + ms;
  return new Promise((res, rej) => {
    const tick = async () => {
      if (proc && proc.exitCode !== null) return rej(new Error(`${url}: process exited with ${proc.exitCode}`));
      try {
        const r = await fetch(url);
        if (r.status < 500) return res();
      } catch {
        /* not up yet */
      }
      if (Date.now() > until) return rej(new Error(`${url} did not come up`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function track(name, child, logLines) {
  child.stdout?.on('data', (d) => logLines.push(...String(d).split('\n').filter(Boolean)));
  child.stderr?.on('data', (d) => logLines.push(...String(d).split('\n').filter(Boolean)));
  onStop(
    () =>
      new Promise((res) => {
        if (child.exitCode !== null || child.signalCode) return res();
        child.once('exit', () => res());
        try {
          // the process group: npx/vite children go too
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
          res();
        }, 4000);
      }),
  );
  log(name, 'pid', child.pid);
}

/** The built API server on 127.0.0.1:8787 with a fresh temp DB. Returns { dbPath, logs, pid }. */
export async function startApi(google, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wh-e2e-db-'));
  onStop(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'e2e.db');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    PORT: String(PORTS.api),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    BACKUP_DIR: join(dir, 'backups'),
    BACKUP_EVERY_HOURS: '0',
    GOOGLE_CLIENT_IDS: WEB_CLIENT_ID,
    GOOGLE_JWKS_URL: `${google.url}/jwks`,
    GOOGLE_ISSUERS: google.issuer,
    ALLOWED_ORIGINS: ORIGIN,
    LEASE_SECONDS: '20',
    VERSUS_TEST_LENGTH: '1',
    LOG_LEVEL: 'warn',
    ...extraEnv,
  };
  const logs = [];
  const child = spawn(process.execPath, ['--no-warnings', 'dist/server/src/main.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  track('api', child, logs);
  await waitHttp(`${API}/healthz`, 30_000, child);
  log('api up', API, 'db', dbPath);
  return { dbPath, logs, pid: child.pid };
}

/**
 * Vite (dev) on 127.0.0.1:5199 with a private cacheDir. `cloud` = the e2e cloud env (API base, the
 * fake Google, the test versus length); otherwise every VITE_* variable is removed.
 */
export async function startVite({ cloud, cacheDir }) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_')) delete env[k];
  if (cloud) {
    env.VITE_API_BASE = API;
    env.VITE_GOOGLE_WEB_CLIENT_ID = WEB_CLIENT_ID;
    env.VITE_FAKE_GOOGLE_URL = GOOGLE;
    env.VITE_VERSUS_TEST = '1';
  }
  const script = `
    const { createServer } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'node_modules/vite/dist/node/index.js')).href)});
    const server = await createServer({
      configFile: ${JSON.stringify(join(REPO, 'vite.config.ts'))},
      root: ${JSON.stringify(REPO)},
      cacheDir: ${JSON.stringify(cacheDir)},
      logLevel: 'warn',
      server: { port: ${PORTS.vite}, strictPort: true, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    console.log('vite ready');
    const stop = () => server.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  `;
  const logs = [];
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  track(`vite (${cloud ? 'cloud' : 'no cloud'})`, child, logs);
  await waitHttp(`${ORIGIN}/index.html`, 120_000, child);
  log('vite up', ORIGIN, cloud ? 'with VITE_API_BASE' : 'without VITE_API_BASE');
  return { logs, pid: child.pid, stop: null };
}

/** A production build without any VITE_* variable (E2E-6), into `outDir`. */
export function buildNoCloud(outDir, cacheDir) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('VITE_')) delete env[k];
  const script = `
    const { build } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'node_modules/vite/dist/node/index.js')).href)});
    await build({
      configFile: ${JSON.stringify(join(REPO, 'vite.config.ts'))},
      root: ${JSON.stringify(REPO)},
      cacheDir: ${JSON.stringify(cacheDir)},
      logLevel: 'warn',
      build: { outDir: ${JSON.stringify(outDir)}, emptyOutDir: true },
    });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, env, stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** A static server for a production build on the Vite port. */
export async function serveStatic(dir) {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', ORIGIN);
    let p = join(dir, decodeURIComponent(u.pathname));
    if (!p.startsWith(dir)) {
      res.writeHead(403);
      return res.end();
    }
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(PORTS.vite, '127.0.0.1', r));
  onStop(() => new Promise((r) => server.close(() => r())));
  log('static build on', ORIGIN, dir);
  return server;
}
