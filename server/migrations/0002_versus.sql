-- 0002_versus.sql: versus matches, seats and stored snapshots.
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('coded','family','rematch')),
  code TEXT UNIQUE,
  length_min INTEGER NOT NULL, days INTEGER NOT NULL, seed INTEGER NOT NULL,
  rules_version INTEGER NOT NULL, start_money INTEGER NOT NULL, budget_min INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','active','finished','expired','cancelled')),
  created_at INTEGER NOT NULL, code_expires_at INTEGER, joined_at INTEGER, finish_by INTEGER,
  invited_profile_id TEXT, finished_at INTEGER, result TEXT
) STRICT;
CREATE TABLE match_seats (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat IN (0,1)),
  profile_id TEXT, account_id TEXT,                   -- NULL = "Player left"; never serialised
  name TEXT NOT NULL, avatar TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  device_id TEXT, device_name TEXT, first_snapshot_at INTEGER,
  ack_hour INTEGER NOT NULL DEFAULT 0, last_total INTEGER NOT NULL DEFAULT 0, last_parts TEXT, last_post_at INTEGER,
  done_at INTEGER, end_hour INTEGER, end_reason TEXT CHECK (end_reason IN ('complete','budget','deadline','forfeit')),
  final_save BLOB, flags TEXT NOT NULL DEFAULT '[]', app_version TEXT,
  PRIMARY KEY (match_id, seat)
) STRICT;
CREATE INDEX match_seats_profile ON match_seats(profile_id);
CREATE TABLE match_snapshots (
  match_id TEXT NOT NULL, seat INTEGER NOT NULL, h INTEGER NOT NULL,
  total INTEGER NOT NULL, parts TEXT NOT NULL, extra TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, seat, h),
  FOREIGN KEY (match_id, seat) REFERENCES match_seats(match_id, seat) ON DELETE CASCADE
) STRICT;
