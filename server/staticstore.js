import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATIC_DIR, STATIC_DB_FILE } from './config.js';
import { slugify } from './store.js';

// Ensure the static-sites root exists on boot.
fs.mkdirSync(STATIC_DIR, { recursive: true });

let state = { sites: [] };
let writeQueue = Promise.resolve();

function load() {
  try {
    state = JSON.parse(fs.readFileSync(STATIC_DB_FILE, 'utf8'));
    if (!Array.isArray(state.sites)) state.sites = [];
  } catch {
    state = { sites: [] };
  }
}

// Atomic, serialized write (temp file + rename) so concurrent mutations
// don't clobber each other.
function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = STATIC_DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, STATIC_DB_FILE);
  });
  return writeQueue;
}

load();

export function listSites() {
  return state.sites;
}

export function getSite(id) {
  return state.sites.find((s) => s.id === id) || null;
}

export function findBySlug(slug) {
  return state.sites.find((s) => s.slug === slug) || null;
}

export async function createSite({ name, source, gitUrl, branch, publishDir, createdBy }) {
  const slug = slugify(name);
  const id = crypto.randomUUID();
  const site = {
    id,
    name,
    slug,
    source: source === 'git' ? 'git' : 'upload',
    gitUrl: source === 'git' ? gitUrl || null : null,
    branch: source === 'git' ? branch || null : null,
    publishDir: publishDir || '.',
    dir: path.join(STATIC_DIR, slug),
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.sites.push(site);
  await persist();
  return site;
}

export async function updateSite(id, patch) {
  const s = getSite(id);
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return s;
}

export async function deleteSite(id) {
  const idx = state.sites.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  state.sites.splice(idx, 1);
  await persist();
  return true;
}
