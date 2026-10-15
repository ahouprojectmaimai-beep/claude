-- TUMIKI 予約システム 初期スキーマ

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,                       -- 予約管理ID (UUIDからハイフンを除いた32桁hex。Googleイベントidにも使う)
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','failed')),
  start_ts INTEGER NOT NULL,                 -- UTC秒
  end_ts INTEGER NOT NULL,
  block_start_ts INTEGER NOT NULL,           -- 前後の余裕時間を含む占有範囲
  block_end_ts INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('online','office','visit')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  location_name TEXT NOT NULL DEFAULT '',
  location_address TEXT NOT NULL DEFAULT '',
  location_source TEXT NOT NULL DEFAULT '' CHECK (location_source IN ('','office','customer','admin')),
  address_unconfirmed INTEGER NOT NULL DEFAULT 0,
  meet_url TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT '',
  manage_token_hash TEXT NOT NULL,
  cancelled_by TEXT NOT NULL DEFAULT '' CHECK (cancelled_by IN ('','customer','admin','calendar','system')),
  externally_changed INTEGER NOT NULL DEFAULT 0,  -- Googleカレンダー側で直接変更された
  fail_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bookings_block ON bookings (status, block_start_ts, block_end_ts);
CREATE INDEX idx_bookings_event ON bookings (event_id);
CREATE INDEX idx_bookings_email ON bookings (email, status, start_ts);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 管理者のGoogleアカウント（refresh_token は AES-GCM で暗号化済みの文字列）
CREATE TABLE google_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  connected_at INTEGER NOT NULL
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- confirmed / changed / cancelled / reminder など
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_booking ON mail_log (booking_id, created_at);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
