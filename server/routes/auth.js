import express from 'express';
import * as auth from '../auth.js';
import { logAction } from '../audit.js';

const router = express.Router();

// Current user (used by the SPA to decide login state).
router.get('/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: user.id, username: user.username, role: user.role });
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
