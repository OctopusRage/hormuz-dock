import httpProxy from 'http-proxy';
import * as store from './store.js';
import * as hostallow from './hostallow.js';

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

// --- Per-route IP allowlist (e.g. restrict a route to the VPN subnet) ---

/**
 * Client IP for the allowlist check. Uses the value our trusted front proxy
 * records — X-Real-IP, else the RIGHTMOST X-Forwarded-For hop (the one nginx
 * appended) — not the leftmost, which a client can spoof. Falls back to the
 * socket peer. Requires nginx to set these headers (proxy_set_header X-Real-IP
 * $remote_addr / X-Forwarded-For $proxy_add_x_forwarded_for).
 */
export function clientIp(req) {
  let ip = req.headers['x-real-ip'];
  if (!ip) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      ip = parts[parts.length - 1];
    }
  }
  if (!ip) ip = req.socket?.remoteAddress || '';
  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function ipv4ToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = parseInt(o, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Is `ip` inside `cidr` (IPv4 a.b.c.d[/n]; non-IPv4 falls back to exact match). */
function ipInCidr(ip, cidr) {
  const [range, bitsStr] = String(cidr).split('/');
  const ipN = ipv4ToInt(ip);
  const rN = ipv4ToInt(range);
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  if (ipN === null || rN === null || isNaN(bits) || bits < 0 || bits > 32) {
    return ip === range && bitsStr === undefined; // non-IPv4: exact match
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipN & mask) === (rN & mask);
}

/** Match one allowlist entry (IPv4 CIDR/IP, or a hostname resolved via DNS). */
function entryMatches(ip, entry) {
  if (hostallow.isHostname(entry)) return hostallow.hostIps(entry).includes(ip);
  return ipInCidr(ip, entry);
}

/** True if `ip` matches any allowlist entry (loopback always allowed). */
export function ipMatchesCidrs(ip, entries) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return !!ip && entries.some((e) => entryMatches(ip, e));
}

/** Allow if no allowlist is set, else the client IP must match one CIDR. */
export function routeAllowsClient(route, req) {
  const cidrs = route.allowCidrs;
  if (!cidrs || !cidrs.length) return true;
  return ipMatchesCidrs(clientIp(req), cidrs);
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

  // Per-route IP allowlist (e.g. VPN-only): reject clients outside the CIDRs.
  if (!routeAllowsClient(route, req)) {
    console.warn(
      `[proxy] blocked ${route.path} — client=${clientIp(req)} ` +
        `x-real-ip=${req.headers['x-real-ip'] || '-'} ` +
        `x-forwarded-for=${req.headers['x-forwarded-for'] || '-'} ` +
        `allow=${(route.allowCidrs || []).join(',')}`
    );
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: this route is restricted to allowed networks.');
    return;
  }

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
  if (!routeAllowsClient(route, req)) { socket.destroy(); return true; } // blocked
  req.url = rewrite(req.url, route);
  proxy.ws(req, socket, head, { target: targetFor(route), changeOrigin: true });
  return true;
}
