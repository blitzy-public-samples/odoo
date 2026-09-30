# Tooling

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

## Purpose

The tools that wrap this fork's development: the `scripts/dev/` wrappers that encode the dev database, the module-update flags, and the guards against a false-green test run; the `skills/` rule packs that state Odoo's house rules; ruff for Python linting; and the packaging tree, which exists but is not part of fork work. The absence of CI is a fact of this repository and shapes all of it.

## scripts/dev

| Script | What it does | What it guards |
| --- | --- | --- |
| `scripts/dev/setup.sh` | Idempotent per-machine setup: apt packages, PostgreSQL cluster and a superuser role for the current user, `.venv` from `requirements.txt` plus `websocket-client` and `phonenumbers`, headless Chrome, then import and `odoo-bin --version` sanity checks. Refuses to run as root. | Missing `websocket-client` would make every browser test skip silently; missing `phonenumbers` fails 5 crm Python tests. |
| `scripts/dev/start.sh [--https]` | Serves the dev database in the foreground, creating it first if absent (`-i crm,mail --with-demo`). Default: `http://localhost:8069`. `--https`: self-signed TLS on 8069 and Odoo on 8070, accepting connections from any interface. | Refuses to start if a server is already running or port 8069 is held; waits for `/web/login` to answer 200 before reporting success. |
| `scripts/dev/stop.sh` | Stops a server started by `start.sh`, including the TLS proxy. | Leaves a server it did not start alone. |
| `scripts/dev/test-py.sh [Class]` | All crm Python tests, or one class. | `assert_tests_selected`: fails on `of 0 tests when loading database`. Prints a note listing Python skips instead of failing, because some crm tests skip by design. |
| `scripts/dev/test-js.sh desktop\|mobile [crm\|web]` | Hoot unit tests under the chosen preset, `crm` by default. | Requires Chrome and `websocket-client`; `assert_tests_selected` plus `assert_no_skips`. |
| `scripts/dev/test-guard.sh` | Runs `HootSuite.test_check_suite` over the whole unit-test bundle. | Same two assertions; fails on any `only(` or `debug(` in a `.test.js`. |
| `scripts/dev/rebuild-assets.sh` | Deletes generated asset attachments and regenerates the bundles through `odoo-bin shell`. | Stops a running dev server first, since it caches assets in memory. |
| `scripts/dev/reset-db.sh` | Drops the database and its filestore, recreates it with crm, mail, and demo data. | Stops the dev server and refuses to proceed while port 8069 is held. |
| `scripts/dev/_common.sh` | Sourced by all of the above; not meant to be run directly. Holds the config, PID helpers, port and database guards, `run_measured`, `assert_tests_selected`, `assert_no_skips`. | Both result guards live here. |

Environment overrides, all in `scripts/dev/_common.sh`: `ODOO_DB` (`crm_offline`), `ODOO_PORT` (`8069`), `ODOO_HTTPS_BACKEND_PORT` (`8070`), `ODOO_ADMIN_LOGIN` and `ODOO_ADMIN_PASSWORD` (`admin`), `PGHOST` (`/var/run/postgresql`), `PGPORT` (`5432`). So `ODOO_DB=other_db ./scripts/dev/test-py.sh` points a whole suite at another database, and `ODOO_PORT` is what the port guards check.

Outputs go to `logs/` (per-script logs, `odoo.log`, `measure-*.txt`) and `var/tls/` (certificates), both gitignored. Read them with [Logging](../how-to-monitor/logging.md) and [Debugging](debugging.md).

## Rule packs in skills/

`skills/` holds four packs written for agents working on Odoo code. They overlap with `AGENTS.md` but are more detailed, and `skills/README.md` notes that they must be installed together because they reference each other.

| Pack | Path | Covers |
| --- | --- | --- |
| Odoo addon guidelines | `skills/odoo-guidelines/SKILL.md` plus `skills/odoo-guidelines/guidelines/` | Every file in an addon outside `static/`: module structure and file naming, manifest, Python imports and model layout, translatable literals, recordsets/domains/context, computes and onchange, extension points, transactions, fields, controllers, views and data records, view inheritance anchored on names, QWeb PDF reports, access rights, batch ORM calls and performance, tests, ASCII punctuation, and changes on a stable branch. |
| Odoo web guidelines | `skills/odoo-web-guidelines/SKILL.md` plus `skills/odoo-web-guidelines/guidelines/` | Anything under an addon's `static/src/` and `static/tests/`: organizing files by feature, avoiding getters, avoiding patching, SCSS, and assets. `static/lib/` is out of scope. |
| Review | `skills/odoo-review/SKILL.md` | A two-pass review: map every changed file to the guideline sections that apply, then judge the change on its merits. It dispatches to the other three packs. |
| Security | `skills/odoo-security/SKILL.md` | An audit sweep over the framework-specific failure modes: over-sudo, raw SQL and parameterization, domain injection, public methods, route auth and CSRF, XSS through `Markup`/`markup()`/`innerHTML`, field-level access on password and `related=` fields, `file_open`, and `eval`/`safe_eval`. |

The fork adds one skill of its own outside `skills/`: `.factory/skills/odoo-offline-qa/SKILL.md`, the browser QA procedure for offline behavior, covered on [Testing](testing.md).

These packs are guidelines, not enforcement. Nothing runs them automatically; the only automated check of this kind is the `only(` / `debug(` guard.

## Ruff

`ruff.toml` at the repo root configures Python linting. It is marked "automatically generated file by the runbot nightly ruff checks, do not modify", targets `py312`, assumes ruff 0.16.1 or newer, and enables a wide rule set (BLE, C, COM, E, EM, EXE, F, FA, FLY, G, I, ICN, INT, ISC, LOG, PGH, PIE, PLC, PLE, PLW, PYI, RET, RUF, SIM, SLOT, T, TC, TID, TRY, UP, W, YTT) with `E501` line length, `C901` complexity, and several style rules ignored. Import ordering is Odoo's documented order, with `odoo` as first party and `odoo.addons` as local folder.

Two practical notes: ruff is not in `requirements.txt`, and `setup.sh` does not install it, so it is not in `.venv` by default. Install it yourself (`pip install ruff`) if you want to lint before finishing; the config says the upstream runbot runs it nightly, and this repository has no equivalent.

## No CI

`.github/` contains only `ISSUE_TEMPLATE/` and `PULL_REQUEST_TEMPLATE.md`; there is no `workflows/` directory and no other CI configuration. Consequences:

- Every test command must be run by a person and its result reported, including the runs that were skipped and why.
- The `scripts/dev/` guards are the only automated protection against a run that tested nothing.
- Ruff, the `only(` / `debug(` guard, and the asset rebuild are all manual steps, driven by the definition of done on [How to contribute](index.md).

## Packaging and maintenance commands

The packaging tree is upstream Odoo's and is untouched by fork work:

- `setup.py` builds the `odoo` package for PyPI, taking version and metadata from `odoo/release.py`, using `find_namespace_packages` and installing `setup/odoo` as a script.
- `debian/` holds the Debian packaging: `control`, `rules`, `init`, `odoo.service`, `logrotate`, and the maintainer scripts.
- `setup/` holds the other distribution targets: `docker/`, `rpm/`, `win32/`, `sandboxing/`, `package.py`, `requirements-check.py`, and `odoo-wsgi.example.py`.
- `requirements.txt` pins the Python dependencies; fork rules forbid changing it.

For the server's own administrative commands (`server`, `shell`, `db`, `module`, `i18n`, `cloc`, `neutralize`, `obfuscate`, `duplicate`, `scaffold`, `deploy`, `start`, `upgrade_code`), see [CLI and maintenance](../systems/cli-and-maintenance.md). For how the packaged tree is deployed, see [Deployment](../deployment.md). In this fork the only commands needed day to day are the `scripts/dev/` wrappers plus `odoo-bin shell --no-http` for asset regeneration.

## Entry points for modification

Add a new wrapper under `scripts/dev/` rather than changing an existing one, and source `_common.sh` for configuration and the result guards. Change `_common.sh` itself only to add shared configuration or a new guard, then call it from the scripts that need it. Do not add a second way to run the tests: the guards only work if every run goes through the wrappers, and `scripts/dev/README.md` documents the commands they run in full.

## Key source files

| File | Purpose |
| --- | --- |
| `scripts/dev/README.md` | The wrapper inventory and the notes on the test runner's false-green modes. |
| `scripts/dev/_common.sh` | Configuration, PID and port helpers, `run_measured`, and the result assertions. |
| `scripts/dev/setup.sh` | One-shot machine setup, including the two test dependencies. |
| `scripts/dev/start.sh` | Dev server, `--https` mode, database creation on first run. |
| `scripts/dev/test-py.sh` | Python suite wrapper and the `-i crm` versus `-u crm` decision. |
| `scripts/dev/test-js.sh` | Desktop and mobile Hoot presets with `-u crm,web`. |
| `scripts/dev/test-guard.sh` | The `only(` / `debug(` check. |
| `scripts/dev/rebuild-assets.sh` | Bundle regeneration through `odoo-bin shell`. |
| `scripts/dev/reset-db.sh` | Clean database and filestore recreation. |
| `skills/README.md` | What the rule packs are and how they are installed. |
| `skills/odoo-guidelines/SKILL.md` | Index of the addon guideline sections. |
| `skills/odoo-web-guidelines/SKILL.md` | Index of the JavaScript, Owl, and SCSS guideline sections. |
| `skills/odoo-review/SKILL.md` | The two-pass review process. |
| `skills/odoo-security/SKILL.md` | The security audit sweep. |
| `.factory/skills/odoo-offline-qa/SKILL.md` | The fork's browser QA procedure for offline behavior. |
| `ruff.toml` | Ruff configuration, target `py312`, generated by the upstream runbot checks. |
| `requirements.txt` | Pinned Python dependencies, unchanged by fork rules. |
| `setup.py` | PyPI packaging entry point. |
| `debian/`, `setup/` | Distribution packaging trees, upstream and untouched. |
| `CONTRIBUTING.md` | Upstream contribution pointers. |

## Related pages

- [Development workflow](development-workflow.md)
- [Testing](testing.md)
- [Debugging](debugging.md)
- [How to contribute](index.md)
- [Getting started](../overview/getting-started.md)
- [CLI and maintenance](../systems/cli-and-maintenance.md)
- [Test framework](../systems/test-framework.md)
- [Logging](../how-to-monitor/logging.md)
