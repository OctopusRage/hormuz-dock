import express from 'express';
import * as auth from '../auth.js';
import * as sso from '../sso.js';
import { logAction } from '../audit.js';

const router = express.Router();

// Current user (used by the SPA to decide login state).
router.get('/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email || null,
    googleLinked: !!user.google_sub,
  });
});

// Does the login page show a "Sign in with Google" button? Public by necessity.
router.get('/sso-status', (req, res) => {
  res.json({ google: sso.isEnabled() });
});

// Login.
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && auth.getUserByUsername(username);
  if (!user || !auth.verifyPassword(password || '', user.password)) {
    logAction({ user: null, action: 'Login failed', detail: `username=${username}`, status: 401 });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  logAction({ user, action: 'Login', status: 200 });
  res.json({ id: user.id, username: user.username, role: user.role });
});

// Logout.
router.post('/logout', (req, res) => {
  const user = auth.currentUser(req);
  const token = auth.sessionTokenFrom(req);
  auth.destroySession(token);
  auth.clearSessionCookie(res);
  if (user) logAction({ user, action: 'Logout', status: 200 });
  res.json({ ok: true });
});

// ---------- Google SSO ----------

// Start the flow. mode=link attaches Google to the *current* account and so
// requires an active session; mode=login (default) is open.
router.get('/google', (req, res) => {
  if (!sso.isEnabled()) return res.status(404).type('txt').send('Google sign-in is not enabled.');
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  let userId = null;
  if (mode === 'link') {
    const user = auth.currentUser(req);
    if (!user) return res.status(401).type('txt').send('Log in first, then link your Google account.');
    userId = user.id;
  }
  const state = sso.makeState({ mode, userId, redirectUri: sso.redirectUriFor(req) });
  res.redirect(sso.authUrl(req, state));
});

// Google sends the browser back here with ?code&state.
router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/?sso_error=' + encodeURIComponent(msg));
  try {
    if (!sso.isEnabled()) return fail('Google sign-in is not enabled.');
    if (req.query.error) return fail(String(req.query.error));

    // One-time state: blocks CSRF and replayed callbacks.
    const st = sso.takeState(String(req.query.state || ''));
    if (!st) return fail('This sign-in link expired or was already used. Please try again.');
    const code = String(req.query.code || '');
    if (!code) return fail('Google returned no authorization code.');

    const tokens = await sso.exchangeCode(code, st.redirectUri || sso.redirectUriFor(req));
    const identity = sso.verifyIdToken(tokens.id_token);

    const cfg = sso.getConfig();
    if (!sso.emailAllowed(identity.email, cfg.allowedDomains)) {
      logAction({ user: null, action: 'SSO login rejected', detail: `domain not allowed: ${identity.email}`, status: 403 });
      return fail(`${identity.email} is not in an allowed email domain.`);
    }

    // Linking an existing account.
    if (st.mode === 'link') {
      const user = auth.getUserById(st.userId);
      if (!user) return fail('Your session ended — log in again before linking.');
      if (!auth.linkGoogle(user.id, identity.sub, identity.email)) {
        return fail('That Google account is already linked to another user.');
      }
      logAction({ user, action: 'Link Google account', detail: identity.email, status: 200 });
      return res.redirect('/?sso_linked=1');
    }

    // Signing in.
    let user = auth.getUserByGoogleSub(identity.sub);
    if (!user) {
      if (!cfg.autoRegister) {
        return fail(
          `No Hormuz account is linked to ${identity.email}. Sign in with your username and password, then link Google from the panel — or ask an admin.`
        );
      }
      const username = sso.usernameFromEmail(identity.email, (n) => !!auth.getUserByUsername(n));
      user = auth.createSsoUser({ username, email: identity.email, googleSub: identity.sub });
      logAction({ user, action: 'SSO auto-register', detail: identity.email, status: 201 });
    }

    const token = auth.createSession(user.id);
    auth.setSessionCookie(res, token);
    logAction({ user, action: 'Login (Google)', detail: identity.email, status: 200 });
    res.redirect('/');
  } catch (err) {
    console.error('[sso] callback failed:', err.message);
    fail(err.message || 'Google sign-in failed.');
  }
});

// Unlink Google from your own account.
router.post('/google/unlink', auth.requireAuth, (req, res) => {
  auth.unlinkGoogle(req.user.id);
  logAction({ user: req.user, action: 'Unlink Google account', status: 200 });
  res.json({ ok: true });
});

// Change own password.
router.post('/password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  if (!auth.verifyPassword(currentPassword || '', req.user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  auth.setPassword(req.user.id, newPassword);
  logAction({ user: req.user, action: 'Change own password', status: 200 });
  res.json({ ok: true });
});

export default router;
