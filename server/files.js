import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EXCLUDE = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 800;

/** Resolve a project-relative path, refusing to escape the project or touch .git. */
export function resolveInProject(project, rel) {
  const base = path.resolve(project.dir);
  const target = path.resolve(base, rel || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    const e = new Error('Path is outside the project directory'); e.status = 400; throw e;
  }
  const top = path.relative(base, target).split(path.sep)[0];
  if (EXCLUDE.has(top)) { const e = new Error(`"${top}" is off-limits`); e.status = 400; throw e; }
  return target;
}

/** Flat, recursive listing of the project dir (excludes .git/node_modules). */
export function listFiles(project) {
  const base = path.resolve(project.dir);
  const out = [];
  const walk = (dir) => {
    if (out.length >= MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (EXCLUDE.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      const rel = path.relative(base, abs);
      const mode = (st.mode & 0o777).toString(8);
      if (ent.isDirectory()) { out.push({ path: rel, dir: true, size: 0, mode }); walk(abs); }
      else out.push({ path: rel, dir: false, size: st.size, mode });
    }
  };
  walk(base);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, truncated: out.length >= MAX_ENTRIES };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Read a file; text is returned inline, binary is flagged (no content). */
export function readFile(project, rel) {
  const target = resolveInProject(project, rel);
  const st = fs.statSync(target);
  if (st.isDirectory()) { const e = new Error('That path is a directory'); e.status = 400; throw e; }
  const buf = fs.readFileSync(target);
  const binary = looksBinary(buf);
  return {
    path: rel,
    size: st.size,
    mode: (st.mode & 0o777).toString(8),
    binary,
    content: binary ? null : buf.toString('utf8'),
  };
}

/**
 * Create/overwrite a file from text (content) or base64 (contentBase64), then
 * chmod 0644 so containers can read it (a 600 file owned by a different uid than
 * the container process is a common bind-mount failure).
 */
export async function writeFile(project, rel, { content, contentBase64 }) {
  const target = resolveInProject(project, rel);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const e = new Error('A directory already exists at that path'); e.status = 400; throw e;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const data = contentBase64 != null
    ? Buffer.from(contentBase64, 'base64')
    : Buffer.from(content ?? '', 'utf8');
  await fsp.writeFile(target, data);
  await fsp.chmod(target, 0o644);
  const st = fs.statSync(target);
  return { path: rel, size: st.size, mode: '644' };
}

/** Delete a file or (empty/non-empty) directory within the project. */
export async function deleteEntry(project, rel) {
  const target = resolveInProject(project, rel);
  if (target === path.resolve(project.dir)) {
    const e = new Error('Refusing to delete the project root'); e.status = 400; throw e;
  }
  await fsp.rm(target, { recursive: true, force: true });
}
