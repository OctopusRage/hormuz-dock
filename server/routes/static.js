import express from 'express';
import fs from 'node:fs';
import * as staticstore from '../staticstore.js';
import { slugify } from '../store.js';
import * as git from '../git.js';
import * as filelib from '../files.js';
import * as staticlib from '../static.js';
import { invalidate } from '../staticserve.js';
import { STATIC_PREFIX } from '../config.js';

const router = express.Router();

const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });

function requireSite(req, res) {
  const s = staticstore.getSite(req.params.id);
  if (!s) {
    res.status(404).json({ error: 'Static site not found' });
    return null;
  }
  return s;
}

// Decorate a stored site with its public URL path for the UI.
function withUrl(s) {
  return { ...s, url: `${STATIC_PREFIX}/${s.slug}/` };
}

// List all static sites (git-backed ones include their latest commit).
router.get(
  '/',
  h(async (req, res) => {
    const sites = staticstore.listSites();
    const out = await Promise.all(
      sites.map(async (s) => {
        let commit = null;
        if (s.source === 'git') {
          try { commit = await git.lastCommit(s.dir); } catch { /* ignore */ }
        }
        return { ...withUrl(s), commit };
      })
    );
    res.json(out);
  })
);

// Create a static site: clone a git repo (auto-detect publish dir) or make an
// empty site to receive an upload. No Docker, no compose file required.
router.post(
  '/',
  h(async (req, res) => {
    const { name, gitUrl, branch } = req.body || {};
    const source = req.body?.source === 'git' ? 'git' : 'upload';
    let publishDir = (req.body?.publishDir || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (source === 'git' && !gitUrl) return res.status(400).json({ error: 'gitUrl is required' });

    const slug = slugify(name);
    if (!slug) return res.status(400).json({ error: 'name produces an empty URL slug' });
    if (staticstore.findBySlug(slug)) {
      return res.status(409).json({ error: `A static site named "${slug}" already exists` });
    }

    const site = await staticstore.createSite({ name, source, gitUrl, branch, publishDir, createdBy: req.user?.username });

    if (source === 'git') {
      try {
        await git.clone(gitUrl, site.dir, branch || undefined);
      } catch (err) {
        await staticstore.deleteSite(site.id);
        return res.status(400).json({ error: err.message });
      }
      if (!publishDir) publishDir = staticlib.detectPublishDir(site.dir);
    } else {
      fs.mkdirSync(site.dir, { recursive: true });
      if (!publishDir) publishDir = '.';
    }

    await staticstore.updateSite(site.id, { publishDir });
    invalidate(site.slug);
    res.status(201).json(withUrl(staticstore.getSite(site.id)));
  })
);

// Get one site.
router.get(
  '/:id',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    res.json(withUrl(s));
  })
);

// Delete a site: remove its files and drop the record.
router.delete(
  '/:id',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    await git.removeDir(s.dir);
    await staticstore.deleteSite(s.id);
    invalidate(s.slug);
    res.json({ ok: true });
  })
);

// Set the publish directory (which folder holds index.html).
router.put(
  '/:id/publish',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    const publishDir = String(req.body?.publishDir ?? '.').trim() || '.';
    await staticstore.updateSite(s.id, { publishDir });
    invalidate(s.slug);
    res.json(withUrl(staticstore.getSite(s.id)));
  })
);

// Pull latest (git-backed sites only).
router.post(
  '/:id/pull',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    if (s.source !== 'git') return res.status(400).json({ error: 'This site was uploaded, not cloned from git.' });
    const output = await git.pull(s.dir);
    invalidate(s.slug);
    res.json({ ok: true, output });
  })
);

// --- Files (reuses files.js; a site has a .dir just like a project) ---

router.get(
  '/:id/files',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    res.json(filelib.listFiles(s));
  })
);

router.get(
  '/:id/file',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    res.json(filelib.readFile(s, String(req.query.path)));
  })
);

router.put(
  '/:id/file',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    const { path: rel, content, contentBase64 } = req.body || {};
    if (!rel) return res.status(400).json({ error: 'path is required' });
    if (content == null && contentBase64 == null) {
      return res.status(400).json({ error: 'content or contentBase64 is required' });
    }
    const out = await filelib.writeFile(s, rel, { content, contentBase64 });
    invalidate(s.slug);
    res.json(out);
  })
);

router.post(
  '/:id/unzip',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    const { contentBase64, path: target } = req.body || {};
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 (zip) is required' });
    await filelib.extractZip(s, contentBase64, target || '.');
    invalidate(s.slug);
    res.json({ ok: true });
  })
);

router.delete(
  '/:id/file',
  h(async (req, res) => {
    const s = requireSite(req, res);
    if (!s) return;
    if (!req.query.path) return res.status(400).json({ error: 'path is required' });
    await filelib.deleteEntry(s, String(req.query.path));
    invalidate(s.slug);
    res.json({ ok: true });
  })
);

export default router;
