import httpProxy from 'http-proxy';
import * as store from './store.js';

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on('error', (err, req, res) => {
  // res is an http.ServerResponse for web requests; a socket for ws.
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway: ' + err.message);
  } else if (res && res.destroy) {
    res.destroy();
  }
});

/** Gather all configured routes across projects, longest path first. */
function allRoutes() {
  return store
    .listProjects()
    .flatMap((p) => (p.routes || []).map((r) => ({ ...r, projectId: p.id })))
    .filter((r) => r.path && r.port)
    .sort((a, b) => b.path.length - a.path.length);
}

/**
 * Find the route whose prefix matches this pathname. Matches "/_chat" for
 * "/_chat" and "/_chat/..." but not "/_chatx" (respects a path boundary).
 */
export function findRoute(pathname) {
  for (const r of allRoutes()) {
    if (pathname === r.path || pathname.startsWith(r.path + '/')) return r;
  }
  return null;
}

function targetFor(route) {
  return `http://127.0.0.1:${route.port}`;
}

// Strip the route prefix so the backend app sees a root-relative path.
function rewrite(url, route) {
  if (route.stripPrefix === false) return url;
  const stripped = url.slice(route.path.length);
  return stripped.startsWith('/') ? stripped : '/' + stripped;
}

/** Express middleware: proxy matching requests, otherwise fall through. */
export function proxyMiddleware(req, res, next) {
  const pathname = req.url.split('?')[0];
  const route = findRoute(pathname);
  if (!route) return next();
  req.url = rewrite(req.url, route);
  proxy.web(req, res, { target: targetFor(route), changeOrigin: true });
}

/** Handle a WebSocket upgrade for a proxied route. Returns true if handled. */
export function handleProxyUpgrade(req, socket, head) {
  const pathname = req.url.split('?')[0];
  const route = findRoute(pathname);
  if (!route) return false;
  req.url = rewrite(req.url, route);
  proxy.ws(req, socket, head, { target: targetFor(route), changeOrigin: true });
  return true;
}
