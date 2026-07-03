import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';
import { COMPOSE_FILES } from './config.js';

/** Clone a repo into `dir`. Fails if dir already has content. */
export async function clone(gitUrl, dir, branch) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`Target directory already exists and is not empty: ${dir}`);
  }
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(gitUrl, dir);

  // Disable interactive credential prompts so a bad/private URL fails fast
  // instead of hanging.
  const res = await run('git', args, {
    timeout: 5 * 60 * 1000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  if (res.code !== 0) {
    throw new Error(`git clone failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/**
 * Sync the clone to its remote branch. This is a deploy checkout, not a working
 * copy, so we mirror the remote (fetch + hard reset) rather than merge — that
 * also handles force-pushed / diverged histories, which `pull --ff-only` rejects.
 */
export async function pull(dir) {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
  const opts = { cwd: dir, timeout: 5 * 60 * 1000, env };

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  const branch = branchRes.stdout.trim() || 'HEAD';

  const fetch = await run('git', ['fetch', '--prune', 'origin', branch], opts);
  if (fetch.code !== 0) {
    throw new Error(`git fetch failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`);
  }
  const reset = await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dir });
  if (reset.code !== 0) {
    throw new Error(`git reset failed: ${reset.stderr.trim() || reset.stdout.trim()}`);
  }
  return `${fetch.stderr.trim()}\n${reset.stdout.trim()}`.trim();
}

const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

/** Current checked-out branch name of a repo. */
export async function currentBranch(dir) {
  const res = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** List branch names on the remote (origin). */
export async function listRemoteBranches(dir) {
  const res = await run('git', ['ls-remote', '--heads', 'origin'], {
    cwd: dir,
    timeout: 60 * 1000,
    env: NO_PROMPT,
  });
  if (res.code !== 0) return [];
  return res.stdout
    .trim()
    .split('\n')
    .map((l) => l.split('\t')[1])
    .filter(Boolean)
    .map((ref) => ref.replace('refs/heads/', ''));
}

/**
 * Switch to `branch`. The repo was cloned shallow, so fetch that branch first,
 * then hard-reset the local branch to it (discarding local checkout diffs).
 */
export async function checkout(dir, branch) {
  const fetch = await run('git', ['fetch', '--depth', '1', 'origin', branch], {
    cwd: dir,
    timeout: 5 * 60 * 1000,
    env: NO_PROMPT,
  });
  if (fetch.code !== 0) {
    throw new Error(`git fetch ${branch} failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`);
  }
  const co = await run('git', ['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: dir });
  if (co.code !== 0) {
    throw new Error(`git checkout ${branch} failed: ${co.stderr.trim() || co.stdout.trim()}`);
  }
  return co.stdout + co.stderr;
}

/** Return the first matching compose file name in a dir, or null. */
export function detectComposeFile(dir) {
  for (const f of COMPOSE_FILES) {
    if (fs.existsSync(path.join(dir, f))) return f;
  }
  return null;
}

/** Remove a repo directory recursively. */
export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}
