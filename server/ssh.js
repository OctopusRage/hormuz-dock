import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

function keyPaths() {
  const home = process.env.HOME || '/root';
  const dir = path.join(home, '.ssh');
  return { dir, priv: path.join(dir, 'id_ed25519'), pub: path.join(dir, 'id_ed25519.pub') };
}

/** Read the deploy public key (the one an operator adds to their git host). */
export function readPublicKey() {
  const { pub } = keyPaths();
  try {
    return { exists: true, path: pub, publicKey: fs.readFileSync(pub, 'utf8').trim() };
  } catch {
    return { exists: false, path: pub, publicKey: null };
  }
}

/** Generate an ed25519 deploy key if one doesn't exist yet (never overwrites). */
export async function generateKey() {
  const { dir, priv } = keyPaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(priv)) {
    const res = await run(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-f', priv, '-C', 'hormuz-dock'],
      { timeout: 30 * 1000 }
    );
    if (res.code !== 0 && !fs.existsSync(priv)) {
      throw new Error('ssh-keygen failed: ' + (res.stderr || res.stdout).trim());
    }
  }
  return readPublicKey();
}
