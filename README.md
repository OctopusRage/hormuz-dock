<p align="center">
  <img src="poster.svg" alt="Hormuz Dock — run all your Docker Compose apps from one dashboard" width="620">
</p>

# Hormuz Dock

A lightweight web app to manage multiple **Docker Compose** projects on a single server.
Drop in a git link, Hormuz Dock clones it, finds the compose file, and gives you a GUI to
edit env vars, start/stop the stack, and watch resource usage.

> **Best for developers with a playground server** — a single box where you spin up
> experiments, demos, side-projects, and internal tools from a git URL, wire each one to
> a `/_slug` URL, and tear it down when you're done. It trades the guardrails of a full
> PaaS/orchestrator (multi-node, RBAC per app, GitOps) for a fast, low-ceremony way to
> juggle many small stacks on one host. Great for staging/experiments; for
> business-critical production prefer a managed platform or Kubernetes.

## Quick start

On an Ubuntu/Debian server that already has Docker + the compose plugin, one
command installs and starts everything (see [Run in production](#run-in-production-ubuntudebian-systemd) for details):

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusRage/hormuz-dock/master/deploy/install.sh | sudo bash
```

Re-run it any time to update. It prints the generated `admin` password on first install.

## Features

1. **Create project** — paste a Bitbucket / GitHub / any git URL (optional branch).
2. **Auto clone + detect** — the repo is cloned and must contain a `docker-compose.yml`
   (`.yaml` / `compose.yml` / `compose.yaml` are also accepted). Missing → rejected & rolled back.
3. **Env editor** — edit the project's `.env` from the web UI (form view or raw text).
   Compose reads it automatically on the next start/restart.
4. **Resource monitoring** — live CPU % and memory per container (and totals),
   auto-refreshed every few seconds via `docker stats`.
5. **Lifecycle control** — Start (`compose up -d`), Stop (`compose stop`),
   Restart, Pull (`git pull`), Logs, and Delete (`compose down` + remove repo).
6. **Reverse proxy & access control** — expose apps under `/_<slug>` (WebSockets +
   optional CORS fix), and restrict a route or the whole admin panel to your VPN by
   IP/CIDR **or hostname** (see [Reverse proxy & access control](#reverse-proxy--access-control)).
7. **API keys (AI-friendly)** — mint personal keys to drive Hormuz over REST from
   scripts or AI agents (Claude &amp; co.). Keys are scoped to the operational plane
   and **cannot** touch users, keys, or global secrets. Self-documenting at
   [`/docs`](#api).
8. **Google SSO (optional)** — admins can turn on “Sign in with Google”, restrict
   it to specific email domains, and optionally auto-create accounts on first
   sign-in. Password login keeps working alongside it; users link their own
   Google account from **Password → Google account**. See
   [Google SSO](#google-sso).
9. **Private projects & sites** — mark any project or static site **private** so
   only its creator (and admins) can start / deploy / edit it, or read its env /
   files / shell. Others still see the card (locked with a 🔒) but its controls are
   disabled. The public proxy route (`/_<slug>`) and published static URL
   (`/_static_/`) stay reachable regardless. Filter each tab to **Mine**.

## Requirements

- Node.js ≥ 18
- `git` on PATH
- Docker Engine + Docker Compose v2 (`docker compose`)

## Run

```bash
cd apphub
npm install
npm start           # or: npm run dev  (auto-reload)
```

Open http://localhost:4100

Change the port with `PORT=8080 npm start`.

## Run in production (Ubuntu/Debian, systemd)

One idempotent installer sets up a service user, installs Node 24 + git, clones
the repo to `/opt/hormuz-dock/app`, writes an env file with a generated admin
password, and starts a `systemd` service. Requires Docker Engine + the compose
plugin already installed.

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusRage/hormuz-dock/master/deploy/install.sh | sudo bash
```

Re-run the same command any time to update to the latest code. It prints the
generated `admin` password on first install (also stored in `/etc/hormuz-dock.env`).
Then put it behind HTTPS — e.g. Caddy:

```
dock.example.com {
    reverse_proxy 127.0.0.1:4100
}
```

Manual equivalents live in `deploy/` (`hormuz-dock.service`, `hormuz-dock.env.example`).

## Run in Docker

Hormuz Dock can run in a container, but because it manages the **host's** Docker,
the setup is deliberate — a plain `docker run` will misbehave. A `Dockerfile` and
`docker-compose.yml` are included:

```bash
mkdir -p /opt/hormuz-dock/data
ADMIN_PASSWORD=your-strong-pass docker compose up -d --build
```

Three things in `docker-compose.yml` are required and why:

1. **Docker socket** (`/var/run/docker.sock`) — how it drives the host daemon
   (start/stop/build/stats/exec). This grants **root-equivalent control of the
   host** to anything that can reach the app. Treat it accordingly.
2. **Same-path data bind mount** — the data dir is mounted at an *identical
   absolute path* inside and out (`/opt/hormuz-dock/data`), and `DATA_DIR` points
   at it. The host daemon resolves cloned repos' **build contexts** and
   **`./relative` bind mounts** on the host filesystem, so the path Hormuz Dock
   clones into must exist at the same path on the host. (Verified: a project with
   a `./html` bind mount serves correctly through the containerized instance.)
3. **`network_mode: host`** — so the reverse proxy can reach managed apps on
   `127.0.0.1:<published-port>` and the app's own port binds on the host. Host
   networking is **Linux-only**; on Docker Desktop (mac/Windows) use a bridge
   network with `extra_hosts: ["host.docker.internal:host-gateway"]` and expect
   the `/_name` reverse proxy to need `host.docker.internal` instead of loopback.

Other notes:

- **Node ≥ 24** in the image (the built-in `node:sqlite` module is used unflagged).
- **Private git repos**: uncomment the `~/.ssh` mount for SSH remotes, or use an
  HTTPS URL with a token.
- The container runs as **root**, so files it writes to the data volume are
  root-owned on the host.

## How it works

- **No database** — project metadata is stored in `data/db.json` (atomic writes).
- **Cloned repos** live in `data/repos/<slug>/`.
- Each project runs under a pinned compose project name (`-p <slug>`), so its
  containers are consistently labeled and isolated from others.
- All shell calls use argument arrays (no shell interpolation) so git URLs and
  names can't inject commands. Git credential prompts are disabled so bad/private
  URLs fail fast instead of hanging.

## Reverse proxy & access control

Each project can expose **reverse-proxy routes** under `/_<slug>` (e.g. name `chat`
+ port `9999` → `<host>/_chat` proxies to `127.0.0.1:9999`, WebSockets included),
managed in a project's **Proxy routes**. Per-route options:

- **strip** — strip the `/_<slug>` prefix before forwarding (default on).
- **CORS** — the proxy answers preflight and rewrites responses for credentialed
  cross-origin calls (echoes `Origin`, adds `Allow-Credentials`, reflects requested
  headers, and handles Chrome's Private Network Access).
- **🔒 Allow from** — restrict the route to an allowlist. Accepts IPv4 CIDRs/IPs
  (`10.30.0.0/16`) **or a hostname** (`vpn.example.com`, resolved via DNS and
  re-resolved every 5 min). Blank = open; clients outside the list get `403`.

### VPN-only admin panel (routes stay public)

Set `HORMUZ_PANEL_ALLOW_CIDRS` in the env file to lock the **admin panel** (UI +
`/api` + the container shell) to your network, while proxy routes stay public:

```bash
HORMUZ_PANEL_ALLOW_CIDRS=vpn.example.com            # hostname — auto-follows DNS
# HORMUZ_PANEL_ALLOW_CIDRS=10.30.0.0/16,203.0.113.4 # or CIDRs / IPs (comma-separated)
```

`/_slug` routes and `/_static_/` sites stay **public** — so you can host the panel
VPN-only while serving public apps from the same instance. Empty/unset = open;
loopback is always allowed. Set via env (not the UI) so a bad value can't lock you
out — fix the env and restart.

**Client IP** is read from `X-Real-IP` or the rightmost `X-Forwarded-For` hop (the
one your trusted front proxy records, not the spoofable leftmost), so the front proxy
must forward it:

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Blocked attempts are logged with the client IP (`journalctl -u hormuz-dock | grep blocked`)
— handy for finding the right CIDR/hostname.

## API

The REST API powers the panel and is open to **API keys** for automation and AI
agents. Full, self-documenting reference lives at **`/docs`** (safe to hand to an
AI agent). In short:

- **Authenticate** with a personal key as `Authorization: Bearer hormuz_…` (or the
  `X-API-Key` header). Create/revoke keys in the panel → **API Keys**.
- A key inherits your role and is logged in the audit trail as *“via API key”*.
- Keys are **barred (403)** from the identity/secret plane — `/api/users`,
  `/api/api-keys`, `/api/secure-env`, `/api/system/prune`, `/api/ssh-key`, and the
  web shell — so a leaked key can't escalate, mint keys, or read secrets. Those
  need an interactive browser session.
- The API shares the panel's network gate: if `HORMUZ_PANEL_ALLOW_CIDRS` is set,
  API calls must also come from the allowed network (VPN).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/me` | Who am I (verify a key) — returns `authVia` |
| GET | `/api/system` | Host Docker info (CPUs, RAM, versions) |
| GET | `/api/projects` | List projects with live status |
| POST | `/api/projects` | `{name, gitUrl, branch?}` → clone & add |
| GET | `/api/projects/:id` | Project + container detail |
| DELETE | `/api/projects/:id` | compose down + remove |
| POST | `/api/projects/:id/start\|stop\|restart\|rebuild\|redeploy` | Lifecycle & deploy |
| POST | `/api/projects/:id/pull` | git pull |
| GET | `/api/projects/:id/stats` | CPU/mem per container |
| GET | `/api/projects/:id/logs?service=&tail=` | Recent logs |
| GET/PUT | `/api/projects/:id/env` | Read / write `.env` |
| GET/POST/DELETE | `/api/api-keys` | Manage your keys (session-only) |

## Google SSO

Off by default. An admin turns it on in the panel → **Google SSO**.

1. In Google Cloud Console → *APIs & Services* → *Credentials*, create an
   **OAuth client ID** of type *Web application*.
2. Copy the **Authorized redirect URI** shown in the Hormuz SSO modal
   (`https://<your-host>/api/auth/google/callback`) into that OAuth client.
3. Paste the **Client ID** and **Client secret** into the modal, tick *Enable*,
   and save.

Options:

| Setting | Effect |
|---------|--------|
| **Allowed email domains** | Only these domains may sign in (e.g. `qiscus.com`). Blank = any. Enforced server-side, exact-domain match. |
| **Auto-create accounts** | On: a first-time Google user gets an account with the **user** role. Off: the account must already exist and be linked. |

Notes:

- **Password login always keeps working** — SSO is additive.
- A user links Google to an existing account from **Password → Google account**.
  Accounts are never auto-linked by email address: someone who controls a
  matching mailbox must not be able to claim an existing account.
- SSO can never create an **admin** — auto-created users are always `user`.
- The client secret is encrypted at rest with the same key as Global Secret Env
  and is never returned by the API (the settings endpoint only reports whether
  one is stored). Those settings are admin + session-only — no API keys.
- The flow is the OAuth authorization-code flow with a one-time `state` (CSRF /
  replay protection). The `id_token` is validated for audience, issuer, expiry
  and `email_verified`.
- `/api/auth/google` sits behind the panel network gate, so with
  `HORMUZ_PANEL_ALLOW_CIDRS` set, Google sign-in also only works from the VPN.

## Sessions

A login lasts **3 days**, then you sign in again. Change it with
`HORMUZ_SESSION_DAYS` in the env file (fractions allowed — `0.5` = 12 hours):

```sh
HORMUZ_SESSION_DAYS=3
```

Shortening it applies to everyone on the next restart: sessions issued under a
longer lifetime are capped to the new one, and expired sessions are purged. Nobody
is signed out early — sessions are capped at *now + lifetime*, never below it.
Changing your password still invalidates all of your existing sessions.

## Security note

Hormuz Dock has username/password auth with **admin** and **user** roles, cookie
sessions, and an audit log. But it also runs Docker and git on the host and offers
a **web shell into containers** — so any authenticated account is effectively
**root-equivalent on the host** (doubly so when run with the Docker socket
mounted). Therefore:

- Change the seeded `admin` password immediately (or set `ADMIN_PASSWORD` before
  first run) and only hand out accounts to people you'd trust with host root.
- There is **no HTTPS** built in — put it behind a TLS-terminating reverse proxy,
  or bind to localhost and reach it via SSH tunnel. Run it on a trusted network.
- Reverse-proxy `/_name` routes are **public by default** (they serve your published
  apps). Restrict any route with a per-route **Allow from** allowlist, and/or gate the
  whole admin panel with `HORMUZ_PANEL_ALLOW_CIDRS` — see
  [Reverse proxy & access control](#reverse-proxy--access-control).
- **API keys** carry their owner's operational power but are deliberately kept off
  the identity/secret/shell plane (see [API](#api)). Treat a key like a password:
  it can deploy and read logs/env for anything its owner can. Revoke leaked keys
  from the panel → **API Keys** (takes effect immediately).
