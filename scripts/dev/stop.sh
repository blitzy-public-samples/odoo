#!/usr/bin/env bash
# Stop the dev server (and its TLS proxy in --https mode), if running.
# Usage: scripts/dev/stop.sh
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

if dev_server_running || { [ -f "$TLS_PID_FILE" ] && [ -n "$(tls_proxy_pid)" ] && [ -d "/proc/$(tls_proxy_pid)" ]; }; then
    stop_dev_server
    log "dev server stopped"
else
    log "no running dev server found"
    rm -f "$ODOO_PID_FILE" "$TLS_PID_FILE"
fi
