-- Migration 014: Mark Enhancement (#12)
-- Adds AI analysis, share tokens, and digest_id to marks

ALTER TABLE marks ADD COLUMN analysis TEXT DEFAULT NULL;
ALTER TABLE marks ADD COLUMN analyzed_at TEXT DEFAULT NULL;
ALTER TABLE marks ADD COLUMN share_token TEXT DEFAULT NULL;
ALTER TABLE marks ADD COLUMN digest_id INTEGER DEFAULT NULL REFERENCES digests(id);
ALTER TABLE marks ADD COLUMN tags TEXT DEFAULT '[]';

CREATE UNIQUE INDEX idx_marks_share_token ON marks(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX idx_marks_user_analyzed ON marks(user_id, analyzed_at);
CREATE INDEX idx_marks_digest ON marks(digest_id) WHERE digest_id IS NOT NULL;
