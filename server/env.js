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

/**
 * Decode one .env value using Docker Compose's quoting rules:
 *  - 'single-quoted' → literal (no escapes, no interpolation)
 *  - "double-quoted" → escapes processed (\" \\ \$ \n \r \t)
 *  - bare            → as-is
 * This is the exact inverse of `quoteValue` below, so form edits round-trip.
 */
function unquote(s) {
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(["\\$nrt])/g, (_, c) =>
      ({ '"': '"', '\\': '\\', $: '$', n: '\n', r: '\r', t: '\t' }[c])
    );
  }
  return s;
}

/** Parse .env into key/value pairs (comments and blank lines skipped). */
export function parseEnv(raw) {
  const pairs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    pairs.push({ key, value: unquote(trimmed.slice(eq + 1).trim()) });
  }
  return pairs;
}

/** Write raw .env content. */
export async function writeEnvRaw(project, raw) {
  await fsp.writeFile(envPath(project), raw, 'utf8');
}

/**
 * Quote a single value for .env, minimally and Compose-compatibly:
 *  - safe chars      → bare
 *  - has no `'`      → single-quote it (literal: spaces, $, ", #, \ all fine)
 *  - contains a `'`  → double-quote with \\ \" \$ escaped
 * Inverse of `unquote`, so a value survives any number of load/save cycles.
 */
function quoteValue(v) {
  if (v === '') return '';
  if (/^[^\s'"#$\\`]+$/.test(v)) return v; // no whitespace/quote/#/$/backslash/backtick
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

/** Serialize key/value pairs into .env format. */
export function serializeEnv(pairs) {
  return (
    pairs
      .filter((p) => p.key)
      .map(({ key, value }) => `${key}=${quoteValue(value ?? '')}`)
      .join('\n') + '\n'
  );
}
