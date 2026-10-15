CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  chat_id TEXT,
  paired_at INTEGER,
  sent_bucket INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pairings_expires_at ON pairings (expires_at);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES pairings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS commands_device_created ON commands (device_id, created_at);

CREATE TABLE IF NOT EXISTS notification_receipts (
  device_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  telegram_message_id INTEGER,
  PRIMARY KEY (device_id, notification_id)
);
