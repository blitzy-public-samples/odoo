# Offline and mobile CRM

Developer notes for the offline-capable, mobile-first CRM in this fork. All of it
lives in `addons/crm` and is built on the offline/PWA framework that `addons/web`
already provides. See the repository-root `AGENTS.md` (sections 1 and 2) for the
framework itself and `scripts/dev/README.md` for the dev scripts.

## What this is

- **Offline writes use the existing framework.** Every offline write goes into the
  `addons/web` `OfflinePlugin` queue (`scheduleORM`), which is stored in the encrypted
  IndexedDB and shown in the offline systray. It is replayed verbatim on reconnection:
  timestamp-ordered, last write wins, failed calls parked in the systray as "Sync issues".
- **crm builds no second offline stack.** There is no new queue, store, service worker,
  cache, encryption helper, connectivity detector, or conflict resolver. crm only consumes
  the framework, through Python `_inherit`, controller subclassing, JS `patch()` or
  subclassing, and XML inheritance.
- **Mobile pipeline.** A small-screen branch inside the `crm_kanban` renderer, gated on
  `UIPlugin.isSmall()`, shows one stage at full width with a fixed header (name, count,
  expected revenue) and previous/next controls. Desktop rendering is unchanged.
- **Mobile card, quick create, pending creates.** On small screens the pipeline renders a
  fixed mobile lead card with 44px touch targets and a pending-sync badge. A "+" control
  opens a six-field quick create as a bottom sheet. Lead creates still in the queue show as
  non-clickable pending cards.
- **Shared offline hooks.** `useCrmOffline()` is the one place crm code reads offline state
  from. It wraps `usePlugin(OfflinePlugin)` and keeps no state of its own.
- **PWA shortcuts.** The web manifest gains "My Pipeline" and "New Lead" shortcuts,
  resolved from XML ids at request time. The share target stays enabled.

Offline data behavior (mark won, activities, pending-sync marks) applies at every screen
size while offline. The mobile UI applies only when `isSmall()` is true.

## Layout

This directory:

- `offline_hooks/` - `useCrmOffline()`: `isOffline`, `isLeadAvailableOffline`,
  `pendingForLead`, `pendingLeadCreates`, `pendingActivities`, `queueCall`,
  `cachedMany2XRecords`.
- `crm_mobile_pipeline/` - the fixed stage header (name, count, revenue, previous/next,
  "+" control) used by the renderer's small-screen branch.
- `crm_mobile_card/` - the mobile lead card (name, partner, revenue, priority,
  pending-sync badge).
- `crm_mobile_quick_create/` - the bottom-sheet quick create; one `web_save`, queued on
  `ConnectionLostError` like `record.js` does.
- `crm_mobile_pending_lead_create/` - the presentational card for a queued lead create.
- `offline_inventory.md` - the classification of every crm entry point that needs a
  server: **QUEUE**, **SKIP**, or **DISABLE**. Totals: 26 QUEUE, 9 SKIP, 115 DISABLE,
  150 rows.

Related changes outside this directory (paths relative to `addons/crm/`):

- `static/src/views/crm_kanban/crm_kanban_renderer.{js,xml,scss}` - the small-screen
  pipeline branch and the quick-create popover.
- `static/src/views/crm_form/crm_form.js`, `crm_lead_activity_panel.{js,xml}` - offline
  Won button and the offline activity panel (schedule, done, log a call).
- `static/src/components/team_switcher/` - offline team list from the RPC cache and the
  hardened sales-manager probe.
- `static/src/views/view_components/` - offline patches for kanban/list controllers,
  records, action menus, group menus, relational fields, and the priority field.
- `static/src/webclient/offline_systray_patch.js` - systray labels for CRM-queued methods.
- `models/crm_lead.py` - `action_log_call()`: creates a Call activity and marks it done in
  one server call, so it can be queued.
- `models/mail_activity.py` - `create()` derives `res_model_id` for `crm.lead` when a
  `res_id` is given, so a client-built activity create can be queued.
- `controllers/webmanifest.py` - `_get_shortcuts()` appends "My Pipeline" and "New Lead".

## Offline behavior

The full row-by-row list is in `offline_inventory.md`. In short:

- **Queued** (written to the framework queue, UI updated at once): lead edits from the
  form, lead create (form and mobile quick create), stage moves in the kanban, mark won
  (`action_set_won`, Won ribbon shown immediately, no rainbowman), archive, unarchive and
  delete from the list or form, activity schedule (`mail.activity.create`), activity done
  (`action_done`), and log a call (`action_log_call`).
- **Skipped silently** (decorative or advisory reads, never queued): the rainbowman
  message, PLS tooltips, promotional hints, and group probes that only toggle display.
- **Disabled** (the button is disabled offline because it lacks `data-available-offline`):
  wizards, module installs, paid external lookups, server-computed reports, stage and
  group delete or reorder, and navigation to anything not available offline. Anything that
  needs a server onchange, a transient-model wizard, or an id from another call is
  disabled, never queued.

## Running it

```sh
./scripts/dev/setup.sh            # once per machine
./scripts/dev/start.sh            # http://localhost:8069, db crm_offline, admin / admin
./scripts/dev/start.sh --https    # any host other than localhost
./scripts/dev/stop.sh
./scripts/dev/rebuild-assets.sh   # after every js/css/scss/xml change
```

Offline needs a secure context. Over plain HTTP on a host other than `localhost`, the
framework disables offline storage entirely and queued ORM calls raise
`NonSecureContextError`. Use `--https` in that case (self-signed certificate in
`var/tls/`). Rebuild assets before testing any front-end change; a failure caused by a
stale bundle is not a real result.

## Testing

```sh
./scripts/dev/test-py.sh                  # all crm Python tests
./scripts/dev/test-py.sh TestCrmOffline   # the three offline test modules
./scripts/dev/test-js.sh desktop          # crm JS unit tests, desktop preset
./scripts/dev/test-js.sh mobile           # same suite, 375x667 touch preset
./scripts/dev/test-guard.sh               # rejects only( / debug() in .test.js files
./scripts/dev/stop.sh; .venv/bin/python ./odoo-bin -d crm_offline -u web --test-enable \
    --test-tags /web:WebManifestRoutesTest --stop-after-init --log-level=test
```

- **Python.** `tests/test_crm_offline.py` (models), `tests/test_crm_offline_webmanifest.py`
  (shortcuts), and `tests/test_crm_offline_tour.py` all define a class named
  `TestCrmOffline`, so the class filter above runs all three. New test modules must be
  imported in `tests/__init__.py` or they are never collected.
- **JS unit tests.** `static/tests/crm_offline_*.test.js`. Every new JS test must pass
  under both the desktop and the mobile preset. Tests that mount a `WebClient` or start
  the mail store should toggle connectivity with `mockCrmOffline()` from
  `static/tests/mock_server/crm_offline_test_helpers.js` instead of the raw web
  `mockOffline()`: it waits for the `mail.store` fetch to settle before going offline,
  which avoids a late uncaught `ConnectionLostError` in an unrelated test. Use
  `waitForMailStoreReady()` before destroying a `WebClient` mounted online.
- **End-to-end tour.** `static/tests/tours/crm_offline_e2e_tour.js`, driven by the
  `HttpCase` in `tests/test_crm_offline_tour.py` with
  `start_tour("/odoo", "crm_offline_e2e_tour", login="admin")`.
- **Manual offline QA.** Use a real browser at a 375x667 viewport on `localhost` (or
  `--https`), after `rebuild-assets.sh`. Visit the pipeline and some leads online, then go
  offline with the browser's real network toggle (not only a mocked flag). Make changes,
  go back online, wait for the systray queue to drain, then confirm on the server that the
  writes arrived, for example:

  ```sh
  psql -d crm_offline -c "SELECT id, name, stage_id, write_date FROM crm_lead ORDER BY write_date DESC LIMIT 5"
  ```

## Known limits

- Leads created offline can't take activities or be marked won until they sync.
- Partner search offline only finds partners cached by earlier online searches.
- The external partner-autocomplete lookup is still attempted offline and fails silently.
- If the VAT script never loaded before going offline, Enter/Tab partner selection hangs.
- The mobile `view_crm_lead_kanban` arch backs the Leads action, not the pipeline; the mobile pipeline is a `crm_kanban` branch.
- Stage delete and reorder (and team/stage group delete/reorder) are disabled offline.
- The `addons/web` offline systray crashes on unknown queued methods; crm patches the labels.
- `addons/mail` composer and follower actions on non-crm.lead chatters still fail offline.
- List cell editing is disabled offline; edit records from their form.
- Opening an uncached lead offline replaces the grid with `OfflineActionHelper`.
- Kanban action-menu Archive/Unarchive/Delete are greyed out offline; use the list or form.
- Offline, the view switcher only allows view types already mounted in this session.
- Offline, the team switcher shows only "All Teams" if the team list was never loaded.
- On phones the list has no selection checkboxes; archive and unarchive from the form.
- One2many sub-lists, such as team members, are read-only offline.
- Mark won offline updates stage and probability only after the queued call replays.
- On phones, contact lookup offline uses only partners cached on this device.
- The manifest `start_url` opens the first app, not CRM; a full offline relaunch shows web's offline page.
- If CRM was first opened by typing /odoo/crm, the CRM shortcut shows a blank page offline (the action is cached under the string key `crm`; the app tile and menus cache the numeric id). Opening CRM from the tile or menu avoids it.
- The "New Lead" shortcut offline shows the cached pipeline instead of a new lead form.
- After an offline save, the Save/Discard indicator can stay visible (cosmetic, `addons/web`).
- A brief false-online flip can leave the offline UI showing after reconnect; reload clears it.
