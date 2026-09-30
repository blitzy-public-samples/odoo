#!/usr/bin/env bash
# Run the crm Python tests against the dev database ($ODOO_DB, default
# crm_offline).
#
# Usage:
#   scripts/dev/test-py.sh            all crm Python tests:
#     ./odoo-bin -d <db> -i crm --test-enable --test-tags /crm --stop-after-init --log-level=test
#
#   scripts/dev/test-py.sh <class>    one test class, e.g. scripts/dev/test-py.sh TestCrmOffline:
#     ./odoo-bin -d <db> -u crm --test-enable --test-tags /crm:<class> --stop-after-init --log-level=test
#
# Notes:
# - a dev server started by start.sh is stopped first (test runs bind the
#   same port themselves);
# - Odoo only runs a module's tests when that module is installed or
#   updated during the run. '-i crm' therefore does nothing on a database
#   where crm is already installed (0 tests, exit code 0). Since
#   crm_offline has crm installed by design, 'all' mode uses '-i crm' only
#   when crm is still missing, and the equivalent '-u crm --test-tags /crm'
#   otherwise. Both run the whole crm Python suite; the command actually
#   used is printed and logged.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

require_venv
ensure_dirs
ensure_port_free
require_db_exists
cd "$REPO_ROOT"

crm_installed() {
    psql -d "$ODOO_DB" -tAc \
        "SELECT 1 FROM ir_module_module WHERE name='crm' AND state='installed'" 2>/dev/null | grep -q 1
}

rc=0
if [ $# -eq 0 ]; then
    NAME="test-py-all"
    if crm_installed; then
        log "running ALL crm Python tests (-u crm: crm is already installed in '$ODOO_DB',"
        log "so '-i crm' would install nothing and run 0 tests)"
        run_measured "$NAME" \
            ./odoo-bin -d "$ODOO_DB" -u crm --test-enable --test-tags /crm --stop-after-init --log-level=test \
            || rc=$?
    else
        log "running ALL crm Python tests (-i crm: installing crm into '$ODOO_DB')"
        run_measured "$NAME" \
            ./odoo-bin -d "$ODOO_DB" -i crm --test-enable --test-tags /crm --stop-after-init --log-level=test \
            || rc=$?
    fi
else
    CLASS="$1"
    NAME="test-py-$CLASS"
    log "running crm Python test class '$CLASS' (-u crm)"
    run_measured "$NAME" \
        ./odoo-bin -d "$ODOO_DB" -u crm --test-enable --test-tags "/crm:$CLASS" --stop-after-init --log-level=test \
        || rc=$?
fi

assert_tests_selected "$LOG_DIR/$NAME.log" "test-py"
# Skips are not fatal here: some crm Python tests skip themselves on
# purpose (missing optional modules). They are listed for visibility.
if grep -qE ': skipped ' "$LOG_DIR/$NAME.log"; then
    log "note: some tests were skipped:"
    grep -E ': skipped ' "$LOG_DIR/$NAME.log" | head -10
fi
exit "$rc"
