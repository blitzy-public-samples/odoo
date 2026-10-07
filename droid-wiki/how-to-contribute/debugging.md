# Debugging

Where things go wrong in this fork and how to see them: the log files the dev scripts produce, the browser devtools that expose the offline stack, the test traps that fake a green run, and the specific failure modes the fork's history already documented — stale bundles, the secure-context requirement, the poisoned `hasGroup` cache, the `mail.store` race. Most entries below end in a server- or database-level check, because that is how offline behavior is actually proven here.

## Logs first

Every script in `scripts/dev/` writes to `logs/` (gitignored):

| File | What lands there |
| --- | --- |
| `logs/odoo.log` | Dev server output, streamed to the terminal and tee'd here; also the first-run database initialization log. |
| `logs/db-init.log` | Database creation (first `start.sh`, or `reset-db.sh`), also appended into `logs/odoo.log`. |
| `logs/<script>.log` | The last run of each script: `logs/test-py-all.log`, `logs/test-js-desktop-crm.log`, `logs/test-js-mobile-crm.log`, `logs/test-guard.log`, `logs/rebuild-assets.log`. |
| `logs/measure-<script>.txt` | Wall time and peak memory of that run, from GNU `time -v`. |

Verbosity comes from `--log-level` (default `info`; also `debug`, `debug_sql`, `debug_rpc`, `debug_rpc_answer`, `runbot`, `warn`, `error`, `critical`, `test`, `notset`). The test wrappers pass `--log-level=test`; interactive debugging usually wants `debug` (the `odoo` logger at DEBUG) or `debug_sql` (every SQL query). Per-module control is `--log-handler MODULE:LEVEL` (repeatable), with `--log-web` and `--log-sql` as shortcuts for `odoo.http` and `odoo.sql_db`. The full logging pipeline is on [Logging](../how-to-monitor/logging.md).

Server-side confirmation is part of debugging offline behavior, not an extra: after a reconnect, check the queue actually drained into PostgreSQL, e.g. `psql -d crm_offline -c "SELECT id, name, stage_id, write_date FROM crm_lead ORDER BY write_date DESC LIMIT 5"`. Connect to the local socket as the OS user; there is no password, and `-h 127.0.0.1 -U odoo` fails.

## Browser devtools for the offline stack

The offline features run in the browser, so most of the evidence is in devtools:

- **Secure context first.** `window.isSecureContext` must be `true` and `"serviceWorker" in navigator` must be `true` before anything else is worth checking. If the first is false, the framework has disabled offline entirely (next section) — no amount of queue inspection will show anything.
- **Service worker.** In devtools' Application panel, the worker is registered from `/web/service-worker.js` with scope `/odoo`. It caches `/odoo` and `/odoo/offline` at install and serves the cached homepage when a document navigation fails — that is the code path behind "reload while offline still renders the pipeline". Inspect its caches to see what a cold relaunch has available.
- **IndexedDB.** The queue lives in database `offline`, object store `orm-to-sync`; the RPC caches (`web_read_group`, `web_read`, ...) live in database `rpc`. Values are AES-GCM ciphertext keyed from `session.browser_cache_secret`, so count entries and keys, do not try to read payloads. `queueCount: 1` after one offline edit, and `0` after a successful replay, are the two numbers that matter. The store version is `session.registry_hash + CRYPTO_ALGO`, which is why an asset rebuild wipes it (below).
- **Console noise is expected offline.** `TypeError: Failed to fetch` from `LocalizationPlugin.fetchTranslations`, `odoo.reloadMenus`, and the bus worker failing to start are the correct offline code paths failing. Judge by state assertions (`navigator.onLine`, `.o_offline_systray`, `.o_disabled_offline` count), not by an empty console.

## The three silent-success traps

A green test run here is not automatically a real result. Raw `./odoo-bin` exits 0 when (1) no module was installed or updated in the run so 0 tests were collected, (2) the JS suites were never collected because `-u` lacked `web`, and (3) browser tests skipped themselves on a missing dependency (`websocket-client`, `phonenumbers`, Chrome). The `scripts/dev/` wrappers close all three via `assert_tests_selected` and `assert_no_skips` in `scripts/dev/_common.sh` — every script fails on an empty selection, and the JS and guard scripts also fail on skips (`test-py.sh` only lists them, since some crm Python tests skip on purpose). Full detail on [Testing](testing.md). Symptom to watch for: a run that finishes suspiciously fast, or a log line containing `of 0 tests when loading database`.

## Stale asset bundles

An asset change takes effect only after the bundles are regenerated — a module upgrade or a restart with regenerated assets. Symptom: a front-end change that "did nothing", or a test failing on behavior you just rewrote. Not a real result until:

```bash
./scripts/dev/rebuild-assets.sh   # stops the dev server first (it caches assets in memory)
./scripts/dev/start.sh           # restart it
```

Two follow-on effects to expect rather than misread:

- The rebuild stops a running dev server, because it would keep serving the stale in-memory bundles.
- The offline store's version is `session.registry_hash + CRYPTO_ALGO`, so after a rebuild the `offline` IndexedDB is wiped. Queued writes and cached views are gone until you re-visit them online; a cache miss right after a rebuild is expected, not a bug.

## `NonSecureContextError` and the secure context

Offline storage needs a secure context: HTTPS or `localhost`. Outside one, the framework degrades *entirely*, not partially — `FakeIndexedDB` instead of the real store, no `Crypto` — and queuing an ORM call throws `NonSecureContextError` (`addons/web/static/src/core/errors/non_secure_context_error.js`). The error message to chase is therefore a symptom, not the bug: the bug is the origin.

- `./scripts/dev/start.sh` serves `http://localhost:8069`, which browsers treat as a secure context — the normal case.
- Any other host (a port forward, another machine) needs `./scripts/dev/start.sh --https`: TLS on 8069 with a self-signed cert in `var/tls/`, Odoo itself on loopback 8070. Accept the browser's certificate warning once.

Confirm with `window.isSecureContext` before trusting any offline behavior.

## The poisoned `hasGroup` cache

`user.hasGroup` is backed by a client `Cache` that never evicts a rejected promise. If the first-ever probe for a group lands during a brief false-online moment and rejects with `ConnectionLostError`, every later `hasGroup` call for that group returns that same rejected promise for the rest of the page's life — a genuine reconnect never issues a new RPC through it. This bit the team switcher (`addons/crm/static/src/components/team_switcher/team_switcher.js`): a sales manager who first mounted the switcher offline (or during a flip) stayed without "Manage Teams" forever, even after reconnecting.

The fix pattern, worth copying for any cached probe that can fail offline:

- Do not issue the probe while `isOffline()` is true; treat it as `false`.
- On a `ConnectionLostError` from the probe, set a `hasGroupCachePoisoned` flag and re-probe through `orm.silent.call("res.users", "has_group", ...)` — a plain RPC that bypasses `user.js`'s group cache entirely.
- Re-probe reactively when `isOffline()` flips back to `false` (an `effect()` on the signal), rather than just once at mount time.

Related trap in the same component: `isOffline()` can briefly read `false` while the network is actually still down (a stray successful response landing ahead of a parked request's failure). A `ConnectionLostError` from a probe issued "while online" is treated the same as an offline skip, not a bug — but it is also what poisons the cache entry in the first place. Commits: `[FIX] crm: harden team switcher's hasGroup re-probe against a brief online flip` and `[FIX] crm: bypass user.hasGroup's poisoned cache on team-switcher reconnect`.

One more reconnect symptom, cosmetic and in `addons/web`: after an offline save the Save/Discard indicator can stay visible, and a brief false-online flip can leave the offline UI showing after reconnect; a reload clears both.

## The `mail.store` race

Mounting a `WebClient` starts a debounced `mail.store` fetch (1 ms debounce, real `setTimeout`, batched with whatever else wants store data). If it is still in flight when the connection drops — or when the app is destroyed — it rejects with an uncaught `ConnectionLostError` that can surface in whichever test happens to be running when the rejection lands. This produced suite-wide flakes attributed to unrelated tests.

The rule, enforced by convention in the offline suites:

- Toggle connectivity with `mockCrmOffline()` from `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js`, not raw `mockOffline()`. It awaits the store's `isReadyPromise`, then `advanceTime(5)` twice around an `animationFrame()` — a fixed 5 ms timer budget that deterministically covers the 1 ms debounce without fast-forwarding the framework's own longer-lived timers (the offline backoff ping, the 1 s pause between replayed calls).
- Call `waitForMailStoreReady()` before `destroyApp()`ing a `WebClient` mounted online. Destroying the app does not cancel its background fetch; left unflushed, it rejects later against a different test.

## Known baseline failures

Two failures exist before this fork's changes and are out of scope. Do not fix them, do not treat them as regressions, and never modify, skip, or retag their tests:

- The full web JS suite (`./scripts/dev/test-js.sh desktop web`) fails in the `scroll loses target` test of the `throttleForAnimation` group, `addons/web/static/tests/core/utils/timing.test.js`, on the untouched baseline. It is in `addons/web`; leave it alone.
- `TestConfig.test_settings_pls_start_date` fails **only** when the run happens between 22:00 and 24:00 UTC (a user-timezone vs UTC date mismatch in upstream code). Inside that window it is a known baseline failure; outside the window it is a real failure. Don't wait for the window to pass.

## The manual QA runbook

When a change touches offline, sync-queue, service-worker, PWA, or small-screen behavior, the browser-level runbook is `.factory/skills/odoo-offline-qa/SKILL.md`. It covers the mobile viewport (375x667) and the touch caveat, going offline with the browser's real network toggle (not a mocked flag), the never-visited-view fallback, proving queued writes reached PostgreSQL, and what console noise to expect. Its two non-negotiables mirror this page: rebuild assets first, and confirm `window.isSecureContext` before trusting any result.

## Key source files

| File | Purpose |
| --- | --- |
| `scripts/dev/_common.sh` | Log paths, the `assert_tests_selected` / `assert_no_skips` guards. |
| `addons/web/static/src/core/errors/non_secure_context_error.js` | The error a non-secure-context queue attempt throws. |
| `addons/crm/static/src/components/team_switcher/team_switcher.js` | The poisoned-cache fix pattern. |
| `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js` | `mockCrmOffline()` / `waitForMailStoreReady()` and the race's full history in comments. |
| `.factory/skills/odoo-offline-qa/SKILL.md` | The manual offline QA runbook. |
| `AGENTS.md` | The known baseline failures, verbatim. |

## Related pages

- [Logging](../how-to-monitor/logging.md) — the server logging pipeline behind `--log-level`
- [Testing](testing.md) — the suites and the silent-success traps in full
- [Tooling](tooling.md) — the scripts that produce the logs
- [Offline CRM](../apps/crm/offline-crm.md) and [Mobile CRM](../apps/crm/mobile-crm.md) — the behavior being debugged
- [Getting started](../overview/getting-started.md) — the quick command view
