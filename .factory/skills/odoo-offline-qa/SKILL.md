---
name: odoo-offline-qa
description: >-
  How to validate the offline and PWA behaviour of this fork in a real
  browser: the mobile viewport, the secure-context requirement, rebuilding
  assets first, going offline and back online, and confirming on the server
  that queued writes actually arrived. Use when testing or reviewing
  offline, sync-queue, service-worker, PWA, or small-screen changes in
  addons/crm.
---

# Offline QA for this fork

This skill is the browser-side companion to the dev scripts in `scripts/dev/`.
It covers the behaviour that only shows up in a real browser: service worker
caching, the offline sync queue, and the offline UI state. It does not replace
the test suites — see [Still run the suites](#still-run-the-suites).

## What you are validating

`addons/web` owns the offline stack; `addons/crm` only consumes it. A change is
offline-correct when, in a secure context, all of the following hold. Prove each
one; do not infer it from the code.

| Claim | How to check it |
| --- | --- |
| Offline is detected | `navigator.onLine` flips and `.o_offline_systray` appears |
| The offline UI locks controls | buttons lacking `data-available-offline` get `disabled` + `o_disabled_offline` |
| A visited view renders from cache | reload while offline still renders the pipeline (cards, columns) |
| A write queues while offline | one entry appears in IndexedDB `offline` / `orm-to-sync` |
| The queue replays on reconnection | the entry disappears and the row changed in PostgreSQL |
| Mobile behaviour does not touch desktop | the same checks pass at the desktop viewport |

## Preconditions

**1. Secure context, or offline is silently disabled.** Offline features only
run over HTTPS or on `localhost`. Outside a secure context the framework swaps
in a no-op `FakeIndexedDB` and throws `NonSecureContextError` when a call is
queued — there is no partial offline mode.

- `./scripts/dev/start.sh` serves `http://localhost:8069`, which browsers treat
  as a secure context. This is the normal choice.
- Use `./scripts/dev/start.sh --https` when the page is opened on any host other
  than `localhost` (port forwards, another machine). TLS is on 8069 with a
  self-signed cert; accept the browser warning once, or launch the browser with
  `--ignore-https-errors`.

Confirm it before trusting any result:

```js
window.isSecureContext        // must be true
"serviceWorker" in navigator  // must be true
```

**2. Rebuild assets before testing any front-end change.** An asset change only
takes effect after the bundles are regenerated, and `rebuild-assets.sh` stops a
running dev server because it caches assets in memory.

```bash
./scripts/dev/rebuild-assets.sh   # stops the server, regenerates bundles
./scripts/dev/start.sh            # start it again
```

A failure that comes only from a stale bundle is not a real result.

**3. Install dependencies once per machine.** `./scripts/dev/setup.sh` is
idempotent. Without it, browser tests skip themselves and still exit 0.

**4. The dev server and the test scripts cannot share port 8069.** Each
`scripts/dev/test-*.sh` stops a server started by `start.sh` first. Stop your
browser session's server before running a test script, and vice versa.

## The mobile viewport

The mobile preset is **375x667 with touch enabled** — the same preset
`./scripts/dev/test-js.sh mobile` uses.

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix offline-qa)"
agent-browser set device "iPhone 15"      # mobile UA + device emulation
agent-browser set viewport 375 667         # exact preset size, overrides 393x852
```

Set `device` first, then `viewport`: the device sets a mobile user agent, the
viewport pins the exact size. Verify before logging in:

```js
[window.innerWidth, window.innerHeight]  // [375, 667]
window.matchMedia("(max-width: 575px)").matches  // true => UIPlugin isSmall()
```

At 375 px the width lands in `SIZES.XS`, so `isSmall()` is true and every
consumer of the small-screen signal (`usePlugin(UIPlugin).isSmall()`) takes its
mobile branch. That is the signal that matters for behaviour; see
[Limits](#limits) about the touch part.

Check the desktop path too. Mobile behaviour must be gated on the signal, and
desktop behaviour must not change:

```bash
agent-browser set viewport 1920 1080
agent-browser reload
```

## The verification loop

Log in once and keep the session; the browser stays up across commands.

```bash
agent-browser open "http://localhost:8069/web/login"
agent-browser snapshot -i                       # find the Email/Password refs
agent-browser fill @e3 "admin"
agent-browser fill @e10 "admin"
agent-browser click @e5                         # Log in
agent-browser open "http://localhost:8069/odoo/crm"
```

`/odoo/crm` is the CRM pipeline, and it is the view this fork's offline work
targets. Wait for it to render, then confirm you have a real baseline — an
empty pipeline proves nothing:

```js
JSON.stringify({
  url: location.href,
  title: document.title,                      // "Pipeline"
  cards: document.querySelectorAll(".o_kanban_record").length,
  columns: document.querySelectorAll(".o_kanban_group").length,
})
```

Refs (`@eN`) go stale on every re-render. Re-run `agent-browser snapshot -i`
after anything changes the page.

## Going offline and back online

`set offline` drives `Network.emulateNetworkConditions` over CDP, so the page
gets a genuine `offline` event and every request fails. This is the real code
path, not a stubbed one.

```bash
agent-browser set offline on
```

Odoo's offline state is then observable in three places. Check all three:

```js
JSON.stringify({
  navOnline: navigator.onLine,                            // false
  offlineSystray: !!document.querySelector(".o_offline_systray"),   // true
  systrayIcon: document.querySelector(".o_offline_systray i")?.dataset.icon, // "link_off"
  disabledOffline: document.querySelectorAll(".o_disabled_offline").length,  // > 0
})
```

- `navigator.onLine === false` — the browser event the framework listens for.
- `.o_offline_systray` — the navbar entry, an `<i data-icon="link_off">` with
  `aria-label="Working offline"`. Its text is empty; assert on the icon, not on
  inner text.
- `.o_disabled_offline` — the count of controls the framework disabled. The
  offline pass disables every `<button>` that lacks `data-available-offline`,
  so a New button that is *not* disabled means it was tagged, and one that *is*
  disabled means it was not.

Take a screenshot for the record, and always read the console — offline errors
are expected, but they tell you which code paths ran:

```bash
agent-browser screenshot logs/offline-spike/offline.png
agent-browser console
```

Expected and harmless while offline: `TypeError: Failed to fetch` from
`LocalizationPlugin.fetchTranslations`, `odoo.reloadMenus`, and the bus worker
failing to start (`BusService: Real-time notifications disabled`). Offline is
exactly when those are supposed to fail.

### Reloading while offline

This is the cache test: the service worker serves the document it cached, and
the views re-render from the IndexedDB `rpc` cache.

```bash
agent-browser reload
```

Assert the pipeline still renders rather than trusting the title alone:

```js
JSON.stringify({
  title: document.title,                                  // "Pipeline"
  navOnline: navigator.onLine,                            // still false
  offlineSystray: !!document.querySelector(".o_offline_systray"),   // still true
  cards: document.querySelectorAll(".o_kanban_record").length,      // > 0
})
```

### The never-visited-view fallback

When the view arch is available but the **data** was never cached, the
controller renders `OfflineActionHelper` instead of an empty view or an error.
It is driven by `couldNotLoadRootOffline`
(`addons/web/static/src/model/relational_model/relational_model.js`), which the
model sets when the root load throws `ConnectionLostError`. The helper is
rendered by both the list and the kanban controller.

It has no class of its own — it reuses `.o_view_nocontent` — so match it on its
text:

```js
document.body.innerText.includes("There is no data to display offline")
```

To reach it deliberately, visit the pipeline online, drop the cached **data**,
then go offline and reload. Clearing only the data stores is what makes this a
never-visited view *for data* while leaving the view arch and the action
available:

```bash
# 1. Visit the pipeline online first, so its view arch is cached.
agent-browser open "http://localhost:8069/odoo/crm"
# ... wait for the cards ...

# 2. Drop the cached data (web_read_group / web_read), keep everything else.
cat <<'EOF' | agent-browser eval --stdin
(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("rpc");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const cleared = [];
  for (const s of ["web_read_group", "web_read"]) {
    if (!db.objectStoreNames.contains(s)) continue;
    await new Promise((res, rej) => {
      const r = db.transaction(s, "readwrite").objectStore(s).clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    cleared.push(s);
  }
  db.close();
  return "cleared " + cleared.join(", ");
})()
EOF

# 3. Go offline and reload.
agent-browser set offline on
agent-browser reload
```

Assert the helper replaced the cards:

```js
JSON.stringify({
  navOnline: navigator.onLine,                                   // false
  cards: document.querySelectorAll(".o_kanban_record").length,   // 0
  helper: document.body.innerText.includes("There is no data to display offline"),
})
```

Two variants, both valid:

- **`visited-ui-items` intact and a kanban search recorded** — the helper also
  shows a **Reset Filters** button (`.o_view_nocontent button`) that re-applies
  the cached search. Clicking it does not bring the data back, so the helper
  stays while the data is still uncached.
- **`visited-ui-items` empty** — `getAvailableSearches` returns `[]` and the
  button is absent; only the text renders.

What not to do:

- **Do not clear the whole `offline` database**, and do not rely on a registry
  change, to force this state. The view arch (`get_views`) and the action
  (`/web/action/load`) live in the `rpc` database; wiping everything removes the
  arch too, so the action fails before the controller renders and you get an
  error instead of the helper.
- **Clearing `visited-ui-items` alone is not enough.** That only removes offline
  availability: controls come back disabled, but the view still renders from the
  data cache. It is a different fallback.

Afterwards, go back online and reload the pipeline. The data caches repopulate on
the next successful load, and any other view you want available offline again
needs a fresh online visit.

Reconnecting is the mirror image:

```bash
agent-browser set offline off
```

Assert `navigator.onLine === true`, `.o_offline_systray` gone, and
`.o_disabled_offline` back to 0.

## Queued writes, and proving they reached the server

A reload proves reads are cached. A queued write is the part that can silently
break, so test it explicitly.

**1. Produce a write while offline.** On the crm kanban, click a priority radio
(`Medium`/`High`/`Very High` on a card). That is a card edit, so it goes through
`dynamic_list.js` into the queue. Clicking a card *link* to open its form does
nothing while offline when that record was not cached — that is the framework's
availability guard, not a bug.

**2. Confirm it is queued.** The queue lives in IndexedDB database `offline`,
store `orm-to-sync`. Values are AES-GCM ciphertext, so count entries rather
than reading them:

```js
(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("offline");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const keys = await new Promise((res, rej) => {
    const r = db.transaction("orm-to-sync").objectStore("orm-to-sync").getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return JSON.stringify({ queueCount: keys.length, keys });
})()
```

A key is the caller's `options.id` (so repeated saves of one record overwrite
one entry) or a hash of the payload. `queueCount: 1` after one edit is the
expected result.

**3. Record the server-side baseline before reconnecting.** Replay is
timestamp-ordered and last-write-wins with no conflict detection, so the only
honest check is the row's value afterwards.

```bash
psql -d crm_offline -c \
  "select id, name, priority, write_date from crm_lead order by id limit 12;"
```

Connect to the local socket as the OS user; there is no password, and
`-h 127.0.0.1 -U odoo` will fail with `fe_sendauth: no password supplied`.

**4. Go back online and let it replay.** `_syncORM()` runs on reconnection and
pauses 1 second between calls, so allow ~10 seconds before concluding anything.

```bash
agent-browser set offline off
sleep 12
```

**5. Confirm the queue drained and the row changed.** Both halves are required:
an empty queue plus an unchanged row means the write was dropped.

```bash
# browser side: queueCount must be 0
psql -d crm_offline -c "select id, name, priority, write_date from crm_lead where id = <id>;"
```

`write_date` must be newer than your baseline. In the UI the card's priority
radio must move to the value you clicked.

**6. Leave the database as you found it.** Revert the test write through the UI
(click the original priority back), not with `UPDATE`, so the ORM cache stays
consistent. Say in your report which records you touched.

### When a write does not arrive

Failed replays are not deleted. They stay in the same queue with `extras.error`
set, excluded from replay until the user acts, and the systray shows a danger
"Sync issues" badge. So a non-empty queue after reconnection is a real finding,
not a timing artifact — check the systray and the entry's `extras.error` before
re-testing.

## Limits

### agent-browser does not emulate touch

`set device "iPhone 15"` applies a mobile user agent and device metrics, but it
does **not** turn on touch: `navigator.maxTouchPoints` stays `0` and
`window.ontouchstart` stays `undefined`, so Odoo's `hasTouch()` is false.

```js
// addons/web/static/src/core/browser/feature_detection.js
hasTouch() === (window.ontouchstart !== undefined || matchMedia("(pointer:coarse)").matches)
```

Width still drives `UIPlugin.isSmall()`, so anything gated on the small-screen
signal alone is testable at 375x667. Anything gated on touch is not. The bottom
sheet is gated on **both** — `useBottomSheet()` is `ui.isSmall && hasTouch()`
(`addons/web/static/src/core/datetime/datetimepicker_service.js`) — as are the
selection, many2many-tags and badges bottom sheets, the dropdown `bottomSheet`
prop, and the `o_touch_device` body class.

**Do not report a missing bottom sheet in the browser as a failure.** In an
agent-browser session at 375x667 the date picker opens as a **popover**, not a
bottom sheet. That is the correct pointer-device behaviour, not a bug.

**Verify touch-dependent behaviour with the mobile JS unit tests instead.** The
mobile preset is `browser_size = "375x667"` with `touch_enabled = True`
(`addons/web/tests/test_js.py`, `MobileWebSuite`), so touch is genuinely on
there:

```bash
./scripts/dev/test-js.sh mobile        # crm's own tests (fast)
./scripts/dev/test-js.sh mobile web    # web's tests: thousands, slow
```

The bottom-sheet coverage lives in web, for example the `test.tags("mobile")`
test "toggle datepicker on mobile" in
`addons/web/static/tests/views/fields/date_field.test.js`, which asserts
`.o_datetime_picker` opens and then closes via `.o_bottom_sheet_backdrop`. Run
the `web` variant when a change touches touch-dependent behaviour.

#### Optional: emulating touch over raw CDP

Touch can be switched on through the CDP endpoint that `agent-browser get
cdp-url` exposes, but only inside a script that drives the page over CDP for the
**whole** flow. The moment agent-browser issues a command it re-applies its own
device metrics, resetting `maxTouchPoints` to `0` and the viewport to its
default — the two cannot be mixed. The sequence that works:

```bash
agent-browser get cdp-url                       # ws://127.0.0.1:<port>/devtools/browser/<id>
curl -s "http://127.0.0.1:<port>/json/list"     # the page target's webSocketDebuggerUrl
```

```
Emulation.setTouchEmulationEnabled { enabled: true, maxTouchPoints: 5 }
Emulation.setDeviceMetricsOverride { width: 375, height: 667,
    deviceScaleFactor: 1, mobile: true, screenWidth: 375, screenHeight: 667 }
Page.navigate <url>
Runtime.evaluate  ...   # interact via JS; do not use agent-browser clicks
```

With that, `window.ontouchstart !== undefined`, `(pointer:coarse)` matches, and
clicking the **Expected Closing** date field on a lead form opens
`.o_bottom_sheet.o_bottom_sheet_ready` instead of a popover. Node 22+ has a
global `WebSocket`, so no package is needed. Treat this as a fallback: the
mobile JS suite is the supported way to check touch behaviour.

### Other limits

- **Console noise is expected offline.** Judge by the state assertions above,
  not by an empty console.
- **`set offline` blocks the network, not the service worker.** That is the
  point: it exercises the real cache. It is not a substitute for testing a cold
  cache (unregister the worker) if the change touches install-time caching.
- **IndexedDB values are encrypted**, keyed from `session.browser_cache_secret`.
  You can count and key entries; you cannot inspect payloads without the
  framework's own `Crypto`.
- **The database is wiped when the asset registry hash changes.** After
  `rebuild-assets.sh` the offline store is empty, so re-visit the views online
  before testing offline. A cache miss right after a rebuild is expected.
- **`start.sh` serves one database.** Use `ODOO_DB=...` to point elsewhere, and
  `./scripts/dev/reset-db.sh` if the state is polluted.

## Still run the suites

Browser checks do not replace the repo's tests, and there is no CI here — every
command you run must be reported, including the ones you skipped and why.

```bash
./scripts/dev/test-py.sh TestCrmOffline    # crm offline Python tests
./scripts/dev/test-js.sh desktop           # crm JS unit tests
./scripts/dev/test-js.sh mobile            # the same suite, mobile preset
./scripts/dev/test-guard.sh                # no only()/debug() in .test.js
```

New JS tests must pass under **both** presets. Remember the runner's three
silent-success modes: 0 collected tests, JS suites not collected without
`-u crm,web`, and browser tests skipping when a dependency is missing. The
`scripts/dev/` wrappers guard against all three, so use them rather than raw
`./odoo-bin` invocations.

Failures listed under "Known baseline failures" in `AGENTS.md` are out of scope:
do not fix them and do not report them as regressions.
