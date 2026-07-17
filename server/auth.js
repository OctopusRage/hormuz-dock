import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE = 'apphub_session';

// ---------- password hashing (scrypt, no external deps) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

// ---------- users ----------
export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function listUsers() {
  return db
    .prepare('SELECT id, username, role, created_at, created_by FROM users ORDER BY id')
    .all();
}
export function createUser({ username, password, role, createdBy }) {
  const info = db
    .prepare(
      'INSERT INTO users (username, password, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
    )
    .run(username, hashPassword(password), role === 'admin' ? 'admin' : 'user', new Date().toISOString(), createdBy || null);
  return getUserById(info.lastInsertRowid);
}
export function deleteUser(id) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}
export function setPassword(id, password) {
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), id);
  // Invalidate existing sessions on password change.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}
export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// ---------- sessions ----------
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  );
  return token;
}
export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function userForToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return getUserById(s.user_id);
}

// ---------- cookies ----------
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
export function sessionTokenFrom(req) {
  return parseCookies(req)[COOKIE] || null;
}

/** Resolve the authenticated user for a request (or null). */
export function currentUser(req) {
  return userForToken(sessionTokenFrom(req));
}

// ---------- API keys (for automation / AI agents) ----------
// A key is `hormuz_<random>`. We store only its sha256 hash; the plaintext is
// shown once at creation and never again. Keys authenticate the SAME identity as
// their owner but are deliberately barred from the identity/secret/shell plane
// (see requireSession + the route wiring in index.js).
const API_KEY_PREFIX = 'hormuz_';

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** Read a bearer token / X-API-Key header off a request (null if absent). */
export function apiKeyFrom(req) {
  const authz = req.headers['authorization'];
  if (authz && /^bearer\s+/i.test(authz)) return authz.replace(/^bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  return x ? String(x).trim() : null;
}

/** Mint a new key for a user. Returns the DB record plus the one-time plaintext. */
export function createApiKey({ userId, name }) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = API_KEY_PREFIX + secret;
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6); // e.g. hormuz_Ab12Cd
  const info = db
    .prepare('INSERT INTO api_keys (user_id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, (name || '').trim() || null, prefix, hashApiKey(key), new Date().toISOString());
  return { ...getApiKeyById(info.lastInsertRowid), key };
}

export function getApiKeyById(id) {
  return db.prepare('SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?').get(id);
}

/** List a user's keys (metadata only — never the hash or plaintext). */
export function listApiKeys(userId) {
  return db
    .prepare('SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id DESC')
    .all(userId);
}

/** Revoke a key, but only if it belongs to `userId` (owner-scoped). */
export function revokeApiKey(id, userId) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return true;
}

/** Resolve the user for a raw API key, updating last_used_at. Null if invalid/revoked. */
export function userForApiKey(key) {
  if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE hash = ?').get(hashApiKey(key));
  if (!row || row.revoked_at) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return getUserById(row.user_id);
}

// ---------- middleware ----------
export function requireAuth(req, res, next) {
  // Session cookie first — that's the interactive panel (browser UI).
  const sessionUser = currentUser(req);
  if (sessionUser) {
    req.user = sessionUser;
    req.authVia = 'session';
    return next();
  }
  // Then an API key — automation / AI agents. Marks req.authVia='apikey' so the
  // identity/secret/shell plane can refuse it (requireSession).
  const key = apiKeyFrom(req);
  if (key) {
    const user = userForApiKey(key);
    if (user) {
      req.user = user;
      req.authVia = 'apikey';
      return next();
    }
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }
  return res.status(401).json({ error: 'Not authenticated' });
}
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

/**
 * Gate for the security-sensitive plane (user/role management, API-key
 * management, global secrets, shell, key material). These require an interactive
 * browser session — an API key can never reach them, so a leaked key cannot
 * escalate privileges, mint more keys, or exfiltrate secrets.
 */
export function requireSession(req, res, next) {
  if (req.authVia === 'apikey') {
    return res.status(403).json({
      error: 'This endpoint is not available to API keys. Use the web panel (session login).',
    });
  }
  next();
}

/** Seed a default admin on first boot so the app is usable. */
export function seedAdmin() {
  if (countUsers() > 0) return null;
  const password = process.env.ADMIN_PASSWORD || 'admin';
  createUser({ username: 'admin', password, role: 'admin', createdBy: 'system' });
  return { username: 'admin', password };
}
