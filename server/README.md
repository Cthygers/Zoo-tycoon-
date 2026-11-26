# Wildhaven API server

The online part of Wildhaven Zoo: Google sign-in, family player profiles, cloud saves for each
player's main zoo, and Versus matches. One small Node process with a SQLite file. It is built for a
family-sized load on one VPS behind Caddy.

- Stack: Node ≥ 22.13 (the image uses Node 26), Fastify 5, `node:sqlite`, jose (Google ID tokens),
  zod (validation), @fastify/cors and @fastify/rate-limit. Tests use vitest.
- The HTTP contract is `api.md` (design folder). Request and response types are shared with the
  game in `../shared/api-types.ts`. Versus rules, name checks and limits are also in `../shared/`.
- There is no refresh endpoint. Sign-in returns one opaque `whs_…` session token, kept 180 days
  from last use (refreshed at most once a day) and at most 2 years in total.

## Layout

```
server/
  src/main.ts          env → config → db → migrate → listen; hourly housekeeping, backups, DB size check
  src/app.ts           createApp({ db, clock, verifier, config, log? }) — the Fastify app, no listen()
  src/cli.ts           owner tools: backup | restore | restore-revision | flags | revoke | purge
  src/config.ts        env parsing (zod) and production checks
  src/db/*.ts          all SQL: sqlite adapter, migrations, backups, housekeeping, accounts, sessions,
                       profiles, saves, versus (incl. the seat-based DTO serializer)
  src/auth/*.ts        Google ID-token verifier, nonces, Bearer sessions, hooks and rate limiters
  src/routes/*.ts      one file per area (health/config, auth, account, profiles, saves, versus, public)
  migrations/*.sql     numbered schema files (PRAGMA user_version)
  public/*.html        /privacy and /account/delete ({{CONTACT_EMAIL}} is filled in at startup)
  test/*.test.ts       vitest suites (in-process, temp DB, fake Google)
  test/support/        fakeGoogle.ts, testApp.ts, injectFetch.ts (used by the integrator too)
  Dockerfile  Dockerfile.dockerignore  docker-compose.yml  docker-compose.caddynet.yml
  .env.example  Caddyfile.example
```

## Tests

```
cd server
npm ci
npm run typecheck      # src + shared (no DOM), then tests
npm test               # all suites, in-process with app.inject — no ports, no network
```

On Node 22, `node:sqlite` prints one `ExperimentalWarning` per process. That is expected; Node 24
and 26 don't print it. The suites:

| Suite | Covers |
|---|---|
| `auth` | sign-in, wrong aud/iss, expiry, future iat, bad signature, unknown kid, nonces, `ALLOWED_EMAILS`, sliding/absolute expiry, sign-out, no refresh route, `MIN_APP_VERSION` |
| `account-delete` | fresh re-auth, `reauth_mismatch`, every row wiped, "Player left", other accounts untouched |
| `profiles` | CRUD, 8-player limit, names (shared fixtures), prefs size, soft delete/undo/purge, IDOR matrix |
| `saves` | CAS 200/412, replay, `pushIds`, `keep_local` pin, retention, size/zip-bomb/checksum/bad save/quota, 507, new epoch after restore |
| `lease`, `stash` | lease life cycle and conflicts; stash create/replay/quota/expiry |
| `versus` | create/join/limits, snapshots (idempotent, bad snapshots, pace, family), device binding, series, finish/forfeit/cancel/rematch, every `decideOutcome` branch, expiry, **deep key scan** of every versus response |
| `security` | CORS, body limits, rate limits, 401 on every `/v1` route (from the route table), log redaction, static pages |
| `migrations`, `backup` | fresh → latest, pre-migration backup, refuse newer DB, snapshots, retention 8 + 14 daily, CLI commands |
| `quota` | final saves cannot fill the DB (family: none kept; coded: a quarter of `MAX_ACCOUNT_BYTES`, then dropped), rematch counts as a create, 30 new matches a day per account, save quota measured after retention |
| `restore` | 507 clears once space is free, fail-safe restore (bad file, newer schema, API still running), kept copy has the `-wal` commits, deleted accounts and `revoke`s survive a restore |
| `anticheat` | early `budget` ends refused (family: flagged), bounded snapshot numbers, `burst` and `same_device` flags, rematch honours `VERSUS_LENGTHS` |
| `access` | `ALLOWED_EMAILS` on live sessions (delete still allowed), per-IP limits on the IPv6 /64 |
| `names-filter` | homoglyph, glued-root and "Zalgo" names (runs once `shared/` has `WORDLIST_VERSION` 2) |

## Running locally against the fake Google

The fake issuer signs real RS256 ID tokens with a local key and serves its JWKS, so the server
runs its normal verification code path.

```
cd server
npm run build
npm run fake-google -- 8799            # terminal 1: prints GOOGLE_JWKS_URL / GOOGLE_ISSUERS

# terminal 2:
NODE_ENV=test PORT=8787 HOST=127.0.0.1 DB_PATH=./data/dev.db BACKUP_EVERY_HOURS=0 \
GOOGLE_CLIENT_IDS=e2e-web-client \
GOOGLE_JWKS_URL=http://127.0.0.1:8799/jwks GOOGLE_ISSUERS=http://127.0.0.1:8799 \
ALLOWED_ORIGINS=http://localhost:5173 VERSUS_TEST_LENGTH=1 LEASE_SECONDS=20 \
node dist/server/src/main.js
```

Sign in by hand:

```
NONCE=$(curl -s -X POST -H 'content-type: application/json' -d '{}' 127.0.0.1:8787/v1/auth/nonce | jq -r .nonce)
IDT=$(curl -s "127.0.0.1:8799/token?sub=parent1&email=parent1@example.com&aud=e2e-web-client&nonce=$NONCE" | jq -r .idToken)
curl -s -X POST -H 'content-type: application/json' 127.0.0.1:8787/v1/auth/google \
  -d "{\"idToken\":\"$IDT\",\"nonce\":\"$NONCE\",\"device\":{\"id\":\"dev-laptop-0001\",\"name\":\"Laptop\",\"platform\":\"web\",\"appVersion\":\"0.15.0\"}}"
```

`NODE_ENV=test` (or `development`) is required for a non-Google JWKS URL or issuer: production
refuses to start with them. `VERSUS_TEST_LENGTH=1` allows the 4-minute (2 zoo days) match length
outside production. The game's dev build points at this server with `VITE_API_BASE`,
`VITE_GOOGLE_WEB_CLIENT_ID=e2e-web-client` and `VITE_FAKE_GOOGLE_URL=http://127.0.0.1:8799`.

In code (tests, contract test, e2e):

```ts
import { createFakeGoogle, startFakeGoogle } from './test/support/fakeGoogle.js';
import { makeTestApp } from './test/support/testApp.js';
import { injectFetch } from './test/support/injectFetch.js';

const t = await makeTestApp({ LEASE_SECONDS: '20' });  // env-style or camelCase AppConfig overrides
const { token, accountId } = await t.signIn('parent1');  // nonce → fake ID token → POST /v1/auth/google
t.clock.advance(60_000);                                  // FakeClock drives every server time check
const fetchLike = injectFetch(t.app);                     // a fetch that calls app.inject, no sockets
t.newEpoch();                                             // as after `cli restore` (S4)
await t.close();
```

`makeTestApp` defaults: `NODE_ENV=test`, a temp DB, backups off, `GOOGLE_CLIENT_IDS=test-web-client`,
`VERSUS_TEST_LENGTH=1`, `CONTACT_EMAIL=owner@example.test`.

## Configuration

Set these in `server/.env` (see `.env.example`). Everything has a sensible default except the first two.

| Variable | Default | Notes |
|---|---|---|
| `GOOGLE_CLIENT_IDS` | — (required) | the Google OAuth **Web** client id (comma list allowed) |
| `CONTACT_EMAIL` | — (required in production) | shown on `/privacy` and `/account/delete` |
| `ALLOWED_ORIGINS` | `https://localhost` | CORS allowlist (the Android app); add `http://localhost:5173` for browser dev |
| `VERSUS_LENGTHS` | `30,60,90,120` | match lengths offered; drop `90,120` if the phone soak test fails |
| `ALLOWED_EMAILS` | empty | optional allowlist of Google emails, checked at sign-in **and on every request** (removing an address signs it out at once) |
| `NODE_ENV` | `production` | production requires Google's JWKS/issuers and refuses `VERSUS_TEST_LENGTH=1` |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | inside the container |
| `DB_PATH` / `BACKUP_DIR` | `/data/wildhaven.db` / `<DB dir>/backups` | |
| `BACKUP_EVERY_HOURS` / `BACKUP_KEEP_RECENT` / `BACKUP_KEEP_DAILY` | `6` / `8` / `14` | `0` turns scheduled backups off |
| `GOOGLE_ISSUERS` / `GOOGLE_JWKS_URL` | Google's | point at the fake only with `NODE_ENV=test` |
| `TRUST_PROXY` | `127.0.0.1,::1,172.16.0.0/12` | the Caddy hop (real client IPs for rate limits) |
| `MAX_PROFILES` | `8` | active players per account |
| `MAX_ACCOUNT_BYTES` | `16777216` | save bytes per account that stay stored (newest 10 per player, pins, stashes; measured after retention) → `413 quota`. Versus final saves get a further quarter of it; past that they are dropped, not refused |
| `MAX_DB_BYTES` | `2147483648` | bytes in use in the DB (free pages not counted) → `507 server_full` and an unhealthy `/healthz` |
| `LEASE_SECONDS` | `150` | one device plays a zoo at a time |
| `VERSUS_TEST_LENGTH` | `0` | `1` = allow the 4-minute test match (not in production) |
| `MIN_APP_VERSION` | empty | older apps get `426 upgrade_required` |
| `LOG_LEVEL` | `info` | JSON logs to stdout |

## Running it on the server (Docker + Caddy)

The image is built from the **repo root** (it compiles `../shared`):

```
cd ~/wildhaven/server
cp .env.example .env && nano .env        # GOOGLE_CLIENT_IDS, CONTACT_EMAIL
docker compose up -d --build
docker compose ps                         # api: healthy
curl -s http://127.0.0.1:8787/healthz     # {"ok":true,...}
```

- Caddy on the host: add `Caddyfile.example` (with your domain) to `/etc/caddy/Caddyfile`, then
  `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
- Caddy in Docker: set `CADDY_NETWORK` in `.env`, start with
  `docker compose -f docker-compose.yml -f docker-compose.caddynet.yml up -d --build` and use
  `reverse_proxy wildhaven-api-1:8080` in the site block.
- The container runs as the non-root `node` user with a read-only root filesystem, no capabilities,
  `no-new-privileges`, 384 MB of memory, and a health check on `/healthz`. The port is bound to
  `127.0.0.1:8787` only. Data lives in the `wildhaven-data` volume (`/data`).
- Updating: `git pull && docker compose up -d --build`. Pending migrations run at start, after a
  `pre-migrate-*.db.gz` backup. A database newer than the image is refused rather than touched.

## Backups and support tools

- Automatic: every `BACKUP_EVERY_HOURS` (6) an online snapshot is written to
  `/data/backups/wildhaven-YYYYMMDDTHHMMZ.db.gz`. The newest 8 are kept, plus the newest of each of
  the last 14 days. `/healthz` shows `backup: "stale"` (and turns unhealthy) after two missed intervals.
- Off-site (recommended): copy `/var/lib/docker/volumes/wildhaven_wildhaven-data/_data/backups`
  every night, for example with restic to a Hetzner Storage Box.

Commands. Run them inside the container: `docker compose exec api node dist/server/src/cli.js <command>`.
Locally, use `npm run cli -- <command>` with `DB_PATH` set.

| Command | What it does |
|---|---|
| `backup` | write a snapshot now (plus retention) |
| `restore <file.db.gz>` | **API stopped** (refused while it runs): check the backup in a temp file first (integrity, migrate, newer schema refused), apply `deletions.log` again, write a **new epoch**; only then swap it in. The old DB is kept, with its `-wal` folded in, as `<db>.pre-restore-<ts>`. A failed restore leaves the live DB untouched |
| `restore-revision --profile <id> --rev <n>` | make an older revision of a player's zoo the head again (the replaced head is pinned 30 days) |
| `restore-revision --profile <id> --stash <id>` | the same for a stashed copy (a zoo that lost a conflict) |
| `flags [--match <id>]` | Versus seats the server flagged: `pace`, `over_budget`, `cap_*`, `burst` (uploaded far faster than playable: idle then burst, or played offline), `same_device` (both seats of a non-family match on one install), `early_budget` (family match ended by budget too early), `save_dropped` (final save over the account's share) |
| `vacuum` | **API stopped** (refused while it runs): rewrite the DB file without its free pages |
| `revoke --account <id>` / `revoke --email <addr>` | sign that account out on every device (lost phone, address removed from `ALLOWED_EMAILS`); logged so a restore keeps it |
| `purge` | run the hourly housekeeping now |

Restore:

```
docker compose stop api
docker compose run --rm api node dist/server/src/cli.js restore /data/backups/<file>.db.gz
docker compose start api
```

A new epoch means every phone re-checks its zoos. A zoo with more play on the phone than in the
backup is uploaded again, and a phone with less play pulls the backup copy. Sign-ins and Versus
matches made after the backup are gone. Phones keep those zoos as practice, and people sign in again.

Account deletions and `revoke`s are appended to `BACKUP_DIR/deletions.log` (random internal ids and
times only), and every restore applies them again, so a restore never brings a deleted family back.
Keep that file with the backups (the off-site copy of `/data/backups` includes it).

Disk space: deleted rows leave free pages inside the file. They are reused before the file grows and
do not count toward `MAX_DB_BYTES`, but the file itself never shrinks. To give the space back to the
disk (it needs about the DB's size free for a moment):

```
docker compose stop api
docker compose run --rm api node dist/server/src/cli.js vacuum
docker compose start api
```

## Behaviour notes

- Every query is scoped to the caller's account. Another account's id answers `404`, never `403`.
- Versus responses are seat-based: no profile id, account id, email or device name of the other seat
  is ever sent. `test/versus.test.ts` deep-scans every versus response it makes.
- Versus limits: 3 active matches and 1 open code per player, 10 new matches (create or rematch) a
  day per player and 30 per account, 10 an hour per account.
- A removed player is soft-deleted for 30 days (`POST …/restore` undoes it). Then housekeeping
  deletes the player, its saves and stashes, and its match seats show "Player left".
- Logs are JSON lines with the route template, status, time, request id and internal account id.
  Tokens, emails, names, bodies and IP addresses are never logged. Security events are logged at
  `warn` with a `kind`: `token_invalid`, `nonce_invalid`, `rate_limited`, `idor_denied`, `zip_bomb`,
  `pace_flag`, `server_full`, `reauth_mismatch`, `not_allowed`.
