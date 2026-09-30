#!/usr/bin/env bash
# Run the browser-based JavaScript unit tests (Hoot, headless Chrome) with
# a given preset.
#
# Usage: scripts/dev/test-js.sh desktop|mobile [module]
#
#   desktop: WebSuite.test_unit_desktop
#   mobile:  MobileWebSuite.test_unit_mobile   (375x667, touch enabled)
#
#   module defaults to 'crm' (crm's own *.test.js files, fast). Pass 'web'
#   to run the whole web suite instead - that is thousands of tests and
#   takes a long time.
#
# Command actually run (module = crm, preset = desktop):
#   ./odoo-bin -d <db> -u crm,web --test-enable \
#       --test-tags /crm:WebSuite.test_unit_desktop --stop-after-init --log-level=test
#
# Why '-u crm,web' and not '-u crm':
#   these suites are defined in addons/web/tests/test_js.py, and Odoo only
#   collects tests from modules it installed or updated during the run.
#   '-u crm' updates crm and the modules depending on crm, never web, so
#   the suite is not collected and the run reports "0 tests" with exit
#   code 0. Adding web to -u makes the suite available; the module part of
#   the --test-tags value then selects whose *.test.js files run.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

PRESET="${1:-}"
MODULE="${2:-crm}"
case "$PRESET" in
    desktop) SUITE="WebSuite.test_unit_desktop" ;;
    mobile)  SUITE="MobileWebSuite.test_unit_mobile" ;;
    *) die "usage: $0 desktop|mobile [module]" ;;
esac
case "$MODULE" in
    crm|web) ;;
    *) die "unsupported module '$MODULE' (use crm or web)" ;;
esac
TAG="/$MODULE:$SUITE"

require_venv
ensure_dirs
ensure_port_free
require_db_exists
command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 \
    || die "no Chrome/Chromium found for the JS tests; run scripts/dev/setup.sh"
python -c "import websocket" 2>/dev/null \
    || die "websocket-client is missing: browser tests would silently skip; run scripts/dev/setup.sh"

cd "$REPO_ROOT"
NAME="test-js-$PRESET-$MODULE"
log "running $MODULE JS unit tests, preset: $PRESET (tag: $TAG)"
rc=0
run_measured "$NAME" \
    ./odoo-bin -d "$ODOO_DB" -u crm,web --test-enable --test-tags "$TAG" --stop-after-init --log-level=test \
    || rc=$?

assert_tests_selected "$LOG_DIR/$NAME.log" "JS $PRESET/$MODULE"
assert_no_skips "$LOG_DIR/$NAME.log" "JS $PRESET/$MODULE"
exit "$rc"
