import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ROOT } from './config.js';
import { run } from './exec.js';
import projectsRouter from './routes/projects.js';
import { setupTerminal, handleExecUpgrade, EXEC_PATH } from './terminal.js';
import { proxyMiddleware, handleProxyUpgrade } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Reverse proxy for configured routes (e.g. /_chat -> :9999). Runs FIRST, before
// body parsing, so request bodies stream to the target untouched.
app.use(proxyMiddleware);

app.use(express.json({ limit: '2mb' }));

// API
app.use('/api/projects', projectsRouter);

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
  if (pathname === EXEC_PATH) return handleExecUpgrade(req, socket, head);
  if (handleProxyUpgrade(req, socket, head)) return;
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`AppHub running on http://localhost:${PORT}`);
});
