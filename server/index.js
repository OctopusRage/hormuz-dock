import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ROOT } from './config.js';
import { run } from './exec.js';
import projectsRouter from './routes/projects.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import logsRouter from './routes/logs.js';
import * as auth from './auth.js';
import * as ssh from './ssh.js';
import { auditMiddleware } from './audit.js';
import { setupTerminal, handleExecUpgrade, EXEC_PATH } from './terminal.js';
import { proxyMiddleware, handleProxyUpgrade } from './proxy.js';

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

const app = express();

// Reverse proxy for configured routes (e.g. /_chat -> :9999). Runs FIRST, before
// body parsing and auth, so proxied apps stay publicly reachable.
app.use(proxyMiddleware);

app.use(express.json({ limit: '20mb' })); // room for base64 file uploads via the Files manager

// Auth endpoints are open (login / me / logout).
app.use('/api/auth', authRouter);

// Everything else under /api requires an authenticated user, and every mutating
// request is recorded in the audit log with the acting user.
app.use('/api', auth.requireAuth);
app.use(auditMiddleware);

app.use('/api/projects', projectsRouter);
app.use('/api/users', usersRouter);
app.use('/api/logs', logsRouter);

// SSH deploy key (admin) — view / generate the key to add to a git host.
app.get('/api/ssh-key', auth.requireAdmin, (req, res) => res.json(ssh.readPublicKey()));
app.post('/api/ssh-key', auth.requireAdmin, async (req, res) => {
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

// Static frontend
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
setupTerminal(); // registers the exec WebSocket connection handler

// Single upgrade dispatcher: exec shell vs proxied app WebSockets.
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  if (pathname === EXEC_PATH) {
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

server.listen(PORT, () => {
  console.log(`AppHub running on http://localhost:${PORT}`);
});
