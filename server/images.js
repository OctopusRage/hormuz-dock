import { spawn } from 'node:child_process';
import { run } from './exec.js';

// Pre-built Docker images ("bring your own image"): instead of building on the
// server or pulling from a registry (ECR/Docker Hub), an operator can build the
// image locally, `docker save` it to a tarball, and upload it here. We stream
// that tarball straight into `docker load` on the host daemon, so the image
// lands in the local image store. A compose service that references it by tag
// (`image: myapp:latest`, no `build:`) then uses the loaded image and won't try
// to pull it.

/** Tags reported by `docker load` ("Loaded image: repo:tag" / "…ID: sha256:…"). */
function parseLoaded(text) {
  const tags = [];
  for (const m of text.matchAll(/Loaded image:\s*(\S+)/g)) tags.push(m[1]);
  for (const m of text.matchAll(/Loaded image ID:\s*(\S+)/g)) tags.push(m[1]);
  return tags;
}

/**
 * Stream a `docker save` tarball (optionally gzip/xz-compressed) from a readable
 * `input` (the HTTP request body) into `docker load` on the host daemon.
 * Resolves with { code, output, loaded: [tags] } — never rejects, mirroring
 * exec.run()'s contract, so callers branch on `code`.
 */
export function loadImageFromStream(input, { onData, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['load'], { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    const cap = (d) => {
      const s = d.toString();
      if (out.length < 5 * 1024 * 1024) out += s;
      onData?.(s);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap); // docker writes load progress to stderr

    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;

    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output: out, loaded: parseLoaded(out) });
    };

    child.on('error', (err) => { cap('\n' + err.message + '\n'); finish(-1); });
    child.on('close', finish);

    // If the client aborts mid-upload, don't leave a half-fed `docker load`.
    input.on('error', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
    // docker may exit before we finish writing (bad tar) — swallow the EPIPE.
    child.stdin.on('error', () => { /* ignore */ });

    input.pipe(child.stdin);
  });
}

/** Local images as { tag, id, size, createdAt }. Untagged show as "<none>:<none>". */
export async function listImages() {
  const res = await run(
    'docker',
    ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedAt}}'],
    { timeout: 30 * 1000 }
  );
  if (res.code !== 0) return [];
  const out = [];
  for (const line of res.stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [tag, id, size, createdAt] = line.split('\t');
    out.push({ tag, id, size, createdAt });
  }
  return out;
}

/**
 * Remove a local image by tag/id. Returns { ok, notFound, output } — a
 * "No such image" is treated as a soft success so a record for an
 * already-gone image can be cleared.
 */
export async function removeImage(tag) {
  const res = await run('docker', ['rmi', tag], { timeout: 60 * 1000 });
  const output = (res.stdout + res.stderr).trim();
  return { ok: res.code === 0, notFound: /No such image/i.test(output), output };
}
