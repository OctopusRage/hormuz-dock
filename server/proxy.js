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

// CORS fix (opt-in per route): rewrite the backend's CORS headers on the way out
// so credentialed cross-origin requests work. Echoes the caller's Origin and adds
// Allow-Credentials, replacing any wildcard the backend sent (a wildcard "*" is
// rejected by browsers for credentialed requests).
proxy.on('proxyRes', (proxyRes, req) => {
  if (!req.__corsFix || !req.headers.origin) return;
  const h = proxyRes.headers;
  delete h['access-control-allow-origin'];
  delete h['access-control-allow-credentials'];
  h['access-control-allow-origin'] = req.headers.origin;
  h['access-control-allow-credentials'] = 'true';
  h['vary'] = h['vary']
    ? (/\borigin\b/i.test(h['vary']) ? h['vary'] : h['vary'] + ', Origin')
    : 'Origin';
});

// Answer a CORS preflight directly at the proxy so it never depends on the
// backend's config. Reflects the requested headers, so a header the backend
// forgot to allow can't break the preflight.
function writePreflight(req, res) {
  const headers = {
    'Access-Control-Allow-Origin': req.headers.origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      req.headers['access-control-request-headers'] || 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin, Access-Control-Request-Headers',
    'Content-Length': '0',
  };
  // Private Network Access (Chrome): a public-origin page calling a server that
  // resolves to a private/local IP is blocked unless the preflight opts in.
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  res.writeHead(204, headers);
  res.end();
}

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

  // Opt-in CORS fix: short-circuit preflights, and flag real requests so the
  // proxyRes handler rewrites their CORS headers.
  if (route.cors && req.headers.origin) {
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      return writePreflight(req, res);
    }
    req.__corsFix = true;
  }

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
