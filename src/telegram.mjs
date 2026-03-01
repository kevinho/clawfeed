#!/usr/bin/env node
/**
 * ClawFeed Telegram Bot
 *
 * Long-polling Telegram bot for:
 * - /start — initiate account linking (generates 6-digit code)
 * - /digest — get latest personalized digest
 * - /stop — unlink Telegram from account
 * - /settings — show push preferences
 * - Push notifications when new digests are generated
 *
 * Usage:
 *   node src/telegram.mjs              # Run bot (long polling)
 *   node src/telegram.mjs --push <digestId> <type>   # Push a digest to subscribers
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — Bot token from @BotFather
 */

import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomInt } from 'crypto';
import {
  getDb,
  createLinkCode,
  consumeLinkCode,
  getTelegramLinkByChatId,
  saveTelegramLink,
  removeTelegramLink,
  updateTelegramPrefs,
  getUsersWithTelegramForDigest,
  getDigest,
  listDigestsByUser,
  logPush,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ──
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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
const DB_PATH = process.env.DIGEST_DB || env.DIGEST_DB || join(ROOT, 'data', 'digest.db');
const POLL_TIMEOUT = 30; // long polling timeout in seconds

if (!BOT_TOKEN) {
  console.error('[telegram] TELEGRAM_BOT_TOKEN not configured');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ──

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const url = new URL(`${API_BASE}/${method}`);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) {
            reject(new Error(`Telegram API ${method}: ${json.description || data.slice(0, 200)}`));
          } else {
            resolve(json.result);
          }
        } catch (e) {
          reject(new Error(`Telegram API parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendMessage(chatId, text, opts = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...opts,
  });
}

// ── Command handlers ──

async function handleStart(db, msg) {
  const chatId = String(msg.chat.id);
  const username = msg.from?.username || '';

  // Check if already linked
  const existing = getTelegramLinkByChatId(db, chatId);
  if (existing) {
    await sendMessage(chatId,
      `You're already linked to a ClawFeed account.\n\nUse /digest to get your latest digest.\nUse /stop to unlink.`
    );
    return;
  }

  // Generate 6-digit code
  const code = String(randomInt(100000, 999999));
  createLinkCode(db, code, chatId, username);

  await sendMessage(chatId,
    `Welcome to *ClawFeed*! 🗞️\n\n` +
    `To link your account, go to your ClawFeed settings and enter this code:\n\n` +
    `\`${code}\`\n\n` +
    `This code expires in 10 minutes.`
  );
}

async function handleDigest(db, msg) {
  const chatId = String(msg.chat.id);
  const link = getTelegramLinkByChatId(db, chatId);

  if (!link) {
    await sendMessage(chatId, `You haven't linked your account yet. Use /start to begin.`);
    return;
  }

  const digests = listDigestsByUser(db, link.user_id, { type: '4h', limit: 1 });
  if (!digests.length) {
    // Try daily
    const daily = listDigestsByUser(db, link.user_id, { type: 'daily', limit: 1 });
    if (daily.length) {
      await sendDigestMessage(chatId, daily[0]);
      return;
    }
    await sendMessage(chatId, `No digests available yet. Your personalized digest will be generated soon!`);
    return;
  }

  await sendDigestMessage(chatId, digests[0]);
}

async function handleStop(db, msg) {
  const chatId = String(msg.chat.id);
  const link = getTelegramLinkByChatId(db, chatId);

  if (!link) {
    await sendMessage(chatId, `You're not linked to any account.`);
    return;
  }

  removeTelegramLink(db, link.user_id);
  await sendMessage(chatId, `Account unlinked. You won't receive push notifications anymore.\n\nUse /start to re-link.`);
}

async function handleSettings(db, msg) {
  const chatId = String(msg.chat.id);
  const link = getTelegramLinkByChatId(db, chatId);

  if (!link) {
    await sendMessage(chatId, `You haven't linked your account yet. Use /start to begin.`);
    return;
  }

  const types = JSON.parse(link.digest_types || '[]');
  const typesStr = types.length ? types.join(', ') : 'none';

  await sendMessage(chatId,
    `*Push Settings*\n\n` +
    `Status: ${link.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
    `Digest types: ${typesStr}\n\n` +
    `To change settings, visit your ClawFeed account settings page.`
  );
}

// ── Format & send digest ──

function sendPlainMessage(chatId, text) {
  // Send without parse_mode — safe for LLM-generated content
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendDigestMessage(chatId, digest) {
  const content = digest.content || '';
  // Telegram message limit is 4096 chars
  const maxLen = 4000;

  const typeLabels = { '4h': '☀️ 简报', daily: '📰 日报', weekly: '📅 周报', monthly: '📊 月报' };
  const label = typeLabels[digest.type] || '📝 Digest';
  const header = `${label} — ${digest.created_at?.split(' ')[0] || 'latest'}\n\n`;

  if (header.length + content.length <= maxLen) {
    await sendPlainMessage(chatId, header + content);
  } else {
    // Split into chunks
    const chunkSize = maxLen - header.length;
    await sendPlainMessage(chatId, header + content.slice(0, chunkSize) + '\n\n(continued...)');
    for (let i = chunkSize; i < content.length; i += maxLen - 50) {
      await sendPlainMessage(chatId, content.slice(i, i + maxLen - 50));
    }
  }
}

// ── Push notifications ──

export async function pushDigestToTelegram(db, digestId, digestType) {
  if (!BOT_TOKEN) return { sent: 0, skipped: 'no bot token' };

  const digest = getDigest(db, digestId);
  if (!digest) return { sent: 0, error: 'digest not found' };

  const users = getUsersWithTelegramForDigest(db, digestType);
  if (!users.length) return { sent: 0, reason: 'no subscribers for this type' };

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const user of users) {
    // Only send to the user who owns this digest (prevent cross-user leak)
    if (digest.user_id && digest.user_id !== user.user_id) {
      skipped++;
      continue;
    }
    try {
      await sendDigestMessage(user.chat_id, digest);
      logPush(db, user.user_id, 'telegram', digestId, 'sent');
      sent++;
    } catch (e) {
      console.error(`  [push] Failed to send to ${user.name || user.user_id}: ${e.message}`);
      logPush(db, user.user_id, 'telegram', digestId, 'failed', e.message);
      failed++;
    }
  }

  console.log(`[telegram] Pushed digest #${digestId} (${digestType}): ${sent} sent, ${failed} failed, ${skipped} skipped (wrong user)`);
  return { sent, failed, skipped };
}

// ── Long polling ──

async function pollLoop(db) {
  let offset = 0;

  console.log('[telegram] Bot started, polling for updates...');

  // Set bot commands
  try {
    await tgApi('setMyCommands', {
      commands: [
        { command: 'start', description: 'Link your ClawFeed account' },
        { command: 'digest', description: 'Get your latest digest' },
        { command: 'settings', description: 'View push settings' },
        { command: 'stop', description: 'Unlink your account' },
      ],
    });
  } catch (e) {
    console.error('[telegram] Failed to set commands:', e.message);
  }

  while (true) {
    try {
      const updates = await tgApi('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const text = msg.text.trim();
        const cmd = text.split(/\s/)[0].split('@')[0].toLowerCase();

        try {
          switch (cmd) {
            case '/start': await handleStart(db, msg); break;
            case '/digest': await handleDigest(db, msg); break;
            case '/stop': await handleStop(db, msg); break;
            case '/settings': await handleSettings(db, msg); break;
            default:
              // Ignore non-command messages in private chats
              if (msg.chat.type === 'private') {
                await sendMessage(msg.chat.id,
                  `I don't understand that command.\n\n` +
                  `Available commands:\n` +
                  `/start — Link your account\n` +
                  `/digest — Get latest digest\n` +
                  `/settings — Push settings\n` +
                  `/stop — Unlink account`
                );
              }
          }
        } catch (e) {
          console.error(`[telegram] Error handling ${cmd}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[telegram] Poll error:', e.message);
      // Wait before retry on error
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── CLI: push mode ──
async function pushMode(db) {
  const args = process.argv.slice(2);
  const digestId = parseInt(args[args.indexOf('--push') + 1], 10);
  const digestType = args[args.indexOf('--push') + 2] || '4h';

  if (!digestId) {
    console.error('Usage: node telegram.mjs --push <digestId> <type>');
    process.exit(1);
  }

  const result = await pushDigestToTelegram(db, digestId, digestType);
  console.log(JSON.stringify(result));
}

// ── Main ──
const db = getDb(DB_PATH);
const args = process.argv.slice(2);

if (args.includes('--push')) {
  pushMode(db).catch(e => { console.error('[telegram] Push error:', e.message); process.exit(1); });
} else {
  pollLoop(db).catch(e => { console.error('[telegram] Fatal:', e.message); process.exit(1); });
}
