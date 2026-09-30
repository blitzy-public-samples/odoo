#!/usr/bin/env bash
# Forbidden-statement guard: fails if any *.test.js file of the
# web.assets_unit_tests bundle (crm's files included) contains only( or
# debug() - such a statement silently disables every other test.
#
# Usage: scripts/dev/test-guard.sh
#
# Command actually run:
#   ./odoo-bin -d <db> -u crm,web --test-enable \
#       --test-tags /web:HootSuite.test_check_suite --stop-after-init --log-level=test
#
# 'web' is in the -u list because the check lives in
# addons/web/tests/test_js.py (HootSuite.test_check_suite) and Odoo only
# collects tests from modules updated during the run; with '-u crm' alone
# the check is never collected and the run reports "0 tests" with exit
# code 0. The check itself scans the whole bundle, so crm is covered.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

require_venv
ensure_dirs
ensure_port_free
require_db_exists
cd "$REPO_ROOT"

log "running the forbidden-statement guard (only(/debug( in *.test.js)"
rc=0
run_measured "test-guard" \
    ./odoo-bin -d "$ODOO_DB" -u crm,web --test-enable --test-tags /web:HootSuite.test_check_suite --stop-after-init --log-level=test \
    || rc=$?

assert_tests_selected "$LOG_DIR/test-guard.log" "test-guard"
assert_no_skips "$LOG_DIR/test-guard.log" "test-guard"
exit "$rc"
