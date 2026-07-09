import dns from 'node:dns/promises';

// Allowlist entries may be an IPv4 CIDR/IP or a hostname (e.g. vpn.qiscus.com).
// Hostnames are resolved to their A records and refreshed periodically, so the
// allowlist follows DNS automatically when the target's IP changes.

const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/(3[0-2]|[12]?\d))?$/;

export function isIpEntry(e) {
  return IPV4_CIDR.test(String(e).trim());
}
export function isHostname(e) {
  const s = String(e).trim();
  return !isIpEntry(s) && /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s) && /[a-zA-Z]/.test(s);
}

const cache = new Map(); // hostname -> Set<ip>
const known = new Set(); // hostnames to keep refreshed

async function resolveHost(host) {
  let ips = [];
  try {
    ips = await dns.resolve4(host);
  } catch {
    try {
      ips = (await dns.lookup(host, { all: true, family: 4 })).map((r) => r.address);
    } catch {
      // Keep the last known IPs on a transient failure so we don't lock out.
      if (cache.has(host)) return;
      cache.set(host, new Set());
      return;
    }
  }
  cache.set(host, new Set(ips));
}

/** Current resolved IPs for a hostname. Warms the cache on first miss. */
export function hostIps(host) {
  known.add(host);
  if (!cache.has(host)) {
    resolveHost(host); // async warm; this call misses until it lands
    return [];
  }
  return [...cache.get(host)];
}

/** Resolve a batch now (await) — used to warm panel hostnames before listen. */
export async function warm(entries) {
  const hosts = (entries || []).filter(isHostname);
  await Promise.all(hosts.map((h) => { known.add(h); return resolveHost(h); }));
}

/** Start the periodic re-resolve of every hostname we've seen. */
export function startRefresh(intervalMs = 5 * 60 * 1000) {
  const t = setInterval(() => { for (const h of known) resolveHost(h); }, intervalMs);
  t.unref?.();
  return t;
}
