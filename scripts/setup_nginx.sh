#!/usr/bin/env bash
set -euo pipefail

DOMAIN="transcriptions.velab.dev"
BACKEND_PORT="16384"
CERT_EMAIL=""
SKIP_CERTBOT="false"
STAGING="false"
WEBROOT_DIR="/var/www/letsencrypt"

usage() {
  cat <<'USAGE'
Usage: setup_nginx.sh [options]

Configures Nginx to reverse-proxy the Call Transcribe web UI over HTTPS.
Run as root (or with sudo) on the host serving the application.

Options:
  --domain NAME        DNS name for the site (default: transcriptions.velab.dev)
  --backend-port PORT  Local port the Node app listens on (default: 16384)
  --email ADDRESS      Email address for Let's Encrypt (required unless --skip-certbot)
  --skip-certbot       Only write Nginx config; do not request/renew certificates
  --staging            Use Let's Encrypt staging environment (rate-limit safe)
  -h, --help           Show this help message

The script will:
  * create/update /etc/nginx/sites-available/<domain>.conf
  * enable the site and reload Nginx
  * (unless skipped) obtain/renew certificates via certbot using the webroot plugin

Ensure the Node app is reachable on the chosen backend port before running.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --domain" >&2; exit 1; }
      DOMAIN="$1"
      ;;
    --backend-port)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --backend-port" >&2; exit 1; }
      BACKEND_PORT="$1"
      ;;
    --email)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --email" >&2; exit 1; }
      CERT_EMAIL="$1"
      ;;
    --skip-certbot)
      SKIP_CERTBOT="true"
      ;;
    --staging)
      STAGING="true"
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
done

if [[ "$SKIP_CERTBOT" != "true" && -z "$CERT_EMAIL" ]];
then
  echo "--email is required when requesting certificates. Provide an address or use --skip-certbot." >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed or not in PATH." >&2
  exit 1
fi

if [[ "$SKIP_CERTBOT" != "true" ]] && ! command -v certbot >/dev/null 2>&1; then
  echo "certbot is not installed or not in PATH." >&2
  exit 1
fi

AVAILABLE_DIR="/etc/nginx/sites-available"
ENABLED_DIR="/etc/nginx/sites-enabled"
CONFIG_NAME="${DOMAIN}.conf"
CONFIG_PATH="${AVAILABLE_DIR}/${CONFIG_NAME}"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY_PATH="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

if [[ $EUID -ne 0 ]]; then
  echo "This script requires root privileges. Re-run with sudo or as root." >&2
  exit 1
fi

mkdir -p "$WEBROOT_DIR"
chown root:root "$WEBROOT_DIR"
chmod 755 "$WEBROOT_DIR"

mkdir -p "$AVAILABLE_DIR" "$ENABLED_DIR"

cat >"$CONFIG_PATH" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT_DIR};
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
    }
}
EOF

ln -sf "$CONFIG_PATH" "${ENABLED_DIR}/${CONFIG_NAME}"

nginx -t
systemctl reload nginx

if [[ "$SKIP_CERTBOT" == "true" ]]; then
  echo "Nginx HTTP proxy configured. Skipping certificate request as requested."
  exit 0
fi

CERTBOT_ARGS=(certbot certonly --webroot -w "$WEBROOT_DIR" -d "$DOMAIN" --email "$CERT_EMAIL" --agree-tos --no-eff-email --non-interactive)
if [[ "$STAGING" == "true" ]]; then
  CERTBOT_ARGS+=(--staging)
fi

"${CERTBOT_ARGS[@]}"

if [[ ! -f "$CERT_PATH" || ! -f "$KEY_PATH" ]]; then
  echo "Certificate files were not found after certbot run. Aborting." >&2
  exit 1
fi

cat >"$CONFIG_PATH" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT_DIR};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
    }
}
EOF

nginx -t
systemctl reload nginx

echo "Nginx HTTPS proxy configured for ${DOMAIN}. Certificates managed by certbot."
