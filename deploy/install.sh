#!/usr/bin/env bash
# Hormuz Dock — production installer for Ubuntu/Debian (systemd).
# Idempotent: safe to re-run to update to the latest code. Run with sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/OctopusRage/hormuz-dock/master/deploy/install.sh | sudo bash
# or from a checkout:
#   sudo bash deploy/install.sh
#
# Override any default via env, e.g.:  sudo PORT=8080 BRANCH=master bash deploy/install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/OctopusRage/hormuz-dock.git}"
BRANCH="${BRANCH:-master}"
BASE_DIR="${BASE_DIR:-/opt/hormuz-dock}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"
HORMUZ_USER="${HORMUZ_USER:-hormuz}"
PORT="${PORT:-4100}"
ENV_FILE="${ENV_FILE:-/etc/hormuz-dock.env}"
SERVICE_FILE="/etc/systemd/system/hormuz-dock.service"
NODE_MAJOR="24"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mXX\033[0m  %s\n' "$*" >&2; exit 1; }

[ "${EUID:-$(id -u)}" -eq 0 ] || die "Run as root (use sudo)."
command -v apt-get >/dev/null || die "This installer targets Ubuntu/Debian (apt)."
command -v curl >/dev/null || { apt-get update && apt-get install -y curl; }

# --- Node.js >= 24 (needed for the built-in node:sqlite module) ---
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x + git ..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs git
else
  log "Node.js $(node -v) already present; ensuring git ..."
  apt-get install -y git
fi

# --- Docker check (required at runtime) ---
if ! command -v docker >/dev/null; then
  warn "Docker not found — Hormuz Dock needs it. Install Docker Engine, then re-run."
elif ! docker compose version >/dev/null 2>&1; then
  warn "'docker compose' plugin not found — install docker-compose-plugin, then re-run."
else
  log "Docker detected: $(docker compose version | head -1)"
fi

# --- service user + directories ---
if ! id "$HORMUZ_USER" >/dev/null 2>&1; then
  log "Creating service user '$HORMUZ_USER' ..."
  useradd -r -m -s /usr/sbin/nologin "$HORMUZ_USER"
fi
if getent group docker >/dev/null; then
  usermod -aG docker "$HORMUZ_USER"
else
  warn "No 'docker' group yet — '$HORMUZ_USER' will get Docker access once Docker is installed (re-run then)."
fi
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$HORMUZ_USER":"$HORMUZ_USER" "$BASE_DIR"

# --- fetch / update code ---
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout in $APP_DIR ..."
  sudo -u "$HORMUZ_USER" git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -u "$HORMUZ_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $APP_DIR ..."
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"; chown "$HORMUZ_USER":"$HORMUZ_USER" "$APP_DIR"
  sudo -u "$HORMUZ_USER" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
log "Installing dependencies ..."
( cd "$APP_DIR" && sudo -u "$HORMUZ_USER" npm ci --omit=dev )

# --- env file (never clobber; generate a strong admin password on first create) ---
NEW_PW=""
if [ ! -f "$ENV_FILE" ]; then
  NEW_PW="$(openssl rand -base64 18 2>/dev/null || head -c 18 /dev/urandom | base64)"
  log "Writing $ENV_FILE (generated a random admin password)"
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD=$NEW_PW
EOF
  chmod 600 "$ENV_FILE"
else
  log "$ENV_FILE already exists — leaving it untouched."
fi

# --- systemd unit ---
log "Writing $SERVICE_FILE ..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Hormuz Dock
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
User=$HORMUZ_USER
SupplementaryGroups=docker
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hormuz-dock >/dev/null 2>&1 || true
systemctl restart hormuz-dock
sleep 2

echo
if systemctl is-active --quiet hormuz-dock; then
  log "Hormuz Dock is running on http://<server-ip>:${PORT}"
else
  warn "Service is not active — check: journalctl -u hormuz-dock -n 40 --no-pager"
fi
if [ -n "$NEW_PW" ]; then
  printf '\033[1;32m    Login:  admin  /  %s\033[0m\n' "$NEW_PW"
  echo "    (stored in $ENV_FILE — change it after first login)"
else
  echo "    Login with the admin password in $ENV_FILE"
fi
echo "    Put it behind HTTPS (see README) before exposing it publicly."
