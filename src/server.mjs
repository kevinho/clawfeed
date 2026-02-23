import { createServer } from 'http';
import http from 'http';
import https from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { getDb, listDigests, getDigest, createDigest, listMarks, createMark, deleteMark, getConfig, setConfig, upsertUser, createSession, getSession, deleteSession, listSources, getSource, createSource, updateSource, deleteSource, getSourceByTypeConfig, getUserBySlug, listDigestsByUser, countDigestsByUser, createPack, getPack, getPackBySlug, listPacks, incrementPackInstall, deletePack, listSubscriptions, subscribe, unsubscribe, bulkSubscribe, isSubscribed, createFeedback, getUserFeedback, getAllFeedback, replyToFeedback, updateFeedbackStatus, markFeedbackRead, getUnreadFeedbackCount } from './db.mjs';

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

const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = env.SESSION_SECRET || process.env.SESSION_SECRET;
const API_KEY = env.API_KEY || process.env.API_KEY || '';
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || 'localhost').split(',').map(o => o.trim()).filter(Boolean);
const PORT = process.env.DIGEST_PORT || env.DIGEST_PORT || 8767;
const OAUTH_STATE_SECRET = env.OAUTH_STATE_SECRET || process.env.OAUTH_STATE_SECRET || SESSION_SECRET || API_KEY || 'dev-state-secret';
const MAX_BODY_BYTES = 1024 * 1024;
const DB_PATH = process.env.DIGEST_DB || join(ROOT, 'data', 'digest.db');

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = getDb(DB_PATH);

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('payload too large'));
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
  });
}

function parseUrl(url) {
  const [path, qs] = url.split('?');
  const params = new URLSearchParams(qs || '');
  return { path, params };
}

function parseCookies(req) {
  const obj = {};
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) obj[k] = decodeURIComponent(v.join('='));
  }
  return obj;
}

const COOKIE_NAME = process.env.COOKIE_NAME || env.COOKIE_NAME || 'session';
function setSessionCookie(res, value, maxAge = 30 * 86400) {
  const cookie = `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  setSessionCookie(res, '', 0);
}

function normalizeOrigin(input) {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (!ALLOWED_ORIGINS.length) return false;
  return ALLOWED_ORIGINS.some((allowed) => {
    if (allowed.includes('://')) return normalizeOrigin(allowed) === normalized;
    try { return new URL(normalized).hostname === allowed; } catch { return false; }
  });
}

function signOAuthState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || !state.includes('.')) return null;
  const [body, sig] = state.split('.', 2);
  const expected = createHmac('sha256', OAUTH_STATE_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

function isPrivateOrSpecialIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const n = ip.toLowerCase();
    return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n.startsWith('::ffff:127.');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertSafeFetchUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid url scheme');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
  if (isIP(host) && isPrivateOrSpecialIp(host)) throw new Error('blocked host');
  const resolved = await lookup(host, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateOrSpecialIp(r.address))) {
    throw new Error('blocked host');
  }
}

// ── Google OAuth helpers ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Auth middleware: attach req.user if valid session
function attachUser(req) {
  const cookies = parseCookies(req);
  const sessionVal = cookies[COOKIE_NAME];
  if (sessionVal) {
    const sess = getSession(db, sessionVal);
    if (sess) {
      req.user = { id: sess.uid, email: sess.email, name: sess.name, avatar: sess.avatar, slug: sess.slug };
      req.sessionId = sessionVal;
    }
  }
}

function _digestTitle(d, ca) {
  const dt = new Date(ca.includes('+') ? ca : ca.replace(' ', 'T') + '+08:00');
  const timeStr = dt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const icons = { '4h': '☀️', daily: '📰', weekly: '📅', monthly: '📊' };
  const labels = { '4h': 'AI 简报', daily: 'AI 日报', weekly: 'AI 周报', monthly: 'AI 月报' };
  return `${icons[d.type] || '📝'} ${labels[d.type] || 'ClawFeed'} | ${timeStr} SGT`;
}

// ── Source URL resolver ──
async function httpFetch(url, timeout = 5000, redirectsLeft = 3) {
  await assertSafeFetchUrl(url);
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.get(url, { headers: { 'User-Agent': 'AI-Digest/1.0', 'Accept': 'text/html,application/xhtml+xml,application/xml,application/json,*/*' } }, async (resp) => {
      try {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          clearTimeout(timer);
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const nextUrl = new URL(resp.headers.location, url).toString();
          return resolve(await httpFetch(nextUrl, Math.max(1000, timeout - 1000), redirectsLeft - 1));
        }
        let data = '';
        resp.on('data', c => { data += c; if (data.length > 200000) resp.destroy(); });
        resp.on('end', () => { clearTimeout(timer); resolve({ contentType: resp.headers['content-type'] || '', body: data }); });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    const timer = setTimeout(() => { r.destroy(); reject(new Error('timeout')); }, timeout);
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function extractRssPreview(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 5) {
    const block = m[1] || m[2];
    const t = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
    const l = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>(.*?)<\/link>/i);
    items.push({ title: t ? t[1].trim() : '(untitled)', url: l ? l[1].trim() : '' });
  }
  return items;
}

async function resolveSourceUrl(url) {
  const u = url.toLowerCase();

  // Twitter/X
  if (u.includes('x.com') || u.includes('twitter.com')) {
    const listMatch = url.match(/\/i\/lists\/(\d+)/);
    if (listMatch) {
      return { name: `X List ${listMatch[1]}`, type: 'twitter_list', config: { list_url: url }, icon: '🐦' };
    }
    const handleMatch = url.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]+)/);
    if (handleMatch && !['i','search','explore','home','notifications','messages','settings'].includes(handleMatch[1].toLowerCase())) {
      const handle = handleMatch[1].replace(/^@/, '');
      return { name: `@${handle}`, type: 'twitter_feed', config: { handle: `@${handle}` }, icon: '🐦' };
    }
    return { name: 'X Feed', type: 'twitter_feed', config: { handle: url }, icon: '🐦' };
  }

  // Reddit
  const redditMatch = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/);
  if (redditMatch) {
    return { name: `r/${redditMatch[1]}`, type: 'reddit', config: { subreddit: redditMatch[1], sort: 'hot', limit: 20 }, icon: '👽' };
  }

  // GitHub Trending
  if (u.includes('github.com/trending')) {
    const langMatch = url.match(/\/trending\/([a-z0-9+#.-]+)/i);
    const lang = langMatch ? langMatch[1] : '';
    return { name: `GitHub Trending${lang ? ' - ' + lang : ''}`, type: 'github_trending', config: { language: lang || 'all', since: 'daily' }, icon: '⭐' };
  }

  // Hacker News
  if (u.includes('news.ycombinator.com')) {
    return { name: 'Hacker News', type: 'hackernews', config: { filter: 'top', min_score: 100 }, icon: '🔶' };
  }

  // Fetch the URL to detect content type
  const resp = await httpFetch(url);
  const ct = resp.contentType.toLowerCase();
  const body = resp.body;

  // RSS/Atom
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || body.trimStart().startsWith('<?xml') || body.includes('<rss') || body.includes('<feed')) {
    if (body.includes('<rss') || body.includes('<feed') || body.includes('<channel')) {
      const titleMatch = body.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const name = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;
      const preview = extractRssPreview(body);
      return { name, type: 'rss', config: { url }, icon: '📡', preview };
    }
  }

  // JSON Feed
  if (ct.includes('json') || body.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(body);
      if (j.version && j.version.includes('jsonfeed')) {
        const preview = (j.items || []).slice(0, 5).map(i => ({ title: i.title || '(untitled)', url: i.url }));
        return { name: j.title || new URL(url).hostname, type: 'digest_feed', config: { url }, icon: '📰', preview };
      }
    } catch {}
  }

  // HTML - extract title, treat as website
  if (ct.includes('html') || body.includes('<html') || body.includes('<!DOCTYPE')) {
    const titleMatch = body.match(/<title[^>]*>(.*?)<\/title>/is);
    const name = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ').slice(0, 100) : new URL(url).hostname;
    return { name, type: 'website', config: { url }, icon: '🌐' };
  }

  throw new Error('Cannot detect source type');
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let { path, params } = parseUrl(req.url);

  // ── Health check (no auth required) ──
  if (req.method === 'GET' && (path === '/api/health' || path === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── Feed endpoints (public, before auth) ──
  const feedMatch = path.match(/^\/feed\/([a-z0-9_-]+?)(?:\.(json|rss))?$/);
  if (req.method === 'GET' && feedMatch) {
    const slug = feedMatch[1];
    const format = feedMatch[2] || 'api'; // 'json', 'rss', or 'api'
    const user = getUserBySlug(db, slug);
    if (!user) return json(res, { error: 'user not found' }, 404);

    const type = params.get('type') || '4h';
    const limit = Math.min(parseInt(params.get('limit') || '10'), 50);
    const since = params.get('since') || undefined;
    const digests = listDigestsByUser(db, user.id, { type, limit, since });
    const total = countDigestsByUser(db, user.id, { type });
    const BASE = 'https://clawfeed.kevinhe.io';

    if (format === 'json') {
      // JSON Feed 1.1
      const feed = {
        version: 'https://jsonfeed.org/version/1.1',
        title: `${user.name}'s ClawFeed`,
        home_page_url: BASE,
        feed_url: `${BASE}/feed/${slug}.json`,
        items: digests.map(d => {
          const ca = d.created_at;
          const dt = ca.includes('+') ? ca : ca.replace(' ', 'T') + '+08:00';
          const title = _digestTitle(d, ca);
          return {
            id: String(d.id),
            title,
            content_text: d.content,
            date_published: dt,
            url: `${BASE}/#digest-${d.id}`
          };
        })
      };
      res.writeHead(200, { 'Content-Type': 'application/feed+json; charset=utf-8' });
      res.end(JSON.stringify(feed));
      return;
    }

    if (format === 'rss') {
      // RSS 2.0
      const escXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      let items = '';
      for (const d of digests) {
        const ca = d.created_at;
        const dt = new Date(ca.includes('+') ? ca : ca.replace(' ', 'T') + '+08:00');
        const title = _digestTitle(d, ca);
        items += `<item><title>${escXml(title)}</title><link>${BASE}/#digest-${d.id}</link><guid isPermaLink="false">${d.id}</guid><pubDate>${dt.toUTCString()}</pubDate><description>${escXml(d.content.slice(0, 2000))}</description></item>\n`;
      }
      const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escXml(user.name)}'s ClawFeed</title><link>${BASE}</link><description>ClawFeed Feed</description>\n${items}</channel></rss>`;
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(rss);
      return;
    }

    // Simple API
    return json(res, {
      user: { name: user.name, slug: user.slug },
      digests: digests.map(d => ({ id: d.id, type: d.type, content: d.content, created_at: d.created_at })),
      total
    });
  }

  // SPA route: / and /pack/:slug serve frontend HTML
  if (req.method === 'GET' && (path === '/' || path.startsWith('/pack/'))) {
    try {
      const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500); res.end('Internal error'); return;
    }
  }

  if (!path.startsWith('/api/') && path !== '/mark' && path !== '/marks') {
    path = '/api' + path;
  }

  attachUser(req);

  try {
    // ── Auth endpoints ──

    // GET /api/auth/config — tells frontend if auth is available
    if (req.method === 'GET' && path === '/api/auth/config') {
      const authEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
      return json(res, { authEnabled });
    }

    // GET /api/auth/google
    if (req.method === 'GET' && path === '/api/auth/google') {
      const originCandidate = params.get('origin') || req.headers.referer || (req.headers.host ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : `http://localhost:${PORT}`);
      const origin = normalizeOrigin(originCandidate);
      if (!origin || !isAllowedOrigin(origin)) return json(res, { error: 'origin not allowed' }, 400);
      const originUrl = new URL(origin);
      const basePath = env.BASE_PATH || process.env.BASE_PATH || '';
      const redirectUri = `${originUrl.protocol}//${originUrl.host}${basePath}/api/auth/callback`;
      const nonce = randomBytes(16).toString('hex');
      const state = signOAuthState({ origin, redirectUri, nonce, ts: Date.now() });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent('openid email profile')}` +
        `&state=${encodeURIComponent(state)}` +
        `&access_type=offline` +
        `&prompt=select_account`;
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    // GET /api/auth/callback
    if (req.method === 'GET' && path === '/api/auth/callback') {
      const code = params.get('code');
      const stateRaw = params.get('state');
      if (!code) return json(res, { error: 'missing code' }, 400);

      let origin = req.headers.host ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : `http://localhost:${PORT}`;
      let redirectUri = `${origin}/api/auth/callback`;
      const st = verifyOAuthState(stateRaw);
      if (!st) return json(res, { error: 'invalid oauth state' }, 400);
      if (Date.now() - (st.ts || 0) > 10 * 60 * 1000) return json(res, { error: 'expired oauth state' }, 400);
      if (!isAllowedOrigin(st.origin)) return json(res, { error: 'origin not allowed' }, 400);
      origin = st.origin;
      redirectUri = st.redirectUri || redirectUri;

      // Exchange code for tokens
      const tokenResp = await httpsPost('https://oauth2.googleapis.com/token', {
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code'
      });
      const tokens = JSON.parse(tokenResp.body);
      if (!tokens.access_token) {
        console.error('Token exchange failed');
        return json(res, { error: 'token exchange failed', detail: tokens.error }, 500);
      }

      // Get user info
      const userResp = await httpsGet(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokens.access_token}`);
      const gUser = JSON.parse(userResp.body);

      // Upsert user
      const user = upsertUser(db, { googleId: gUser.id, email: gUser.email, name: gUser.name, avatar: gUser.picture });

      // Create session
      const sessionId = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      createSession(db, { id: sessionId, userId: user.id, expiresAt });

      // Set cookie and redirect to frontend
      setSessionCookie(res, sessionId);
      const originUrl = new URL(origin);
      const bp = env.BASE_PATH || process.env.BASE_PATH || (originUrl.pathname.includes('/digest') ? '/digest' : '');
      const frontendUrl = `${originUrl.protocol}//${originUrl.host}${bp}/`;
      res.writeHead(302, { Location: frontendUrl });
      res.end();
      return;
    }

    // GET /api/auth/me
    if (req.method === 'GET' && path === '/api/auth/me') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      return json(res, { user: req.user });
    }

    // POST /api/auth/logout
    if (req.method === 'POST' && path === '/api/auth/logout') {
      if (req.sessionId) deleteSession(db, req.sessionId);
      clearSessionCookie(res);
      return json(res, { ok: true });
    }

    // ── Digest endpoints (public) ──

    if (req.method === 'GET' && path === '/api/digests') {
      const type = params.get('type') || undefined;
      const limit = parseInt(params.get('limit') || '20');
      const offset = parseInt(params.get('offset') || '0');
      return json(res, listDigests(db, { type, limit, offset }));
    }

    const digestMatch = path.match(/^\/api\/digests\/(\d+)$/);
    if (req.method === 'GET' && digestMatch) {
      const d = getDigest(db, parseInt(digestMatch[1]));
      if (!d) return json(res, { error: 'not found' }, 404);
      return json(res, d);
    }

    if (req.method === 'POST' && path === '/api/digests') {
      const authHeader = req.headers.authorization || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!API_KEY || bearerKey !== API_KEY) return json(res, { error: 'invalid api key' }, 401);
      const body = await parseBody(req);
      const result = createDigest(db, body);
      return json(res, result, 201);
    }

    // ── Marks endpoints (auth required) ──

    if (req.method === 'GET' && path === '/api/marks') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const status = params.get('status') || undefined;
      return json(res, listMarks(db, { status, userId: req.user.id }));
    }

    if (req.method === 'POST' && path === '/api/marks') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      const result = createMark(db, { ...body, userId: req.user.id });
      return json(res, { ok: true, ...result });
    }

    const markMatch = path.match(/^\/api\/marks\/(\d+)$/);
    if (req.method === 'DELETE' && markMatch) {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      deleteMark(db, parseInt(markMatch[1]), req.user.id);
      return json(res, { ok: true });
    }

    // POST /mark — backward compat (now requires auth)
    if (req.method === 'POST' && path === '/mark') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      const url = (body.url || '').split('?')[0];
      if (!url) return json(res, { error: 'invalid url' }, 400);
      const result = createMark(db, { url, userId: req.user.id });
      return json(res, { ok: true, status: result.duplicate ? 'already_marked' : 'marked' });
    }

    // GET /marks — backward compat (requires auth)
    if (req.method === 'GET' && path === '/marks') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const marks = listMarks(db, { userId: req.user.id });
      const history = marks.map(m => ({
        action: m.status === 'processed' ? 'processed' : 'mark',
        target: m.url, at: m.created_at, title: m.title || '',
      }));
      return json(res, { tweets: marks.filter(m => m.status === 'pending').map(m => ({ url: m.url, markedAt: m.created_at })), history });
    }

    // ── Subscriptions endpoints ──

    if (req.method === 'GET' && path === '/api/subscriptions') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const subs = listSubscriptions(db, req.user.id);
      return json(res, subs.map(s => ({ ...s, sourceDeleted: !!s.is_deleted })));
    }

    if (req.method === 'POST' && path === '/api/subscriptions') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      if (!body.sourceId) return json(res, { error: 'sourceId required' }, 400);
      const source = getSource(db, body.sourceId);
      if (!source) return json(res, { error: 'source not found' }, 404);
      subscribe(db, req.user.id, body.sourceId);
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/subscriptions/bulk') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const body = await parseBody(req);
      if (!Array.isArray(body.sourceIds)) return json(res, { error: 'sourceIds array required' }, 400);
      const added = bulkSubscribe(db, req.user.id, body.sourceIds);
      return json(res, { ok: true, added });
    }

    const subMatch = path.match(/^\/api\/subscriptions\/(\d+)$/);
    if (req.method === 'DELETE' && subMatch) {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      unsubscribe(db, req.user.id, parseInt(subMatch[1]));
      return json(res, { ok: true });
    }

    // ── Source resolve endpoint ──
    if (req.method === 'POST' && path === '/api/sources/resolve') {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const body = await parseBody(req);
      const url = (body.url || '').trim();
      if (!url) return json(res, { error: 'url required' }, 400);

      try {
        const result = await resolveSourceUrl(url);
        return json(res, result);
      } catch (e) {
        return json(res, { error: e.message || 'cannot resolve' }, 422);
      }
    }

    // ── Sources endpoints ──

    if (req.method === 'GET' && path === '/api/sources') {
      if (req.user) {
        const sources = listSources(db, { userId: req.user.id, includePublic: true });
        // Add subscribed field
        const subs = new Set(listSubscriptions(db, req.user.id).map(s => s.id));
        return json(res, sources.map(s => ({ ...s, subscribed: subs.has(s.id) })));
      } else {
        return json(res, listSources(db, { includePublic: true }));
      }
    }

    const sourceMatch = path.match(/^\/api\/sources\/(\d+)$/);
    if (req.method === 'GET' && sourceMatch) {
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      if (!s.is_public && (!req.user || s.created_by !== req.user.id)) {
        return json(res, { error: 'not found' }, 404);
      }
      return json(res, s);
    }

    if (req.method === 'POST' && path === '/api/sources') {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const body = await parseBody(req);
      const result = createSource(db, { ...body, createdBy: req.user.id });
      return json(res, result, 201);
    }

    if (req.method === 'PUT' && sourceMatch) {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      if (s.created_by !== req.user.id) return json(res, { error: 'forbidden' }, 403);
      const body = await parseBody(req);
      updateSource(db, parseInt(sourceMatch[1]), body);
      return json(res, { ok: true });
    }

    if (req.method === 'DELETE' && sourceMatch) {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      if (s.created_by !== req.user.id) return json(res, { error: 'forbidden' }, 403);
      deleteSource(db, parseInt(sourceMatch[1]), req.user.id);
      return json(res, { ok: true });
    }

    // ── Source Packs endpoints ──

    if (req.method === 'GET' && path === '/api/packs') {
      const packs = listPacks(db, { publicOnly: true, userId: req.user?.id });
      return json(res, packs.map(p => ({ ...p, sources: JSON.parse(p.sources_json || '[]'), sources_json: undefined })));
    }

    const packSlugMatch = path.match(/^\/api\/packs\/([a-z0-9_-]+)$/);
    const packInstallMatch = path.match(/^\/api\/packs\/([a-z0-9_-]+)\/install$/);

    if (req.method === 'POST' && packInstallMatch) {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const pack = getPackBySlug(db, packInstallMatch[1]);
      if (!pack) return json(res, { error: 'not found' }, 404);
      const sources = JSON.parse(pack.sources_json || '[]');
      let added = 0;
      for (const s of sources) {
        const configStr = typeof s.config === 'string' ? s.config : JSON.stringify(s.config);
        // Check if source already exists (including deleted)
        const existing = getSourceByTypeConfig(db, s.type, configStr);
        if (existing) {
          if (existing.is_deleted) {
            // Soft-deleted → skip, don't resurrect
            continue;
          }
          // Source exists and active — just subscribe if not already
          if (!isSubscribed(db, req.user.id, existing.id)) {
            subscribe(db, req.user.id, existing.id);
            added++;
          }
        } else {
          // Create new source (createSource auto-subscribes)
          createSource(db, { name: s.name, type: s.type, config: configStr, isPublic: 0, createdBy: req.user.id });
          added++;
        }
      }
      incrementPackInstall(db, pack.id);
      return json(res, { ok: true, added, skipped: sources.length - added });
    }

    if (req.method === 'GET' && packSlugMatch) {
      const pack = getPackBySlug(db, packSlugMatch[1]);
      if (!pack) return json(res, { error: 'not found' }, 404);
      if (!pack.is_public && (!req.user || pack.created_by !== req.user.id)) return json(res, { error: 'not found' }, 404);
      return json(res, { ...pack, sources: JSON.parse(pack.sources_json || '[]'), sources_json: undefined });
    }

    if (req.method === 'POST' && path === '/api/packs') {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const body = await parseBody(req);
      const name = (body.name || '').trim();
      if (!name) return json(res, { error: 'name required' }, 400);
      let slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      // Ensure unique slug
      let candidate = slug;
      let i = 1;
      while (getPackBySlug(db, candidate)) { candidate = slug + '-' + (i++); }
      slug = candidate;
      const sourcesJson = body.sourcesJson || body.sources_json || '[]';
      const result = createPack(db, { name, description: body.description || '', slug, sourcesJson, createdBy: req.user.id });
      return json(res, { ...result, slug }, 201);
    }

    const packIdMatch = path.match(/^\/api\/packs\/(\d+)$/);
    if (req.method === 'DELETE' && packIdMatch) {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      const pack = getPack(db, parseInt(packIdMatch[1]));
      if (!pack) return json(res, { error: 'not found' }, 404);
      if (pack.created_by !== req.user.id) return json(res, { error: 'forbidden' }, 403);
      deletePack(db, pack.id);
      return json(res, { ok: true });
    }

    // ── Feedback endpoints ──

    if (req.method === 'POST' && path === '/api/feedback') {
      const body = await parseBody(req);
      if (!body.message || !body.message.trim()) return json(res, { error: 'message required' }, 400);
      const id = createFeedback(db, req.user?.id || null, body.email || null, body.name || null, body.message.trim(), body.category || null);
      // Lark channel notification (fire-and-forget)
      const LARK_WEBHOOK = env.FEEDBACK_LARK_WEBHOOK;
      if (LARK_WEBHOOK) {
        const userName = req.user?.name || body.name || 'Anonymous';
        const userEmail = req.user?.email || body.email || '';
        const notifBody = JSON.stringify({ msg_type: 'text', content: { text: `📨 新反馈 #${id}\n👤 ${userName}${userEmail ? ' (' + userEmail + ')' : ''}\n💬 "${body.message.trim().slice(0, 200)}"\n🕐 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}` } });
        try {
          const u = new URL(LARK_WEBHOOK);
          const mod = u.protocol === 'https:' ? https : http;
          const r = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(notifBody) } });
          r.on('error', () => {});
          r.end(notifBody);
        } catch {}
      }
      return json(res, { ok: true, id });
    }

    if (req.method === 'GET' && path === '/api/feedback') {
      if (!req.user) return json(res, []);
      const feedback = getUserFeedback(db, req.user.id);
      const unread = getUnreadFeedbackCount(db, req.user.id);
      return json(res, { feedback, unread });
    }

    // Mark feedback as read
    if (req.method === 'POST' && path === '/api/feedback/read') {
      if (!req.user) return json(res, { error: 'login required' }, 401);
      // Mark all unread replies as read for this user
      db.prepare("UPDATE feedback SET read_at = datetime('now') WHERE user_id = ? AND reply IS NOT NULL AND read_at IS NULL").run(req.user.id);
      return json(res, { ok: true });
    }

    if (req.method === 'GET' && path === '/api/feedback/all') {
      const key = params.get('key') || '';
      const authHeader = req.headers.authorization || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!API_KEY || (key !== API_KEY && bearerKey !== API_KEY)) return json(res, { error: 'invalid api key' }, 401);
      return json(res, getAllFeedback(db));
    }

    const feedbackReplyMatch = path.match(/^\/api\/feedback\/(\d+)\/reply$/);
    if (req.method === 'POST' && feedbackReplyMatch) {
      const key = params.get('key') || '';
      const authHeader = req.headers.authorization || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!API_KEY || (key !== API_KEY && bearerKey !== API_KEY)) return json(res, { error: 'invalid api key' }, 401);
      const body = await parseBody(req);
      if (!body.reply) return json(res, { error: 'reply required' }, 400);
      replyToFeedback(db, parseInt(feedbackReplyMatch[1]), body.reply, body.replied_by || 'agent');
      return json(res, { ok: true });
    }

    // PATCH /api/feedback/:id/status
    const feedbackStatusMatch = path.match(/^\/api\/feedback\/(\d+)\/status$/);
    if (req.method === 'PATCH' && feedbackStatusMatch) {
      const key = params.get('key') || '';
      const authHeader = req.headers.authorization || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!API_KEY || (key !== API_KEY && bearerKey !== API_KEY)) return json(res, { error: 'invalid api key' }, 401);
      const body = await parseBody(req);
      const validStatuses = ['open', 'auto_draft', 'needs_human', 'replied', 'closed'];
      if (!validStatuses.includes(body.status)) return json(res, { error: 'invalid status' }, 400);
      updateFeedbackStatus(db, parseInt(feedbackStatusMatch[1]), body.status);
      return json(res, { ok: true });
    }

    // ── Config endpoints ──

    // GET /api/changelog?lang=zh|en
    if (req.method === 'GET' && path === '/api/changelog') {
      const l = params.get('lang') || 'en';
      const suffix = l === 'zh' ? '.zh.md' : '.md';
      try {
        const content = readFileSync(join(__dirname, '..', `CHANGELOG${suffix}`), 'utf-8');
        return json(res, { content });
      } catch { return json(res, { content: '# Changelog\n\nNo changelog found.' }); }
    }

    // GET /api/roadmap?lang=zh|en
    if (req.method === 'GET' && path === '/api/roadmap') {
      const l = params.get('lang') || 'en';
      const suffix = l === 'zh' ? '.zh.md' : l === 'en' ? '.en.md' : '.md';
      try {
        const content = readFileSync(join(__dirname, '..', `ROADMAP${suffix}`), 'utf-8');
        return json(res, { content });
      } catch { return json(res, { content: '# Roadmap\n\nNo roadmap found.' }); }
    }

    if (req.method === 'GET' && path === '/api/config') {
      return json(res, getConfig(db));
    }

    if (req.method === 'PUT' && path === '/api/config') {
      const authHeader = req.headers.authorization || '';
      const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!API_KEY || bearerKey !== API_KEY) return json(res, { error: 'invalid api key' }, 401);
      const body = await parseBody(req);
      for (const [k, v] of Object.entries(body)) setConfig(db, k, v);
      return json(res, { ok: true });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    if (e.message === 'payload too large') return json(res, { error: e.message }, 413);
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 ClawFeed API running on http://127.0.0.1:${PORT}`);
});
