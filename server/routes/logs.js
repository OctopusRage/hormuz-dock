import express from 'express';
import * as auth from '../auth.js';
import { readLog } from '../audit.js';

const router = express.Router();

router.use(auth.requireAuth);

// Admins see everything (optionally filtered by ?user=<id>); regular users see
// only their own actions.
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  if (req.user.role === 'admin') {
    const userId = req.query.user ? parseInt(req.query.user) : null;
    return res.json(readLog({ userId, limit }));
  }
  res.json(readLog({ userId: req.user.id, limit }));
});

export default router;
