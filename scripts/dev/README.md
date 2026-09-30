# Odoo dev environment (`scripts/dev`)

Reproducible local setup for this branch: PostgreSQL, the Python
virtualenv, headless Chrome, a `crm_offline` database with **crm**, **mail**
and **demo data**, and one script per task.

All scripts live in `scripts/dev/` and are run from the repository root.
Everything they produce (logs, measurements, TLS certificates) lands in the
gitignored `logs/` and `var/` directories.

## Quick start

```bash
./scripts/dev/setup.sh      # once per machine (idempotent, safe to re-run)
./scripts/dev/start.sh      # creates crm_offline on first run, then serves it
```

Open <http://localhost:8069> and log in with `admin` / `admin`.

## The commands

| Command | What it does |
| --- | --- |
| `./scripts/dev/setup.sh` | system packages, PostgreSQL, `.venv`, headless Chrome |
| `./scripts/dev/start.sh` | serve Odoo on <http://localhost:8069> (foreground, Ctrl+C stops it) |
| `./scripts/dev/start.sh --https` | same, but TLS on port 8069 (self-signed) with Odoo on 8070 |
| `./scripts/dev/stop.sh` | stop a server started by `start.sh` |
| `./scripts/dev/test-py.sh` | all crm Python tests |
| `./scripts/dev/test-py.sh TestCrmOffline` | only that test class |
| `./scripts/dev/test-js.sh desktop` | crm JS unit tests, desktop preset |
| `./scripts/dev/test-js.sh mobile` | crm JS unit tests, mobile preset (375x667, touch) |
| `./scripts/dev/test-js.sh desktop web` | the whole web JS suite instead of crm's (slow) |
| `./scripts/dev/test-guard.sh` | fail if any `.test.js` uses `only(` or `debug()` |
| `./scripts/dev/rebuild-assets.sh` | regenerate front-end asset bundles |
| `./scripts/dev/reset-db.sh` | drop and recreate `crm_offline` clean |

Defaults can be overridden with environment variables, e.g.
`ODOO_DB=other_db ./scripts/dev/test-py.sh`.

## Secure context (offline features)

Offline features need a secure context, otherwise the framework disables
them. `start.sh` serves on **`http://localhost:8069`**, which browsers treat
as a secure context, so service workers are available. Verified in the
browser on the CRM pipeline page:

```js
window.isSecureContext            // true
"serviceWorker" in navigator      // true
```

Use `start.sh --https` when the page is *not* opened on `localhost` (for
example through a port forward under another hostname), where a plain
`http://` origin would not be a secure context. It terminates TLS on port
8069 with a self-signed certificate generated in `var/tls/` and proxies to
Odoo on 8070; browsers show a certificate warning you have to accept once.
Unlike the default mode, the TLS port accepts connections from any
interface.

## Logs and measurements

- `logs/odoo.log` — dev server log (also streamed to the terminal), plus the
  database initialization logs.
- `logs/<script>.log` — output of the last run of each script, for example
  `logs/test-py-all.log`, `logs/test-js-desktop-crm.log`, `logs/test-guard.log`.
- `logs/measure-<script>.txt` — wall time and peak memory of that run
  (GNU `time -v`).

## Front-end changes

A test that fails only because an asset bundle is stale is not a real
result. After **any** front-end change (js/css/scss/xml) and before
re-testing:

```bash
./scripts/dev/rebuild-assets.sh
./scripts/dev/test-js.sh desktop
```

## Notes on the test commands

The scripts wrap `./odoo-bin` and print the exact command they run. Three
behaviours of the test runner are worth knowing, because each of them makes
a run report success while testing nothing:

1. **Odoo only collects tests from modules it installed or updated during
   the run.** `-i crm` does nothing on a database where crm is already
   installed, so it runs 0 tests and still exits 0. `test-py.sh` therefore
   uses `-i crm` only when crm is missing from the database and
   `-u crm --test-tags /crm` otherwise; both run the whole crm suite.

2. **The JS suites live in `addons/web/tests/test_js.py`.** `-u crm` updates
   crm and the modules that depend on crm, never `web`, so with `-u crm`
   alone the suites are never collected (0 tests, exit 0). `test-js.sh` and
   `test-guard.sh` use `-u crm,web`. The module part of `--test-tags` then
   selects whose `*.test.js` files run: `/crm:WebSuite.test_unit_desktop`
   runs crm's own tests (the default, seconds), `/web:...` runs the whole
   web suite (thousands of tests, much slower).

3. **Browser tests skip themselves when a dependency is missing** — for
   example `websocket-client` or Chrome — and a skipped test still exits 0.
   `setup.sh` installs `websocket-client` (and `phonenumbers`, without which
   5 crm Python tests fail), and the test scripts fail when the log shows a
   skipped test or an empty selection.

The commands the scripts run, in full:

```bash
# all crm Python tests (crm already installed / not installed)
./odoo-bin -d crm_offline -u crm --test-enable --test-tags /crm --stop-after-init --log-level=test
./odoo-bin -d crm_offline -i crm --test-enable --test-tags /crm --stop-after-init --log-level=test

# one crm Python test class
./odoo-bin -d crm_offline -u crm --test-enable --test-tags /crm:TestCrmOffline --stop-after-init --log-level=test

# crm JS unit tests, desktop and mobile presets
./odoo-bin -d crm_offline -u crm,web --test-enable --test-tags /crm:WebSuite.test_unit_desktop --stop-after-init --log-level=test
./odoo-bin -d crm_offline -u crm,web --test-enable --test-tags /crm:MobileWebSuite.test_unit_mobile --stop-after-init --log-level=test

# forbidden-statement guard
./odoo-bin -d crm_offline -u crm,web --test-enable --test-tags /web:HootSuite.test_check_suite --stop-after-init --log-level=test
```

## Ports

Test runs bind port 8069 themselves, so they cannot share it with the dev
server. Each test script stops a server started by `start.sh` first and
refuses to run if something else holds the port.
