import { createServer } from 'http';
import https from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { getDb, listDigests, getDigest, createDigest, listMarks, createMark, deleteMark, getConfig, setConfig, upsertUser, createSession, getSession, deleteSession, migrateMarksToUser, listSources, getSource, createSource, updateSource, deleteSource } from './db.mjs';

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
const ADMIN_EMAILS = (env.ADMIN_EMAILS || process.env.ADMIN_EMAILS || '').split(',').filter(Boolean);
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || 'localhost').split(',').map(o => o.trim());
const PORT = process.env.DIGEST_PORT || env.DIGEST_PORT || 8767;
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
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
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

function setSessionCookie(res, value, maxAge = 30 * 86400) {
  const cookie = `session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  setSessionCookie(res, '', 0);
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
  if (cookies.session) {
    const sess = getSession(db, cookies.session);
    if (sess) {
      req.user = { id: sess.uid, email: sess.email, name: sess.name, avatar: sess.avatar, is_admin: sess.is_admin };
      req.sessionId = cookies.session;
    }
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let { path, params } = parseUrl(req.url);
  if (!path.startsWith('/api/') && path !== '/mark' && path !== '/marks') {
    path = '/api' + path;
  }

  attachUser(req);

  try {
    // ── Auth endpoints ──

    // GET /api/auth/google
    if (req.method === 'GET' && path === '/api/auth/google') {
      // Determine redirect URI based on origin
      const origin = params.get('origin') || req.headers.referer || req.headers.host || 'http://localhost:' + PORT;
      const originUrl = new URL(origin);
      const redirectUri = `${originUrl.protocol}//${originUrl.host}${originUrl.pathname.includes('/digest') ? '/digest' : ''}/api/auth/callback`;
      const state = Buffer.from(JSON.stringify({ origin, redirectUri })).toString('base64url');
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent('openid email profile')}` +
        `&state=${state}` +
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

      let origin = req.headers.host ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : 'http://localhost:' + PORT;
      let redirectUri = `${origin}/api/auth/callback`;
      if (stateRaw) {
        try {
          const st = JSON.parse(Buffer.from(stateRaw, 'base64url').toString());
          origin = st.origin || origin;
          redirectUri = st.redirectUri || redirectUri;
        } catch {}
      }

      // Exchange code for tokens
      const tokenResp = await httpsPost('https://oauth2.googleapis.com/token', {
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code'
      });
      const tokens = JSON.parse(tokenResp.body);
      if (!tokens.access_token) {
        console.error('Token exchange failed:', tokenResp.body);
        console.error('Used redirect_uri:', redirectUri);
        console.error('Client ID:', GOOGLE_CLIENT_ID);
        console.error('Client Secret length:', GOOGLE_CLIENT_SECRET?.length);
        return json(res, { error: 'token exchange failed', detail: tokens.error }, 500);
      }

      // Get user info
      const userResp = await httpsGet(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokens.access_token}`);
      const gUser = JSON.parse(userResp.body);

      // Upsert user
      const user = upsertUser(db, { googleId: gUser.id, email: gUser.email, name: gUser.name, avatar: gUser.picture });

      // Migrate existing marks to admin on first login
      if (user.is_admin) {
        migrateMarksToUser(db, user.id);
      }

      // Create session
      const sessionId = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      createSession(db, { id: sessionId, userId: user.id, expiresAt });

      // Set cookie and redirect to frontend
      setSessionCookie(res, sessionId);
      const originUrl = new URL(origin);
      const frontendUrl = `${originUrl.protocol}//${originUrl.host}${originUrl.pathname.includes('/digest') ? '/digest/' : '/'}`;
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
      if (!req.user || !req.user.is_admin) return json(res, { error: 'admin required' }, 403);
      const body = await parseBody(req);
      const result = createDigest(db, body);
      return json(res, result, 201);
    }

    // ── Marks endpoints (auth required) ──

    if (req.method === 'GET' && path === '/api/marks') {
      if (!req.user) return json(res, { error: 'not authenticated' }, 401);
      const status = params.get('status') || undefined;
      return json(res, listMarks(db, { status, userId: req.user.id, isAdmin: req.user.is_admin }));
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
      deleteMark(db, parseInt(markMatch[1]), req.user.id, req.user.is_admin);
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
      const marks = listMarks(db, { userId: req.user.id, isAdmin: req.user.is_admin });
      const history = marks.map(m => ({
        action: m.status === 'processed' ? 'processed' : 'mark',
        target: m.url, at: m.created_at, title: m.title || '',
      }));
      return json(res, { tweets: marks.filter(m => m.status === 'pending').map(m => ({ url: m.url, markedAt: m.created_at })), history });
    }

    // ── Sources endpoints ──

    if (req.method === 'GET' && path === '/api/sources') {
      if (req.user && req.user.is_admin) {
        return json(res, listSources(db));
      } else if (req.user) {
        return json(res, listSources(db, { userId: req.user.id, includePublic: true }));
      } else {
        return json(res, listSources(db, { includePublic: true }));
      }
    }

    const sourceMatch = path.match(/^\/api\/sources\/(\d+)$/);
    if (req.method === 'GET' && sourceMatch) {
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      if (!s.is_public && (!req.user || (!req.user.is_admin && s.created_by !== req.user.id))) {
        return json(res, { error: 'not found' }, 404);
      }
      return json(res, s);
    }

    if (req.method === 'POST' && path === '/api/sources') {
      if (!req.user || !req.user.is_admin) return json(res, { error: 'admin required' }, 403);
      const body = await parseBody(req);
      const result = createSource(db, { ...body, createdBy: req.user.id });
      return json(res, result, 201);
    }

    if (req.method === 'PUT' && sourceMatch) {
      if (!req.user || !req.user.is_admin) return json(res, { error: 'admin required' }, 403);
      const body = await parseBody(req);
      updateSource(db, parseInt(sourceMatch[1]), body);
      return json(res, { ok: true });
    }

    if (req.method === 'DELETE' && sourceMatch) {
      if (!req.user || !req.user.is_admin) return json(res, { error: 'admin required' }, 403);
      deleteSource(db, parseInt(sourceMatch[1]));
      return json(res, { ok: true });
    }

    // ── Config endpoints ──

    if (req.method === 'GET' && path === '/api/config') {
      return json(res, getConfig(db));
    }

    if (req.method === 'PUT' && path === '/api/config') {
      if (!req.user || !req.user.is_admin) return json(res, { error: 'admin required' }, 403);
      const body = await parseBody(req);
      for (const [k, v] of Object.entries(body)) setConfig(db, k, v);
      return json(res, { ok: true });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 AI Digest API running on http://127.0.0.1:${PORT}`);
});
