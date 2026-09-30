# shellcheck shell=bash
# Part of the Odoo dev-environment scripts. See scripts/dev/README.md.
# Shared helpers, sourced by the other scripts in scripts/dev/ — not meant to be run directly.
# (shellcheck warnings about "unused" variables below are expected: the
#  sourcing scripts use them.)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
export ODOO_DB="${ODOO_DB:-crm_offline}"
export ODOO_PORT="${ODOO_PORT:-8069}"                          # public port (HTTP, or HTTPS with start.sh --https)
export ODOO_HTTPS_BACKEND_PORT="${ODOO_HTTPS_BACKEND_PORT:-8070}"  # loopback backend port used in --https mode
export ODOO_ADMIN_LOGIN="${ODOO_ADMIN_LOGIN:-admin}"
export ODOO_ADMIN_PASSWORD="${ODOO_ADMIN_PASSWORD:-admin}"

# Point libpq at the distro PostgreSQL socket directory so that the plain
# `./odoo-bin -d <db> ...` commands need no extra database flags. (Odoo also
# documents PGHOST/PGPORT support itself, see odoo/cli/server.py.)
export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"

# ---------------------------------------------------------------------------
# Paths (derived from the location of this file: <repo>/scripts/dev/_common.sh)
# ---------------------------------------------------------------------------
_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_DEV_DIR/../.." && pwd)"

# Exported because the scripts sourcing this file use them.
export LOG_DIR="$REPO_ROOT/logs"          # gitignored runtime dir for logs, pids and measurements
export VAR_DIR="$REPO_ROOT/var"           # gitignored runtime dir (TLS certs, ...)
export ODOO_LOG_FILE="$LOG_DIR/odoo.log"  # dev server log (also keeps the init logs)
export ODOO_PID_FILE="$LOG_DIR/odoo.pid"
export TLS_PID_FILE="$LOG_DIR/tls-proxy.pid"
export TLS_DIR="$VAR_DIR/tls"
export TLS_CRT="$TLS_DIR/odoo-dev.crt"
export TLS_KEY="$TLS_DIR/odoo-dev.key"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
log() { echo "[$(date '+%F %T')] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

ensure_dirs() { mkdir -p "$LOG_DIR" "$TLS_DIR"; }

# Activate the repo virtualenv so that ./odoo-bin runs against it.
require_venv() {
    if [ ! -f "$REPO_ROOT/.venv/bin/activate" ]; then
        die "virtualenv not found at $REPO_ROOT/.venv - run scripts/dev/setup.sh first"
    fi
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.venv/bin/activate"
    export PATH="$REPO_ROOT/.venv/bin:$PATH"
}

# ---------------------------------------------------------------------------
# Dev server process management (server started by scripts/dev/start.sh)
# ---------------------------------------------------------------------------
proc_is_odoo() {
    local pid="$1"
    [ -n "$pid" ] && [ -d "/proc/$pid" ] \
        && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'odoo-bin'
}

# '|| true' matters: callers run under 'set -e' and assign these to a
# variable, where a non-zero status would abort the script.
dev_server_pid() { cat "$ODOO_PID_FILE" 2>/dev/null || true; }
tls_proxy_pid()  { cat "$TLS_PID_FILE" 2>/dev/null || true; }
dev_server_running() { proc_is_odoo "$(dev_server_pid)"; }

kill_and_wait() {
    # kill_and_wait <pid> <max_seconds>
    local pid="$1" max="$2" waited=0
    kill "$pid" 2>/dev/null || true
    while [ -d "/proc/$pid" ] && [ "$waited" -lt "$max" ]; do
        sleep 1
        waited=$((waited + 1))
    done
    if [ -d "/proc/$pid" ]; then
        log "process $pid did not exit in ${max}s, killing it"
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
    fi
}

stop_dev_server() {
    local tls_pid odoo_pid
    tls_pid="$(tls_proxy_pid)"
    if [ -n "$tls_pid" ] && [ -d "/proc/$tls_pid" ]; then
        log "stopping TLS proxy (pid $tls_pid)"
        kill_and_wait "$tls_pid" 10
    fi
    rm -f "$TLS_PID_FILE"
    odoo_pid="$(dev_server_pid)"
    if [ -n "$odoo_pid" ] && [ -d "/proc/$odoo_pid" ]; then
        log "stopping dev server (pid $odoo_pid)"
        kill_and_wait "$odoo_pid" 30
    fi
    rm -f "$ODOO_PID_FILE"
}

# Only listeners on these addresses conflict with binding 127.0.0.1:<port>:
# the sandbox may run forwarders on other local addresses (e.g. a preview
# forwarder bound to the machine's link-local ip), those coexist fine.
port_in_use() {
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "^(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\*):$1\$"
}

wait_port_free() {
    local _
    for _ in $(seq 1 20); do
        port_in_use "$1" || return 0
        sleep 0.5
    done
    return 1
}

# Test-like scripts bind port 8069 themselves: the dev server must not run.
# A server started by start.sh is stopped automatically; anything else on the
# port is left alone and reported.
ensure_port_free() {
    if dev_server_running; then
        log "stopping the dev server started by scripts/dev/start.sh (tests bind port $ODOO_PORT themselves)"
        stop_dev_server
    fi
    if port_in_use "$ODOO_PORT"; then
        die "port $ODOO_PORT is already in use by another process; stop it and retry"
    fi
    wait_port_free "$ODOO_PORT" || die "port $ODOO_PORT did not become free"
}

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
db_exists() {
    psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$ODOO_DB'" 2>/dev/null | grep -q 1
}

require_db_exists() {
    db_exists || die "database '$ODOO_DB' does not exist - run scripts/dev/start.sh (or scripts/dev/reset-db.sh) first"
}

# ---------------------------------------------------------------------------
# Result checks.
#
# Odoo exits 0 both when no test matched the tags and when a test was
# skipped (a browser test skips itself when websocket-client or Chrome is
# missing). Neither is a real result, so the scripts check the log too.
# ---------------------------------------------------------------------------
assert_tests_selected() {
    # assert_tests_selected <logfile> <label>
    if grep -qE 'of 0 tests when loading database' "$1"; then
        die "$2: no test matched the tags, 0 tests ran - see $1"
    fi
}

assert_no_skips() {
    # assert_no_skips <logfile> <label>
    if grep -qE ': skipped ' "$1"; then
        grep -E ': skipped ' "$1" | head -5
        die "$2: tests were skipped (Odoo still exits 0, so this would look green) - see $1"
    fi
}

# ---------------------------------------------------------------------------
# Measured runner: tee output to logs/<name>.log, record wall time and peak RSS
# with GNU time when available, and propagate the command's exit code.
# Set MEASURE_APPEND_LOG=<file> to also append to that file (used by start.sh
# to keep the database init logs inside logs/odoo.log).
# ---------------------------------------------------------------------------
run_measured() {
    local name="$1"; shift
    local out_log="$LOG_DIR/$name.log"
    local measure_file="$LOG_DIR/measure-$name.txt"
    local -a tee_args=(-a "$out_log")
    [ -n "${MEASURE_APPEND_LOG:-}" ] && tee_args+=(-a "$MEASURE_APPEND_LOG")

    log "running: $*"
    log "log:     $out_log"

    local start rc elapsed
    echo "[$(date '+%F %T')] command: $*" > "$out_log"
    start=$(date +%s)
    set +e
    if [ -x /usr/bin/time ]; then
        /usr/bin/time -v -o "$measure_file" "$@" 2>&1 | tee "${tee_args[@]}"
        rc=${PIPESTATUS[0]}
    else
        "$@" 2>&1 | tee "${tee_args[@]}"
        rc=${PIPESTATUS[0]}
    fi
    set -e
    elapsed=$(( $(date +%s) - start ))

    log "'$name' finished: exit code $rc, wall time ${elapsed}s"
    if [ -f "$measure_file" ]; then
        grep -E "Elapsed \(wall clock\)|Maximum resident set size" "$measure_file" | sed 's/^\t/    /' || true
    fi
    return "$rc"
}
