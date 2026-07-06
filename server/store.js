import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, REPOS_DIR, DB_FILE } from './config.js';

// Ensure data directories exist on boot.
fs.mkdirSync(REPOS_DIR, { recursive: true });

let state = { projects: [] };
let writeQueue = Promise.resolve();

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = JSON.parse(raw);
    if (!Array.isArray(state.projects)) state.projects = [];
  } catch {
    state = { projects: [] };
  }
}

// Atomic write: write to temp then rename. Serialized so concurrent
// mutations don't clobber each other.
function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return writeQueue;
}

load();

/** Turn a display name into a safe docker-compose project name / dir name. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function listProjects() {
  return state.projects;
}

export function getProject(id) {
  return state.projects.find((p) => p.id === id) || null;
}

export function findBySlug(slug) {
  return state.projects.find((p) => p.slug === slug) || null;
}

export async function createProject({ name, gitUrl, branch, type, source, publishDir }) {
  const slug = slugify(name);
  const id = crypto.randomUUID();
  const project = {
    id,
    name,
    slug,
    gitUrl: gitUrl || null,
    branch: branch || null,
    type: type || 'compose', // 'compose' | 'static'
    source: source || (gitUrl ? 'git' : 'upload'),
    publishDir: publishDir || null,
    dir: path.join(REPOS_DIR, slug),
    composeFile: null,
    routes: [],
    status: 'stopped',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.projects.push(project);
  await persist();
  return project;
}

export async function updateProject(id, patch) {
  const p = getProject(id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return p;
}

export async function deleteProject(id) {
  const idx = state.projects.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  state.projects.splice(idx, 1);
  await persist();
  return true;
}
