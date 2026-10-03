-- PHASE 3: LINE受信まわり。一意キーで再送・二重処理を防ぐ。
CREATE TABLE IF NOT EXISTS line_events (
  webhook_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_type TEXT,
  group_id TEXT,
  user_id TEXT,
  message_id TEXT,
  timestamp INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_line_events_message ON line_events(message_id);

CREATE TABLE IF NOT EXISTS line_groups (
  group_id TEXT PRIMARY KEY,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  store_id TEXT,
  claim_message_id TEXT,
  duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_images_sha ON images(sha256);
CREATE INDEX IF NOT EXISTS idx_images_waiting ON images(group_id, user_id, status, posted_at);

CREATE TABLE IF NOT EXISTS store_claims (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  store_id TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON store_claims(group_id, user_id, posted_at);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
