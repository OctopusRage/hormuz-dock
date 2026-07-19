import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as git from '../git.js';
import * as docker from '../docker.js';
import * as envlib from '../env.js';
import * as filelib from '../files.js';
import * as hostallow from '../hostallow.js';
import * as oplog from '../oplog.js';
import * as auth from '../auth.js';
import { canManage } from '../authz.js';

const router = express.Router();

// GET sub-paths that expose secrets (env values, file contents, compose which
// may inline credentials). For a private project these are restricted to its
// creator/admin, just like mutations — cards stay visible, but their innards and
// controls are locked. Plain status/stats/logs stay open (the "visible" half).
const SENSITIVE_GET = new Set(['env', 'files', 'file', 'compose']);

// Ownership gate for a single project's sub-routes. Runs before the handlers:
// blocks mutations and secret-exposing reads on a private project for anyone who
// isn't its creator or an admin. Unknown ids fall through so the handler 404s.
router.use((req, res, next) => {
  const m = req.path.match(/^\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return next(); // e.g. "/" (list/create) — no project id
  const p = store.getProject(m[1]);
  if (!p) return next();
  req.project = p; // handlers may reuse it
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  const sensitiveRead = req.method === 'GET' && SENSITIVE_GET.has(m[2] || '');
  if ((mutating || sensitiveRead) && !canManage(p, req.user)) {
    return res.status(403).json({
      error: 'This project is private — only its creator or an admin can manage it.',
    });
  }
  next();
});

// Per-project operation lock. While a mutating operation (start/stop/restart/
// rebuild/redeploy/branch) runs for a project, other mutating ops on the SAME
// project are rejected with 409 so we never start something that's mid-start.
const busy = new Set();

async function withLock(id, fn) {
  if (busy.has(id)) {
    const err = new Error('An operation is already in progress for this project. Please wait.');
    err.status = 409;
    throw err;
  }
  busy.add(id);
  try {
    return await fn();
  } finally {
    busy.delete(id);
  }
}

// Wrap async handlers so thrown errors become 500 JSON responses.
const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    const body = { error: err.message };
    if (err.missingFiles) body.missingFiles = err.missingFiles;
    res.status(err.status || 500).json(body);
  });

// Before an up/start, refuse if the compose bind-mounts files that don't exist
// on the host (Docker would create them as empty dirs and the app would crash).
async function preflight(project) {
  const missing = (await docker.missingBindFiles(project)).filter((m) => m.likelyFile);
  if (missing.length) {
    const err = new Error(
      'Missing files that the compose bind-mounts: ' +
        missing.map((m) => m.rel).join(', ') +
        '. Create/upload them (Files) before starting.'
    );
    err.status = 409;
    err.missingFiles = missing;
    throw err;
  }
}

function requireProject(req, res) {
  const p = store.getProject(req.params.id);
  if (!p) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return p;
}

// List all projects (with live status).
router.get(
  '/',
  h(async (req, res) => {
    const projects = store.listProjects();
    const withStatus = await Promise.all(
      projects.map(async (p) => {
        let containers = [];
        try {
          containers = await docker.ps(p);
        } catch {
          /* docker may be down; report anyway */
        }
        let commit = null;
        try {
          commit = await git.lastCommit(p.dir);
        } catch {
          /* not a git repo (uploaded) or git missing */
        }
        // Collect unique published host ports across all containers.
        const ports = [
          ...new Set(
            containers.flatMap((c) => c.ports || []).map((p) => p.split(':')[0])
          ),
        ].sort((a, b) => a - b);
        return {
          ...p,
          status: docker.deriveStatus(containers),
          containerCount: containers.length,
          ports,
          commit,
        };
      })
    );
    res.json(withStatus);
  })
);

// Create a project: clone repo, verify docker-compose.yml exists.
router.post(
  '/',
  h(async (req, res) => {
    const { name, gitUrl, branch } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!gitUrl) return res.status(400).json({ error: 'gitUrl is required' });
    const slug = store.slugify(name);
    if (!slug) return res.status(400).json({ error: 'name produces an empty slug' });
    if (store.findBySlug(slug)) {
      return res.status(409).json({ error: `A project named "${slug}" already exists` });
    }

    const project = await store.createProject({
      name,
      gitUrl,
      branch,
      createdBy: req.user?.username,
      private: req.body?.private === true || req.body?.private === 'true',
    });

    try {
      await git.clone(gitUrl, project.dir, branch);
    } catch (err) {
      await store.deleteProject(project.id);
      return res.status(400).json({ error: err.message });
    }

    const composeFile = git.detectComposeFile(project.dir);
    if (!composeFile) {
      await git.removeDir(project.dir);
      await store.deleteProject(project.id);
      return res.status(400).json({
        error: 'No docker-compose.yml found in the repository. A compose file is required.',
      });
    }

    await store.updateProject(project.id, { composeFile });
    res.status(201).json(store.getProject(project.id));
  })
);

// Get one project with containers.
router.get(
  '/:id',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    let containers = [];
    try {
      containers = await docker.ps(p);
    } catch {
      /* ignore */
    }
    res.json({ ...p, status: docker.deriveStatus(containers), containers });
  })
);

// Delete a project: compose down + remove repo dir + drop record.
router.delete(
  '/:id',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    try {
      if (fs.existsSync(p.dir)) await docker.down(p);
    } catch (err) {
      console.warn('compose down during delete failed:', err.message);
    }
    await git.removeDir(p.dir);
    await store.deleteProject(p.id);
    res.json({ ok: true });
  })
);

// git pull latest.
router.post(
  '/:id/pull',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const out = await git.pull(p.dir);
    // Re-detect compose file in case it changed.
    const composeFile = git.detectComposeFile(p.dir);
    await store.updateProject(p.id, { composeFile: composeFile || p.composeFile });
    res.json({ ok: true, output: out });
  })
);

// List branches (current + remote) for the branch switcher.
router.get(
  '/:id/branches',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const [current, remote] = await Promise.all([
      git.currentBranch(p.dir),
      git.listRemoteBranches(p.dir),
    ]);
    res.json({ current, remote });
  })
);

// Switch branch, re-detect compose file, optionally rebuild + recreate.
router.post(
  '/:id/branch',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const { branch, rebuild } = req.body || {};
    if (!branch) return res.status(400).json({ error: 'branch is required' });

    const result = await withLock(p.id, async () => {
      const coOut = await git.checkout(p.dir, branch);
      const composeFile = git.detectComposeFile(p.dir);
      if (!composeFile) {
        const err = new Error(`Branch "${branch}" has no docker-compose.yml.`);
        err.status = 400;
        throw err;
      }
      await store.updateProject(p.id, { branch, composeFile });

      let buildOut = '';
      if (rebuild) buildOut = await docker.up(store.getProject(p.id), { build: true });

      const containers = await docker.ps(p);
      await store.updateProject(p.id, { status: docker.deriveStatus(containers) });
      return {
        ok: true,
        branch,
        status: docker.deriveStatus(containers),
        output: `$ git checkout ${branch}\n${coOut}${buildOut ? '\n\n$ docker compose up -d --build\n' + buildOut : ''}`,
      };
    });
    res.json(result);
  })
);

// Rebuild images from current source and recreate containers (no pull).
router.post(
  '/:id/rebuild',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const result = await withLock(p.id, async () => {
      await preflight(p);
      const output = await oplog.withOpLog(p.id, 'rebuild', (onData) =>
        docker.up(p, { build: true, onData })
      );
      const containers = await docker.ps(p);
      await store.updateProject(p.id, {
        status: docker.deriveStatus(containers),
        lastDeployedAt: new Date().toISOString(),
      });
      return { ok: true, output, status: docker.deriveStatus(containers) };
    });
    res.json(result);
  })
);

// Pull latest code, then rebuild + recreate containers. One-click deploy.
router.post(
  '/:id/redeploy',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const result = await withLock(p.id, async () => {
      return await oplog.withOpLog(p.id, 'redeploy', async (onData) => {
        onData('$ git pull\n');
        const pullOut = await git.pull(p.dir);
        onData(pullOut + '\n');
        const composeFile = git.detectComposeFile(p.dir);
        await store.updateProject(p.id, { composeFile: composeFile || p.composeFile });
        await preflight(store.getProject(p.id));
        onData('\n$ docker compose up -d --build\n');
        const upOut = await docker.up(store.getProject(p.id), { build: true, onData });
        const containers = await docker.ps(p);
        await store.updateProject(p.id, {
          status: docker.deriveStatus(containers),
          lastDeployedAt: new Date().toISOString(),
        });
        return {
          ok: true,
          output: `$ git pull\n${pullOut}\n\n$ docker compose up -d --build\n${upOut}`,
          status: docker.deriveStatus(containers),
        };
      });
    });
    res.json(result);
  })
);

// Lifecycle: start / stop / restart.
for (const [action, fn] of [
  ['start', docker.up],
  ['stop', docker.stop],
  ['restart', docker.restart],
]) {
  router.post(
    `/:id/${action}`,
    h(async (req, res) => {
      const p = requireProject(req, res);
      if (!p) return;
      const result = await withLock(p.id, async () => {
        if (action === 'start') await preflight(p);
        const output = await oplog.withOpLog(p.id, action, (onData) => fn(p, { onData }));
        const containers = await docker.ps(p);
        await store.updateProject(p.id, {
          status: docker.deriveStatus(containers),
          ...(action === 'start' ? { lastDeployedAt: new Date().toISOString() } : {}),
        });
        return { ok: true, output, status: docker.deriveStatus(containers) };
      });
      res.json(result);
    })
  );
}

// Resource stats.
router.get(
  '/:id/stats',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    res.json(await docker.stats(p));
  })
);

// Live operation log (SSE). Replays the current op's buffer, then streams
// chunks as docker compose produces them, and an "end" event on completion.
router.get('/:id/op-stream', (req, res) => {
  const p = requireProject(req, res);
  if (!p) return;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  const cur = oplog.currentOp(p.id);
  if (cur) {
    send('start', { action: cur.action });
    if (cur.lines.length) send('data', cur.lines.join(''));
    if (cur.done) send('end', { ok: cur.ok });
  }

  const unsub = oplog.subscribe(p.id, (ev) => {
    if (ev.type === 'start') send('start', { action: ev.action });
    else if (ev.type === 'data') send('data', ev.chunk);
    else if (ev.type === 'end') send('end', { ok: ev.ok, message: ev.message });
  });

  const keepalive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(keepalive); unsub(); });
});

// Logs.
router.get(
  '/:id/logs',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const service = req.query.service || null;
    const tail = Math.min(parseInt(req.query.tail) || 200, 2000);
    res.json({ logs: await docker.logs(p, service, tail) });
  })
);

// Files: list everything in the project dir (excludes .git/node_modules).
router.get(
  '/:id/files',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    res.json(filelib.listFiles(p));
  })
);

// Files: read one file's content (text inline; binary flagged).
router.get(
  '/:id/file',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    res.json(filelib.readFile(p, String(req.query.path)));
  })
);

// Files: create/overwrite a file (text via content, binary via contentBase64).
router.put(
  '/:id/file',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const { path: rel, content, contentBase64 } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path is required' });
    if (content == null && contentBase64 == null) {
      return res.status(400).json({ error: 'content or contentBase64 is required' });
    }
    res.json(await filelib.writeFile(p, rel, { content, contentBase64 }));
  })
);

// Files: upload + extract a zip into the project (contentBase64).
router.post(
  '/:id/unzip',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const { contentBase64, path: target } = req.body || {};
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 (zip) is required' });
    await filelib.extractZip(p, contentBase64, target || '.');
    res.json({ ok: true });
  })
);

// Files: delete a file or directory within the project.
router.delete(
  '/:id/file',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    await filelib.deleteEntry(p, String(req.query.path));
    res.json({ ok: true });
  })
);

// Compose: read the repo's base compose file (read-only) + the editable override.
router.get(
  '/:id/compose',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    let base = '';
    try {
      base = fs.readFileSync(path.join(p.dir, p.composeFile), 'utf8');
    } catch {
      /* ignore */
    }
    const ovPath = docker.overridePath(p);
    const override = fs.existsSync(ovPath) ? fs.readFileSync(ovPath, 'utf8') : '';
    res.json({ file: p.composeFile, base, override, overrideExists: !!override.trim() });
  })
);

// Compose: write the override file. Validates the merged config and rolls back
// on error so a broken override can never be persisted.
router.put(
  '/:id/compose',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    if (typeof req.body?.override !== 'string') {
      return res.status(400).json({ error: 'override (string) required' });
    }
    const content = req.body.override;
    const ovPath = docker.overridePath(p);
    const backup = fs.existsSync(ovPath) ? fs.readFileSync(ovPath, 'utf8') : null;

    const restore = () => {
      if (backup === null) fs.rmSync(ovPath, { force: true });
      else fs.writeFileSync(ovPath, backup);
    };

    if (!content.trim()) {
      // Empty override → remove the file entirely (no override layer).
      fs.rmSync(ovPath, { force: true });
      const check = await docker.validateConfig(p);
      if (!check.ok) { restore(); return res.status(400).json({ error: check.error }); }
      return res.json({ ok: true, overrideExists: false });
    }

    fs.writeFileSync(ovPath, content);
    const check = await docker.validateConfig(p);
    if (!check.ok) {
      restore();
      return res.status(400).json({ error: 'Invalid compose config:\n' + check.error });
    }
    res.json({ ok: true, overrideExists: true });
  })
);

// Routes (reverse-proxy mappings): read.
router.get(
  '/:id/routes',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    res.json({ routes: p.routes || [] });
  })
);

// Routes: write. Validates and normalizes path/port entries.
router.put(
  '/:id/routes',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const input = Array.isArray(req.body?.routes) ? req.body.routes : null;
    if (!input) return res.status(400).json({ error: 'routes (array) required' });

    const routes = [];
    for (const r of input) {
      // Users provide only an alphanumeric slug; every proxy path is "/_<slug>".
      // Accept either a raw slug or a full "/_chat" path and reduce to the slug.
      const slug = String(r.slug ?? r.path ?? '')
        .trim()
        .replace(/^\/?_?/, ''); // strip a leading "/" and/or "_"
      const port = parseInt(r.port);
      if (!slug || !port) continue;
      if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
        return res.status(400).json({
          error: `Invalid route name "${slug}". Use letters, numbers, and hyphens only.`,
        });
      }
      if (port < 1 || port > 65535) return res.status(400).json({ error: `Invalid port ${r.port}` });

      // Optional IP allowlist (VPN-only etc). Accept an array or a comma/space list.
      const rawCidrs = Array.isArray(r.allowCidrs)
        ? r.allowCidrs
        : typeof r.allowCidrs === 'string'
          ? r.allowCidrs.split(/[\s,]+/)
          : [];
      const allowCidrs = [];
      for (const c of rawCidrs) {
        const s = String(c).trim();
        if (!s) continue;
        if (!hostallow.isIpEntry(s) && !hostallow.isHostname(s)) {
          return res.status(400).json({ error: `Invalid entry "${s}" — use an IPv4 CIDR/IP (10.30.0.0/16) or a hostname (vpn.example.com).` });
        }
        allowCidrs.push(s);
      }

      routes.push({
        path: '/_' + slug,
        slug,
        port,
        stripPrefix: r.stripPrefix !== false,
        cors: r.cors === true || r.cors === 'true',
        allowCidrs,
      });
    }
    // Reject duplicate paths within this project.
    const seen = new Set();
    for (const r of routes) {
      if (seen.has(r.path)) return res.status(400).json({ error: `Duplicate route path ${r.path}` });
      seen.add(r.path);
    }
    await store.updateProject(p.id, { routes });
    res.json({ ok: true, routes });
  })
);

// Env: read.
router.get(
  '/:id/env',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const raw = envlib.readEnvRaw(p);
    res.json({ raw, pairs: envlib.parseEnv(raw) });
  })
);

// Env: write (accepts either raw text or a pairs array).
router.put(
  '/:id/env',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const { raw, pairs } = req.body || {};
    let content;
    if (typeof raw === 'string') content = raw;
    else if (Array.isArray(pairs)) content = envlib.serializeEnv(pairs);
    else return res.status(400).json({ error: 'Provide raw (string) or pairs (array)' });
    await envlib.writeEnvRaw(p, content);
    res.json({ ok: true, raw: content, pairs: envlib.parseEnv(content) });
  })
);

// Privacy: flip whether this project is private. Guarded by the ownership gate
// above (mutation) — so only the creator or an admin can change it.
router.put(
  '/:id/private',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    // Only the creator or an admin may change privacy — otherwise anyone could
    // grab a public project and lock its owner out. (The generic gate above
    // lets any user mutate a *public* project, so guard this one explicitly.)
    const owner = req.user?.role === 'admin' || (p.createdBy && p.createdBy === req.user?.username);
    if (!owner) return res.status(403).json({ error: 'Only the creator or an admin can change privacy.' });
    const isPrivate = req.body?.private === true || req.body?.private === 'true';
    await store.updateProject(p.id, { private: isPrivate });
    res.json({ ok: true, private: isPrivate });
  })
);

// Transfer ownership. Creator or admin only (same as privacy). The new owner
// must be an existing user — you can't orphan a project to a stranger.
router.put(
  '/:id/owner',
  h(async (req, res) => {
    const p = requireProject(req, res);
    if (!p) return;
    const owner = req.user?.role === 'admin' || (p.createdBy && p.createdBy === req.user?.username);
    if (!owner) return res.status(403).json({ error: 'Only the current owner or an admin can transfer ownership.' });
    const target = String(req.body?.owner || '').trim();
    if (!target) return res.status(400).json({ error: 'owner (username) is required' });
    if (!auth.getUserByUsername(target)) return res.status(404).json({ error: `No such user: ${target}` });
    await store.updateProject(p.id, { createdBy: target });
    res.json({ ok: true, createdBy: target });
  })
);

export default router;
