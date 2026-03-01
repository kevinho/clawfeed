#!/usr/bin/env node
/**
 * Telegram push unit tests — tests DB functions and push logic
 * without requiring a real Telegram bot token.
 *
 * Usage: node test/telegram.test.mjs
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = join(__dirname, '..', 'data', 'test-telegram.db');

let pass = 0, fail = 0;
function assert(desc, condition) {
  if (condition) { pass++; console.log(`  ✅ ${desc}`); }
  else { fail++; console.log(`  ❌ ${desc}`); }
}

// ── Setup test DB ──
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
try { rmSync(TEST_DB); } catch {}

// Import DB functions (this runs migrations)
process.env.DIGEST_DB = TEST_DB;
const db = (await import('../src/db.mjs')).getDb(TEST_DB);

const {
  saveTelegramLink,
  getTelegramLink,
  getTelegramLinkByChatId,
  removeTelegramLink,
  updateTelegramPrefs,
  getUsersWithTelegramForDigest,
  createLinkCode,
  consumeLinkCode,
  logPush,
  getDigest,
  createDigest,
  upsertUser,
} = await import('../src/db.mjs');

// ── Create test users ──
const alice = upsertUser(db, { googleId: 'g-alice', email: 'alice@test.com', name: 'Alice', avatar: '' });
const bob = upsertUser(db, { googleId: 'g-bob', email: 'bob@test.com', name: 'Bob', avatar: '' });

console.log('\n─── Telegram Link CRUD ───');

saveTelegramLink(db, alice.id, '111', 'alice_tg');
const link = getTelegramLink(db, alice.id);
assert('saveTelegramLink creates link', link && link.chat_id === '111');
assert('Default enabled=1', link?.enabled === 1);
assert('Default digest_types', JSON.parse(link?.digest_types || '[]').includes('4h'));

const byChat = getTelegramLinkByChatId(db, '111');
assert('getTelegramLinkByChatId works', byChat?.user_id === alice.id);

console.log('\n─── S-3: Re-link preserves preferences ───');

updateTelegramPrefs(db, alice.id, { enabled: true, digestTypes: ['daily'] });
const before = getTelegramLink(db, alice.id);
assert('Prefs updated to daily only', JSON.parse(before.digest_types).length === 1);

// Re-link with new chat_id (simulates re-linking from different device)
saveTelegramLink(db, alice.id, '222', 'alice_tg_new');
const after = getTelegramLink(db, alice.id);
assert('Re-link updates chat_id', after.chat_id === '222');
assert('Re-link preserves digest_types', JSON.parse(after.digest_types).includes('daily'));
assert('Re-link preserves enabled state', after.enabled === 1);

console.log('\n─── C-1: Cross-user digest isolation ───');

// Create per-user digests
const aliceDigest = createDigest(db, { type: '4h', content: 'Alice news', user_id: alice.id });
const bobDigest = createDigest(db, { type: '4h', content: 'Bob news', user_id: bob.id });
const systemDigest = createDigest(db, { type: '4h', content: 'System news' });

// Link both users to telegram
saveTelegramLink(db, bob.id, '333', 'bob_tg');
updateTelegramPrefs(db, bob.id, { enabled: true, digestTypes: ['4h'] });
// Reset alice to 4h
updateTelegramPrefs(db, alice.id, { digestTypes: ['4h'] });

const subscribers = getUsersWithTelegramForDigest(db, '4h');
assert('Both users subscribe to 4h', subscribers.length === 2);

// Verify digest ownership
const ad = getDigest(db, Number(aliceDigest.id));
assert('Alice digest has user_id', ad.user_id === alice.id);

const bd = getDigest(db, Number(bobDigest.id));
assert('Bob digest has user_id', bd.user_id === bob.id);

const sd = getDigest(db, Number(systemDigest.id));
assert('System digest has null user_id', sd.user_id === null);

// Simulate push logic — only matching user should receive
let aliceSent = 0, bobSent = 0;
for (const user of subscribers) {
  if (ad.user_id && ad.user_id !== user.user_id) continue;
  if (user.user_id === alice.id) aliceSent++;
  if (user.user_id === bob.id) bobSent++;
}
assert('Alice digest only sent to Alice', aliceSent === 1 && bobSent === 0);

// System digest (user_id=null) should go to all
let systemSentCount = 0;
for (const user of subscribers) {
  if (sd.user_id && sd.user_id !== user.user_id) continue;
  systemSentCount++;
}
assert('System digest sent to all subscribers', systemSentCount === 2);

console.log('\n─── S-1: Link code attempt limiting ───');

createLinkCode(db, '123456', '999', 'test_user');

// 4 wrong attempts should not invalidate
for (let i = 0; i < 4; i++) consumeLinkCode(db, '000000');
const stillValid = db.prepare("SELECT * FROM telegram_link_codes WHERE code = '123456'").get();
assert('Code survives 4 wrong attempts', !!stillValid);

// 5th wrong attempt should invalidate
consumeLinkCode(db, '000000');
const invalidated = db.prepare("SELECT * FROM telegram_link_codes WHERE code = '123456'").get();
assert('Code invalidated after 5 wrong attempts', !invalidated);

// Correct code consumption
createLinkCode(db, '654321', '888', 'test_user2');
const consumed = consumeLinkCode(db, '654321');
assert('Correct code consumed', consumed?.chat_id === '888');
const gone = consumeLinkCode(db, '654321');
assert('Code deleted after consumption', !gone);

console.log('\n─── Push log ───');

logPush(db, alice.id, 'telegram', Number(aliceDigest.id), 'sent');
const logs = db.prepare('SELECT * FROM push_log WHERE user_id = ?').all(alice.id);
assert('Push log recorded', logs.length >= 1);

// ── Cleanup ──
try { rmSync(TEST_DB); } catch {}

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
