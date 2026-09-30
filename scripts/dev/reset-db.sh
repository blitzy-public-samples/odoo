#!/usr/bin/env bash
# Drop and recreate the dev database (crm_offline by default) in a clean
# state: crm + mail + demo data, exactly like a first run of start.sh.
#
# Usage: scripts/dev/reset-db.sh
#
# The database is recreated but the server is NOT started afterwards; run
# scripts/dev/start.sh for that. A dev server started by start.sh is stopped
# first. The database filestore (~/.local/share/Odoo/filestore/<db>) is
# removed as well so the reset is fully clean.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

require_venv
ensure_dirs
ensure_port_free   # also stops a dev server started by start.sh
cd "$REPO_ROOT"

log "dropping database '$ODOO_DB' (and its filestore)"
psql -d postgres -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$ODOO_DB' AND pid <> pg_backend_pid();"
psql -d postgres -qc "DROP DATABASE IF EXISTS \"$ODOO_DB\";"

FILESTORE="$HOME/.local/share/Odoo/filestore/$ODOO_DB"
case "$FILESTORE" in
    "$HOME"/.local/share/Odoo/filestore/*)
        [ -d "$FILESTORE" ] && rm -rf "$FILESTORE" && log "removed filestore $FILESTORE"
        ;;
    *) die "unexpected filestore path: $FILESTORE" ;;
esac

log "recreating '$ODOO_DB' with crm, mail and demo data (takes a few minutes)"
MEASURE_APPEND_LOG="$ODOO_LOG_FILE" run_measured "db-init" \
    ./odoo-bin -d "$ODOO_DB" -i crm,mail --with-demo --stop-after-init \
    || die "database initialization failed, see logs/db-init.log"

log "database '$ODOO_DB' is back to a clean state. Start the server: scripts/dev/start.sh"
