# Pitfalls

These are the danger zones of working on this fork, each with its symptom and its fix.
Most produce a silent wrong result rather than a loud failure, which is what makes them
expensive: a green test run that tested nothing, an offline stack that quietly disabled
itself, an error that lands in a different test than the one that caused it. Sources:
`AGENTS.md`, `addons/crm/static/src/mobile/README.md` (the "Known limits" list), the
test helpers in `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js`, and
the fix commits named in each entry.

## No secure context means no offline at all

**Symptom.** The offline stack is entirely absent: offline features don't queue,
`navigator.serviceWorker` is undefined, and queueing an ORM write throws
`NonSecureContextError`. This happens when the page is opened over plain HTTP on any
host other than `localhost`, for example through a port forward.

**Cause.** `OfflinePlugin` gates its store and crypto on `window.isSecureContext`
(`addons/web/static/src/core/offline/offline_plugin.js:53-59`): outside a secure context
it degrades to a no-op `FakeIndexedDB` ("used in non secure context to disable the
offline features as data can't be encrypted") and drops the `Crypto` instance, and
`scheduleORM()` refuses to queue (`:271-276`). The degradation is total, not partial.

**Fix.** Serve with `./scripts/dev/start.sh --https` whenever the page is not on
`localhost` (self-signed certificates in `var/tls/`; accept the warning once). See
[offline and PWA](../features/offline-and-pwa/index.md).

## Asset bundles go stale and lie about your change

**Symptom.** A js/css/scss/xml change has no visible effect, or a JS test fails for a
reason that no longer matches the source you just edited.

**Fix.** Run `./scripts/dev/rebuild-assets.sh` after every front-end change and before
any test run that follows one. `AGENTS.md` is explicit: "A test that fails only because
an asset bundle is stale is not a real result — rebuild and re-run before drawing
conclusions."

## Three ways a test run reports success while testing nothing

**Symptom.** A test command exits 0 in seconds, but nothing ran.

**Cause.** Three distinct silent-success modes: Odoo exits 0 having collected 0 tests
when the module was not installed or updated in that run; the JS suites in
`addons/web/tests/test_js.py` are only collected with `-u crm,web`; and browser tests
skip themselves (still exiting 0) when a dependency like `websocket-client` or headless
Chrome is missing.

**Fix.** Never trust a raw `./odoo-bin` exit code: run everything through
`./scripts/dev/test-py.sh` and `./scripts/dev/test-js.sh`, which parse the run log and
fail on `of 0 tests` and skipped tests (`scripts/dev/_common.sh`). Also import every
new Python test module in `addons/crm/tests/__init__.py` — an unimported module is
silently never collected. See [testing](../how-to-contribute/testing.md).

## `mockOffline()` races the mail.store fetch — use `mockCrmOffline()`

**Symptom.** An uncaught `ConnectionLostError` from `/mail/store` fails a test that
mounts no `WebClient` and asserts nothing about mail, and the failing file moves
between runs.

**Cause.** Any test that mounts a `WebClient` (directly or through mail's `start()`)
starts a debounced background `mail.store` fetch. Web's raw `mockOffline()` drops the
connection immediately; if that fetch is still in flight it rejects a tick later and
lands in whichever test happens to be running then — observed in
`crm_offline_config_list_guards.test.js`, `crm_offline_lead_list_controls.test.js`, and
`crm_offline_email_phone_force_save.test.js` across different runs (commit
`9adf1c966ec`).

**Fix.** Toggle connectivity with `mockCrmOffline()` from
`addons/crm/static/tests/mock_server/crm_offline_test_helpers.js` instead of the raw
`mockOffline()`. It settles the mail store first: `isReadyPromise`, then
`advanceTime(5)`, `animationFrame()`, and a second `advanceTime(5)` — a deterministic
timer flush that covers the 1ms debounce without fast-forwarding the framework's own
long-lived timers (the offline backoff ping, `_syncORM`'s 1s pause).

## Flush the mail.store fetch before `destroyApp()`

**Symptom.** In `crm_offline_cold_start.test.js`-style tests (mount a `WebClient`,
destroy it, mount another, go offline), an intermittent `/mail/store` assertion fails
in `crm_offline_config_list_guards.test.js` — the next file alphabetically, which never
mounts a `WebClient` itself.

**Cause.** Destroying the app does not cancel its background fetch.
`mockCrmOffline()`'s wait only reaches the *currently mounted* app's mail store, so the
first `WebClient`'s fetch was still in flight when the second test flipped the
connection offline; the late rejection surfaced wherever hoot happened to be (hoot runs
file-ordered). Diagnosed and fixed in commit `7eaae3cfa16`.

**Fix.** Call `waitForMailStoreReady()` (exported from the same helpers file) on a
`WebClient` mounted online, right before `destroyApp()`.

## `user.hasGroup` caches rejections forever

**Symptom.** A sales manager loses the "Manage Teams" entry for the rest of the page's
life after a reconnect, with no error dialog; every later probe returns the same dead
promise.

**Cause.** Web's `user.hasGroup` caches the promise per group, and `Cache.read()`
never evicts a rejection (`addons/web/static/src/core/utils/cache.js`). If the first
probe for a component rejects with `ConnectionLostError` during a brief false-online
moment, every subsequent `hasGroup("sales_team.group_sale_manager")` returns that same
rejected promise. Commit `e73c21d0720` added the recovery; commit `eb41b7fd512` first
hardened the rejection handling whose absence made it loop.

**Fix.** Already shipped in `addons/crm/static/src/components/team_switcher/team_switcher.js`:
once a `ConnectionLostError` poisons the cache, later online probes bypass
`user.hasGroup` entirely and issue a fresh, uncached `orm.silent.call("res.users",
"has_group", ...)`. The general lesson for any new code probing groups: never call
`hasGroup` unguarded from an effect that re-runs on `isOffline()` flips, and treat a
`ConnectionLostError` as a skip, not a poison.

## A brief false-online flip leaves stale offline UI

**Symptom.** After reconnecting, the offline systray badge and disabled buttons can
persist with no network traffic; or, before the fix, the page looped back to offline
repeatedly. A reload clears it.

**Cause.** `isOffline()` can briefly read `false` while the network is actually still
down — a stray successful `RPC:RESPONSE` lands ahead of a parked request's own failure.
A reactive probe that fires on the online flip then rejects with
`ConnectionLostError`, and (combined with the poisoned `hasGroup` cache above) could
re-trigger `setOffline(true)` in a loop (commit `eb41b7fd512`). The mobile README
lists the residual cosmetic case: "A brief false-online flip can leave the offline UI
showing after reconnect; reload clears it."

**Fix.** Handle the rejection in every effect that re-runs on `isOffline()` flips:
swallow `ConnectionLostError`, keep the last known value, re-probe on the next flip.
The team-switcher fix scanned every other CRM effect for the same pattern and found
none; new effects must not reintroduce it.

## Queuing a method web's systray doesn't know crashes the systray

**Symptom.** Opening the offline systray dropdown throws
(`element.status.color` of undefined) once a non-standard method is queued.

**Cause.** Web's systray only assigns `item.status` for the four methods it produces
itself (`web_save`, `web_unlink`, `action_archive`, `action_unarchive`); any other
queued method leaves `status` undefined and the dropdown template dereferences it.
The fix is deliberately CRM-side (commit `04c021aeb50`): "Work around it from crm's
side (never fixed in addons/web itself, see known limits) with
`offline_systray_patch.js`", patching `OfflineSystray.setup()` to label every method
CRM queues — `action_set_won` ("Won"), `action_restore` ("Restored"),
`action_log_call` ("Call logged"), `mail.activity` create ("Activity scheduled"),
`action_done` ("Activity done").

**Fix.** If you queue a new method through `useCrmOffline().queueCall`, add its label
to `addons/crm/static/src/webclient/offline_systray_patch.js` in the same change, or
the systray crashes the first time the entry is listed. The known limit stays open
because the root cause is in `addons/web`.

## Service-worker and manifest gotchas

**Symptom.** Two offline PWA scenarios behave in surprising ways:

- The manifest's `start_url` opens the first app, not CRM: web serves
  `'start_url': '/odoo'` (`addons/web/controllers/webmanifest.py:47`), and a full
  offline relaunch shows web's offline page. The "New Lead" shortcut shows the cached
  pipeline instead of a new-lead form while offline.
- If CRM was first opened by typing `/odoo/crm`, the CRM shortcut shows a blank page
  offline: the action is cached under the *string* key `crm`, while the app tile and
  menus cache the *numeric* action id.

**Cause.** `isAvailableOffline(actionId, ...)` keys offline availability on the action
id the view was opened with (`addons/web/static/src/core/offline/offline_plugin.js:229-238`;
`addons/web/static/src/webclient/actions/action_plugin.js:1309-1315`), while menus carry
numeric ids (`addons/web/static/src/webclient/menus/menu_providers.js:39`). Typing
`/odoo/crm` records the visit under the string `crm`, so the numeric-id lookup misses.

**Fix.** Documented avoidance, not code: open CRM from the app tile or the menu, not a
typed URL. Both quirks are entries in the mobile README's known-limits list because
the manifest and the keying live in `addons/web`, outside the fork's scope. See
[service worker and install](../features/offline-and-pwa/service-worker-and-install.md).

## Mobile-preset flakes: deterministic timers, not wall-clock waits

**Symptom.** `./scripts/dev/test-js.sh mobile` fails intermittently (1-2 runs of 3)
with no code change, always in a different file, and passes on rerun; new JS tests
must pass under both presets, so these look like real regressions.

**Cause.** Two flake classes fixed in commit `9adf1c966ec`: asserting
(`expect.verifyErrors`) right after a disk-cache `doAction` resolved, before the
declared background `ConnectionLostError`s had been logged — fixed with an extra
`animationFrame()` tick; and replacing a single real `animationFrame()` wall-clock
wait with `advanceTime(5)`, because under full-suite load one real tick is not always
enough time for a 1ms debounced timer to fire. A related chatter paste/drop timeout was
stabilized the same way (commit `f297e5e5e6c`).

**Fix.** Prefer hoot's deterministic timer control (`advanceTime`, `animationFrame`)
over real waits; never assert immediately after a promise resolves if background
declarations are still in flight; and always run both presets before reporting a
front-end result.

## Known baseline failures are not regressions

**Symptom.** Two failures appear on the untouched baseline and will reappear in your
runs: the `scroll loses target` test of the `throttleForAnimation` group
(`addons/web/static/tests/core/utils/timing.test.js`, full web JS suite), and
`TestConfig.test_settings_pls_start_date`, which fails only when the run happens
between 22:00 and 24:00 UTC (a user-timezone vs UTC date mismatch in upstream code).

**Fix.** `AGENTS.md` defines them out of scope: do not fix them, do not treat them as
regressions, and never modify, skip, or retag the timezone test to make it pass.
Report them as known baseline failures in that window and move on. See
[debugging](../how-to-contribute/debugging.md).

## Key sources

| Source | What it holds |
| --- | --- |
| `AGENTS.md` | The secure-context warning, the stale-assets rule, the silent-success modes, the baseline failures |
| `addons/crm/static/src/mobile/README.md` | The "Known limits" list most of these traps ship as, and the `mockCrmOffline()` testing guidance |
| `addons/crm/static/tests/mock_server/crm_offline_test_helpers.js` | `mockCrmOffline()` and `waitForMailStoreReady()`, with the full race documented in the doc comments |
| `addons/web/static/src/core/offline/offline_plugin.js` | The secure-context gates, the visited-action keying, the queue |
| `addons/crm/static/src/components/team_switcher/team_switcher.js` | The poisoned-cache bypass and the false-online rejection handling |
| `addons/crm/static/src/webclient/offline_systray_patch.js` | The systray label patch for CRM-queued methods |

## Related pages

- [Design decisions](design-decisions.md) for the rules these traps hang off
- [Background](index.md) for the hub
- [Debugging](../how-to-contribute/debugging.md),
  [testing](../how-to-contribute/testing.md), and
  [patterns and conventions](../how-to-contribute/patterns-and-conventions.md) for the
  workflows that catch them
- [Offline CRM](../apps/crm/offline-crm.md) for the feature surface the traps guard,
  and the mobile README's "Testing" section
  (`addons/crm/static/src/mobile/README.md`) for the manual offline QA procedure
