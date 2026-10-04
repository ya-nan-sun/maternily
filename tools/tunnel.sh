#!/usr/bin/env bash
# Expose the local server (port 8787 or $PORT) to the internet for WhatsApp webhooks.
#   With NGROK_AUTHTOKEN and NGROK_DOMAIN in .env: a permanent address (free ngrok static domain).
#   Otherwise: a temporary cloudflared quick tunnel (the address changes on every start).
# The server reads the address itself (NGROK_DOMAIN, or the cloudflared URL in work/tunnel.log).
set -euo pipefail
cd "$(dirname "$0")/.."
val() { { grep -E "^$1=" .env 2>/dev/null || true; } | head -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'\'']//;s/["'\'']$//'; }
PORT="${PORT:-$(val PORT)}"; PORT="${PORT:-8787}"
TOKEN="$(val NGROK_AUTHTOKEN)"; DOMAIN="$(val NGROK_DOMAIN)"; DOMAIN="${DOMAIN#https://}"
mkdir -p work
if [[ -n "$TOKEN" && -n "$DOMAIN" ]]; then
  echo "Permanent address: https://$DOMAIN  (ngrok → localhost:$PORT)"
  exec ngrok http "$PORT" --url "https://$DOMAIN" --authtoken "$TOKEN" --log stdout > work/tunnel.log
else
  echo "No NGROK_AUTHTOKEN/NGROK_DOMAIN in .env: temporary cloudflared tunnel (address in work/tunnel.log)"
  exec cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > work/tunnel.log 2>&1
fi
