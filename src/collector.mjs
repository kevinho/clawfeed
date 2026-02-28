/**
 * ClawFeed Collector — fetches content from sources into raw_items.
 *
 * Usage:
 *   node src/collector.mjs              # one-shot: fetch all due sources
 *   node src/collector.mjs --loop       # continuous: run on interval
 *   node src/collector.mjs --source 5   # fetch a single source by ID
 */

import http from 'http';
import https from 'https';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { getDb, getSourcesDueForFetch, getSource, insertRawItemsBatch, touchSourceFetch, recordSourceError, cleanOldRawItems } from './db.mjs';

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

const DB_PATH = process.env.DIGEST_DB || env.DIGEST_DB || join(ROOT, 'data', 'digest.db');
mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = getDb(DB_PATH);

const LOOP_INTERVAL = parseInt(process.env.COLLECTOR_INTERVAL || env.COLLECTOR_INTERVAL || '300', 10) * 1000;
const CONCURRENCY = parseInt(process.env.COLLECTOR_CONCURRENCY || env.COLLECTOR_CONCURRENCY || '5', 10);
const UA = 'ClawFeed-Collector/1.0';

// ── SSRF protection ──

function isPrivateOrSpecialIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const n = ip.toLowerCase();
    if (n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:')) return true;
    // IPv6-mapped IPv4 (::ffff:x.x.x.x) — extract the IPv4 and check it
    const v4Mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateOrSpecialIp(v4Mapped[1]);
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function resolveAndValidateUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid url scheme');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) throw new Error('blocked host');
    return { url: u, resolvedIp: host };
  }
  const resolved = await lookup(host, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateOrSpecialIp(r.address))) {
    throw new Error('blocked host');
  }
  return { url: u, resolvedIp: resolved[0].address, resolvedFamily: resolved[0].family };
}

// ── HTTP helper ──

function httpGet(url, { timeout = 10000, maxBytes = 500000, redirectsLeft = 3 } = {}) {
  return new Promise(async (resolve, reject) => {
    let safe;
    try {
      safe = await resolveAndValidateUrl(url);
    } catch (e) {
      return reject(e);
    }
    const mod = url.startsWith('https') ? https : http;
    // Pin DNS to the already-resolved IP to prevent DNS rebinding (TOCTOU)
    const pinnedLookup = (_hostname, _opts, cb) => cb(null, safe.resolvedIp, safe.resolvedFamily || 4);
    const r = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/json,*/*' }, lookup: pinnedLookup }, async (resp) => {
      try {
        resp.setEncoding('utf8');
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          clearTimeout(timer);
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const nextUrl = new URL(resp.headers.location, url).toString();
          return resolve(await httpGet(nextUrl, { timeout: Math.max(2000, timeout - 2000), maxBytes, redirectsLeft: redirectsLeft - 1 }));
        }
        if (resp.statusCode >= 400) {
          clearTimeout(timer);
          return reject(new Error(`HTTP ${resp.statusCode}`));
        }
        let data = '';
        let size = 0;
        resp.on('data', c => { size += c.length; if (size > maxBytes) { resp.destroy(); clearTimeout(timer); reject(new Error('response too large')); } else { data += c; } });
        resp.on('end', () => { clearTimeout(timer); resolve({ status: resp.statusCode, contentType: resp.headers['content-type'] || '', body: data }); });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    const timer = setTimeout(() => { r.destroy(); reject(new Error('timeout')); }, timeout);
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Source fetchers ──

function parseConfig(source) {
  return typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
}

async function fetchRss(source) {
  const config = parseConfig(source);
  const url = config.url;
  if (!url) return [];

  const resp = await httpGet(url);
  const xml = resp.body;
  const items = [];

  const re = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 50) {
    const block = m[1] || m[2];
    const title = extractXmlTag(block, 'title');
    const link = extractXmlLink(block);
    const author = extractXmlTag(block, 'author') || extractXmlTag(block, 'dc:creator') || '';
    const description = extractXmlTag(block, 'content:encoded') || extractXmlTag(block, 'description') || extractXmlTag(block, 'summary') || extractXmlTag(block, 'content') || '';
    const pubDate = extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'published') || extractXmlTag(block, 'updated') || '';

    items.push({
      title: stripCdata(title),
      url: link,
      author: stripCdata(author),
      content: stripHtml(stripCdata(description)).slice(0, 2000),
      publishedAt: pubDate ? normalizeDate(pubDate) : null,
    });
  }

  return items;
}

async function fetchHackerNews(source) {
  const config = parseConfig(source);
  const filter = config.filter || 'top';
  const minScore = config.min_score || 50;

  const listUrl = `https://hacker-news.firebaseio.com/v0/${filter}stories.json`;
  const resp = await httpGet(listUrl);
  const ids = JSON.parse(resp.body).slice(0, 30);

  // Fetch items with limited concurrency (5 at a time)
  const items = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const itemResp = await httpGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 5000 });
        return JSON.parse(itemResp.body);
      })
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const item = r.value;
      if (item.dead || item.deleted || item.score < minScore) continue;
      items.push({
        title: item.title || '',
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        author: item.by || '',
        content: item.title || '',
        publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
        metadata: { score: item.score, comments: item.descendants || 0 },
      });
    }
  }

  return items;
}

async function fetchReddit(source) {
  const config = parseConfig(source);
  const subreddit = config.subreddit;
  const sort = config.sort || 'hot';
  const limit = Math.min(config.limit || 25, 50);

  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${limit}&raw_json=1`;
  const resp = await httpGet(url);
  const data = JSON.parse(resp.body);

  if (!data.data || !data.data.children) return [];

  return data.data.children
    .filter(c => c.kind === 't3' && !c.data.stickied)
    .map(c => {
      const d = c.data;
      return {
        title: d.title || '',
        url: d.url || `https://www.reddit.com${d.permalink}`,
        author: d.author || '',
        content: (d.selftext || d.title || '').slice(0, 2000),
        publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
        metadata: { score: d.score, comments: d.num_comments, subreddit: d.subreddit },
      };
    });
}

async function fetchGithubTrending(source) {
  const config = parseConfig(source);
  const language = config.language || '';
  const since = config.since || 'daily';

  const url = `https://github.com/trending${language && language !== 'all' ? '/' + encodeURIComponent(language) : ''}?since=${since}`;
  const resp = await httpGet(url, { maxBytes: 1000000 });
  const html = resp.body;

  const items = [];
  const repoRe = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = repoRe.exec(html)) && items.length < 25) {
    const block = m[1];
    const hrefMatch = block.match(/href="(\/[^"]+?)"/);
    if (!hrefMatch) continue;
    const repoPath = hrefMatch[1].trim();
    const repoUrl = `https://github.com${repoPath}`;
    const repoName = repoPath.replace(/^\//, '');

    const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const desc = descMatch ? stripHtml(descMatch[1]).trim() : '';

    const starsMatch = block.match(/(\d[\d,]*)\s*stars?\s*today/i);
    const starsToday = starsMatch ? parseInt(starsMatch[1].replace(/,/g, '')) : 0;

    items.push({
      title: repoName,
      url: repoUrl,
      content: desc,
      publishedAt: null,
      metadata: { stars_today: starsToday, language: language || 'all' },
    });
  }

  return items;
}

async function fetchWebsite(source) {
  const config = parseConfig(source);
  const url = config.url;
  if (!url) return [];

  const resp = await httpGet(url, { maxBytes: 200000 });
  const html = resp.body;

  // Look for RSS link in HTML
  const rssMatch = html.match(/<link[^>]*type=["']application\/(rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i);
  if (rssMatch) {
    const rssUrl = new URL(rssMatch[2], url).toString();
    return fetchRss({ ...source, config: JSON.stringify({ url: rssUrl }) });
  }

  // Fallback: record page title + og:description as a single item
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : url;
  const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*?)["']/i);
  const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : '';

  return [{
    title,
    url,
    content: ogDesc || title,
  }];
}

// Fetcher registry
const FETCHERS = {
  rss: fetchRss,
  digest_feed: fetchRss,
  hackernews: fetchHackerNews,
  reddit: fetchReddit,
  github_trending: fetchGithubTrending,
  website: fetchWebsite,
  // twitter_feed, twitter_list, twitter_bookmarks — Phase 1.5 (needs Twitter API)
};

// ── XML helpers ──

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractXmlLink(xml) {
  const hrefMatch = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1].trim();
  const contentMatch = xml.match(/<link[^>]*>(.*?)<\/link>/i);
  if (contentMatch) return contentMatch[1].trim();
  return '';
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function normalizeDate(s) {
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

// ── Concurrency pool ──

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(
      (result) => { executing.delete(p); return { ok: true, result }; },
      (error) => { executing.delete(p); return { ok: false, error }; }
    );
    executing.add(p);
    results.push(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ── Main collection logic ──

async function collectSource(source) {
  const fetcher = FETCHERS[source.type];
  if (!fetcher) {
    return { sourceId: source.id, name: source.name, type: source.type, skipped: true, reason: `no fetcher for type '${source.type}'` };
  }

  try {
    const items = await fetcher(source);
    if (!items.length) {
      touchSourceFetch(db, source.id);
      return { sourceId: source.id, name: source.name, fetched: 0, inserted: 0 };
    }

    const inserted = insertRawItemsBatch(db, source.id, items);
    touchSourceFetch(db, source.id);

    return { sourceId: source.id, name: source.name, fetched: items.length, inserted };
  } catch (e) {
    recordSourceError(db, source.id, e.message);
    return { sourceId: source.id, name: source.name, error: e.message };
  }
}

async function collectAll() {
  const sources = getSourcesDueForFetch(db);
  if (!sources.length) {
    console.log('[collector] No sources due for fetch');
    return [];
  }

  console.log(`[collector] ${sources.length} source(s) due for fetch (concurrency: ${CONCURRENCY})`);

  // Build task functions for concurrency pool
  const tasks = sources.map((source) => () => collectSource(source));
  const poolResults = await runWithConcurrency(tasks, CONCURRENCY);

  const results = [];
  for (let i = 0; i < sources.length; i++) {
    const pr = poolResults[i];
    const result = pr.ok ? pr.result : { sourceId: sources[i].id, name: sources[i].name, error: pr.error?.message || 'unknown error' };
    results.push(result);

    if (result.error) {
      console.error(`[collector] ${result.name} (${sources[i].type}): ERROR ${result.error}`);
    } else if (result.skipped) {
      console.log(`[collector] ${result.name} (${sources[i].type}): skipped (${result.reason})`);
    } else {
      console.log(`[collector] ${result.name} (${sources[i].type}): fetched=${result.fetched} inserted=${result.inserted}`);
    }
  }

  // Clean old items (30-day TTL)
  const cleaned = cleanOldRawItems(db);
  if (cleaned.changes > 0) {
    console.log(`[collector] Cleaned ${cleaned.changes} old raw_items (>30 days)`);
  }

  return results;
}

// ── CLI ──

const args = process.argv.slice(2);

if (args.includes('--source')) {
  const idx = args.indexOf('--source');
  const sourceId = parseInt(args[idx + 1]);
  const source = getSource(db, sourceId);
  if (!source) {
    console.error(`Source ${sourceId} not found`);
    process.exit(1);
  }
  const result = await collectSource(source);
  console.log(JSON.stringify(result, null, 2));
} else if (args.includes('--loop')) {
  console.log(`[collector] Starting loop (interval: ${LOOP_INTERVAL / 1000}s, concurrency: ${CONCURRENCY})`);
  let running = true;
  const shutdown = (sig) => {
    if (!running) return;
    running = false;
    console.log(`[collector] ${sig} received, shutting down gracefully...`);
    clearInterval(loopTimer);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await collectAll();
  const loopTimer = setInterval(() => { if (running) collectAll(); }, LOOP_INTERVAL);
} else {
  const results = await collectAll();
  console.log(`\n[collector] Done. ${results.length} source(s) processed.`);
  const inserted = results.reduce((sum, r) => sum + (r.inserted || 0), 0);
  const errors = results.filter(r => r.error).length;
  console.log(`[collector] Total inserted: ${inserted}, errors: ${errors}`);
}
