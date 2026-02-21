CREATE TABLE IF NOT EXISTS user_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subs_source ON user_subscriptions(source_id);
