# hormuz-mcp

An [MCP](https://modelcontextprotocol.io) server that wraps the **Hormuz Dock**
REST API, so an AI agent can drive your Hormuz instance — and, in particular,
**deploy by uploading a locally-built Docker image** instead of pushing to a
registry (ECR/Docker Hub) and pulling on the server.

The headline tool is `hormuz_deploy_local_image`: it (optionally) `docker build`s,
then `docker save`s the image, streams it into `docker load` on the Hormuz host
via `POST /api/projects/:id/image`, and restarts the project.

## Setup

```bash
cd mcp
npm install
```

You need a Hormuz **API key**: open the panel → **API Keys** → create one. It
inherits your role and appears in the audit log tagged *“via API key”*.

Config is via two env vars:

| var | example |
| --- | --- |
| `HORMUZ_URL` | `https://hormuz.qiscus.io` |
| `HORMUZ_API_KEY` | `hormuz_xxxxxxxxxxxxxxxxxxxxxxxx` |

The build/save tools (`hormuz_deploy_local_image`, and `hormuz_upload_image`
with `imageTag`) shell out to your **local `docker` CLI**, so run this server on
a machine that has the image / build context.

### Claude Code

```bash
claude mcp add hormuz \
  -e HORMUZ_URL=https://hormuz.qiscus.io \
  -e HORMUZ_API_KEY=hormuz_xxxxxxxxxxxx \
  -- node /absolute/path/to/apphub/mcp/server.js
```

### Claude Desktop / other clients

```json
{
  "mcpServers": {
    "hormuz": {
      "command": "node",
      "args": ["/absolute/path/to/apphub/mcp/server.js"],
      "env": {
        "HORMUZ_URL": "https://hormuz.qiscus.io",
        "HORMUZ_API_KEY": "hormuz_xxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

| tool | what it does |
| --- | --- |
| `hormuz_whoami` | Verify the key; show identity/role. |
| `hormuz_list_projects` | All projects with status, ports, branch, last deploy. |
| `hormuz_get_project` | One project with its containers. |
| `hormuz_logs` | Recent container logs (optionally one service). |
| `hormuz_lifecycle` | `start` / `stop` / `restart` / `rebuild` / `redeploy`. |
| `hormuz_list_images` | Uploaded images (tag, present on host?, size). |
| `hormuz_upload_image` | Upload a local image (`imageTag`) or a tarball (`tarPath`) → `docker load`. |
| `hormuz_remove_image` | `docker rmi` an uploaded image + drop its record. |
| `hormuz_get_compose` | Read base compose + editable override. |
| `hormuz_set_compose_override` | Write the override (e.g. wire `image: <tag>`). |
| `hormuz_deploy_local_image` | **Build?/save/upload/restart** — deploy a local image in one call. |

## Example prompts

> Deploy `myapp:1.0` (built locally) to the **myapp** project on Hormuz.

→ `hormuz_deploy_local_image { project: "myapp", imageTag: "myapp:1.0" }`

> Build the image in `./service` and deploy it to **myapp**.

→ `hormuz_deploy_local_image { project: "myapp", imageTag: "myapp:1.0", buildContext: "./service" }`

## Notes

- For the loaded image to be used, the project's compose must reference it by tag
  (`image: myapp:1.0`) **with no `build:`** — Compose then uses the locally
  loaded image and won't try to pull it. `hormuz_set_compose_override` can wire
  this if the base compose doesn't already.
- API keys are scoped to the operational plane — they can manage/deploy projects
  but cannot touch users, keys, or the global secret store.
