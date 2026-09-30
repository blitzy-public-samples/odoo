#!/usr/bin/env bash
# Regenerate the front-end asset bundles of the dev database.
#
# Usage: scripts/dev/rebuild-assets.sh
#
# Run this after any front-end change (js/css/scss/xml) and before
# re-running tests: a test that fails only because an asset bundle is
# stale is not a real result. It deletes every generated asset attachment
# and rebuilds (pregenerates) the bundles in the database.
#
# A dev server started by start.sh is stopped first: it caches assets in
# memory and would keep serving stale ones. Restart it afterwards.
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

require_venv
ensure_dirs
if dev_server_running; then
    log "stopping the dev server first (it caches assets in memory and would keep serving them stale)"
    stop_dev_server
fi
require_db_exists
cd "$REPO_ROOT"

log "regenerating asset bundles for '$ODOO_DB' (deleting generated attachments + pregenerating bundles)"
set +e
./odoo-bin shell -d "$ODOO_DB" --no-http 2>&1 <<'PY' | tee -a "$LOG_DIR/rebuild-assets.log"
env['ir.attachment'].regenerate_assets_bundles()
env['ir.qweb']._pregenerate_assets_bundles()
env.cr.commit()
print("asset bundles regenerated")
PY
rc=${PIPESTATUS[0]}
set -e
[ "$rc" -eq 0 ] || die "asset regeneration failed, see $LOG_DIR/rebuild-assets.log"
log "done. If you had the dev server running, restart it: scripts/dev/start.sh"
