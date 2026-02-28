-- Migration 011: Digest generation optimization
-- Index for efficient per-user, per-type digest queries
CREATE INDEX IF NOT EXISTS idx_digests_user_type_created ON digests(user_id, type, created_at DESC);
