import crypto from 'node:crypto';
import { db } from './db.js';
import { encrypt, decrypt } from './secure-env.js';

/**
 * Google Sign-In (OAuth 2.0 authorization-code flow).
 *
 * Admin-configured and off by default. The client secret is encrypted at rest
 * with the same master key as Global Secret Env and is never sent to the browser
 * — the API only ever reports whether one is set.
 */

const SETTINGS_KEY = 'sso.google';

// Google endpoints. Overridable via env so tests can point at a local stub;
// never set these in production.
export const ENDPOINTS = {
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
};

const DEFAULTS = {
  enabled: false,
  clientId: '',
  allowedDomains: [], // e.g. ['qiscus.com'] — empty means any domain
  autoRegister: false, // create an account on first successful sign-in
  redirectUri: '', // blank = derive from the incoming request
};

// ---------- config ----------
function readRaw() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row?.value) return { ...DEFAULTS, clientSecretEnc: null };
  try {
    return { ...DEFAULTS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULTS, clientSecretEnc: null };
  }
}

/** Full config including the decrypted secret — server-side use only. */
export function getConfig() {
  const raw = readRaw();
  return { ...raw, clientSecret: raw.clientSecretEnc ? decrypt(raw.clientSecretEnc) : '' };
}

/** Safe view for the admin UI: never includes the secret itself. */
export function getPublicConfig() {
  const c = readRaw();
  return {
    enabled: !!c.enabled,
    clientId: c.clientId || '',
    allowedDomains: c.allowedDomains || [],
    autoRegister: !!c.autoRegister,
    redirectUri: c.redirectUri || '',
    hasSecret: !!c.clientSecretEnc,
  };
}

/** Is sign-in with Google usable right now? (What the login page asks.) */
export function isEnabled() {
  const c = readRaw();
  return !!(c.enabled && c.clientId && c.clientSecretEnc);
}

export function saveConfig(patch) {
  const cur = readRaw();
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    clientId: patch.clientId !== undefined ? String(patch.clientId).trim() : cur.clientId,
    autoRegister: patch.autoRegister !== undefined ? !!patch.autoRegister : cur.autoRegister,
    redirectUri: patch.redirectUri !== undefined ? String(patch.redirectUri).trim() : cur.redirectUri,
    allowedDomains:
      patch.allowedDomains !== undefined ? normalizeDomains(patch.allowedDomains) : cur.allowedDomains,
    clientSecretEnc: cur.clientSecretEnc,
  };
  // Only replace the stored secret when a new non-empty one is supplied; the UI
  // sends a blank field to mean "leave it alone".
  if (patch.clientSecret) next.clientSecretEnc = encrypt(String(patch.clientSecret).trim());
  if (patch.clearSecret) next.clientSecretEnc = null;

  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(SETTINGS_KEY, JSON.stringify(next));
  return getPublicConfig();
}

/** Accept an array or a comma/space separated string; strip any leading "@". */
export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return [
    ...new Set(
      list
        .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
        .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    ),
  ];
}

/** Does this email satisfy the configured domain allowlist? */
export function emailAllowed(email, domains) {
  const list = domains || getConfig().allowedDomains || [];
  if (!list.length) return true; // unrestricted
  const at = String(email || '').toLowerCase().lastIndexOf('@');
  if (at === -1) return false;
  const domain = String(email).toLowerCase().slice(at + 1);
  // Exact domain only — "notqiscus.com" must not pass for "qiscus.com".
  return list.includes(domain);
}

// ---------- one-time state (CSRF) ----------
const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map(); // state -> { mode, userId, at }

export function makeState(data) {
  const state = crypto.randomBytes(24).toString('base64url');
  states.set(state, { ...data, at: Date.now() });
  // Opportunistic sweep so the map can't grow without bound.
  for (const [k, v] of states) if (Date.now() - v.at > STATE_TTL_MS) states.delete(k);
  return state;
}
/** Consume a state: valid exactly once, and only within its TTL. */
export function takeState(state) {
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  if (Date.now() - entry.at > STATE_TTL_MS) return null;
  return entry;
}

// ---------- flow ----------
/** Absolute base URL of this panel as the browser sees it (honours nginx). */
export function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function redirectUriFor(req) {
  const c = readRaw();
  return c.redirectUri || `${baseUrl(req)}/api/auth/google/callback`;
}

export function authUrl(req, state) {
  const c = getConfig();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${ENDPOINTS.auth}?${params}`;
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(code, redirectUri) {
  const c = getConfig();
  const res = await fetch(ENDPOINTS.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`);
  if (!data.id_token) throw new Error('Google did not return an id_token');
  return data;
}

/**
 * Read the identity out of an id_token.
 *
 * The token arrives on a direct TLS connection to Google's token endpoint, which
 * is why Google documents signature verification as optional for this flow. We
 * still check the claims that bind it to us: audience, issuer, expiry, and that
 * the address is verified.
 */
export function verifyIdToken(idToken, { clientId } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Unreadable id_token payload');
  }
  const aud = clientId || getConfig().clientId;
  if (claims.aud !== aud) throw new Error('id_token audience mismatch');
  const iss = String(claims.iss || '');
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') {
    throw new Error('id_token issuer mismatch');
  }
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new Error('id_token has expired');
  if (!claims.sub) throw new Error('id_token has no subject');
  if (!claims.email) throw new Error('Google returned no email address');
  if (claims.email_verified === false || claims.email_verified === 'false') {
    throw new Error('That Google address is not verified');
  }
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name || '' };
}

/** Derive a unique, valid panel username from an email address. */
export function usernameFromEmail(email, exists) {
  let base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (base.length < 2) base = `user${base}`;
  base = base.slice(0, 28);
  let name = base;
  for (let i = 2; exists(name); i++) name = `${base}${i}`.slice(0, 32);
  return name;
}
