import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function envPath(project) {
  return path.join(project.dir, '.env');
}

/** Read the raw .env file contents (empty string if none). */
export function readEnvRaw(project) {
  const p = envPath(project);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Parse .env into key/value pairs (comments and blanks preserved separately). */
export function parseEnv(raw) {
  const pairs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    pairs.push({ key, value });
  }
  return pairs;
}

/** Write raw .env content. */
export async function writeEnvRaw(project, raw) {
  await fsp.writeFile(envPath(project), raw, 'utf8');
}

/** Serialize key/value pairs into .env format (quotes values with spaces). */
export function serializeEnv(pairs) {
  return (
    pairs
      .filter((p) => p.key)
      .map(({ key, value }) => {
        const v = value ?? '';
        const needsQuote = /[\s#"']/.test(v);
        return `${key}=${needsQuote ? JSON.stringify(v) : v}`;
      })
      .join('\n') + '\n'
  );
}
