# Getting started

The dev environment lives in `scripts/dev/` and is fully scripted. Run everything from the repository root. The dev database is `crm_offline` (crm, mail, demo data); log in as `admin` / `admin` at `http://localhost:8069`.

## Prerequisites

- Python 3.12–3.14 and PostgreSQL 16+ (the versions supported by `odoo/release.py`).
- Headless Chrome for JS/browser tests: installed by the setup script.
- Linux; the setup script uses apt. It refuses to run as root.
- No node/npm anywhere: JavaScript has no build step. Vendored libraries live in each addon's `static/lib/` and assets are compiled by the server itself.

## First run

```bash
./scripts/dev/setup.sh      # once per machine (idempotent, safe to re-run)
./scripts/dev/start.sh      # creates crm_offline on first run, serves on :8069
```

Open `http://localhost:8069`, log in with `admin` / `admin`. `start.sh` runs in the foreground; Ctrl+C stops it. `./scripts/dev/stop.sh` stops a server started this way, including the TLS proxy.

`setup.sh` installs system packages, sets up PostgreSQL (cluster plus a superuser role for your user), creates `.venv` from `requirements.txt` **plus** `websocket-client` and `phonenumbers`. Their absence makes tests skip or fail silently, which is exactly what the environment is built to prevent. It also installs headless Chrome and runs import sanity checks.

## Secure context (offline features)

Offline features only work in a secure context (HTTPS, or plain HTTP on `localhost`). Outside one, the framework disables offline entirely: no storage, and any attempt to queue an ORM call throws `NonSecureContextError`. Verified in the browser:

```js
window.isSecureContext            // true
"serviceWorker" in navigator      // true
```

Use `./scripts/dev/start.sh --https` whenever the page is opened on any host other than `localhost` (port forwards, other machines). It terminates TLS on port 8069 with a self-signed certificate from `var/tls/` and proxies to Odoo on 8070, accepting connections from any interface. Browsers show a certificate warning you accept once.

## Running the tests

| Command | What it runs |
| --- | --- |
| `./scripts/dev/test-py.sh` | all crm Python tests (pass a class name to narrow, e.g. `TestCRMLead`) |
| `./scripts/dev/test-js.sh desktop` | crm JS unit tests, desktop preset |
| `./scripts/dev/test-js.sh mobile` | same suite at 375x667 with touch (new JS tests must pass both presets) |
| `./scripts/dev/test-guard.sh` | fails if any `.test.js` contains `only(` or `debug(` |
| `./scripts/dev/rebuild-assets.sh` | regenerate front-end bundles (run after every js/css/scss/xml change, before re-testing) |
| `./scripts/dev/reset-db.sh` | drop and recreate `crm_offline` clean |

Defaults can be overridden with environment variables, e.g. `ODOO_DB=other_db ./scripts/dev/test-py.sh`.

The scripts wrap `./odoo-bin` and print the exact command they run. They exist because the raw test runner has three false-green modes (zero collected tests still exit 0; JS suites are only collected with `-u crm,web`; browser tests skip silently on missing dependencies). The wrappers fail on empty selections and skipped tests. Details in [testing](../how-to-contribute/testing.md).

## Where things land

- `logs/`: dev server log (`odoo.log`), per-script output (`test-py-all.log`, `test-js-desktop-crm.log`, ...), wall-time and peak-memory measurements (`measure-*.txt`).
- `var/tls/`: self-signed certificates for `--https`.
- Both are gitignored runtime output; nothing else in the repo should write to them.

## Manual offline checking

To try the offline behavior by hand: log in, browse the CRM pipeline (visiting a view online is what makes it available offline), switch the browser to offline (DevTools network tab or cut the connection), edit and save a lead. The entry appears in the offline systray with a Created/Edited/Deleted label. Go back online and watch the replay: entries leave the systray one by one, with a spinner while syncing. The `odoo-offline-qa` skill in this environment documents the full browser walkthrough.

## Next steps

- Read [architecture](architecture.md) for how the pieces fit together.
- Read [development workflow](../how-to-contribute/development-workflow.md) before making changes.
- The [CRM app](../apps/crm/index.md) pages describe where fork development actually happens.
