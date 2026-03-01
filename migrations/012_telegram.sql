-- Telegram push notification settings
CREATE TABLE IF NOT EXISTS telegram_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  digest_types TEXT NOT NULL DEFAULT '["4h","daily"]',
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id),
  UNIQUE(chat_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_links_chat ON telegram_links(chat_id);

-- Pending link codes (short-lived, for account binding)
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_username TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Push delivery log
CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  digest_id INTEGER,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_log_user ON push_log(user_id, created_at DESC);
