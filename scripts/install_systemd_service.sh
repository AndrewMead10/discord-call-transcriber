#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="call-transcribe-bot"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

usage() {
  cat <<'USAGE'
Usage: install_systemd_service.sh [--service-name NAME]

Creates or updates a systemd service that runs the Call Transcribe bot using Docker Compose
and enables it so the bot starts automatically on boot.

Options:
  --service-name NAME   Override the default service unit name (call-transcribe-bot)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --service-name" >&2; exit 1; }
      SERVICE_NAME="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "docker-compose.yml not found at $COMPOSE_FILE" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/tmp" "$PROJECT_DIR/data"

# Prefer the Docker Compose v2 plugin, fall back to the v1 binary if needed.
COMPOSE_PREFIX=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_PREFIX="$(command -v docker) compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_PREFIX="$(command -v docker-compose)"
else
  echo "Neither 'docker compose' nor 'docker-compose' is available on PATH" >&2
  exit 1
fi

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

compose_cmd="$COMPOSE_PREFIX -f $COMPOSE_FILE"

$SUDO tee "$UNIT_PATH" >/dev/null <<EOF_UNIT
[Unit]
Description=Call Transcribe Discord Bot (Docker Compose)
Requires=docker.service
After=docker.service

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$compose_cmd up
ExecStop=$compose_cmd down
Restart=always
RestartSec=10
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF_UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME"

echo "Systemd service '$SERVICE_NAME' installed."
