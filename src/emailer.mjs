#!/usr/bin/env node
/**
 * ClawFeed Email Digest Sender
 *
 * Sends personalized digest emails to users who opted in.
 * Uses Resend API for delivery.
 *
 * Usage:
 *   node src/emailer.mjs                    # Send all due emails
 *   node src/emailer.mjs --type daily       # Send daily digests only
 *   node src/emailer.mjs --type weekly      # Send weekly digests only
 *   node src/emailer.mjs --user 5           # Send to specific user
 *   node src/emailer.mjs --dry-run          # Preview without sending
 */

import { Resend } from 'resend';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import {
  getDb,
  getEmailPreference,
  upsertEmailPreference,
  getUsersDueForEmail,
  listDigestsByUser,
  logEmail,
  updateEmailLog,
  touchEmailSent,
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
const RESEND_API_KEY = process.env.RESEND_API_KEY || env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || env.EMAIL_FROM || 'ClawFeed <digest@example.com>';
const BASE_URL = process.env.BASE_URL || env.BASE_URL || 'https://clawfeed.kevinhe.io';
const DB_PATH = process.env.DIGEST_DB || env.DIGEST_DB || join(ROOT, 'data', 'digest.db');
const MAX_RETRIES = 2;

// ── Load HTML template ──
const templatePath = join(ROOT, 'templates', 'email-digest.html');
const EMAIL_TEMPLATE = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : null;

// ── HTML escaping (prevent XSS from external RSS/feed content) ──
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeHref(url) {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return '#';
}

// ── Simple markdown to HTML (for digest content) ──
function markdownToHtml(md) {
  // Escape HTML entities first to prevent injection
  const escaped = escapeHtml(md);
  return escaped
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Links (sanitize href to http/https only)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${sanitizeHref(url)}">${text}</a>`)
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Blockquotes
    .replace(/&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    // Unordered lists (simple single-level)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    // Paragraphs (double newline)
    .replace(/\n\n+/g, '</p><p>')
    // Single newlines → <br>
    .replace(/\n/g, '<br>')
    // Wrap in paragraph
    .replace(/^(.+)/, '<p>$1</p>');
}

// ── Render email HTML ──
function renderEmail({ title, date, content, frequency, webUrl, unsubscribeUrl }) {
  if (!EMAIL_TEMPLATE) {
    // Fallback: plain HTML
    return `<html><body><h1>${title}</h1><p>${date}</p>${markdownToHtml(content)}<hr><p><a href="${unsubscribeUrl}">Unsubscribe</a></p></body></html>`;
  }

  const htmlContent = markdownToHtml(content);

  return EMAIL_TEMPLATE
    .replace(/\{\{SUBJECT\}\}/g, title)
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{CONTENT\}\}/g, htmlContent)
    .replace(/\{\{FREQUENCY\}\}/g, frequency)
    .replace(/\{\{WEB_URL\}\}/g, webUrl)
    .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubscribeUrl);
}

// ── Build subject line ──
function buildSubject(type, date) {
  const icons = { daily: '\u{1F4F0}', weekly: '\u{1F4C5}' };
  const labels = { daily: 'Daily Digest', weekly: 'Weekly Digest' };
  return `${icons[type] || '\u{1F4DD}'} ClawFeed ${labels[type] || 'Digest'} — ${date}`;
}

// ── Send single email ──
async function sendEmail(resend, { to, subject, html }) {
  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: [to],
    subject,
    html,
  });

  if (result.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }

  return result.data;
}

// ── Send digest email to one user ──
async function sendDigestToUser(db, resend, user, type, dryRun) {
  const pref = getEmailPreference(db, user.id);
  if (!pref || pref.frequency === 'off') {
    console.log(`  [skip] ${user.name || user.id}: email off`);
    return null;
  }

  if (pref.frequency !== type) {
    console.log(`  [skip] ${user.name || user.id}: wants ${pref.frequency}, running ${type}`);
    return null;
  }

  // Get latest digest for this user matching the email frequency type
  const digests = listDigestsByUser(db, user.id, { type, limit: 1 });
  const digest = digests[0];

  if (!digest) {
    console.log(`  [skip] ${user.name || user.id}: no ${type} digest available`);
    return null;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-SG', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = buildSubject(type, dateStr);
  const unsubscribeUrl = `${BASE_URL}/api/email/unsubscribe?token=${pref.unsubscribe_token}`;
  const webUrl = user.slug ? `${BASE_URL}/feed/${user.slug}` : BASE_URL;

  const html = renderEmail({
    title: `ClawFeed ${type === 'daily' ? 'Daily' : 'Weekly'} Digest`,
    date: `${dateStr} SGT`,
    content: digest.content,
    frequency: type,
    webUrl,
    unsubscribeUrl,
  });

  if (dryRun) {
    console.log(`  [dry-run] ${user.name || user.id}: would send "${subject}" (${html.length} bytes)`);
    return { userId: user.id, subject, dryRun: true };
  }

  // Log the attempt
  const logId = logEmail(db, user.id, digest.id);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await sendEmail(resend, {
        to: user.email,
        subject,
        html,
      });

      updateEmailLog(db, logId, 'sent', result.id);
      touchEmailSent(db, user.id);
      console.log(`  [sent] ${user.name || user.id}: ${result.id}`);
      return { userId: user.id, resendId: result.id };
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`  [retry] ${user.name || user.id}: attempt ${attempt + 1} failed — ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        updateEmailLog(db, logId, 'failed', null, e.message);
        console.error(`  [fail] ${user.name || user.id}: ${e.message}`);
        return null;
      }
    }
  }
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : 'daily';
  const userId = args.includes('--user') ? parseInt(args[args.indexOf('--user') + 1], 10) : null;
  const dryRun = args.includes('--dry-run');

  if (!['daily', 'weekly'].includes(type)) {
    console.error(`Invalid email type: ${type}. Must be 'daily' or 'weekly'.`);
    process.exit(1);
  }

  if (!RESEND_API_KEY && !dryRun) {
    console.error('RESEND_API_KEY not configured. Use --dry-run to preview.');
    process.exit(1);
  }

  const db = getDb(DB_PATH);
  const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

  console.log(`[emailer] Starting ${type} email send${dryRun ? ' (dry-run)' : ''}`);

  let users;
  if (userId) {
    const u = db.prepare('SELECT id, name, email, slug FROM users WHERE id = ?').get(userId);
    if (!u) { console.error(`User ${userId} not found`); process.exit(1); }
    if (!u.email) { console.error(`User ${userId} has no email`); process.exit(1); }
    users = [u];
  } else {
    users = getUsersDueForEmail(db, type);
  }

  console.log(`[emailer] ${users.length} user(s) due for ${type} email`);

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const result = await sendDigestToUser(db, resend, user, type, dryRun);
      if (result) sent++;
    } catch (e) {
      console.error(`  [error] ${user.name || user.id}: ${e.message}`);
      failed++;
    }
  }

  console.log(`[emailer] Done. Sent: ${sent}, Failed: ${failed}, Total: ${users.length}`);
}

main().catch(e => {
  console.error('[emailer] Fatal:', e.message);
  process.exit(1);
});
