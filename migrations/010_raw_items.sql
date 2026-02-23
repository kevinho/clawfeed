CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  author TEXT DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  dedup_key TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  UNIQUE(source_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_raw_items_source_fetched ON raw_items(source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_items_fetched ON raw_items(fetched_at DESC);
