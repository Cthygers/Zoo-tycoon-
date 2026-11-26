-- 0001_init.sql: accounts, sessions, nonces, profiles, saves (slot 'main'), revisions, stashes.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;           -- 'epoch' (8 chars), 'created_at'
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,                    -- sha256(whs_ token)
  device_id TEXT NOT NULL, device_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_touched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE auth_nonces (nonce_hash BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, name_key TEXT NOT NULL, avatar TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, purge_at INTEGER
) STRICT;
CREATE UNIQUE INDEX profiles_name ON profiles(account_id, name_key) WHERE deleted_at IS NULL;
CREATE INDEX profiles_account ON profiles(account_id);
CREATE TABLE saves (                                  -- one row per profile (slot 'main')
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  head_rev INTEGER NOT NULL DEFAULT 0, head_epoch TEXT,
  updated_at INTEGER NOT NULL,
  lease_device_id TEXT, lease_device_name TEXT, lease_until INTEGER, lease_seen_at INTEGER
) STRICT;
CREATE TABLE save_revisions (
  save_id INTEGER NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL, rev INTEGER NOT NULL,
  push_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL, app_version TEXT NOT NULL,
  save_version INTEGER NOT NULL, meta TEXT NOT NULL, client_saved_at INTEGER,
  size_raw INTEGER NOT NULL, size_gz INTEGER NOT NULL, sha256 TEXT NOT NULL,
  blob BLOB, pinned_until INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (save_id, epoch, rev)
) STRICT;
CREATE INDEX save_revisions_push ON save_revisions(save_id, push_id);
CREATE TABLE save_stash (
  stash_id TEXT PRIMARY KEY, save_id INTEGER NOT NULL REFERENCES saves(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, device_name TEXT NOT NULL, save_version INTEGER NOT NULL, meta TEXT NOT NULL,
  client_saved_at INTEGER, size_raw INTEGER NOT NULL, size_gz INTEGER NOT NULL, sha256 TEXT NOT NULL,
  blob BLOB NOT NULL, pinned_until INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;
