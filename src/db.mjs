import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env
const envPath = join(ROOT, '.env');
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

let _db;

export function getDb(dbPath) {
  if (_db) return _db;
  const p = dbPath || join(ROOT, 'data', 'digest.db');
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // Run migrations
  const sql = readFileSync(join(ROOT, 'migrations', '001_init.sql'), 'utf8');
  _db.exec(sql);
  // Run auth migration (idempotent)
  try {
    const sql2 = readFileSync(join(ROOT, 'migrations', '002_auth.sql'), 'utf8');
    // Execute each statement separately since ALTER TABLE may fail if column exists
    for (const stmt of sql2.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column')) console.error('Migration 002:', e.message);
  }
  // Run sources migration (idempotent)
  try {
    const sql3 = readFileSync(join(ROOT, 'migrations', '003_sources.sql'), 'utf8');
    _db.exec(sql3);
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 003:', e.message);
  }
  // Run feed migration (idempotent)
  try {
    const sql4 = readFileSync(join(ROOT, 'migrations', '004_feed.sql'), 'utf8');
    for (const stmt of sql4.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) console.error('Migration 004:', e.message);
  }
  // Run source packs migration (idempotent)
  try {
    const sql5 = readFileSync(join(ROOT, 'migrations', '005_source_packs.sql'), 'utf8');
    _db.exec(sql5);
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 005:', e.message);
  }
  // Run subscriptions migration (idempotent)
  try {
    const sql6 = readFileSync(join(ROOT, 'migrations', '006_subscriptions.sql'), 'utf8');
    _db.exec(sql6);
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 006:', e.message);
  }
  // Run soft delete migration (idempotent)
  try {
    const sql7 = readFileSync(join(ROOT, 'migrations', '007_soft_delete.sql'), 'utf8');
    for (const stmt of sql7.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column')) console.error('Migration 007:', e.message);
  }
  // Run feedback migration (idempotent)
  try {
    const sql8 = readFileSync(join(ROOT, 'migrations', '008_feedback.sql'), 'utf8');
    _db.exec(sql8);
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 008:', e.message);
  }
  // Migration 009: feedback v2 (category + read_at)
  try {
    const sql9 = readFileSync(join(ROOT, 'migrations', '009_feedback_v2.sql'), 'utf8');
    for (const stmt of sql9.split(';').filter(s => s.trim())) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column')) console.error('Migration 009:', e.message);
  }
  // Migration 010: raw_items table + sources error tracking
  try {
    const sql10 = readFileSync(join(ROOT, 'migrations', '010_raw_items.sql'), 'utf8');
    for (const stmt of sql10.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) console.error('Migration 010:', e.message);
  }
  // Migration 011: digest generation optimization
  try {
    const sql11 = readFileSync(join(ROOT, 'migrations', '011_digest_generation.sql'), 'utf8');
    for (const stmt of sql11.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 011:', e.message);
  }
  // Migration 012: Telegram push notifications
  try {
    const sql12 = readFileSync(join(ROOT, 'migrations', '012_telegram.sql'), 'utf8');
    for (const stmt of sql12.split(';').map(s => s.trim()).filter(Boolean)) {
      try { _db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('Migration 012:', e.message);
  }
  // Backfill slugs for existing users
  _backfillSlugs(_db);
  return _db;
}

function _generateSlug(email, name) {
  const base = (email ? email.split('@')[0] : name || 'user').toLowerCase();
  return base.replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'user';
}

function _backfillSlugs(db) {
  const users = db.prepare('SELECT id, email, name, slug FROM users WHERE slug IS NULL').all();
  // Special slug mappings
  const SLUG_MAP = { 'freefacefly@gmail.com': 'kevin', 'kevin@coco.xyz': 'kevinhe' };
  for (const u of users) {
    let slug = SLUG_MAP[u.email] || _generateSlug(u.email, u.name);
    let candidate = slug;
    let i = 1;
    while (db.prepare('SELECT 1 FROM users WHERE slug = ? AND id != ?').get(candidate, u.id)) {
      candidate = slug + i++;
    }
    db.prepare('UPDATE users SET slug = ? WHERE id = ?').run(candidate, u.id);
  }
}

// ── Digests ──

export function listDigests(db, { type, limit = 20, offset = 0 } = {}) {
  let sql = 'SELECT id, type, content, metadata, created_at FROM digests';
  const params = [];
  if (type) { sql += ' WHERE type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function getDigest(db, id) {
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id);
}

export function createDigest(db, { type, content, metadata = '{}', created_at, user_id }) {
  const uid = user_id || null;
  const sql = created_at
    ? 'INSERT INTO digests (type, content, metadata, created_at, user_id) VALUES (?, ?, ?, ?, ?)'
    : 'INSERT INTO digests (type, content, metadata, user_id) VALUES (?, ?, ?, ?)';
  const params = created_at ? [type, content, metadata, created_at, uid] : [type, content, metadata, uid];
  const result = db.prepare(sql).run(...params);
  return { id: result.lastInsertRowid };
}

// ── Marks ──

export function listMarks(db, { status, limit = 100, offset = 0, userId } = {}) {
  let sql = 'SELECT * FROM marks';
  const params = [];
  const conditions = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function createMark(db, { url, title = '', note = '', userId }) {
  // Check duplicate for this user
  const existing = db.prepare('SELECT id FROM marks WHERE url = ? AND user_id = ?').get(url, userId);
  if (existing) return { id: existing.id, duplicate: true };
  const result = db.prepare('INSERT INTO marks (url, title, note, user_id) VALUES (?, ?, ?, ?)').run(url, title, note, userId);
  return { id: result.lastInsertRowid, duplicate: false };
}

export function deleteMark(db, id, userId) {
  return db.prepare('DELETE FROM marks WHERE id = ? AND user_id = ?').run(id, userId);
}

export function migrateMarksToUser(db, userId) {
  return db.prepare('UPDATE marks SET user_id = ? WHERE user_id IS NULL').run(userId);
}

export function updateMarkStatus(db, id, status) {
  return db.prepare('UPDATE marks SET status = ? WHERE id = ?').run(status, id);
}

// ── Auth ──

export function upsertUser(db, { googleId, email, name, avatar }) {
  const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ?, avatar = ? WHERE google_id = ?').run(email, name, avatar, googleId);
    // Backfill slug if missing
    if (!existing.slug) {
      let slug = _generateSlug(email, name);
      let candidate = slug;
      let i = 1;
      while (db.prepare('SELECT 1 FROM users WHERE slug = ? AND id != ?').get(candidate, existing.id)) {
        candidate = slug + i++;
      }
      db.prepare('UPDATE users SET slug = ? WHERE id = ?').run(candidate, existing.id);
    }
    return db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  }
  let slug = _generateSlug(email, name);
  let candidate = slug;
  let i = 1;
  while (db.prepare('SELECT 1 FROM users WHERE slug = ?').get(candidate)) {
    candidate = slug + i++;
  }
  db.prepare('INSERT INTO users (google_id, email, name, avatar, slug) VALUES (?, ?, ?, ?, ?)').run(googleId, email, name, avatar, candidate);
  const newUser = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  // Auto-subscribe new user to all public sources
  db.prepare('INSERT OR IGNORE INTO user_subscriptions (user_id, source_id) SELECT ?, id FROM sources WHERE is_public = 1').run(newUser.id);
  return newUser;
}

export function createSession(db, { id, userId, expiresAt }) {
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
}

export function getSession(db, sessionId) {
  return db.prepare(`
    SELECT s.*, u.id as uid, u.google_id, u.email, u.name, u.avatar, u.slug
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).get(sessionId);
}

export function deleteSession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ── Feed ──

export function getUserBySlug(db, slug) {
  return db.prepare('SELECT id, name, slug, avatar FROM users WHERE slug = ?').get(slug);
}

export function listDigestsByUser(db, userId, { type, limit = 10, since } = {}) {
  // userId=null means system digests (user_id IS NULL), which we also show for any user feed
  let sql = 'SELECT id, type, content, created_at FROM digests WHERE (user_id = ? OR user_id IS NULL)';
  const params = [userId];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (since) { sql += ' AND created_at >= ?'; params.push(since); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(limit, 50));
  return db.prepare(sql).all(...params);
}

export function countDigestsByUser(db, userId, { type } = {}) {
  let sql = 'SELECT COUNT(*) as total FROM digests WHERE (user_id = ? OR user_id IS NULL)';
  const params = [userId];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  return db.prepare(sql).get(...params).total;
}

// ── Sources ──

export function listSources(db, { activeOnly, userId, includePublic } = {}) {
  let sql = 'SELECT sources.*, users.name as creator_name FROM sources LEFT JOIN users ON sources.created_by = users.id';
  const conditions = ['sources.is_deleted = 0'];
  const params = [];
  if (activeOnly) { conditions.push('is_active = 1'); }
  if (userId && includePublic) {
    conditions.push('(created_by = ? OR is_public = 1)');
    params.push(userId);
  } else if (userId) {
    conditions.push('created_by = ?');
    params.push(userId);
  } else if (includePublic) {
    conditions.push('is_public = 1');
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

export function getSource(db, id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

export function createSource(db, { name, type, config = '{}', isPublic = 0, createdBy }) {
  const result = db.prepare(
    'INSERT INTO sources (name, type, config, is_public, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, type, config, isPublic ? 1 : 0, createdBy);
  const sourceId = result.lastInsertRowid;
  // Auto-subscribe creator
  if (createdBy) {
    try {
      db.prepare('INSERT OR IGNORE INTO user_subscriptions (user_id, source_id) VALUES (?, ?)').run(createdBy, sourceId);
    } catch {}
  }
  return { id: sourceId };
}

export function updateSource(db, id, patch) {
  const allowed = ['name', 'type', 'config', 'is_active', 'is_public'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = k === 'isActive' ? 'is_active' : k === 'isPublic' ? 'is_public' : k;
    if (allowed.includes(col)) {
      sets.push(`${col} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
  }
  if (!sets.length) return { changes: 0 };
  sets.push("updated_at = datetime('now')");
  params.push(id);
  return db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteSource(db, id, userId) {
  if (userId) {
    return db.prepare("UPDATE sources SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ? AND created_by = ?").run(id, userId);
  }
  return db.prepare("UPDATE sources SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?").run(id);
}

export function getSourceByTypeConfig(db, type, config) {
  return db.prepare('SELECT * FROM sources WHERE type = ? AND config = ?').get(type, config);
}

// ── Source Packs ──

export function createPack(db, { name, description, slug, sourcesJson, createdBy }) {
  const result = db.prepare(
    'INSERT INTO source_packs (name, description, slug, sources_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description || '', slug, sourcesJson, createdBy);
  return { id: result.lastInsertRowid };
}

export function getPack(db, id) {
  return db.prepare('SELECT * FROM source_packs WHERE id = ?').get(id);
}

export function getPackBySlug(db, slug) {
  return db.prepare('SELECT sp.*, u.name as creator_name, u.avatar as creator_avatar, u.slug as creator_slug FROM source_packs sp LEFT JOIN users u ON sp.created_by = u.id WHERE sp.slug = ?').get(slug);
}

export function listPacks(db, { publicOnly, userId } = {}) {
  let sql = 'SELECT sp.*, u.name as creator_name, u.avatar as creator_avatar, u.slug as creator_slug FROM source_packs sp LEFT JOIN users u ON sp.created_by = u.id';
  const conditions = [];
  const params = [];
  if (publicOnly && userId) {
    conditions.push('(sp.is_public = 1 OR sp.created_by = ?)');
    params.push(userId);
  } else if (publicOnly) {
    conditions.push('sp.is_public = 1');
  } else if (userId) {
    conditions.push('sp.created_by = ?');
    params.push(userId);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY sp.install_count DESC, sp.created_at DESC';
  return db.prepare(sql).all(...params);
}

export function incrementPackInstall(db, id) {
  return db.prepare("UPDATE source_packs SET install_count = install_count + 1, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function deletePack(db, id) {
  return db.prepare('DELETE FROM source_packs WHERE id = ?').run(id);
}

// ── Subscriptions ──

export function listSubscriptions(db, userId) {
  return db.prepare(`
    SELECT s.*, us.created_at as subscribed_at, u.name as creator_name, s.is_deleted
    FROM user_subscriptions us
    JOIN sources s ON us.source_id = s.id
    LEFT JOIN users u ON s.created_by = u.id
    WHERE us.user_id = ?
    ORDER BY us.created_at DESC
  `).all(userId);
}

export function subscribe(db, userId, sourceId) {
  return db.prepare('INSERT OR IGNORE INTO user_subscriptions (user_id, source_id) VALUES (?, ?)').run(userId, sourceId);
}

export function unsubscribe(db, userId, sourceId) {
  return db.prepare('DELETE FROM user_subscriptions WHERE user_id = ? AND source_id = ?').run(userId, sourceId);
}

export function bulkSubscribe(db, userId, sourceIds) {
  const stmt = db.prepare('INSERT OR IGNORE INTO user_subscriptions (user_id, source_id) VALUES (?, ?)');
  const run = db.transaction((ids) => {
    let added = 0;
    for (const sid of ids) {
      const r = stmt.run(userId, sid);
      added += r.changes;
    }
    return added;
  });
  return run(sourceIds);
}

export function isSubscribed(db, userId, sourceId) {
  return !!db.prepare('SELECT 1 FROM user_subscriptions WHERE user_id = ? AND source_id = ?').get(userId, sourceId);
}

export function getSubscriberCount(db, sourceId) {
  return db.prepare('SELECT COUNT(*) as count FROM user_subscriptions WHERE source_id = ?').get(sourceId).count;
}

// ── Feedback ──

export function createFeedback(db, userId, email, name, message, category) {
  const result = db.prepare('INSERT INTO feedback (user_id, email, name, message, category) VALUES (?, ?, ?, ?, ?)').run(userId, email, name, message, category || null);
  return result.lastInsertRowid;
}

export function getUserFeedback(db, userId) {
  return db.prepare('SELECT id, message, reply, replied_by, replied_at, created_at, status, category, read_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getAllFeedback(db) {
  return db.prepare(`SELECT f.*, u.name as user_name, u.email as user_email, u.avatar as user_avatar
    FROM feedback f LEFT JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC`).all();
}

export function replyToFeedback(db, id, reply, repliedBy) {
  return db.prepare("UPDATE feedback SET reply = ?, replied_by = ?, replied_at = datetime('now'), status = 'replied' WHERE id = ?").run(reply, repliedBy, id);
}

export function updateFeedbackStatus(db, id, status) {
  return db.prepare("UPDATE feedback SET status = ? WHERE id = ?").run(status, id);
}

export function markFeedbackRead(db, id) {
  return db.prepare("UPDATE feedback SET read_at = datetime('now') WHERE id = ?").run(id);
}

export function getUnreadFeedbackCount(db, userId) {
  return db.prepare("SELECT COUNT(*) as count FROM feedback WHERE user_id = ? AND reply IS NOT NULL AND read_at IS NULL").get(userId)?.count || 0;
}

// ── Raw Items ──

export function insertRawItemsBatch(db, sourceId, items) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO raw_items (source_id, title, url, author, content, published_at, dedup_key, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const run = db.transaction((rows) => {
    let inserted = 0;
    for (const item of rows) {
      const key = item.dedupKey || (item.url ? `${sourceId}:${item.url}` : `${sourceId}:${_contentHash(item.content)}`);
      const meta = typeof item.metadata === 'string' ? item.metadata : JSON.stringify(item.metadata || {});
      const r = stmt.run(sourceId, item.title || '', item.url || '', item.author || '', item.content || '', item.publishedAt || null, key, meta);
      inserted += r.changes;
    }
    return inserted;
  });
  return run(items);
}

function _contentHash(content) {
  return 'sha256:' + createHash('sha256').update(content || '').digest('hex').slice(0, 16);
}

export function listRawItems(db, { sourceId, since, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT ri.*, s.name as source_name, s.type as source_type FROM raw_items ri JOIN sources s ON ri.source_id = s.id';
  const conditions = [];
  const params = [];
  if (sourceId) { conditions.push('ri.source_id = ?'); params.push(sourceId); }
  if (since) { conditions.push('ri.fetched_at >= ?'); params.push(since); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY ri.fetched_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(limit, 500), offset);
  return db.prepare(sql).all(...params);
}

export function listRawItemsForDigest(db, sourceIds, { since, limit = 500 } = {}) {
  if (!sourceIds.length) return [];
  const placeholders = sourceIds.map(() => '?').join(',');
  let sql = `SELECT ri.*, s.name as source_name, s.type as source_type FROM raw_items ri JOIN sources s ON ri.source_id = s.id WHERE ri.source_id IN (${placeholders})`;
  const params = [...sourceIds];
  if (since) { sql += ' AND ri.fetched_at >= ?'; params.push(since); }
  sql += ' ORDER BY ri.fetched_at DESC LIMIT ?';
  params.push(Math.min(limit, 1000));
  return db.prepare(sql).all(...params);
}

export function getRawItemStats(db) {
  return db.prepare(`
    SELECT s.id as source_id, s.name, s.type,
      COUNT(ri.id) as total_items,
      MAX(ri.fetched_at) as last_item_at,
      COUNT(CASE WHEN ri.fetched_at >= datetime('now', '-24 hours') THEN 1 END) as items_24h
    FROM sources s
    LEFT JOIN raw_items ri ON s.id = ri.source_id
    WHERE s.is_active = 1 AND s.is_deleted = 0
    GROUP BY s.id
    ORDER BY last_item_at DESC NULLS LAST
  `).all();
}

export function cleanOldRawItems(db, daysToKeep = 30) {
  return db.prepare("DELETE FROM raw_items WHERE fetched_at < datetime('now', '-' || ? || ' days')").run(daysToKeep);
}

export function touchSourceFetch(db, sourceId) {
  return db.prepare("UPDATE sources SET last_fetched_at = datetime('now'), fetch_count = fetch_count + 1, fetch_error_count = 0 WHERE id = ?").run(sourceId);
}

export function recordSourceError(db, sourceId, errorMsg) {
  const lastError = JSON.stringify({ message: errorMsg, at: new Date().toISOString() });
  db.prepare("UPDATE sources SET fetch_error_count = fetch_error_count + 1, last_error = ? WHERE id = ?").run(lastError, sourceId);
  // Auto-pause after 5 consecutive failures
  db.prepare("UPDATE sources SET is_active = 0 WHERE id = ? AND fetch_error_count >= 5").run(sourceId);
}

export function getSourcesDueForFetch(db) {
  // Only query types that have a fetcher implemented (skip twitter_* until Phase 1.5)
  return db.prepare(`
    SELECT * FROM sources
    WHERE is_active = 1 AND is_deleted = 0
    AND type IN ('rss', 'digest_feed', 'hackernews', 'reddit', 'github_trending', 'website')
    AND (
      last_fetched_at IS NULL
      OR (type IN ('hackernews', 'reddit') AND last_fetched_at < datetime('now', '-1 hour'))
      OR (type IN ('rss', 'website', 'digest_feed', 'github_trending') AND last_fetched_at < datetime('now', '-4 hours'))
    )
    ORDER BY last_fetched_at ASC NULLS FIRST
  `).all();
}

export function getCollectorStatus(db) {
  const due = db.prepare(`
    SELECT COUNT(*) as count FROM sources
    WHERE is_active = 1 AND is_deleted = 0
    AND type IN ('rss', 'digest_feed', 'hackernews', 'reddit', 'github_trending', 'website')
    AND (
      last_fetched_at IS NULL
      OR (type IN ('hackernews', 'reddit') AND last_fetched_at < datetime('now', '-1 hour'))
      OR (type IN ('rss', 'website', 'digest_feed', 'github_trending') AND last_fetched_at < datetime('now', '-4 hours'))
    )
  `).get();
  const total = db.prepare("SELECT COUNT(*) as count FROM sources WHERE is_active = 1 AND is_deleted = 0").get();
  const paused = db.prepare("SELECT COUNT(*) as count FROM sources WHERE is_active = 0 AND is_deleted = 0 AND fetch_error_count >= 5").get();
  const lastFetch = db.prepare("SELECT MAX(last_fetched_at) as last_at FROM sources WHERE last_fetched_at IS NOT NULL").get();
  const rawItemCount = db.prepare("SELECT COUNT(*) as count FROM raw_items").get();
  const rawItems24h = db.prepare("SELECT COUNT(*) as count FROM raw_items WHERE fetched_at >= datetime('now', '-24 hours')").get();
  return {
    sources_due: due.count,
    sources_active: total.count,
    sources_paused: paused.count,
    last_fetch_at: lastFetch.last_at,
    raw_items_total: rawItemCount.count,
    raw_items_24h: rawItems24h.count,
  };
}

// ── Digest Generation ──

export function getLastDigestTime(db, userId, type) {
  const row = db.prepare(
    'SELECT created_at FROM digests WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId, type);
  return row ? row.created_at : null;
}

export function getActiveSubscriptionSourceIds(db, userId) {
  return db.prepare(
    'SELECT s.id FROM user_subscriptions us JOIN sources s ON us.source_id = s.id WHERE us.user_id = ? AND s.is_active = 1 AND s.is_deleted = 0'
  ).all(userId).map(r => r.id);
}

export function getUsersDueForDigest(db, type, intervalHours) {
  // Find users with active subscriptions whose last digest of this type
  // is older than the interval (or who have never had one)
  return db.prepare(`
    SELECT DISTINCT us.user_id as id, u.name, u.slug
    FROM user_subscriptions us
    JOIN users u ON us.user_id = u.id
    JOIN sources s ON us.source_id = s.id
    WHERE s.is_active = 1 AND s.is_deleted = 0
    AND NOT EXISTS (
      SELECT 1 FROM digests d
      WHERE d.user_id = us.user_id AND d.type = ?
      AND d.created_at >= datetime('now', '-' || ? || ' hours')
    )
  `).all(type, intervalHours);
}

// ── Config ──

export function getConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const obj = {};
  for (const r of rows) {
    try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; }
  }
  return obj;
}

export function setConfig(db, key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, v);
}

// ── Telegram ──

export function saveTelegramLink(db, userId, chatId, username) {
  return db.prepare(
    `INSERT INTO telegram_links (user_id, chat_id, enabled, digest_types)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id`
  ).run(userId, chatId, JSON.stringify(['4h', 'daily']));
}

export function getTelegramLink(db, userId) {
  return db.prepare('SELECT * FROM telegram_links WHERE user_id = ?').get(userId);
}

export function getTelegramLinkByChatId(db, chatId) {
  return db.prepare('SELECT * FROM telegram_links WHERE chat_id = ?').get(chatId);
}

export function removeTelegramLink(db, userId) {
  return db.prepare('DELETE FROM telegram_links WHERE user_id = ?').run(userId);
}

export function updateTelegramPrefs(db, userId, { enabled, digestTypes }) {
  const sets = [];
  const params = [];
  if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (digestTypes) { sets.push('digest_types = ?'); params.push(JSON.stringify(digestTypes)); }
  if (!sets.length) return { changes: 0 };
  params.push(userId);
  return db.prepare(`UPDATE telegram_links SET ${sets.join(', ')} WHERE user_id = ?`).run(...params);
}

export function getUsersWithTelegramForDigest(db, digestType) {
  // Filter by digest_types JSON array containing the given type
  return db.prepare(`
    SELECT tl.chat_id, tl.user_id, u.name, u.slug
    FROM telegram_links tl
    JOIN users u ON tl.user_id = u.id
    WHERE tl.enabled = 1
    AND EXISTS (
      SELECT 1 FROM json_each(tl.digest_types) WHERE json_each.value = ?
    )
  `).all(digestType);
}

export function getEnabledTelegramUsers(db) {
  return db.prepare(`
    SELECT tl.*, u.name, u.slug
    FROM telegram_links tl
    JOIN users u ON tl.user_id = u.id
    WHERE tl.enabled = 1
  `).all();
}

export function createLinkCode(db, code, chatId, username) {
  // Clean up old codes first (> 10 min)
  db.prepare("DELETE FROM telegram_link_codes WHERE created_at < datetime('now', '-10 minutes')").run();
  return db.prepare('INSERT OR REPLACE INTO telegram_link_codes (code, chat_id, chat_username) VALUES (?, ?, ?)').run(code, chatId, username || null);
}

export function consumeLinkCode(db, code) {
  const row = db.prepare(
    "SELECT * FROM telegram_link_codes WHERE code = ? AND created_at >= datetime('now', '-10 minutes')"
  ).get(code);
  if (row) {
    db.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);
    return row;
  }
  // Wrong code — increment attempts on all active codes to mitigate brute-force
  // If any code exceeds 5 attempts, invalidate it
  db.prepare("UPDATE telegram_link_codes SET attempts = attempts + 1 WHERE created_at >= datetime('now', '-10 minutes')").run();
  db.prepare("DELETE FROM telegram_link_codes WHERE attempts >= 5").run();
  return null;
}

export function logPush(db, userId, channel, digestId, status, error) {
  return db.prepare(
    'INSERT INTO push_log (user_id, channel, digest_id, status, error) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, channel, digestId || null, status, error || null);
}
