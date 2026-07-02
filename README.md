# AppHub

A lightweight web app to manage multiple **Docker Compose** projects on a single server.
Drop in a git link, AppHub clones it, finds the compose file, and gives you a GUI to
edit env vars, start/stop the stack, and watch resource usage.

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

## How it works

- **No database** — project metadata is stored in `data/db.json` (atomic writes).
- **Cloned repos** live in `data/repos/<slug>/`.
- Each project runs under a pinned compose project name (`-p <slug>`), so its
  containers are consistently labeled and isolated from others.
- All shell calls use argument arrays (no shell interpolation) so git URLs and
  names can't inject commands. Git credential prompts are disabled so bad/private
  URLs fail fast instead of hanging.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/system` | Host Docker info (CPUs, RAM, versions) |
| GET | `/api/projects` | List projects with live status |
| POST | `/api/projects` | `{name, gitUrl, branch?}` → clone & add |
| GET | `/api/projects/:id` | Project + container detail |
| DELETE | `/api/projects/:id` | compose down + remove |
| POST | `/api/projects/:id/start\|stop\|restart` | Lifecycle |
| POST | `/api/projects/:id/pull` | git pull |
| GET | `/api/projects/:id/stats` | CPU/mem per container |
| GET | `/api/projects/:id/logs?service=&tail=` | Recent logs |
| GET/PUT | `/api/projects/:id/env` | Read / write `.env` |

## Security note

AppHub runs Docker and git commands on the host. It has **no authentication** —
run it only on a trusted/internal network, behind a reverse proxy with auth, or
bind it to localhost and access via SSH tunnel. Anyone who can reach the port can
start/stop containers and edit env files.
