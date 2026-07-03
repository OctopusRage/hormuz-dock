import { spawn } from 'node:child_process';

/**
 * Run a command, capturing stdout/stderr. Never uses a shell, so arguments
 * are passed as an array (no injection via git urls / project names).
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      // replaceEnv: use exactly opts.env (don't inherit our process env). Used for
      // `docker compose` so our own vars (PORT, ADMIN_PASSWORD, …) never leak in
      // and override the managed project's .env.
      env: opts.replaceEnv ? { ...(opts.env || {}) } : { ...process.env, ...(opts.env || {}) },
    });

    let stdout = '';
    let stderr = '';
    const maxBuf = opts.maxBuffer || 10 * 1024 * 1024;

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuf) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuf) stderr += d.toString();
    });

    const timer = opts.timeout
      ? setTimeout(() => child.kill('SIGKILL'), opts.timeout)
      : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
