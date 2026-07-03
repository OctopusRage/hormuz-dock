import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { OVERRIDE_FILE } from './config.js';

export function overridePath(project) {
  return path.join(project.dir, OVERRIDE_FILE);
}

/**
 * Build the base `docker compose` argument list for a project. We pin the
 * project name (-p) so containers are consistently labeled, and point at the
 * detected compose file explicitly. If an override file exists, it is layered
 * on top (Compose merges later -f files over earlier ones).
 */
function baseArgs(project) {
  const args = ['compose', '-p', project.slug];
  if (project.composeFile) args.push('-f', project.composeFile);
  if (fs.existsSync(overridePath(project))) args.push('-f', OVERRIDE_FILE);
  return args;
}

// A minimal, clean environment for `docker compose`. Only what the docker CLI
// itself needs — NOT Hormuz Dock's own env — so the managed project's .env is
// authoritative and our secrets never reach it. (OS env vars otherwise override
// a project's .env in Compose.)
function composeEnv() {
  const keep = [
    'PATH', 'HOME',
    'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  ];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  return env;
}

function compose(project, extra, opts = {}) {
  return run('docker', [...baseArgs(project), ...extra], {
    cwd: project.dir,
    timeout: opts.timeout || 10 * 60 * 1000,
    replaceEnv: true,
    env: composeEnv(),
  });
}

/**
 * Validate the merged compose config (base + override) via `docker compose
 * config`. Returns { ok, error } without changing anything.
 */
export async function validateConfig(project) {
  const res = await compose(project, ['config', '-q'], { timeout: 30 * 1000 });
  return res.code === 0
    ? { ok: true }
    : { ok: false, error: (res.stderr || res.stdout).trim() };
}

/**
 * Bind-mount sources referenced by the merged compose that DON'T exist on the
 * host. Docker would create these as empty directories, which breaks file
 * mounts (e.g. a cert mounted as a dir). `likelyFile` flags paths that have an
 * extension — almost certainly meant to be a file the operator must provide.
 */
export async function missingBindFiles(project) {
  const res = await compose(project, ['config', '--format', 'json'], { timeout: 30 * 1000 });
  if (res.code !== 0) return []; // invalid config — let `up` surface that error
  let cfg;
  try { cfg = JSON.parse(res.stdout); } catch { return []; }
  const missing = [];
  const seen = new Set();
  for (const svc of Object.values(cfg.services || {})) {
    for (const v of svc.volumes || []) {
      if (v.type !== 'bind' || !v.source || seen.has(v.source)) continue;
      seen.add(v.source);
      if (fs.existsSync(v.source)) continue;
      const rel = path.relative(project.dir, v.source);
      const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
      missing.push({
        source: v.source,
        rel: inside ? rel : v.source,
        target: v.target,
        inside,
        likelyFile: path.basename(v.source).includes('.'),
      });
    }
  }
  return missing;
}

export async function up(project, { build = false } = {}) {
  const args = ['up', '-d', '--remove-orphans'];
  if (build) args.push('--build'); // rebuild images from source before recreating
  const res = await compose(project, args);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || 'compose up failed');
  }
  return res.stdout + res.stderr;
}

export async function stop(project) {
  const res = await compose(project, ['stop']);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'compose stop failed');
  }
  return res.stdout + res.stderr;
}

export async function down(project) {
  const res = await compose(project, ['down', '--remove-orphans']);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'compose down failed');
  }
  return res.stdout + res.stderr;
}

export async function restart(project) {
  const res = await compose(project, ['restart']);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'compose restart failed');
  }
  return res.stdout + res.stderr;
}

/** Parse `docker compose ps --format json` (one JSON object per line or an array). */
function parseJsonLines(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Compose v2 may emit a JSON array or newline-delimited objects.
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) return arr;
    return [arr];
  } catch {
    // fall through to line parsing
  }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* ignore malformed line */
    }
  }
  return out;
}

/** List containers belonging to a compose project with status info. */
export async function ps(project) {
  const res = await compose(project, ['ps', '--all', '--format', 'json'], {
    timeout: 30 * 1000,
  });
  if (res.code !== 0) return [];
  return parseJsonLines(res.stdout).map((c) => ({
    id: c.ID || c.Id,
    name: c.Name || c.Names,
    service: c.Service,
    image: c.Image,
    state: c.State,
    status: c.Status,
    health: c.Health || '',
    ports: c.Publishers
      ? c.Publishers.filter((p) => p.PublishedPort).map(
          (p) => `${p.PublishedPort}:${p.TargetPort}`
        )
      : [],
  }));
}

/**
 * Derive an aggregate project status from its containers.
 * running = at least one container running; stopped = none; unknown = no containers.
 */
export function deriveStatus(containers) {
  if (!containers.length) return 'stopped';
  const anyRunning = containers.some((c) => c.state === 'running');
  const allRunning = containers.every((c) => c.state === 'running');
  if (allRunning) return 'running';
  if (anyRunning) return 'partial';
  return 'stopped';
}

/**
 * Resource usage per container via `docker stats`. Returns cpu %, mem usage,
 * mem %. Only queries containers belonging to this project.
 */
export async function stats(project) {
  const containers = await ps(project);
  const running = containers.filter((c) => c.state === 'running' && c.id);
  if (!running.length) {
    return { containers: [], totals: { cpu: 0, memBytes: 0, memPerc: 0 } };
  }

  const ids = running.map((c) => c.id);
  const res = await run(
    'docker',
    [
      'stats',
      '--no-stream',
      '--format',
      '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}',
      ...ids,
    ],
    { timeout: 30 * 1000 }
  );

  const rows = [];
  let totalCpu = 0;
  let totalMem = 0;
  let totalMemPerc = 0;

  for (const line of res.stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [id, name, cpu, mem, memPerc] = line.split('\t');
    const cpuNum = parseFloat(cpu) || 0;
    const memPercNum = parseFloat(memPerc) || 0;
    const memBytes = parseMemUsage(mem);
    totalCpu += cpuNum;
    totalMem += memBytes;
    totalMemPerc += memPercNum;
    const container = running.find((c) => c.id.startsWith(id) || id.startsWith(c.id));
    rows.push({
      id,
      name,
      service: container?.service || name,
      ports: container?.ports || [],
      cpu: cpuNum,
      memBytes,
      memUsage: mem,
      memPerc: memPercNum,
    });
  }

  return {
    containers: rows,
    totals: {
      cpu: Math.round(totalCpu * 100) / 100,
      memBytes: totalMem,
      memPerc: Math.round(totalMemPerc * 100) / 100,
    },
  };
}

/** Parse "12.34MiB / 1.5GiB" -> used bytes. */
function parseMemUsage(str) {
  if (!str) return 0;
  const used = str.split('/')[0].trim();
  const m = used.match(/([\d.]+)\s*([A-Za-z]+)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = {
    b: 1,
    kb: 1e3, kib: 1024,
    mb: 1e6, mib: 1024 ** 2,
    gb: 1e9, gib: 1024 ** 3,
    tb: 1e12, tib: 1024 ** 4,
  };
  return Math.round(val * (mult[unit] || 1));
}

/** Recent logs for a project (optionally a single service). */
export async function logs(project, service, tail = 200) {
  const extra = ['logs', '--no-color', '--tail', String(tail)];
  if (service) extra.push(service);
  const res = await compose(project, extra, { timeout: 30 * 1000 });
  return res.stdout + res.stderr;
}
