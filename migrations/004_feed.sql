-- Add slug to users
ALTER TABLE users ADD COLUMN slug TEXT;

-- Add user_id to digests (nullable, NULL = system digest)
ALTER TABLE digests ADD COLUMN user_id INTEGER REFERENCES users(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);
CREATE INDEX IF NOT EXISTS idx_digests_user ON digests(user_id);
