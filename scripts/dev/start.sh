#!/usr/bin/env bash
# One command to run the Odoo dev server.
#
# Usage: scripts/dev/start.sh [--https]
#
# - serves Odoo on port 8069 bound to localhost (http://localhost:8069),
#   which browsers treat as a secure context, so offline features such as
#   service workers are enabled;
# - --https additionally terminates TLS on port 8069 (self-signed dev
#   certificate; browsers will show a warning that you have to accept) and
#   runs Odoo itself on the loopback-only port 8070. Use this when the page
#   is not opened on localhost (e.g. through a port forward with a
#   different hostname), where a plain http origin would NOT be a secure
#   context.
#
# The server runs in the foreground; Ctrl+C stops it. All logs are written
# to logs/odoo.log AND to the terminal.
#
# On first run (or after reset-db.sh was interrupted) the database below is
# created with crm, mail and demo data.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

MODE=local
case "${1:-}" in
    "") MODE=local ;;
    --https) MODE=https ;;
    *) die "usage: $0 [--https]" ;;
esac

require_venv
ensure_dirs

if dev_server_running; then
    die "the dev server is already running (pid $(dev_server_pid)); stop it with scripts/dev/stop.sh first"
fi
if port_in_use "$ODOO_PORT"; then
    die "port $ODOO_PORT is already in use by another process"
fi

# ---------------------------------------------------------------------------
# Create the database if it is missing: crm + mail + demo data.
# (mail is a dependency of crm, it is listed explicitly on purpose.)
# ---------------------------------------------------------------------------
if ! db_exists; then
    log "database '$ODOO_DB' not found - creating it with crm, mail and demo data (takes a few minutes)"
    MEASURE_APPEND_LOG="$ODOO_LOG_FILE" run_measured "db-init" \
        ./odoo-bin -d "$ODOO_DB" -i crm,mail --with-demo --stop-after-init \
        || die "database initialization failed, see logs/db-init.log"
    db_exists || die "database '$ODOO_DB' was not created"
    log "database '$ODOO_DB' created"
fi

# ---------------------------------------------------------------------------
# From here on, everything this script prints (and everything the server
# logs) goes to logs/odoo.log as well as to the terminal.
# ---------------------------------------------------------------------------
exec > >(tee -a "$ODOO_LOG_FILE") 2>&1

BACKEND_PORT="$ODOO_PORT"                 # local mode: Odoo directly on 8069
PUBLIC_SCHEME="http"
[ "$MODE" = "https" ] && { BACKEND_PORT="$ODOO_HTTPS_BACKEND_PORT"; PUBLIC_SCHEME="https"; }

ensure_tls_certificate() {
    [ -f "$TLS_CRT" ] && [ -f "$TLS_KEY" ] && return 0
    log "generating a self-signed dev certificate in $TLS_DIR (browsers will warn about it)"
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -keyout "$TLS_KEY" -out "$TLS_CRT" \
        -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
        || die "could not generate the self-signed certificate"
}

cleanup() {
    rc=$?
    trap - EXIT INT TERM
    local tls_pid odoo_pid
    tls_pid="$(tls_proxy_pid)"
    if [ -n "$tls_pid" ] && [ -d "/proc/$tls_pid" ]; then
        log "stopping TLS proxy (pid $tls_pid)"
        kill_and_wait "$tls_pid" 10
    fi
    rm -f "$TLS_PID_FILE"
    odoo_pid="$(dev_server_pid)"
    if [ -n "$odoo_pid" ] && [ -d "/proc/$odoo_pid" ]; then
        log "stopping Odoo (pid $odoo_pid)"
        kill_and_wait "$odoo_pid" 30
    fi
    rm -f "$ODOO_PID_FILE"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

log "=== starting Odoo ($MODE mode, db: $ODOO_DB) ==="
cd "$REPO_ROOT"

if [ "$MODE" = "https" ]; then
    ensure_tls_certificate
    ./odoo-bin -d "$ODOO_DB" --http-interface=127.0.0.1 --http-port="$BACKEND_PORT" &
else
    ./odoo-bin -d "$ODOO_DB" --http-interface=127.0.0.1 --http-port="$BACKEND_PORT" &
fi
ODOO_PID=$!
echo "$ODOO_PID" > "$ODOO_PID_FILE"
log "Odoo pid $ODOO_PID (backend http://127.0.0.1:$BACKEND_PORT)"

if [ "$MODE" = "https" ]; then
    socat \
        OPENSSL-LISTEN:"$ODOO_PORT",fork,reuseaddr,verify=0,cert="$TLS_CRT",key="$TLS_KEY" \
        TCP:127.0.0.1:"$BACKEND_PORT" &
    TLS_PID=$!
    echo "$TLS_PID" > "$TLS_PID_FILE"
    sleep 1
    kill -0 "$TLS_PID" 2>/dev/null \
        || die "the TLS proxy failed to start on port $ODOO_PORT (see $ODOO_LOG_FILE)"
    log "TLS proxy pid $TLS_PID (https://localhost:$ODOO_PORT -> 127.0.0.1:$BACKEND_PORT)"
fi

# Wait for the web client to answer.
log "waiting for Odoo on port $ODOO_PORT ..."
READY=0
for _ in $(seq 1 240); do
    if [ "$MODE" = "https" ]; then
        code=$(curl -sk -o /dev/null -w '%{http_code}' "$PUBLIC_SCHEME://127.0.0.1:$ODOO_PORT/web/login" || true)
    else
        code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_SCHEME://127.0.0.1:$ODOO_PORT/web/login" || true)
    fi
    if [ "$code" = "200" ]; then READY=1; break; fi
    kill -0 "$ODOO_PID" 2>/dev/null || break
    sleep 1
done
if [ "$READY" != "1" ]; then
    log "Odoo did not answer on port $ODOO_PORT in time; last http code: ${code:-none}. See $ODOO_LOG_FILE"
    exit 1
fi

log "=== Odoo is up: $PUBLIC_SCHEME://localhost:$ODOO_PORT (login: $ODOO_ADMIN_LOGIN / $ODOO_ADMIN_PASSWORD) ==="
log "logs: $ODOO_LOG_FILE (Ctrl+C to stop)"

wait "$ODOO_PID" || log "Odoo exited with a non-zero status; see $ODOO_LOG_FILE"
