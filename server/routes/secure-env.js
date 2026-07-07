import express from 'express';
import * as auth from '../auth.js';
import * as secure from '../secure-env.js';

const router = express.Router();

const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// List scopes + keys. Values are included ONLY for admins; regular users get the
// list so they can reference a secret without ever seeing its value.
router.get(
  '/',
  h(async (req, res) => {
    const isAdmin = req.user?.role === 'admin';
    res.json({ admin: isAdmin, scopes: secure.listGrouped({ withValues: isAdmin }) });
  })
);

// Create or update a secret (admin only).
router.post(
  '/',
  auth.requireAdmin,
  h(async (req, res) => {
    const scope = String(req.body?.scope || '').trim();
    const key = String(req.body?.key || '').trim();
    const value = req.body?.value;
    if (!scope || !key) return res.status(400).json({ error: 'scope and key are required' });
    if (!NAME_RE.test(scope)) return res.status(400).json({ error: 'Invalid scope (use letters, numbers, . _ -)' });
    if (!NAME_RE.test(key)) return res.status(400).json({ error: 'Invalid key (use letters, numbers, . _ -)' });
    if (typeof value !== 'string') return res.status(400).json({ error: 'value (string) is required' });
    await secure.upsert({ scope, key, value, updatedBy: req.user.username });
    res.json({ ok: true, ref: secure.makeRef(scope, key) });
  })
);

// Delete a single secret (admin only).
router.delete(
  '/',
  auth.requireAdmin,
  h(async (req, res) => {
    const scope = String(req.query.scope || '').trim();
    const key = String(req.query.key || '').trim();
    if (!scope || !key) return res.status(400).json({ error: 'scope and key are required' });
    const ok = await secure.remove(scope, key);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  })
);

// Delete an entire scope (admin only).
router.delete(
  '/scope',
  auth.requireAdmin,
  h(async (req, res) => {
    const scope = String(req.query.scope || '').trim();
    if (!scope) return res.status(400).json({ error: 'scope is required' });
    const n = await secure.removeScope(scope);
    res.json({ ok: true, removed: n });
  })
);

export default router;
