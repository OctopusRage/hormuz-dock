import express from 'express';
import * as auth from '../auth.js';

const router = express.Router();

// Usernames only — available to any authenticated session (used by the ownership
// picker). Defined before the admin gate below. Parent mount already ran
// requireAuth + requireSession, so this is logged-in-only, no API keys.
router.get('/names', (req, res) => {
  res.json(auth.listUsernames());
});

// Everything else here requires an authenticated admin.
router.use(auth.requireAuth, auth.requireAdmin);

// List users.
router.get('/', (req, res) => {
  res.json(auth.listUsers());
});

// Create a user.
router.post('/', (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 2–32 chars: letters, numbers, . _ -' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  if (auth.getUserByUsername(username)) {
    return res.status(409).json({ error: 'username already exists' });
  }
  const user = auth.createUser({
    username,
    password,
    role: role === 'admin' ? 'admin' : 'user',
    createdBy: req.user.username,
  });
  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

// Reset a user's password.
router.post('/:id/password', (req, res) => {
  const id = parseInt(req.params.id);
  const { password } = req.body || {};
  if (!auth.getUserById(id)) return res.status(404).json({ error: 'User not found' });
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  auth.setPassword(id, password);
  res.json({ ok: true });
});

// Delete a user (cannot delete yourself).
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (!auth.getUserById(id)) return res.status(404).json({ error: 'User not found' });
  auth.deleteUser(id);
  res.json({ ok: true });
});

export default router;
