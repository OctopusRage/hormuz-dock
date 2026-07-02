import { WebSocketServer } from 'ws';
import Docker from 'dockerode';
import { URL } from 'node:url';
import * as store from './store.js';
import * as docker from './docker.js';
import { logAction } from './audit.js';

const dockerode = new Docker();

// Prefer bash if the image has it, otherwise fall back to sh.
const SHELL_CMD = [
  'sh',
  '-c',
  'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi',
];

/**
 * Attach a WebSocket server for interactive container shells. The browser
 * connects to /ws/exec?project=<id>&container=<containerId>; we open a docker
 * exec with a TTY and pipe it both ways. Docker daemon provides the PTY, so no
 * native node-pty is needed.
 */
const wss = new WebSocketServer({ noServer: true });

/** Path this handler serves. */
export const EXEC_PATH = '/ws/exec';

/** Handle a WebSocket upgrade for the exec shell. */
export function handleExecUpgrade(req, socket, head, user) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._user = user; // carry the authenticated user for auditing
    wss.emit('connection', ws, req);
  });
}

export function setupTerminal() {
  wss.on('connection', async (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const projectId = params.get('project');
    const containerId = params.get('container');

    const project = store.getProject(projectId);
    if (!project) return closeWith(ws, 'Project not found');

    try {
      // Verify the requested container actually belongs to this project — don't
      // let a crafted container id shell into arbitrary containers on the host.
      const owned = await docker.ps(project);
      const match = owned.find(
        (c) => c.id && (c.id === containerId || containerId.startsWith(c.id) || c.id.startsWith(containerId))
      );
      if (!match) return closeWith(ws, 'Container is not part of this project');
      if (match.state !== 'running') return closeWith(ws, 'Container is not running');

      const container = dockerode.getContainer(match.id);
      const exec = await container.exec({
        Cmd: SHELL_CMD,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });

      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

      // Container -> browser
      stream.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
      stream.on('end', () => closeWith(ws, '\r\n[session ended]\r\n'));
      stream.on('error', () => closeWith(ws, '\r\n[stream error]\r\n'));

      // Browser -> container. Text frames may be control messages (resize);
      // everything else is raw keystrokes written to stdin.
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const str = data.toString();
          if (str.startsWith('\x00RESIZE')) {
            try {
              const { cols, rows } = JSON.parse(str.slice(7));
              exec.resize({ w: cols, h: rows }).catch(() => {});
            } catch {
              /* ignore malformed resize */
            }
            return;
          }
        }
        stream.write(data);
      });

      ws.on('close', () => {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      });

      logAction({
        user: ws._user,
        action: 'Open shell',
        target: project.name,
        detail: match.service,
        status: 200,
      });
      ws.send('\r\n\x1b[32mConnected to ' + match.service + '.\x1b[0m\r\n');
    } catch (err) {
      closeWith(ws, 'Failed to open shell: ' + err.message);
    }
  });
}

function closeWith(ws, msg) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
      ws.close();
    }
  } catch {
    /* ignore */
  }
}
