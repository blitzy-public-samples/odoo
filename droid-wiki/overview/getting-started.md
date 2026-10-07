# Getting started

## Prerequisites

- Python 3.11+ with `pip` and `venv`, and PostgreSQL (the setup script installs and configures both on Linux).
- A browser with service-worker support: Chrome, Edge, or Firefox. Offline features additionally require a **secure context**, meaning `localhost` or HTTPS (see below).
- Headless Chrome is installed by the setup script; the JS and tour test suites drive it.

## Setup

```bash
git clone <this repository>
cd odoo
./scripts/dev/setup.sh      # once per machine (idempotent, safe to re-run)
./scripts/dev/start.sh      # creates the crm_offline database on first run, then serves
```

Open <http://localhost:8069> and log in as `admin` / `admin`. The `crm_offline` database has crm, mail, and demo data.

The scripts and what they produce are documented in `scripts/dev/README.md`. Everything they output (logs, timings, TLS certificates) goes to the gitignored `logs/` and `var/` directories.

## Running the server

`./scripts/dev/start.sh` serves the web client at http://localhost:8069 in the foreground; Ctrl+C stops it. `./scripts/dev/stop.sh` stops a server started this way from another shell.

**Offline features need a secure context.** `http://localhost:8069` qualifies. If you open the page on any other host (a port forward, another machine), plain HTTP disables offline storage entirely and queued writes raise `NonSecureContextError`. Use:

```bash
./scripts/dev/start.sh --https
```

which terminates TLS on 8069 with a self-signed certificate in `var/tls/` (accept the browser warning once) and runs Odoo on 8070.

## Testing

| Command | What it runs |
| --- | --- |
| `./scripts/dev/test-py.sh` | all crm Python tests |
| `./scripts/dev/test-py.sh TestCrmOffline` | one test class |
| `./scripts/dev/test-js.sh desktop` | crm JS unit tests at desktop size |
| `./scripts/dev/test-js.sh mobile` | the same suite at 375x667 with touch |
| `./scripts/dev/test-guard.sh` | fails if any `.test.js` uses `only(` or `debug()` |
| `./scripts/dev/rebuild-assets.sh` | regenerate front-end asset bundles |

After **any** front-end change (js/css/scss/xml), run `rebuild-assets.sh` before testing; a failure caused by a stale asset bundle is not a real result. New JS tests must pass under both the desktop and the mobile preset.

The test wrappers exist because raw `./odoo-bin` has three silent-success modes: it runs 0 tests when the module was not installed or updated in the run, JS suites are only collected with `-u crm,web`, and browser tests skip silently when a dependency is missing. The wrappers fail on skipped tests and empty selections. The full commands they run are printed by each script and listed in `scripts/dev/README.md`.

## Trying the offline CRM by hand

1. Run `rebuild-assets.sh`, then `start.sh`, and open the CRM pipeline.
2. Visit a few views and leads while online (offline availability is built from what was visited).
3. Go offline with the browser's real network toggle.
4. Edit a lead, create one from the mobile quick create, mark one won, schedule an activity. Each write lands in the offline systray.
5. Go back online, wait for the systray queue to drain, then confirm the writes on the server, for example `psql -d crm_offline -c "SELECT id, name, stage_id FROM crm_lead ORDER BY write_date DESC LIMIT 5"`.

`.factory/skills/odoo-offline-qa/SKILL.md` is the full manual QA runbook for this, including the mobile viewport and the secure-context pitfalls.

## Resetting

`./scripts/dev/reset-db.sh` drops and recreates `crm_offline` with clean demo data.
