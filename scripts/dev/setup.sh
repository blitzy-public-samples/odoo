#!/usr/bin/env bash
# Install everything the Odoo dev environment needs on this machine:
# system packages, PostgreSQL, the Python virtualenv (.venv) and headless
# Chrome/Chromium. Safe to re-run: every step is idempotent.
#
# Usage: scripts/dev/setup.sh
set -euo pipefail

_DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_DEV_DIR/_common.sh"

log "=== Odoo dev environment setup (idempotent) ==="

if [ "$(id -u)" -eq 0 ]; then
    die "do not run setup.sh as root; it manages the current user's environment"
fi
command -v sudo >/dev/null || die "sudo is required to install system packages"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
# C libraries match the source-build requirements of requirements.txt (the
# virtualenv usually ships prebuilt wheels, these make source builds work
# too), plus fonts for headless Chrome rendering and GNU time (used by the
# other scripts to measure wall time and peak memory of test runs).
APT_PACKAGES=(
    build-essential python3-dev
    libxml2-dev libxslt1-dev libpq-dev libsasl2-dev libldap2-dev
    libjpeg-dev zlib1g-dev libfreetype6-dev libpng-dev
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji
    ca-certificates curl gnupg time socat
    postgresql postgresql-client
)
log "installing system packages with apt"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${APT_PACKAGES[@]}"

# ---------------------------------------------------------------------------
# 2. PostgreSQL cluster up + role for the current user
# ---------------------------------------------------------------------------
if ! pg_isready -q; then
    if ! sudo systemctl start postgresql 2>/dev/null; then
        for cluster in /etc/postgresql/*/*; do
            [ -d "$cluster" ] || continue
            sudo pg_ctlcluster "$(basename "$(dirname "$cluster")")" "$(basename "$cluster")" start || true
        done
    fi
    sleep 2
fi
pg_isready -q || die "PostgreSQL is not accepting connections; try: sudo systemctl start postgresql"

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" | grep -q 1; then
    sudo -u postgres createuser -s "$USER"
    log "created PostgreSQL superuser role '$USER'"
fi
sudo -u postgres psql -qc "ALTER ROLE \"$USER\" WITH LOGIN SUPERUSER CREATEROLE CREATEDB" >/dev/null
log "PostgreSQL: $(pg_isready) / role '$USER' is a superuser"

# ---------------------------------------------------------------------------
# 3. Python virtualenv + pinned dependencies
# ---------------------------------------------------------------------------
if [ ! -x "$REPO_ROOT/.venv/bin/python" ]; then
    log "creating virtualenv at $REPO_ROOT/.venv"
    python3 -m venv "$REPO_ROOT/.venv"
fi
log "installing python dependencies from requirements.txt"
"$REPO_ROOT/.venv/bin/pip" install -q -r "$REPO_ROOT/requirements.txt"

# Optional dependencies that requirements.txt does not pin but the crm
# test suite needs (Odoo's own packaging recommends them):
# - websocket-client: without it every browser test (JS unit tests, tours)
#   raises SkipTest while the run still reports success, i.e. a false
#   green. See odoo/tests/common.py:89.
# - phonenumbers: without it phone_validation silently stops formatting
#   numbers and 5 crm Python tests fail on formatting assertions.
log "installing test dependencies (websocket-client, phonenumbers)"
"$REPO_ROOT/.venv/bin/pip" install -q websocket-client phonenumbers

# ---------------------------------------------------------------------------
# 4. Headless Chrome (driven by the JS test runner through the DevTools API)
# ---------------------------------------------------------------------------
if command -v google-chrome >/dev/null 2>&1; then
    log "Chrome already installed: $(google-chrome --version)"
elif command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
    log "Chromium already installed: $(chromium --version 2>/dev/null || chromium-browser --version)"
else
    log "installing Google Chrome (headless test browser)"
    curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q /tmp/google-chrome-stable_current_amd64.deb
    rm -f /tmp/google-chrome-stable_current_amd64.deb
fi

# ---------------------------------------------------------------------------
# 5. Sanity checks + runtime dirs
# ---------------------------------------------------------------------------
ensure_dirs

psql -d postgres -tAc "SELECT version();" | head -1 | sed 's/^/PostgreSQL connection OK: /'
"$REPO_ROOT/.venv/bin/python" -c "import psycopg2, babel, lxml, reportlab, zeep; print('Python dependencies OK')" \
    || die "python dependencies failed to import; run: $REPO_ROOT/.venv/bin/pip install -r requirements.txt"
(cd "$REPO_ROOT" && ./.venv/bin/python ./odoo-bin --version) >/dev/null 2>&1 \
    || die "odoo-bin failed to start; check the venv and requirements.txt"
log "Odoo: $(cd "$REPO_ROOT" && ./.venv/bin/python ./odoo-bin --version 2>&1 | head -1)"
command -v google-chrome >/dev/null 2>&1 && log "Chrome: $(google-chrome --version)"

log "=== setup complete ==="
log "next: scripts/dev/start.sh   (creates the '$ODOO_DB' database on first run and serves Odoo on port $ODOO_PORT)"
