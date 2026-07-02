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

// ---------- middleware ----------
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
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
