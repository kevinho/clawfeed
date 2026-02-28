#!/usr/bin/env node
/**
 * ClawFeed Digest Generator
 *
 * Generates personalized digests per user based on their subscriptions.
 * Fetches raw_items for each user's sources, sends them to an LLM for
 * curation, and writes the result to the digests table.
 *
 * Usage:
 *   node src/generator.mjs                    # Generate for all due users (4h type)
 *   node src/generator.mjs --type daily       # Generate daily digests
 *   node src/generator.mjs --user 5           # Generate for specific user
 *   node src/generator.mjs --system           # Generate system digest (user_id=NULL)
 *   node src/generator.mjs --dry-run          # Preview without writing to DB
 */

import https from 'https';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import {
  getDb,
  getUsersDueForDigest,
  getActiveSubscriptionSourceIds,
  getLastDigestTime,
  listRawItemsForDigest,
  createDigest,
  listSources,
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

// ── Config ──
const LLM_API_URL = process.env.LLM_API_URL || env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY || env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || env.LLM_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || env.LLM_TIMEOUT || '90', 10) * 1000;
const DB_PATH = process.env.DIGEST_DB || env.DIGEST_DB || join(ROOT, 'data', 'digest.db');
const MAX_ITEMS = parseInt(process.env.GENERATOR_MAX_ITEMS || env.GENERATOR_MAX_ITEMS || '300', 10);

// Digest type → interval in hours
const TYPE_INTERVALS = {
  '4h': 4,
  daily: 24,
  weekly: 168,
  monthly: 720,
};

// ── Prompt template ──
function loadPromptTemplate() {
  const promptPath = join(ROOT, 'templates', 'digest-prompt.md');
  if (existsSync(promptPath)) {
    return readFileSync(promptPath, 'utf8');
  }
  return `You are an AI news curator. Generate a structured digest from the provided feed content.
Select the 15-20 most interesting and important items. Include source URLs.
Output in markdown format.`;
}

// ── LLM call (OpenAI-compatible API) ──
function callLlm(systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    if (!LLM_API_KEY) {
      return reject(new Error('LLM_API_KEY not configured'));
    }

    const url = new URL(LLM_API_URL);
    const payload = JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    });

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      resp.setEncoding('utf8');
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (resp.statusCode !== 200) {
            return reject(new Error(`LLM API ${resp.statusCode}: ${json.error?.message || data.slice(0, 200)}`));
          }
          const content = json.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('LLM returned empty content'));
          resolve(content);
        } catch (e) {
          reject(new Error(`LLM response parse error: ${e.message}`));
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`LLM request timed out after ${LLM_TIMEOUT / 1000}s`));
    }, LLM_TIMEOUT);

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', () => clearTimeout(timer));

    req.write(payload);
    req.end();
  });
}

// ── Format raw_items for LLM input ──
function formatItemsForLlm(items) {
  return items.map((item, i) => {
    const parts = [`[${i + 1}] ${item.title || '(untitled)'}`];
    if (item.source_name) parts.push(`Source: ${item.source_name} (${item.source_type})`);
    if (item.author) parts.push(`Author: ${item.author}`);
    if (item.url) parts.push(`URL: ${item.url}`);
    if (item.content) parts.push(item.content.slice(0, 500));
    if (item.published_at) parts.push(`Published: ${item.published_at}`);
    // Include metadata signals (scores, upvotes, etc.)
    if (item.metadata && item.metadata !== '{}') {
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        const signals = [];
        if (meta.score) signals.push(`score: ${meta.score}`);
        if (meta.upvotes) signals.push(`upvotes: ${meta.upvotes}`);
        if (meta.comments) signals.push(`comments: ${meta.comments}`);
        if (meta.stars) signals.push(`stars: ${meta.stars}`);
        if (signals.length) parts.push(`Signals: ${signals.join(', ')}`);
      } catch {}
    }
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

// ── Subscription hash for caching ──
function subscriptionHash(sourceIds) {
  const sorted = [...sourceIds].sort((a, b) => a - b);
  return createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 16);
}

// ── Generate digest for a single user ──
async function generateForUser(db, userId, userName, type, dryRun) {
  const sourceIds = getActiveSubscriptionSourceIds(db, userId);
  if (!sourceIds.length) {
    console.log(`  [skip] ${userName || userId}: no active subscriptions`);
    return null;
  }

  const lastDigest = getLastDigestTime(db, userId, type);
  const since = lastDigest || undefined;

  const items = listRawItemsForDigest(db, sourceIds, { since, limit: MAX_ITEMS });
  if (!items.length) {
    console.log(`  [skip] ${userName || userId}: no new items since last digest`);
    return null;
  }

  console.log(`  [gen] ${userName || userId}: ${items.length} items from ${sourceIds.length} sources`);

  const promptTemplate = loadPromptTemplate();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
  const timeStr = now.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
  const systemPrompt = promptTemplate
    .replace('{{date}}', dateStr)
    .replace('{{time}}', timeStr)
    .replace('{{timezone}}', 'SGT');

  const userContent = `Generate a ${type} digest from the following ${items.length} items:\n\n${formatItemsForLlm(items)}`;

  if (dryRun) {
    console.log(`  [dry-run] Would send ${userContent.length} chars to LLM`);
    console.log(`  [dry-run] Sources: ${sourceIds.join(', ')}`);
    return { userId, items: items.length, sources: sourceIds.length };
  }

  const content = await callLlm(systemPrompt, userContent);
  const subHash = subscriptionHash(sourceIds);
  const metadata = JSON.stringify({
    source_count: sourceIds.length,
    item_count: items.length,
    subscription_hash: subHash,
    model: LLM_MODEL,
  });

  const result = createDigest(db, { type, content, metadata, user_id: userId });
  console.log(`  [done] ${userName || userId}: digest #${result.id} created`);
  return result;
}

// ── Generate system digest (user_id = NULL) ──
async function generateSystemDigest(db, type, dryRun) {
  // Use public sources for system digest
  const publicSources = listSources(db, { activeOnly: true, includePublic: true })
    .filter(s => s.is_public);
  const sourceIds = publicSources.map(s => s.id);

  if (!sourceIds.length) {
    console.log('  [skip] No public sources for system digest');
    return null;
  }

  // Check if system digest is already fresh
  const db2 = db; // reuse connection
  const lastSystem = db2.prepare(
    'SELECT created_at FROM digests WHERE user_id IS NULL AND type = ? ORDER BY created_at DESC LIMIT 1'
  ).get(type);
  const interval = TYPE_INTERVALS[type] || 4;
  if (lastSystem) {
    const lastTime = new Date(lastSystem.created_at.includes('+') ? lastSystem.created_at : lastSystem.created_at + 'Z');
    const hoursSince = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);
    if (hoursSince < interval) {
      console.log(`  [skip] System digest still fresh (${hoursSince.toFixed(1)}h ago)`);
      return null;
    }
  }

  const since = lastSystem?.created_at || undefined;
  const items = listRawItemsForDigest(db, sourceIds, { since, limit: MAX_ITEMS });
  if (!items.length) {
    console.log('  [skip] No new items for system digest');
    return null;
  }

  console.log(`  [gen] System digest: ${items.length} items from ${sourceIds.length} public sources`);

  const promptTemplate = loadPromptTemplate();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore' });
  const timeStr = now.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
  const systemPrompt = promptTemplate
    .replace('{{date}}', dateStr)
    .replace('{{time}}', timeStr)
    .replace('{{timezone}}', 'SGT');

  const userContent = `Generate a ${type} digest from the following ${items.length} items:\n\n${formatItemsForLlm(items)}`;

  if (dryRun) {
    console.log(`  [dry-run] Would send ${userContent.length} chars to LLM`);
    return { system: true, items: items.length, sources: sourceIds.length };
  }

  const content = await callLlm(systemPrompt, userContent);
  const metadata = JSON.stringify({
    source_count: sourceIds.length,
    item_count: items.length,
    system: true,
    model: LLM_MODEL,
  });

  const result = createDigest(db, { type, content, metadata });
  console.log(`  [done] System digest #${result.id} created`);
  return result;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : '4h';
  const userId = args.includes('--user') ? parseInt(args[args.indexOf('--user') + 1], 10) : null;
  const systemOnly = args.includes('--system');
  const dryRun = args.includes('--dry-run');

  if (!TYPE_INTERVALS[type]) {
    console.error(`Invalid digest type: ${type}. Must be one of: ${Object.keys(TYPE_INTERVALS).join(', ')}`);
    process.exit(1);
  }

  const interval = TYPE_INTERVALS[type];
  const db = getDb(DB_PATH);

  console.log(`[generator] Starting ${type} digest generation${dryRun ? ' (dry-run)' : ''}`);

  let results = [];

  // 1. Always generate/refresh system digest
  if (!userId) {
    try {
      const r = await generateSystemDigest(db, type, dryRun);
      if (r) results.push(r);
    } catch (e) {
      console.error(`  [error] System digest failed: ${e.message}`);
    }
  }

  if (systemOnly) {
    console.log(`[generator] Done. ${results.length} digest(s) generated.`);
    return;
  }

  // 2. Generate per-user digests
  let users;
  if (userId) {
    const u = db.prepare('SELECT id, name, slug FROM users WHERE id = ?').get(userId);
    if (!u) {
      console.error(`User ${userId} not found`);
      process.exit(1);
    }
    users = [u];
  } else {
    users = getUsersDueForDigest(db, type, interval);
  }

  console.log(`[generator] ${users.length} user(s) due for ${type} digest`);

  for (const user of users) {
    try {
      const r = await generateForUser(db, user.id, user.name || user.slug, type, dryRun);
      if (r) results.push(r);
    } catch (e) {
      console.error(`  [error] ${user.name || user.id}: ${e.message}`);
    }
  }

  console.log(`[generator] Done. ${results.length} digest(s) generated.`);
}

main().catch(e => {
  console.error('[generator] Fatal:', e.message);
  process.exit(1);
});
