import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ROOT, PANEL_ALLOW_CIDRS } from './config.js';
import { run } from './exec.js';
import projectsRouter from './routes/projects.js';
import staticSitesRouter from './routes/static.js';
import secureEnvRouter from './routes/secure-env.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import apiKeysRouter from './routes/api-keys.js';
import logsRouter from './routes/logs.js';
import * as store from './store.js';
import * as hostallow from './hostallow.js';
import { staticMiddleware } from './staticserve.js';
import * as auth from './auth.js';
import * as sso from './sso.js';
import * as ssh from './ssh.js';
import * as docker from './docker.js';
import { auditMiddleware } from './audit.js';
import { setupTerminal, handleExecUpgrade, EXEC_PATH } from './terminal.js';
import { proxyMiddleware, handleProxyUpgrade, clientIp, ipMatchesCidrs } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create the default admin on first run and print credentials.
const seeded = auth.seedAdmin();
if (seeded) {
  console.log('=========================================================');
  console.log(' Created default admin account:');
  console.log(`   username: ${seeded.username}`);
  console.log(`   password: ${seeded.password}`);
  console.log(' Change it after logging in (or set ADMIN_PASSWORD before first run).');
  console.log('=========================================================');
}

// Clear expired logins and apply the current session lifetime to sessions that
// were issued under a longer one.
{
  const s = auth.enforceSessionTtl();
  console.log(`Sessions expire after ${s.days} day(s) (removed ${s.expired} expired, shortened ${s.capped})`);
}

// Undo any .env left holding real secrets by a crash during a previous `up`.
docker.recoverResolvedEnv(store.listProjects());

const app = express();

// Published static sites (/_static_/<slug>/…) served straight off disk — no
// Docker. Runs FIRST, before auth, so they're publicly reachable.
app.use(staticMiddleware);

// Reverse proxy for configured routes (e.g. /_chat -> :9999). Runs before
// body parsing and auth, so proxied apps stay publicly reachable.
app.use(proxyMiddleware);

// Optionally restrict the admin panel (UI + /api) to allowed networks (e.g. the
// VPN). Runs AFTER the proxy + static-site middleware, so /_<slug> routes and
// /_static_/ sites stay public — only the panel itself is gated.
if (PANEL_ALLOW_CIDRS.length) {
  console.log(`Admin panel restricted to: ${PANEL_ALLOW_CIDRS.join(', ')} (+ loopback)`);
  app.use((req, res, next) => {
    if (ipMatchesCidrs(clientIp(req), PANEL_ALLOW_CIDRS)) return next();
    res.status(403).type('txt').send('Hormuz Dock admin is restricted to allowed networks (VPN).');
  });
}

app.use(express.json({ limit: '20mb' })); // room for base64 file uploads via the Files manager

// Auth endpoints are open (login / me / logout).
app.use('/api/auth', authRouter);

// Everything else under /api requires an authenticated user, and every mutating
// request is recorded in the audit log with the acting user.
app.use('/api', auth.requireAuth);
app.use(auditMiddleware);

// The caller's identity (works with either a session cookie or an API key) —
// handy for an AI agent to confirm its key is valid and see its role.
app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, authVia: req.authVia });
});

app.use('/api/projects', projectsRouter);
app.use('/api/static-sites', staticSitesRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/logs', logsRouter);

// Identity/secret plane — session-only (never reachable with an API key), so a
// leaked key cannot manage users, mint keys, or read the global secret store.
app.use('/api/secure-env', auth.requireSession, secureEnvRouter);
app.use('/api/users', auth.requireSession, usersRouter);

// Google SSO configuration (admin). Identity plane → session-only. The client
// secret is never returned; the response only reports whether one is stored.
app.get('/api/settings/sso', auth.requireSession, auth.requireAdmin, (req, res) => {
  res.json({
    ...sso.getPublicConfig(),
    suggestedRedirectUri: `${sso.baseUrl(req)}/api/auth/google/callback`,
  });
});
app.put('/api/settings/sso', auth.requireSession, auth.requireAdmin, (req, res) => {
  try {
    res.json(sso.saveConfig(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Docker disk usage + image prune (admin) — reclaim storage. Prune is
// destructive, so it's session-only (no API keys).
app.get('/api/system/disk', auth.requireAdmin, async (req, res) => {
  try { res.json(await docker.systemDf()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/system/prune', auth.requireSession, auth.requireAdmin, async (req, res) => {
  try { res.json(await docker.prune(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-running-container disk footprint + host disk usage (for the storage pie).
app.get('/api/system/storage', async (req, res) => {
  try {
    const [groups, disk] = await Promise.all([docker.storageByContainer(), docker.diskUsage()]);
    res.json({ groups, disk });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSH deploy key (admin) — view / generate the key to add to a git host.
// Key material: session-only (no API keys).
app.get('/api/ssh-key', auth.requireSession, auth.requireAdmin, (req, res) => res.json(ssh.readPublicKey()));
app.post('/api/ssh-key', auth.requireSession, auth.requireAdmin, async (req, res) => {
  try { res.json(await ssh.generateKey()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Host-level resource summary (docker system + host cpu count).
app.get('/api/system', async (req, res) => {
  try {
    const info = await run('docker', [
      'info',
      '--format',
      '{{.NCPU}}\t{{.MemTotal}}\t{{.ServerVersion}}\t{{.ContainersRunning}}\t{{.Containers}}',
    ], { timeout: 15000 });
    const [ncpu, memTotal, version, running, total] = info.stdout.trim().split('\t');
    res.json({
      dockerAvailable: info.code === 0,
      ncpu: parseInt(ncpu) || null,
      memTotal: parseInt(memTotal) || null,
      version: version || null,
      containersRunning: parseInt(running) || 0,
      containersTotal: parseInt(total) || 0,
    });
  } catch (err) {
    res.json({ dockerAvailable: false, error: err.message });
  }
});

// API docs (human + AI readable). No login required — it contains only usage
// instructions, no data — so an agent can read how to drive Hormuz before it has
// a valid key. (Still behind the panel network gate above, if one is set.)
app.get('/docs', (req, res) => res.sendFile(path.join(ROOT, 'public', 'docs.html')));

// Static frontend
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
setupTerminal(); // registers the exec WebSocket connection handler

// Single upgrade dispatcher: exec shell vs proxied app WebSockets.
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  if (pathname === EXEC_PATH) {
    // The shell is part of the panel — gate it to allowed networks too.
    if (PANEL_ALLOW_CIDRS.length && !ipMatchesCidrs(clientIp(req), PANEL_ALLOW_CIDRS)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // The shell is powerful — require an authenticated user.
    const user = auth.currentUser(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    return handleExecUpgrade(req, socket, head, user);
  }
  // Proxied app WebSockets stay public (they are the published apps).
  if (handleProxyUpgrade(req, socket, head)) return;
  socket.destroy();
});

// Warm allowlist hostnames (panel + per-route) so DNS-based rules match on the
// first request, then keep them refreshed so they follow DNS changes.
const routeHosts = store.listProjects().flatMap((p) => (p.routes || []).flatMap((r) => r.allowCidrs || []));
await hostallow.warm([...PANEL_ALLOW_CIDRS, ...routeHosts]);
hostallow.startRefresh();

server.listen(PORT, () => {
  console.log(`AppHub running on http://localhost:${PORT}`);
});
