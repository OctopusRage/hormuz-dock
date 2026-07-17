import express from 'express';
import * as auth from '../auth.js';

const router = express.Router();

// Managing keys is part of the identity plane: it must be done from an
// interactive browser session, never with an API key. (requireAuth already ran
// in index.js; this only rejects api-key-authenticated callers.)
router.use(auth.requireSession);

// List the caller's own keys (metadata only — never the secret).
router.get('/', (req, res) => {
  res.json(auth.listApiKeys(req.user.id));
});

// Create a key. The plaintext is returned exactly once, here.
router.post('/', (req, res) => {
  const name = (req.body?.name || '').toString().trim();
  if (name.length > 60) return res.status(400).json({ error: 'name must be 60 characters or fewer' });
  const created = auth.createApiKey({ userId: req.user.id, name });
  // created.key is the one-time plaintext.
  res.status(201).json(created);
});

// Revoke one of the caller's own keys.
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!auth.revokeApiKey(id, req.user.id)) {
    return res.status(404).json({ error: 'Key not found' });
  }
  res.json({ ok: true });
});

export default router;
