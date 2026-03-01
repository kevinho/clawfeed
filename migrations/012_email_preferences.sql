-- Email digest preferences and unsubscribe tokens
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  frequency TEXT NOT NULL DEFAULT 'off',  -- 'off', 'daily', 'weekly'
  last_sent_at TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_prefs_frequency ON email_preferences(frequency);
CREATE INDEX IF NOT EXISTS idx_email_prefs_unsub_token ON email_preferences(unsubscribe_token);

-- Track sent emails for retry/dedup
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  digest_id INTEGER REFERENCES digests(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'failed'
  resend_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(user_id);
CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log(status);
