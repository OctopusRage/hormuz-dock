import { db } from './db.js';

/** Insert an audit-log entry. */
export function logAction({ user, action, target, detail, status }) {
  db.prepare(
    'INSERT INTO audit_log (at, user_id, username, action, target, detail, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    new Date().toISOString(),
    user?.id ?? null,
    user?.username ?? null,
    action,
    target ?? null,
    detail ?? null,
    status ?? null
  );
}

/** Read recent entries (all users for admin, or one user). */
export function readLog({ userId = null, limit = 200 } = {}) {
  if (userId != null) {
    return db
      .prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

// Map a mutating API request to a human-readable action label.
function describe(req) {
  const url = req.baseUrl + req.path; // e.g. /api/projects/<id>/start
  const m = url.match(/^\/api\/projects\/([^/]+)(?:\/(\w+))?/);
  if (m) {
    const sub = m[2];
    const labels = {
      start: 'Start project',
      stop: 'Stop project',
      restart: 'Restart project',
      rebuild: 'Rebuild project',
      redeploy: 'Pull & rebuild project',
      branch: 'Switch branch',
      pull: 'Git pull',
      env: 'Update env',
      routes: 'Update routes',
    };
    if (!sub && req.method === 'POST') return { action: 'Create project', target: null };
    if (!sub && req.method === 'DELETE') return { action: 'Delete project', target: m[1] };
    return { action: labels[sub] || `${req.method} ${sub}`, target: m[1] };
  }
  if (url.startsWith('/api/users')) {
    if (req.method === 'POST') return { action: 'Create user', target: null };
    if (req.method === 'DELETE') return { action: 'Delete user', target: req.params.id };
    return { action: 'Manage users', target: null };
  }
  return { action: `${req.method} ${url}`, target: null };
}

/**
 * Middleware that records every mutating (non-GET) API request after the
 * response finishes, capturing who did what and the resulting status code.
 */
export function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    // Skip auth endpoints here; login/logout are logged explicitly with detail.
    if (req.originalUrl.startsWith('/api/auth')) return;
    const { action, target } = describe(req);
    logAction({ user: req.user, action, target, status: res.statusCode });
  });
  next();
}
