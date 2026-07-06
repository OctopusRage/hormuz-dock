import express from 'express';
import path from 'node:path';
import { STATIC_PREFIX } from './config.js';
import * as staticstore from './staticstore.js';

// Cache one express.static handler per site, keyed by the resolved root so a
// publishDir change (or delete) transparently rebuilds it.
const cache = new Map(); // slug -> { root, fn }

function rootFor(site) {
  return site.publishDir && site.publishDir !== '.'
    ? path.join(site.dir, site.publishDir)
    : site.dir;
}

function handlerFor(site) {
  const root = rootFor(site);
  const hit = cache.get(site.slug);
  if (hit && hit.root === root) return hit.fn;
  const fn = express.static(root, {
    index: 'index.html',
    dotfiles: 'deny', // .git / .env / dotfiles are never served
    fallthrough: true, // miss -> our own plain 404 (no SPA fallback)
    redirect: false, // we handle trailing-slash redirects ourselves
    etag: true,
  });
  cache.set(site.slug, { root, fn });
  return fn;
}

/** Drop a cached handler (call after delete / publishDir change). */
export function invalidate(slug) {
  cache.delete(slug);
}

/**
 * Serve static sites publicly at STATIC_PREFIX/<slug>/... directly from disk.
 * Mounted before auth so published pages need no login. Plain static: a missing
 * file is a 404, never a rewrite to index.html.
 */
export function staticMiddleware(req, res, next) {
  const pathname = req.url.split('?')[0];
  if (pathname !== STATIC_PREFIX && !pathname.startsWith(STATIC_PREFIX + '/')) {
    return next();
  }

  const rest = pathname.slice(STATIC_PREFIX.length); // '' | '/slug' | '/slug/...'
  const m = rest.match(/^\/([^/]+)(\/.*)?$/);
  if (!m) return res.status(404).type('txt').send('Not found');

  const slug = decodeURIComponent(m[1]);
  const site = staticstore.findBySlug(slug);
  if (!site) return res.status(404).type('txt').send('Static site not found');

  // Never serve dotfiles (.git, .env, …), regardless of publish dir.
  const subPath = decodeURIComponent(m[2] || '/');
  if (subPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    return res.status(403).type('txt').send('Forbidden');
  }

  const query = req.url.slice(pathname.length); // includes leading '?', or ''

  // No trailing slash after the slug: redirect so relative asset links resolve
  // under the site (…/site  →  …/site/).
  if (m[2] == null) {
    return res.redirect(308, `${STATIC_PREFIX}/${slug}/${query}`);
  }

  // Re-root the request onto the site's publish dir, then hand to express.static.
  const original = req.url;
  req.url = m[2] + query;
  handlerFor(site)(req, res, (err) => {
    req.url = original;
    if (err) return next(err);
    res.status(404).type('txt').send('Not found');
  });
}
