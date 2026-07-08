import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const STORE_FILE = path.join(DATA_DIR, 'secure-env.json');
const KEY_FILE = path.join(DATA_DIR, 'secure.key');

// Reference syntax written into a project's .env, e.g. @secure:qismo/DB_PASSWORD.
// Only admins ever see the real value; users just reference it.
const REF_RE = /^@secure:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export function isRef(value) {
  return REF_RE.test(String(value || '').trim());
}
export function makeRef(scope, key) {
  return `@secure:${scope}/${key}`;
}

// ---------- encryption at rest (AES-256-GCM) ----------
// Key comes from HORMUZ_SECRET_KEY (any string) or a generated, 0600 key file.
let cachedKey = null;
function masterKey() {
  if (cachedKey) return cachedKey;
  if (process.env.HORMUZ_SECRET_KEY) {
    cachedKey = crypto.scryptSync(process.env.HORMUZ_SECRET_KEY, 'hormuz-secure-env', 32);
    return cachedKey;
  }
  try {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (cachedKey.length === 32) return cachedKey;
  } catch { /* generate below */ }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, cachedKey.toString('base64'), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* best effort */ }
  return cachedKey;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(blob) {
  try {
    const [iv, tag, ct] = String(blob).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key / corrupt — treat as unreadable
  }
}

// ---------- store ----------
// scopes is an explicit list so an empty scope (created but no keys yet) persists.
let state = { scopes: [], entries: [] };
let writeQueue = Promise.resolve();

function load() {
  try {
    state = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!Array.isArray(state.entries)) state.entries = [];
    if (!Array.isArray(state.scopes)) state.scopes = [];
  } catch {
    state = { scopes: [], entries: [] };
  }
  // Backfill scopes from any entries (older stores had no scopes list).
  for (const e of state.entries) if (!state.scopes.includes(e.scope)) state.scopes.push(e.scope);
}
function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = STORE_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, STORE_FILE);
    try { await fsp.chmod(STORE_FILE, 0o600); } catch { /* best effort */ }
  });
  return writeQueue;
}
load();

function find(scope, key) {
  return state.entries.find((e) => e.scope === scope && e.key === key) || null;
}

export function hasScope(scope) {
  return state.scopes.includes(scope);
}

/** Create an (initially empty) scope. Returns false if it already exists. */
export async function addScope(scope) {
  if (state.scopes.includes(scope)) return false;
  state.scopes.push(scope);
  await persist();
  return true;
}

/**
 * Grouped view: every scope → its entries (empty array for a scope with no keys
 * yet). Values decrypted only when withValues.
 */
export function listGrouped({ withValues = false } = {}) {
  const scopes = {};
  for (const s of state.scopes) scopes[s] = [];
  for (const e of state.entries) {
    (scopes[e.scope] ||= []).push({
      key: e.key,
      updatedBy: e.updatedBy || null,
      updatedAt: e.updatedAt || null,
      ...(withValues ? { value: decrypt(e.enc) ?? '' } : {}),
    });
  }
  for (const k of Object.keys(scopes)) scopes[k].sort((a, b) => a.key.localeCompare(b.key));
  return scopes;
}

export async function upsert({ scope, key, value, updatedBy }) {
  const now = new Date().toISOString();
  if (!state.scopes.includes(scope)) state.scopes.push(scope);
  const existing = find(scope, key);
  if (existing) {
    existing.enc = encrypt(value);
    existing.updatedBy = updatedBy || null;
    existing.updatedAt = now;
  } else {
    state.entries.push({ scope, key, enc: encrypt(value), updatedBy: updatedBy || null, updatedAt: now });
  }
  await persist();
}

export async function remove(scope, key) {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => !(e.scope === scope && e.key === key));
  if (state.entries.length !== before) await persist();
  return before !== state.entries.length;
}

export async function removeScope(scope) {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.scope !== scope);
  const had = state.scopes.includes(scope);
  state.scopes = state.scopes.filter((s) => s !== scope);
  if (before !== state.entries.length || had) await persist();
  return before - state.entries.length;
}

/** Resolve a single reference to its plaintext value, or null if unknown. */
function resolveOne(scope, key) {
  const e = find(scope, key);
  return e ? decrypt(e.enc) : null;
}

/**
 * Given raw .env text, replace any @secure:scope/key reference value with its
 * real secret. Returns { changed, resolved, missing } — missing lists refs that
 * point to a secret that doesn't exist (caller should refuse to start).
 * Comments/blank lines are preserved; only reference lines are rewritten.
 */
export function resolveEnvText(raw) {
  if (!raw || !raw.includes('@secure:')) return { changed: false, resolved: raw, missing: [] };
  const missing = [];
  let changed = false;
  const out = raw.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    const m = val.match(REF_RE);
    if (!m) return line;
    const real = resolveOne(m[1], m[2]);
    if (real == null) { missing.push(`${m[1]}/${m[2]}`); return line; }
    changed = true;
    return `${key}=${quoteForEnv(real)}`;
  });
  return { changed, resolved: out.join('\n'), missing };
}

// Minimal Compose-safe quoting for the resolved value (mirrors env.js).
function quoteForEnv(v) {
  if (v === '') return '';
  if (/^[^\s'"#$\\`]+$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}
