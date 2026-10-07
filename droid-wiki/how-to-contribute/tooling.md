# Tooling

The dev toolchain of this fork: the `scripts/dev/` wrappers and what each one runs underneath, the shared harness that guards against false-green test runs, the TLS and asset machinery behind `--https` and `rebuild-assets.sh`, and the two agent-side tools — the offline QA skill and the `droid` CLI this wiki was generated with.

## `scripts/dev/` at a glance

All scripts run from the repository root, source `scripts/dev/_common.sh`, and print the exact command they execute. Everything they produce lands in the gitignored `logs/` and `var/` directories.

| Script | What it wraps |
| --- | --- |
| `scripts/dev/setup.sh` | System packages, PostgreSQL, the `.venv`, headless Chrome, and the test-only Python deps. Idempotent; safe to re-run. |
| `scripts/dev/start.sh` | Serves Odoo on <http://localhost:8069>, foreground, Ctrl+C stops it. Creates `crm_offline` (crm, mail, demo data) on first run. |
| `scripts/dev/start.sh --https` | Same, with TLS on 8069 and Odoo on loopback 8070, for hosts other than `localhost`. |
| `scripts/dev/stop.sh` | Stops a server started by `start.sh`, including its TLS proxy. |
| `scripts/dev/test-py.sh` | `./odoo-bin -d crm_offline -u crm --test-enable --test-tags /crm --stop-after-init --log-level=test` (all crm Python tests), or the `-i crm` variant when crm is not installed yet. A class argument narrows to `--test-tags /crm:<class>`. |
| `scripts/dev/test-js.sh desktop\|mobile [module]` | `./odoo-bin -d crm_offline -u crm,web --test-enable --test-tags /<module>:WebSuite.test_unit_desktop ...` (or `MobileWebSuite.test_unit_mobile`). Module defaults to `crm`; pass `web` for the whole web suite. |
| `scripts/dev/test-guard.sh` | `./odoo-bin -d crm_offline -u crm,web --test-enable --test-tags /web:HootSuite.test_check_suite ...` — the forbidden-statement check. |
| `scripts/dev/rebuild-assets.sh` | An `odoo-bin shell` run that deletes every generated asset attachment and pregenerates the bundles (below). |
| `scripts/dev/reset-db.sh` | Drops and recreates `crm_offline` clean, including its filestore. |

Defaults are environment-overridable: `ODOO_DB`, `ODOO_PORT`, `ODOO_HTTPS_BACKEND_PORT`, `ODOO_ADMIN_LOGIN`, `ODOO_ADMIN_PASSWORD` (all set in `scripts/dev/_common.sh`).

## The shared harness: `scripts/dev/_common.sh`

`_common.sh` is why the wrappers are more than aliases. It holds:

- **Configuration**: `ODOO_DB=crm_offline`, `ODOO_PORT=8069`, `ODOO_HTTPS_BACKEND_PORT=8070`, admin credentials `admin`/`admin`, and `PGHOST=/var/run/postgresql` so plain `odoo-bin` commands need no database flags. Paths: `LOG_DIR=logs`, `VAR_DIR=var`, `TLS_DIR=var/tls`, log/pid files under `logs/`.
- **The result guards.** `assert_tests_selected` fails the run if the log shows `of 0 tests when loading database` (nothing matched the tags); `assert_no_skips` fails it on any `: skipped ` line, because Odoo exits 0 on both. These close the test runner's three silent-success modes (see [Testing](testing.md)).
- **The measured runner.** `run_measured` tees each command's output to `logs/<name>.log` and, when GNU `time` is installed (setup.sh installs it), records wall time and peak RSS in `logs/measure-<name>.txt`.
- **Port discipline.** Test runs bind port 8069 themselves, so `ensure_port_free` stops a dev server started by `start.sh` first — via the pid files in `logs/` — and the script refuses to run if some other process holds the port.

## `setup.sh` — one-time machine preparation

What it installs, and why each piece matters:

- apt packages: the C libraries matching `requirements.txt` source builds, fonts for headless Chrome rendering, GNU `time`, `socat` (the TLS proxy), PostgreSQL.
- A running PostgreSQL cluster and a superuser role for the current user.
- `.venv` from `requirements.txt`, then `websocket-client` and `phonenumbers` on top: without `websocket-client` every browser test raises `SkipTest` while the run still reports success, and without `phonenumbers` five crm Python tests fail on phone-formatting assertions. Both are deliberate additions to the venv, not to `requirements.txt`, which the fork does not touch.
- Google Chrome, the headless browser the JS suites and tours drive through the DevTools API.

It refuses to run as root and checks its own results at the end (Python imports, `odoo-bin --version`, Chrome version).

## `start.sh` and `start.sh --https`

`start.sh` serves `http://localhost:8069` — browsers treat `localhost` as a secure context, which is what keeps offline features alive in the plain-HTTP dev case. It creates the database on first run (`-i crm,mail --with-demo`), tees everything to `logs/odoo.log` *and* the terminal, and waits for `/web/login` to answer before reporting success.

`start.sh --https` exists for the one case plain HTTP breaks: opening the page on a host other than `localhost` (a port forward, another machine), where a plain `http://` origin is not a secure context and offline storage is disabled. It:

- generates a self-signed certificate in `var/tls/` (`odoo-dev.crt`, `odoo-dev.key`, CN=localhost, valid ~10 years; browsers warn once, accept it once),
- runs Odoo itself on loopback `127.0.0.1:8070`,
- and terminates TLS on port 8069 with a `socat OPENSSL-LISTEN` proxy — unlike local mode, the TLS port accepts connections from any interface.

Both modes write pid files (`logs/odoo.pid`, `logs/tls-proxy.pid`) that `stop.sh` uses, so `stop.sh` cleanly ends the server and the proxy.

## `rebuild-assets.sh` and bundle staleness

Odoo compiles the front end into asset bundles stored as `ir.attachment` records, not committed build files (the full pipeline is on [Assets](../systems/assets.md)). `scripts/dev/rebuild-assets.sh` regenerates them in the dev database:

```python
env['ir.attachment'].regenerate_assets_bundles()   # delete generated attachments
env['ir.qweb']._pregenerate_assets_bundles()      # rebuild every referenced bundle
env.cr.commit()
```

Run it after every front-end change (js/css/scss/xml) and before any test run that follows. It stops a running dev server first — the server caches bundles in memory and would keep serving stale ones — and logs to `logs/rebuild-assets.log`. One knock-on effect to expect: the browser's offline store is versioned on `session.registry_hash + CRYPTO_ALGO`, so a rebuild changes the registry hash and wipes the `offline` IndexedDB — re-visit views online before testing offline again.

## `reset-db.sh`

When database state is polluted: `scripts/dev/reset-db.sh` terminates the database connections, drops `crm_offline`, removes its filestore (`~/.local/share/Odoo/filestore/crm_offline`), and recreates it with `-i crm,mail --with-demo` — exactly the state a first `start.sh` produces. It does not start the server afterwards. Initialization logs land in `logs/db-init.log` (and are appended to `logs/odoo.log`), with timings in `logs/measure-db-init.txt`.

## The forbidden-statement guard

`scripts/dev/test-guard.sh` exists because one `only(` or `debug()` in a `.test.js` file silently disables every other test in that run. It runs `/web:HootSuite.test_check_suite`, which scans the entire `web.assets_unit_tests` bundle — crm's test files included, since the manifest's globs put them there. Run it whenever a JS test is added or edited. The `-u crm,web` in its invocation is load-bearing: the check lives in `addons/web/tests/test_js.py`, and without `web` in the update list it is never collected.

## The QA skill: `.factory/skills/odoo-offline-qa/`

The agent-facing runbook for validating offline and PWA behavior in a real browser: the 375x667 mobile viewport, the secure-context preconditions, going offline with a genuine network toggle, inspecting the `orm-to-sync` queue, proving replayed writes landed in PostgreSQL, and the touch-emulation limits of browser automation. It is the browser-side complement to the suites — the suites prove logic, the skill's loop proves the parts only a real browser shows (service worker caching, the offline UI lock, queue draining). [Debugging](debugging.md) covers when to reach for it.

## The `droid` CLI

This wiki (`droid-wiki/`) was generated with `droid`, Factory's AI coding agent CLI (`/usr/local/bin/droid`). The commands that matter around this repository:

```bash
droid                 # interactive session in the current directory
droid exec "<prompt>" # non-interactive run, for scripts and automation
droid resume           # pick up a previous session
droid search <query>   # search across local session history
droid doctor           # diagnose configuration and connectivity
```

Agent skills live in `.factory/skills/` (the offline QA skill above is one); the repository-level rule packs for agents live in `skills/` at the repo root. `droid update` refreshes the CLI itself.

## Key source files

| File | Purpose |
| --- | --- |
| `scripts/dev/README.md` | The canonical command documentation and the exact `odoo-bin` invocations. |
| `scripts/dev/_common.sh` | Configuration, the result guards, the measured runner, port discipline. |
| `scripts/dev/setup.sh` | Machine preparation, including the two test-only Python dependencies. |
| `scripts/dev/start.sh` | The dev server, the `--https` TLS proxy, first-run database creation. |
| `scripts/dev/rebuild-assets.sh` | Bundle regeneration (`regenerate_assets_bundles` + `_pregenerate_assets_bundles`). |
| `addons/crm/__manifest__.py` | The asset declarations the bundles are built from. |
| `.factory/skills/odoo-offline-qa/SKILL.md` | The manual offline QA runbook. |

## Related pages

- [How to contribute](index.md) — where the toolchain sits in the workflow
- [Testing](testing.md) — what the test scripts guard against
- [Debugging](debugging.md) — the log files and failure modes this tooling exposes
- [Assets](../systems/assets.md) — the server-side bundle pipeline `rebuild-assets.sh` drives
- [Getting started](../overview/getting-started.md) — setup and the quick command view
