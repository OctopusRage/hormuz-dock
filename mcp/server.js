#!/usr/bin/env node
// MCP server for the Hormuz Dock API.
//
// Lets an AI agent drive a Hormuz instance over its REST API using a personal
// API key — list/inspect projects, run the lifecycle, read logs/compose, and
// (the headline flow) DEPLOY BY UPLOADING A LOCALLY-BUILT IMAGE: build and/or
// `docker save` an image on this machine, stream it into `docker load` on the
// Hormuz host via POST /api/projects/:id/image, then restart the project — no
// registry (ECR/Docker Hub) round-trip.
//
// Config (env):
//   HORMUZ_URL       base URL of the Hormuz panel, e.g. https://hormuz.qiscus.io
//   HORMUZ_API_KEY   a key minted in the panel (API Keys). Sent as a bearer token.
//
// Local `docker` CLI is required for the build/save tools (deploy_local_image,
// upload_image with imageTag).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const HORMUZ_URL = (process.env.HORMUZ_URL || '').replace(/\/+$/, '');
const HORMUZ_API_KEY = process.env.HORMUZ_API_KEY || '';

// ---------- HTTP helpers ----------

function requireConfig() {
  if (!HORMUZ_URL) throw new Error('HORMUZ_URL is not set (e.g. https://hormuz.qiscus.io).');
  if (!HORMUZ_API_KEY) throw new Error('HORMUZ_API_KEY is not set (mint one in the panel → API Keys).');
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${HORMUZ_API_KEY}`, ...extra };
}

/** Call the Hormuz API and return parsed JSON, throwing a readable error. */
async function hormuz(path, { method = 'GET', json, headers } = {}) {
  requireConfig();
  const res = await fetch(HORMUZ_URL + path, {
    method,
    headers: authHeaders({
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    }),
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(data?.error || `${method} ${path} → HTTP ${res.status}`);
  }
  return data;
}

/** Resolve a project reference (id, slug, or name) to its record. */
async function resolveProject(ref) {
  if (!ref) throw new Error('project is required (id, slug, or name).');
  const projects = await hormuz('/api/projects');
  const s = String(ref);
  const hit =
    projects.find((p) => p.id === s) ||
    projects.find((p) => p.slug === s) ||
    projects.find((p) => p.name === s);
  if (!hit) {
    const names = projects.map((p) => p.slug).join(', ') || '(none)';
    throw new Error(`No project matching "${ref}". Known slugs: ${names}`);
  }
  return hit;
}

// ---------- local docker helpers ----------

/** Run a local command, resolving { code, stdout, stderr }. */
function runLocal(cmd, args, { onLog } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; onLog?.(d.toString()); });
    child.stderr.on('data', (d) => { stderr += d; onLog?.(d.toString()); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function assertLocalImage(tag) {
  const r = await runLocal('docker', ['image', 'inspect', tag]);
  if (r.code !== 0) {
    throw new Error(`Local image "${tag}" not found (docker image inspect failed). Build it first.`);
  }
}

/**
 * Stream an image into `docker load` on the Hormuz host. `source` is either a
 * gzipped-tar Readable (from `docker save | gzip`) or a file Readable. Uses the
 * raw octet-stream upload endpoint.
 */
async function uploadImageStream(projectId, source) {
  requireConfig();
  const res = await fetch(`${HORMUZ_URL}/api/projects/${projectId}/image`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: source,
    duplex: 'half', // required by undici when body is a stream
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || `image upload → HTTP ${res.status}`);
  return data;
}

/** `docker save <tag>` piped through gzip → a Readable suitable as an upload body. */
function dockerSaveGz(tag) {
  const save = spawn('docker', ['save', tag]);
  const gz = zlib.createGzip();
  save.on('error', (e) => gz.destroy(e));
  save.stderr.on('data', () => { /* swallow progress; errors surface via exit */ });
  save.stdout.pipe(gz);
  return gz;
}

// ---------- tool implementations ----------

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

const handlers = {
  async hormuz_whoami() {
    return ok(await hormuz('/api/me'));
  },

  async hormuz_list_projects() {
    const projects = await hormuz('/api/projects');
    return ok(
      projects.map((p) => ({
        id: p.id, name: p.name, slug: p.slug, status: p.status,
        private: p.private, ports: p.ports, branch: p.branch,
        commit: p.commit?.hash, lastDeployedAt: p.lastDeployedAt,
      }))
    );
  },

  async hormuz_get_project({ project }) {
    const p = await resolveProject(project);
    return ok(await hormuz(`/api/projects/${p.id}`));
  },

  async hormuz_logs({ project, service, tail }) {
    const p = await resolveProject(project);
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    if (tail) q.set('tail', String(tail));
    const d = await hormuz(`/api/projects/${p.id}/logs?${q.toString()}`);
    return ok(d.logs || '(no output)');
  },

  async hormuz_lifecycle({ project, action }) {
    const allowed = ['start', 'stop', 'restart', 'rebuild', 'redeploy'];
    if (!allowed.includes(action)) throw new Error(`action must be one of ${allowed.join(', ')}`);
    const p = await resolveProject(project);
    const d = await hormuz(`/api/projects/${p.id}/${action}`, { method: 'POST' });
    return ok({ ok: true, action, status: d.status, output: (d.output || '').slice(-4000) });
  },

  async hormuz_list_images({ project }) {
    const p = await resolveProject(project);
    return ok(await hormuz(`/api/projects/${p.id}/images`));
  },

  async hormuz_remove_image({ project, tag }) {
    if (!tag) throw new Error('tag is required.');
    const p = await resolveProject(project);
    return ok(await hormuz(`/api/projects/${p.id}/image?tag=${encodeURIComponent(tag)}`, { method: 'DELETE' }));
  },

  async hormuz_get_compose({ project }) {
    const p = await resolveProject(project);
    return ok(await hormuz(`/api/projects/${p.id}/compose`));
  },

  async hormuz_set_compose_override({ project, override }) {
    if (typeof override !== 'string') throw new Error('override (string) is required.');
    const p = await resolveProject(project);
    return ok(await hormuz(`/api/projects/${p.id}/compose`, { method: 'PUT', json: { override } }));
  },

  async hormuz_upload_image({ project, imageTag, tarPath }) {
    const p = await resolveProject(project);
    let source;
    if (tarPath) {
      if (!fs.existsSync(tarPath)) throw new Error(`tarPath not found: ${tarPath}`);
      source = fs.createReadStream(tarPath);
    } else if (imageTag) {
      await assertLocalImage(imageTag);
      source = dockerSaveGz(imageTag);
    } else {
      throw new Error('Provide either imageTag (a local image) or tarPath (a docker save tarball).');
    }
    const d = await uploadImageStream(p.id, source);
    return ok({ ok: true, loaded: d.loaded, output: (d.output || '').trim() });
  },

  async hormuz_deploy_local_image({ project, imageTag, buildContext, dockerfile, restart = true }) {
    const p = await resolveProject(project);
    const log = [];

    // 1) optional build
    if (buildContext) {
      if (!imageTag) throw new Error('imageTag is required when buildContext is given (the tag to build).');
      const args = ['build', '-t', imageTag];
      if (dockerfile) args.push('-f', dockerfile);
      args.push(buildContext);
      log.push(`$ docker ${args.join(' ')}`);
      const b = await runLocal('docker', args);
      log.push((b.stdout + b.stderr).trim().slice(-4000));
      if (b.code !== 0) throw new Error('docker build failed:\n' + (b.stderr || b.stdout).trim());
    }
    if (!imageTag) throw new Error('imageTag is required (the local image to save + upload).');

    // 2) save + upload (docker load on the host)
    await assertLocalImage(imageTag);
    log.push(`$ docker save ${imageTag} | gzip → upload → docker load (host)`);
    const up = await uploadImageStream(p.id, dockerSaveGz(imageTag));
    log.push('Loaded: ' + (up.loaded || []).join(', '));

    // 3) restart so the (re)loaded image is picked up. Use restart (recreate on
    //    up) — the compose must reference the tag with no build: to use it.
    let status = p.status;
    if (restart) {
      log.push('$ restart');
      const r = await hormuz(`/api/projects/${p.id}/start`, { method: 'POST' });
      status = r.status;
    }

    return ok({
      ok: true,
      project: p.slug,
      loaded: up.loaded,
      status,
      note: 'Ensure the compose service uses `image: ' + (imageTag) + '` with no `build:` so the loaded image is used (no pull).',
      log: log.join('\n'),
    });
  },
};

// ---------- tool schemas ----------

const projectArg = { type: 'string', description: 'Project id, slug, or name.' };

const TOOLS = [
  {
    name: 'hormuz_whoami',
    description: 'Verify the API key and show the caller identity/role (GET /api/me).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hormuz_list_projects',
    description: 'List all Hormuz projects with status, ports, branch, and last deploy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hormuz_get_project',
    description: 'Get one project with its containers and full status.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
  },
  {
    name: 'hormuz_logs',
    description: 'Read recent container logs for a project (optionally one service).',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        service: { type: 'string', description: 'Optional compose service name.' },
        tail: { type: 'number', description: 'Lines to tail (default 200, max 2000).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'hormuz_lifecycle',
    description: 'Run a lifecycle action on a project: start, stop, restart, rebuild, or redeploy (git pull + rebuild).',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'rebuild', 'redeploy'] },
      },
      required: ['project', 'action'],
    },
  },
  {
    name: 'hormuz_list_images',
    description: 'List pre-built images uploaded to a project (tag, whether still present on the host, size).',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
  },
  {
    name: 'hormuz_remove_image',
    description: 'Remove an uploaded image from the host (docker rmi) and drop its record.',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, tag: { type: 'string', description: 'Image tag, e.g. myapp:1.0' } },
      required: ['project', 'tag'],
    },
  },
  {
    name: 'hormuz_get_compose',
    description: 'Read a project\'s base compose file (read-only) and its editable override.',
    inputSchema: { type: 'object', properties: { project: projectArg }, required: ['project'] },
  },
  {
    name: 'hormuz_set_compose_override',
    description: 'Write the compose override (validated + applied on next start). Use to wire `image: <tag>` onto a service. Empty string removes the override.',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, override: { type: 'string', description: 'docker-compose.override.yml contents.' } },
      required: ['project', 'override'],
    },
  },
  {
    name: 'hormuz_upload_image',
    description: 'Upload a pre-built image to a project → `docker load` on the host. Provide EITHER imageTag (a local image, saved+gzipped here) OR tarPath (an existing `docker save` tarball).',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        imageTag: { type: 'string', description: 'A local image tag to `docker save` and upload, e.g. myapp:1.0' },
        tarPath: { type: 'string', description: 'Path to an existing docker save tarball (.tar/.tar.gz).' },
      },
      required: ['project'],
    },
  },
  {
    name: 'hormuz_deploy_local_image',
    description: 'Deploy by uploading a locally-built image: optionally `docker build`, then `docker save`+upload into `docker load` on the host, then restart. The project\'s compose must reference the tag with no `build:` so the loaded image is used (no registry pull).',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        imageTag: { type: 'string', description: 'Image tag to save+upload (and build, if buildContext given), e.g. myapp:1.0' },
        buildContext: { type: 'string', description: 'Optional build context dir. If set, `docker build -t imageTag` runs first.' },
        dockerfile: { type: 'string', description: 'Optional Dockerfile path (with buildContext).' },
        restart: { type: 'boolean', description: 'Restart/recreate the project after upload (default true).' },
      },
      required: ['project', 'imageTag'],
    },
  },
];

// ---------- wire up the server ----------

const server = new Server(
  { name: 'hormuz-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const fn = handlers[name];
  if (!fn) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    return await fn(args);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('hormuz-mcp ready' + (HORMUZ_URL ? ` → ${HORMUZ_URL}` : ' (HORMUZ_URL unset)'));
