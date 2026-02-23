-- Test data for CI e2e tests
-- Creates 4 test users + kevin, their sessions, and sample digests

-- Test users
INSERT INTO users (id, google_id, email, name, slug) VALUES
  (1, 'google-alice', 'alice@test.local', 'Alice (Test)', 'alice'),
  (2, 'google-bob', 'bob@test.local', 'Bob (Test)', 'bob'),
  (3, 'google-carol', 'carol@test.local', 'Carol (Test)', 'carol'),
  (4, 'google-dave', 'dave@test.local', 'Dave (Test)', 'dave'),
  (5, 'google-kevin', 'kevin@test.local', 'Kevin (Test)', 'kevin');

-- Test sessions (expire far in the future)
INSERT INTO sessions (id, user_id, expires_at) VALUES
  ('test-sess-alice', 1, '2099-12-31 23:59:59'),
  ('test-sess-bob', 2, '2099-12-31 23:59:59'),
  ('test-sess-carol', 3, '2099-12-31 23:59:59'),
  ('test-sess-dave', 4, '2099-12-31 23:59:59');

-- Sample digests for browse tests
INSERT INTO digests (type, content, created_at) VALUES
  ('4h', 'Test 4h digest content', datetime('now')),
  ('daily', 'Test daily digest content', datetime('now', '-1 hour')),
  ('weekly', 'Test weekly digest content', datetime('now', '-2 hours'));
