import { db } from './db.js';
import * as store from './store.js';
import { getUserById } from './auth.js';

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

// Map a mutating API request to a human-readable action + the entity it targets.
function describe(req) {
  const url = req.baseUrl + req.path; // e.g. /api/projects/<id>/start
  // id is optional so the bare create URL (POST /api/projects) matches too.
  const m = url.match(/^\/api\/projects(?:\/([^/]+))?(?:\/(\w+))?/);
  if (m) {
    const id = m[1];
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
      compose: 'Update compose override',
    };
    if (!id && req.method === 'POST') return { action: 'Create project', kind: 'project-create' };
    if (id && !sub && req.method === 'DELETE') return { action: 'Delete project', kind: 'project', id };
    if (id && sub) return { action: labels[sub] || `${req.method} ${sub}`, kind: 'project', id };
    return { action: `${req.method} project`, kind: 'project', id };
  }
  if (url.startsWith('/api/users')) {
    if (req.method === 'POST' && !/\/password$/.test(url)) return { action: 'Create user', kind: 'user-create' };
    if (req.method === 'POST') return { action: 'Reset password', kind: 'user', id: req.params.id };
    if (req.method === 'DELETE') return { action: 'Delete user', kind: 'user', id: req.params.id };
    return { action: 'Manage users', kind: null };
  }
  return { action: `${req.method} ${url}`, kind: null };
}

// Resolve a friendly target label (project/user name) at request time — before
// the handler runs, so deletes still capture the name.
function resolveTarget(req, info) {
  if (info.kind === 'project' && info.id) {
    const p = store.getProject(info.id);
    return p ? p.name : info.id;
  }
  if (info.kind === 'project-create') return req.body?.name || null;
  if (info.kind === 'user' && info.id) {
    const u = getUserById(parseInt(info.id));
    return u ? u.username : info.id;
  }
  if (info.kind === 'user-create') return req.body?.username || null;
  return null;
}

/**
 * Middleware that records every mutating (non-GET) API request after the
 * response finishes, capturing who did what (with readable names) and status.
 */
export function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const info = describe(req);
  const target = resolveTarget(req, info); // capture now (entity may be deleted by handler)
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api/auth')) return;
    logAction({ user: req.user, action: info.action, target, status: res.statusCode });
  });
  next();
}
