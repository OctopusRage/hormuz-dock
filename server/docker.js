import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { OVERRIDE_FILE } from './config.js';
import * as secureEnv from './secure-env.js';

// While a compose `up` runs we swap @secure references in .env for the real
// secrets (so containers get them), keeping a crash-safe backup of the
// reference version, then restore it. Secrets never persist in the readable .env.
const REF_BACKUP = '.env.hormuz-ref';

async function withResolvedSecrets(project, fn) {
  const envFile = path.join(project.dir, '.env');
  let raw;
  try { raw = fs.readFileSync(envFile, 'utf8'); } catch { return fn(); } // no .env
  const { changed, resolved, missing } = secureEnv.resolveEnvText(raw);
  if (missing.length) {
    const err = new Error(
      'Unknown secure-env reference(s): ' + missing.join(', ') +
        '. An admin must define them in Secure env first.'
    );
    err.status = 409;
    throw err;
  }
  if (!changed) return fn();
  const backup = path.join(project.dir, REF_BACKUP);
  fs.writeFileSync(backup, raw, { mode: 0o600 }); // reference version (crash-safe)
  fs.writeFileSync(envFile, resolved, { mode: 0o600 }); // real secrets, briefly
  try {
    return await fn();
  } finally {
    fs.writeFileSync(envFile, raw, { mode: 0o644 }); // back to references
    try { fs.rmSync(backup, { force: true }); } catch { /* ignore */ }
  }
}

/** On boot, restore any .env left holding real secrets by a crash mid-`up`. */
export function recoverResolvedEnv(projects) {
  for (const p of projects || []) {
    const backup = path.join(p.dir, REF_BACKUP);
    try {
      if (!fs.existsSync(backup)) continue;
      fs.copyFileSync(backup, path.join(p.dir, '.env'));
      fs.chmodSync(path.join(p.dir, '.env'), 0o644);
      fs.rmSync(backup, { force: true });
      console.log(`Recovered .env references for ${p.slug} after an interrupted start`);
    } catch { /* ignore */ }
  }
}

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
    onData: opts.onData, // stream live output to the operation log
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

export async function up(project, { build = false, onData } = {}) {
  return withResolvedSecrets(project, async () => {
    const args = ['up', '-d', '--remove-orphans'];
    if (build) args.push('--build'); // rebuild images from source before recreating
    const res = await compose(project, args, { onData });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || 'compose up failed');
    }
    return res.stdout + res.stderr;
  });
}

export async function stop(project, { onData } = {}) {
  const res = await compose(project, ['stop'], { onData });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'compose stop failed');
  }
  return res.stdout + res.stderr;
}

export async function down(project, { onData } = {}) {
  const res = await compose(project, ['down', '--remove-orphans'], { onData });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'compose down failed');
  }
  return res.stdout + res.stderr;
}

export async function restart(project, { onData } = {}) {
  const res = await compose(project, ['restart'], { onData });
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

/** Parse a `docker ps -s` size string "1.09MB (virtual 210MB)" -> {rw, rootfs} bytes. */
function parseDockerSize(s) {
  if (!s) return { rw: 0, rootfs: 0 };
  const unit = (u) => {
    const map = {
      b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
      kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    };
    return map[String(u).toLowerCase()] || 1;
  };
  const nums = [...s.matchAll(/([\d.]+)\s*([A-Za-z]+)/g)].map((m) => parseFloat(m[1]) * unit(m[2]));
  const rw = nums[0] || 0;
  const rootfs = nums[1] != null ? nums[1] : rw; // "virtual" total (image + writable)
  return { rw: Math.round(rw), rootfs: Math.round(rootfs) };
}

/**
 * On-disk footprint of every RUNNING container, grouped by its compose project
 * (falls back to the container name for non-compose containers). rootfs is the
 * container's total size incl. image layers (may overlap between apps that share
 * a base image); rw is its unique writable layer.
 */
export async function storageByContainer() {
  const res = await run(
    'docker',
    ['ps', '--size', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.State}}\t{{.Size}}'],
    { timeout: 30 * 1000 }
  );
  if (res.code !== 0) return [];
  const groups = {};
  for (const line of res.stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [proj, name, state, size] = line.split('\t');
    if (state !== 'running') continue;
    const key = proj || name || 'unknown';
    const { rw, rootfs } = parseDockerSize(size);
    (groups[key] ||= { key, rwBytes: 0, rootfsBytes: 0, containers: 0 });
    groups[key].rwBytes += rw;
    groups[key].rootfsBytes += rootfs;
    groups[key].containers += 1;
  }
  return Object.values(groups).sort((a, b) => b.rootfsBytes - a.rootfsBytes);
}

/** Docker disk usage summary (images / containers / volumes / build cache). */
export async function systemDf() {
  const res = await run(
    'docker',
    ['system', 'df', '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}'],
    { timeout: 20 * 1000 }
  );
  if (res.code !== 0) return [];
  return res.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [type, total, active, size, reclaimable] = l.split('\t');
      return { type, total, active, size, reclaimable };
    });
}

/**
 * Prune images to reclaim space. Default removes only dangling (untagged)
 * images + build cache. `all: true` also removes any image not used by an
 * existing container (running or stopped) — more aggressive.
 */
export async function prune({ all = false, buildCache = true } = {}) {
  const parts = [];
  const imgArgs = ['image', 'prune', '-f'];
  if (all) imgArgs.push('-a');
  let r = await run('docker', imgArgs, { timeout: 10 * 60 * 1000 });
  parts.push((r.stdout + r.stderr).trim());
  if (buildCache) {
    r = await run('docker', ['builder', 'prune', '-f'], { timeout: 10 * 60 * 1000 });
    parts.push((r.stdout + r.stderr).trim());
  }
  const output = parts.filter(Boolean).join('\n');
  const reclaimed = [...output.matchAll(/Total reclaimed space:\s*([^\n]+)/g)].map((m) => m[1].trim());
  return { output, reclaimed: reclaimed.length ? reclaimed.join(' + ') : '0B' };
}

/** Recent logs for a project (optionally a single service). */
export async function logs(project, service, tail = 200) {
  const extra = ['logs', '--no-color', '--tail', String(tail)];
  if (service) extra.push(service);
  const res = await compose(project, extra, { timeout: 30 * 1000 });
  return res.stdout + res.stderr;
}
