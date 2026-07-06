import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = ['public', 'dist', 'build', '_site', 'site', 'docs', 'out', 'www'];

/**
 * Pick the directory that holds the site's index.html: a common build-output
 * dir if one exists, an index.html at the root, else '.' (serve the root and
 * let 404s happen). Static sites are served directly by Node, not Docker.
 */
export function detectPublishDir(dir) {
  for (const c of CANDIDATES) {
    try {
      if (fs.statSync(path.join(dir, c)).isDirectory() && fs.existsSync(path.join(dir, c, 'index.html'))) {
        return c;
      }
    } catch { /* ignore */ }
  }
  return '.';
}
