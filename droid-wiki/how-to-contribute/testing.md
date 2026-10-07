# Testing

The three test layers of this fork — Python, JS unit, browser tour — the `scripts/dev/` wrappers that run them, and the offline-specific conventions the suites grew. There is no CI, so every command must actually be run and its result reported; the wrappers exist because raw `./odoo-bin` has three modes that report success while testing nothing.

## The commands

| Command | What it runs |
| --- | --- |
| `./scripts/dev/test-py.sh` | All crm Python tests (whole crm suite in one run). |
| `./scripts/dev/test-py.sh TestCrmOffline` | One test class — runs all three `TestCrmOffline` classes (see below). |
| `./scripts/dev/test-js.sh desktop` | crm's `*.test.js` files under `WebSuite.test_unit_desktop` (seconds). |
| `./scripts/dev/test-js.sh mobile` | The same files under `MobileWebSuite.test_unit_mobile`: 375x667, touch enabled. |
| `./scripts/dev/test-js.sh desktop web` | The whole web JS suite instead of crm's (thousands of tests, slow; full-suite baseline). |
| `./scripts/dev/test-guard.sh` | Fails if any `.test.js` in the unit-test bundle contains `only(` or `debug(`. |

The exact `odoo-bin` invocations the wrappers run (also printed by each script):

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

Defaults are overridden with environment variables, e.g. `ODOO_DB=other_db ./scripts/dev/test-py.sh`. Test runs bind port 8069 themselves, so each test script stops a dev server started by `start.sh` first and refuses to run if something else holds the port. Rebuild assets (`./scripts/dev/rebuild-assets.sh`) after any front-end change and before re-testing; a failure caused by a stale bundle is not a real result.

## The three silent-success modes

Each of these makes a run exit 0 while testing nothing; the wrappers detect all three (see `assert_tests_selected` and `assert_no_skips` in `scripts/dev/_common.sh`):

1. **Odoo only collects tests from modules it installed or updated during the run.** `-i crm` does nothing on a database where crm is already installed — 0 tests, exit 0. `test-py.sh` uses `-i crm` only when crm is missing from the database and `-u crm --test-tags /crm` otherwise.
2. **The JS suites live in `addons/web/tests/test_js.py`.** `-u crm` updates crm and its dependents, never `web`, so the suites are never collected (0 tests, exit 0). `test-js.sh` and `test-guard.sh` use `-u crm,web`; the module part of `--test-tags` then selects whose `*.test.js` files run.
3. **Browser tests skip themselves when a dependency is missing** — `websocket-client`, `phonenumbers`, or Chrome — and a skipped test still exits 0. `setup.sh` installs both packages and Chrome; the JS scripts fail when either is absent, and every script fails on an empty selection. The JS and guard scripts also fail on any skipped test; `test-py.sh` only lists skips, because some crm Python tests skip themselves on purpose (missing optional modules).

## Python tests

Python tests live in `addons/crm/tests/test_*.py` on the shared base `TestCrmCommon` (`addons/crm/tests/common.py:49`, built on `TestSalesCommon` from sales_team and mail's `MailCase`). A module runs only if it is imported in `addons/crm/tests/__init__.py` — an unimported module is silently never collected. UI tests extend `HttpCase`, are tagged `@tagged('post_install', '-at_install')`, and drive the browser with `self.start_tour("/odoo", "tour_name", login=...)` (see `addons/crm/tests/test_crm_ui.py`).

The offline work added three modules, each defining a class named `TestCrmOffline`. `odoo`'s `--test-tags` class filter matches the class name regardless of the file, so `./scripts/dev/test-py.sh TestCrmOffline` runs all three:

| File | Base | What it proves |
| --- | --- | --- |
| `addons/crm/tests/test_crm_offline.py` | `TestCrmCommon` | The queue's verbatim-replay invariant server-side: a replayed `web_save` leaves the lead and partner exactly where an online write of the same vals would; same for `action_restore` and `action_set_won`; `mail.activity`'s `create()` derives `res_model_id` for `crm.lead` so a client-built activity create can be queued; `action_log_call` leaves a done note and no open activity. |
| `addons/crm/tests/test_crm_offline_tour.py` | `HttpCase`, `TestCrmCommon`, `@tagged('post_install', '-at_install')` | The end-to-end tour (VAL-E2E-001) at `browser_size = '375x667'` with `touch_enabled = True`, `self.start_tour("/odoo", "crm_offline_e2e_tour", login="admin", timeout=120)`, then asserts every queued write arrived on the server. |
| `addons/crm/tests/test_crm_offline_webmanifest.py` | `HttpCaseWithUserDemo` | The `/web/manifest.webmanifest` route: the "My Pipeline" and "New Lead" shortcuts appear for users who can see the CRM root menu, are absent without it and unauthenticated, resolve menu ids from XML ids at request time, and the share target stays enabled. |

The docstrings in these files are part of the evidence culture: each names the invariant, the validation codes it closes, and why the setup is shaped the way it is (e.g. why the tour deletes all leads and creates exactly one).

## JS unit tests

JS unit tests live in `addons/crm/static/tests/*.test.js` — for the offline work, 46 `crm_offline_*.test.js` files — using `test`/`expect` from `@odoo/hoot`, view helpers (`mountView`, `defineModels`, `onRpc`, ...) from `@web/../tests/web_test_helpers`, and `defineMailModels` from `@mail/../tests/mail_test_helpers` (see `addons/crm/static/tests/forecast_view.test.js` for the upstream pattern).

Shared crm fixtures:

- `addons/crm/static/tests/crm_test_helpers.js` — `defineCrmModels()`, which registers crm's mock models on top of mail's.
- `addons/crm/static/tests/crm_mock_server.js` — mock RPCs crm's own code needs, starting with `get_rainbowman_message`.
- `addons/crm/static/tests/mock_server/mock_models/` — the model mocks (`crm_lead`, ...).
- `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js` — `mockCrmOffline()` and `waitForMailStoreReady()` (below).

Every new JS test must pass under **both** presets: `./scripts/dev/test-js.sh desktop` and `./scripts/dev/test-js.sh mobile`. The mobile preset is what makes touch-dependent behavior testable at all — the hoot runner sets `browser_size = '375x667'` and `touch_enabled = True` (`addons/web/tests/test_js.py:205`), which a plain headless browser at a small viewport does not. Tests that flake only under one preset are treated as real failures and fixed, not retried (e.g. `[FIX] crm: stabilize mobile-preset flakes in crm_offline_cold_start/config_list_guards`).

## Offline test conventions

Tests that mount a `WebClient` or start the mail store — which `defineMailModels()` implies — must not toggle connectivity with the raw web `mockOffline()`. Use `mockCrmOffline()` from `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js`:

```js
import { mockCrmOffline, waitForMailStoreReady } from "@crm/../tests/mock_server/crm_offline_test_helpers";

const setOffline = mockCrmOffline();
// ...
await setOffline(true);   // waits for the mail.store fetch to settle, then goes offline
```

Why: mounting a `WebClient` starts a debounced `mail.store` `fetchStoreData()` call (1 ms debounce, real `setTimeout`). If that fetch is still in flight when the connection drops, it rejects with an uncaught `ConnectionLostError` that can surface in *any* test running at that moment — the flake that `mockCrmOffline()` eliminates by awaiting the store's `isReadyPromise` plus two `advanceTime(5)` ticks before flipping offline. The same helper exports `waitForMailStoreReady()` for the mirror problem: call it right before `destroyApp()`ing a `WebClient` mounted online, so the background fetch resolves instead of rejecting later against a different test.

The mechanics and the history of this race are on [Debugging](debugging.md).

## The forbidden-statement guard

A `only(` or `debug()` left in a `.test.js` file silently disables every other test in the run, so the guard is mandatory whenever a JS test is added or edited:

```bash
./scripts/dev/test-guard.sh
```

It runs `/web:HootSuite.test_check_suite`, which scans the whole `web.assets_unit_tests` bundle — crm's test files included — and fails the run on either statement. The guard exists as a script because the check itself lives in `addons/web/tests/test_js.py` and needs `-u crm,web` to even be collected (silent-success mode 2). Never use `only(` or `debug()` in a `.test.js` file, including temporarily.

## The end-to-end tour

`addons/crm/static/tests/tours/crm_offline_e2e_tour.js` registers `crm_offline_e2e_tour` in the `web_tour.tours` registry and walks the whole offline flow in one browser session at the mobile viewport: pipeline online, open a lead, go offline *in the page* (never by navigating away), edit the lead, create one through the mobile quick create, schedule an activity, mark the lead won, reconnect.

Offline in a tour is simulated differently from hoot: `mockOffline()` only exists inside a hoot run, so the tour stubs the transport itself — `XMLHttpRequest.prototype.send` and `window.fetch` are replaced with functions that synchronously throw `ConnectionLostError` (what a dropped connection produces in `rpc()`), and the tour fires `rpcBus.trigger("RPC:RESPONSE", ...)` directly to flip `OfflinePlugin`'s state deterministically instead of depending on the native `online`/`offline` events. An earlier async-dispatch version of this was intermittently never observed by `rpc()`'s listener in headless Chrome; the synchronous throw removed the race.

The driving `HttpCase` in `addons/crm/tests/test_crm_offline_tour.py` asserts every effect on the server after the tour finishes — the queued `web_save` replayed, the offline-created lead present, the activity scheduled, the lead won. Test tours live in `addons/crm/static/tests/tours/` and ship in the `web.assets_tests` bundle (already covered by the manifest glob `crm/static/tests/tours/**/*`). Onboarding tours are the other species: their steps live in `addons/crm/static/src/js/tours/` and ship with the backend bundle, enabled by the `crm_tour` record in `addons/crm/data/crm_tour.xml`; see [Onboarding tours](../features/onboarding-tours.md).

## Key source files

| File | Purpose |
| --- | --- |
| `scripts/dev/README.md` | The commands, the exact `odoo-bin` invocations, the silent-success modes. |
| `scripts/dev/_common.sh` | `assert_tests_selected` / `assert_no_skips` and the measured runner behind every wrapper. |
| `addons/crm/tests/common.py` | `TestCrmCommon`, the shared Python base. |
| `addons/crm/tests/test_crm_offline.py` | Queue verbatim-replay proofs (models). |
| `addons/crm/tests/test_crm_offline_tour.py` | The E2E tour's `HttpCase`. |
| `addons/crm/tests/test_crm_offline_webmanifest.py` | Manifest route proofs. |
| `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js` | `mockCrmOffline()`, `waitForMailStoreReady()`. |
| `addons/crm/static/tests/crm_test_helpers.js` | `defineCrmModels()`, which registers the crm model mocks from `mock_server/mock_models/`. |
| `addons/crm/static/tests/tours/crm_offline_e2e_tour.js` | The offline E2E tour. |

## Related pages

- [How to contribute](index.md) — what "done" means for a test run
- [Development workflow](development-workflow.md) — where testing sits in the cycle
- [Debugging](debugging.md) — the races and traps the conventions exist to prevent
- [Tooling](tooling.md) — what each wrapper script does
- [Test framework](../systems/test-framework.md) — the upstream machinery under these suites
- [Onboarding tours](../features/onboarding-tours.md) — the tour framework itself
- [Offline CRM](../apps/crm/offline-crm.md) — what the offline tests cover
- [Getting started](../overview/getting-started.md) — the quick command view
