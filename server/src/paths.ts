// paths.ts — locate server/migrations and server/public both from src/ (vitest, tsx) and from
// dist/server/src/ (compiled; the Docker image keeps them at /app/migrations and /app/public).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

/** The directory holding migrations/0001_init.sql (server/ in the repo, /app in the image). */
export function serverRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'migrations', '0001_init.sql'))) return (cachedRoot = dir);
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  throw new Error('cannot find the server directory (migrations/0001_init.sql) above ' + fileURLToPath(import.meta.url));
}

export const migrationsDir = (): string => join(serverRoot(), 'migrations');
export const publicDir = (): string => join(serverRoot(), 'public');
