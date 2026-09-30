# AGENTS.md

Guidance for agents working in this fork. The fork must stay rebasable onto
upstream 20.0; work happens in `addons/crm` on top of the offline/PWA
framework that `addons/web` already provides.

## 1. Commands

The dev environment lives in `scripts/dev/` (see `scripts/dev/README.md`).
Run everything from the repository root. The dev database is `crm_offline`
(crm, mail, demo data); log in as `admin` / `admin`. Script output and
timings land in `logs/` (`logs/test-py-all.log`, `logs/test-js-desktop-crm.log`, ...).

| Command | When to use it |
| --- | --- |
| `./scripts/dev/setup.sh` | Once per machine (idempotent). PostgreSQL, `.venv`, headless Chrome, and the Python test deps (`websocket-client`, `phonenumbers`) whose absence makes tests skip or fail silently. |
| `./scripts/dev/start.sh` | Serve on http://localhost:8069 for manual checking. Foreground; Ctrl+C stops it. Creates `crm_offline` on first run. |
| `./scripts/dev/start.sh --https` | When the page is opened on any host other than `localhost` (port forwards, other machines): TLS on 8069 (self-signed certs in `var/tls/`, accept the warning once), Odoo on 8070, accepts connections from any interface. This is what makes offline features work off-localhost. |
| `./scripts/dev/stop.sh` | Stop a server started by `start.sh`. Test scripts do this themselves first, and refuse to run if something else holds port 8069. |
| `./scripts/dev/test-py.sh` | All crm Python tests. Pass a class name to narrow it, e.g. `./scripts/dev/test-py.sh TestCrmOffline`. |
| `./scripts/dev/test-js.sh desktop` | crm JS unit tests, desktop preset. The default check after any front-end change. |
| `./scripts/dev/test-js.sh mobile` | Same suite under the mobile preset (375x667, touch). New JS tests must pass under **both** presets. |
| `./scripts/dev/test-js.sh desktop web` | The whole web JS suite instead of crm's (thousands of tests, slow). Use it when you need a full-suite baseline. |
| `./scripts/dev/test-guard.sh` | Fails if any `.test.js` contains `only(` or `debug()`. Run it whenever you add or edit a JS test. |
| `./scripts/dev/rebuild-assets.sh` | Regenerate the front-end asset bundles. Run after every front-end change (js/css/scss/xml) and before any test run. |
| `./scripts/dev/reset-db.sh` | Drop and recreate `crm_offline` clean, when the database state is polluted. |

Defaults can be overridden with environment variables, e.g. `ODOO_DB=other_db ./scripts/dev/test-py.sh`.

**Offline needs a secure context.** Offline features work only over HTTPS or on
`localhost`. Outside a secure context the framework disables offline entirely
(no-op storage, `NonSecureContextError` when ORM calls are queued — see
section 2). Use `start.sh --https` whenever the page is not on `localhost`.

**Assets go stale.** An asset change only takes effect after a module upgrade
or a restart with regenerated assets. Run `./scripts/dev/rebuild-assets.sh`
before any test run that follows a front-end change. A test that fails only
because an asset bundle is stale is not a real result — rebuild and re-run
before drawing conclusions.

**There is no CI in this repository.** Every test command must actually be run
and its result reported, including the ones you skip and why. The test runner
has three silent-success modes (documented in `scripts/dev/README.md`): it
reports success while collecting 0 tests if the module wasn't installed or
updated in that run, JS suites are only collected with `-u crm,web`, and
browser tests skip silently when a dependency is missing. The `scripts/dev/`
wrappers guard against all three and fail on skipped tests or empty
selections — use them instead of raw `./odoo-bin` invocations.

### Known baseline failures

Test failures that exist before this project's changes are out of scope. Do
not fix them; do not treat them as regressions. Known so far:

- The full web JS suite (`./scripts/dev/test-js.sh desktop web`) fails in
  the `scroll loses target` test of the `throttleForAnimation` group,
  `addons/web/static/tests/core/utils/timing.test.js`, on the untouched
  baseline. It is in `addons/web`; leave it alone.

## 2. The offline and PWA framework (addons/web)

The entire offline stack lives in `addons/web`. `addons/crm` only consumes
it. Never build a parallel stack (section 4).

### Offline plugin and its sync queue
- `addons/web/static/src/core/offline/offline_plugin.js` — `OfflinePlugin`,
  an OWL `Plugin` registered with `services.add(OfflinePlugin)`. Reactive
  state: `isOffline`, `syncingORM`, and the scheduled-call map `_ormToSync`;
  on going offline it also loads `_visited`, the set of actions/views/records
  previously visited online, so `isAvailableOffline(actionId, viewType, resId)`
  can answer synchronously while rendering.
- Offline detection: browser `online`/`offline` events, every RPC response
  (`ConnectionLostError` ⇒ offline), and the error handlers in
  `addons/web/static/src/core/offline/offline_error.js`
  (`offlineFailToFetchErrorHandler`, `lostConnectionHandler`). While offline
  it pings `/web/webclient/version_info` with exponential backoff.
- What the queue stores: `scheduleORM(model, method, args, kwargs, options)`
  persists `{model, method, args, kwargs, extras}` verbatim in the
  `orm-to-sync` IndexedDB table. The key is the caller's `options.id` (so
  repeated saves of one record overwrite one entry) or a hash of the payload.
  It throws `NonSecureContextError`
  (`addons/web/static/src/core/errors/non_secure_context_error.js`) outside a
  secure context.
- Producers: `addons/web/static/src/model/relational_model/record.js` (form
  saves ⇒ `web_save`, delete ⇒ `web_unlink`, archive/unarchive ⇒
  `action_archive`/`action_unarchive`, each on `ConnectionLostError`) and
  `.../relational_model/dynamic_list.js` (list/kanban edits). `extras` carries
  what the systray displays: `timeStamp`, `actionName`, `displayName(s)`,
  `changes`/`originalValues`, `actionId`, `viewType`.
- Replay order: `_syncORM()` runs on reconnection (and once shortly after
  startup): entries sorted by `extras.timeStamp` ascending, replayed verbatim
  with `orm.silent.call(model, method, args, kwargs)`, a 1s pause between
  calls. Success dequeues the entry; a `ConnectionLostError` aborts the loop
  (entries stay queued); any other error re-queues the same entry with
  `extras.error` set.
- Conflict behavior: none, by design. Timestamp-ordered replay, last write
  wins, no `write_date` comparison, no field merge, no conflict dialog.
- Where failed calls go: parked in the same queue with `extras.error`,
  excluded from replay until the user acts, and surfaced by the offline
  systray ("Sync issues").

### Encrypted local store and multi-tab locking
- `addons/web/static/src/core/utils/indexed_db.js` — the `IndexedDB` wrapper
  every offline read/write goes through: a per-tab `Mutex` serializes all
  operations, a version record keyed on `session.registry_hash + CRYPTO_ALGO`
  wipes the whole database when the asset registry changes, and
  `invalidate()` clears selected tables or everything.
- `addons/web/static/src/core/crypto.js` — `Crypto`: AES-GCM (`CRYPTO_ALGO`)
  keyed from `session.browser_cache_secret`, fresh random IV per value.
- The plugin opens `new IndexedDB("offline", registry_hash + CRYPTO_ALGO)`.
  Outside a secure context it degrades to a no-op `FakeIndexedDB` and no
  `Crypto` — offline storage is disabled entirely, not partially.
- Multi-tab: the replay is serialized across tabs with the Web Locks API
  (`navigator.locks.request("db-sync", ...)`) so only one tab syncs at a time;
  within a tab the wrapper's mutex serializes access.
- On `RPC:CLEAR-CACHES` the visited-ui and many2x tables are invalidated.

### Relational-field cache (Many2X)
- `addons/web/static/src/views/fields/relational_utils.js` —
  `Many2XAutocomplete.search()` feeds successful `web_name_search` results to
  `offlinePlugin.cacheMany2XSearch(resModel, result)`: `{id, display_name}`
  rows, display names encrypted, stored in `many2x_<model>` tables (first
  line only). On `ConnectionLostError` the search falls back to
  `searchMany2XRecords(resModel, name)` — a normalized substring match over
  decrypted cached names; `readMany2XRecords` serves ids already set on the
  record.

### PWA service, manifest controller, service worker, offline page
- PWA service: `addons/web/static/src/core/pwa/pwa_service.js` (service
  `"pwa"`) — captures `beforeinstallprompt` (stashing it before the webclient
  even starts), tracks install state in localStorage, shows a Safari
  instructions dialog (`install_prompt.js`), handles per-app scoped installs.
  Surfaced by the user menu and navbar
  (`addons/web/static/src/webclient/user_menu/user_menu_items.js`,
  `.../navbar/navbar.js`).
- Web-manifest controller: `addons/web/controllers/webmanifest.py` — serves
  `/web/manifest.webmanifest` (name from the `web.web_app_name` parameter,
  `/odoo` scope, standalone display, shortcuts for installed apps),
  `/web/service-worker.js` (the shared worker, with
  `Service-Worker-Allowed: /odoo`), `/odoo/offline` (the fallback page), and
  the `/scoped_app` routes for per-app manifests. `_has_share_target()` is
  `False` in web; addons enable the share target by subclassing (crm does —
  section 3).
- Shared service worker: `addons/web/static/src/service_worker.js`, registered
  in `addons/web/static/src/webclient/webclient.js`. At install it caches
  `/odoo` and `/odoo/offline`. It scrapes `odoo.__session_info__` from the
  page, keeps the fresh copy in memory, masks it in the cached HTML and
  re-injects it when serving. Document navigations are network-first; on
  failure it serves the cached homepage, then the offline page. It also
  relays share-target POSTs to the page and forgets session info on
  `user_logout`. One worker serves everything under `/odoo` — there is no
  per-addon worker.
- Offline fallback page: template `web.webclient_offline`
  (`addons/web/views/webclient_templates.xml`), served at `/odoo/offline`:
  dark-mode aware, reloads itself when the browser reports `online`.

### Offline systray
- `addons/web/static/src/webclient/offline_systray/offline_systray.js` (+ `.xml`,
  `.scss`), registered in the `systray` registry (sequence 1000). Lists queued
  calls grouped by action and ordered by timestamp, labeled
  Created/Edited/Archived/Unarchived/Deleted; spinner while syncing; warning
  badge while offline; danger "Sync issues" badge when any entry has
  `extras.error`. An entry can be discarded (confirmation dialog) or, for
  form saves (while offline, only those whose record is available offline),
  opened in its form — opening it while online also dequeues it.

### Small-screen signal
- `addons/web/static/src/core/ui/ui_plugin.js` — `UIPlugin` exposes the
  reactive `isSmall` and `size` signals, driven by `matchMedia` breakpoints
  defined in `addons/web/static/src/core/ui/ui_utils.js` (`SIZES`). New code:
  `const ui = usePlugin(UIPlugin); if (ui.isSmall()) {...}`. The legacy
  `"ui"` service (same file) still exposes `.isSmall`; the plugin is the API
  to use. Every mobile behavior must be gated on this signal.

### Bottom-sheet dialog option
- `addons/web/static/src/core/bottom_sheet/` — `BottomSheetPlugin`
  (plugin/service `"bottom_sheet"`) renders the `BottomSheet` component over
  the shared overlay plugin, with the same
  `add(target, component, props, options)` signature as the popover plugin.
  Call sites opt in with `usePopover(component, { useBottomSheet: true })`
  (`addons/web/static/src/core/popover/popover_hook.js`); e.g. the datetime
  picker opens as a bottom sheet on small+touch screens
  (`addons/web/static/src/core/datetime/datetimepicker_service.js`). This is
  the mobile alternative to floating popovers and dialogs.

### Offline action helper
- `addons/web/static/src/views/offline_action_helper.js` +
  `offline_action_helper.xml` — the `OfflineActionHelper` component (template
  `web.OfflineActionHelper`) that list and kanban controllers render when the
  user opens a view that was never visited online. It lists the search states
  previously used on that action/view type
  (`offlinePlugin.getAvailableSearches`, most-visited first) and lets the user
  reset the filters to one of them.

### Offline-availability attribute
- The attribute is `data-available-offline`, and it must sit on the
  interactive element itself (the `<button>`), not on a wrapper.
  `OfflinePlugin.SELECTORS_TO_DISABLE` is
  `["button:not([data-available-offline]):not([disabled])"]`: on going
  offline, `_offlineUI()` first re-enables tagged elements, then sets
  `disabled` and the `o_disabled_offline` class on every button lacking the
  tag. A `MutationObserver` on `document.body` (childList + subtree,
  `attributeFilter: ["data-available-offline"]`) re-runs the pass over DOM
  added while offline; `_onlineUI()` restores everything on reconnection. So
  a control whose own DOM node lacks the attribute is disabled while offline.
  Views compute it dynamically, e.g.
  `t-att-data-available-offline="this.isNewButtonAvailableOffline"` on the
  New button (`addons/web/static/src/views/form/form_controller.xml`,
  `.../kanban/kanban_controller.xml`).

### Plugin API vs the legacy offline service bridge
- New code uses the OWL plugin API: classes extending `Plugin` from
  `@odoo/owl`, registered with `services.add(...)`
  (`addons/web/static/src/core/services.js`) and consumed with
  `usePlugin(PluginClass)`; state lives in `signal`/`signal.Object`/`computed`
  and is read by calling it. `OfflinePlugin` is the reference:
  `const offline = usePlugin(OfflinePlugin); offline.isOffline()`.
- The legacy bridge is at the bottom of `offline_plugin.js`: the `"offline"`
  service wraps the plugin with `.offline` (get/set), `.syncingORM`,
  `.scheduledORM`, and is explicitly marked temporary (`@todo owl3
  migration`, to remove once no caller is left). Don't build on it.

## 3. addons/crm conventions

### Layout: one directory per component
- Front-end source sits under `addons/crm/static/src/`, grouped by kind
  (`views/`, `components/`, `webclient/`, `js/`, `core/`), then one directory
  per component named after the component, with files named after the
  directory: `views/crm_kanban/` holds `crm_kanban_view.js`,
  `crm_kanban_model.js`, `crm_kanban_renderer.js`, `crm_kanban_arch_parser.js`
  and `crm_column_progress.js` + `crm_column_progress.xml`;
  `views/crm_form/` holds `crm_form.js`, `crm_form.scss`,
  `crm_pls_tooltip_button.js/.xml/.scss`. Same pattern in
  `views/forecast_kanban/`, `components/breadcrumbs/`,
  `components/lead_generation_dropdown/`, `webclient/share_target/`.
  Component-specific scss lives next to its js.

### Extending other addons' components
- JS patches: `patch(ImportedComponent.prototype, { method() { if (my case)
  {...} else { return super.method(...arguments); } } })` with `patch` from
  `@web/core/utils/patch`. Examples: `static/src/activity_menu_patch.js`
  (patches mail's `ActivityMenu` for `crm.lead` groups, keeping the `super`
  path for everything else) and `static/src/core/common/res_partner_model_patch.js`.
- Subclassing when a whole class must be swapped:
  `views/crm_control_panel.js` (`CrmControlPanel extends ControlPanel`),
  `views/crm_form/crm_form.js` (`CrmFormModel extends formView.Model`,
  registered as `registry.category("views").add("crm_form", { ...formView,
  Model: CrmFormModel })`).
- Python `_inherit`: `models/mail_activity.py` (`_inherit = "mail.activity"`)
  overrides only `action_create_calendar_event`, calls `super()` and amends
  the returned action's context for lead meetings. Every model file must be
  imported in `models/__init__.py`.
- Controller subclassing: `controllers/webmanifest.py` subclasses web's
  `WebManifest` and flips `_has_share_target()` to `True` — that override is
  what enables the PWA share target for CRM. Imported in
  `controllers/__init__.py`.

### Lead views and js_class
- `views/crm_lead_views.xml` binds custom views to the archs with `js_class`:
  the form uses `js_class="crm_form"`, lists `crm_list`, the lead kanban
  `crm_kanban`, the calendar `crm_calendar`, the activity view `crm_activity`;
  forecast variants override `js_class` with
  `<attribute name="js_class">forecast_kanban</attribute>` etc.
- Each `js_class` maps to a view object registered in
  `registry.category("views")`, e.g. `"crm_kanban"` in
  `static/src/views/crm_kanban/crm_kanban_view.js` (spreads mail's
  `rottingKanbanView`, swaps ArchParser/Model/Renderer/ControlPanel, adds
  `LeadGenerationDropdown` to the controller).
- The mobile kanban arch is `view_crm_lead_kanban`:
  `<kanban class="o_kanban_mobile" archivable="false" js_class="crm_kanban"
  sample="1">` with the card markup in the arch templates; `o_kanban_mobile`
  selects the mobile card layout, `js_class` selects the crm view class.

### Manifest asset globs and exclusion style
- `__manifest__.py`: `web.assets_backend` ships `crm/static/src/**`, so new
  source files are covered without touching the manifest. The exclusion
  style is a pair: `('remove', 'crm/static/src/views/<dir>/**')` under
  `assets_backend` plus the same path in `web.assets_backend_lazy` (see
  `crm_activity`, `crm_graph`, `crm_pivot`, `forecast_graph`, `forecast_pivot`).
  Add such a pair only to exclude or lazily load files.
- Test assets: `web.assets_tests` gets `crm/static/tests/tours/**/*`;
  `web.assets_unit_tests` gets `crm/static/tests/mock_server/**/*`,
  `crm/static/tests/crm_test_helpers.js`, `crm/static/tests/**/*.test.js`
  and `crm/static/tests/crm_mock_server.js`.

### Tests
- Python: `tests/test_*.py` on the shared base `TestCrmCommon`
  (`tests/common.py`, built on `TestSalesCommon` and mail's `MailCase`); UI
  tests extend `HttpCase`, are tagged `@tagged('post_install', '-at_install')`
  and drive the browser with `self.start_tour("/odoo", "tour_name", login=...)`
  (see `tests/test_crm_ui.py`). A Python test module runs only if it is
  imported in `tests/__init__.py` — an unimported module is silently never
  collected.
- JS unit tests: `static/tests/*.test.js` using `test`/`expect` from
  `@odoo/hoot`, view helpers (`mountView`, `defineModels`, `onRpc`, ...) from
  `@web/../tests/web_test_helpers`, and `defineMailModels` from
  `@mail/../tests/mail_test_helpers` (see `static/tests/forecast_view.test.js`).
  Shared fixtures: `static/tests/crm_test_helpers.js`, model mocks in
  `static/tests/crm_mock_server.js` and `static/tests/mock_server/`.
- Tours: onboarding tour steps live in `static/src/js/tours/` (registered in
  the `web_tour.tours` registry; the `crm_tour` record in `data/crm_tour.xml`
  enables it). Test tours driven by `start_tour` live in
  `static/tests/tours/` and ship in the `web.assets_tests` bundle.

## 4. Project rules

Scope
- Change files only under addons/crm/. The fork must stay rebasable onto
upstream 20.0. To change behavior owned by another addon, extend it
from inside addons/crm/ with Python _inherit, controller subclassing,
JS patch(), or XML view or template inheritance.
- Make only the changes the current task needs. Don't refactor or
optimize existing code that isn't directly involved.

Offline framework
- Never build a second offline engine: no new sync queue, IndexedDB
wrapper, service worker, cache layer, encryption helper, connectivity
detector, offline-state store, or conflict resolver. A duplicate stack
won't inherit the existing encryption, multi-tab locking, and error
parking, and the two will diverge.
- Don't change the queue's conflict semantics: timestamp-ordered replay,
last write wins, failed calls parked in the offline systray. No
conflict detection, write_date comparison, field-level merge, or
conflict dialog.
- The queue replays model, method, arguments, and kwargs verbatim, with
no id remapping between calls. Anything that needs a server onchange,
a transient-model wizard, or an id produced by another call can't be
queued.
- A control stays usable offline only if it carries the framework's
offline-availability attribute on the interactive element itself.
- New OWL code uses the plugin API (Plugin, usePlugin, signal), not the
legacy offline service bridge.

Mobile and desktop
- Gate every mobile behavior on the small-screen signal. Desktop
behavior must not change.
- "Native mobile" means the installable PWA this fork already supports.
Never create a native app project (React Native, Flutter, Swift,
Kotlin, Gradle, Xcode, Capacitor).

Security and dependencies
- Don't add or change any access rule, record rule, or group. The
offline cache must never widen what a user can see.
- No new dependency: no Python or JS package, no new addon in the
manifest's depends, requirements.txt unchanged. No npm, bundler, or
JS build tooling.
- Don't add fields to crm.lead, crm.stage, or crm.team.

Wiring (a component that exists but is never reached is the most common
failure; prove each point with a test)
- Every new view is registered in the view registry and referenced by a
js_class in the addon's lead views.
- Every new component is reachable from a rendered parent template, not
only from its own unit test.
- The manifest's existing asset globs already cover new source, test,
and tour files. Verify that rather than adding globs; add a bundle
entry only to exclude or lazily load a file, in the existing style.
- Import every new Python test module in the tests package __init__.
Import every new Python model or controller file in its package
__init__, and add every new XML data file to the manifest data list
in dependency order.

Tests
- Follow the addon's existing test conventions: Python tests, JS unit
tests, and browser tours.
- Run new JS unit tests under both the desktop and the mobile preset.
- Never use only() or debug() in a .test.js file; a guard test fails
the run if either appears.
- Never delete, skip, retag, or weaken an existing test. The only
existing test file that may change is the tests package __init__.
