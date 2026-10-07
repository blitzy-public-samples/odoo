# Glossary

Terms used across this wiki and in the codebase.

## Core Odoo

- **Addon (module)** — a directory under `addons/` with a `__manifest__.py` declaring its dependencies, data files, and assets. Installed addons contribute models, views, routes, and assets to a database.
- **Action** — a window action (`ir.actions.act_window`) or other action record; the client's action service opens views through actions.
- **Arch** — the XML definition of a view (`<form>`, `<list>`, `<kanban>`, ...), stored in `ir.ui.view` and parsed by each view type's arch parser.
- **js_class** — an attribute on a view arch that selects a custom view object from `registry.category("views")` instead of the default one, e.g. `js_class="crm_kanban"`.
- **ORM** — Odoo's model layer in `odoo/orm/` and `odoo/fields/`; the client talks to it through `orm` service calls like `web_save`, `web_read_group`, `web_name_search`.
- **OWL** — the component framework the web client is written in (bundled at `addons/web/static/src/owl2/`). Components, reactive state, plugins, and services.
- **Plugin** — the current API for core state and services: classes extending `Plugin` from `@odoo/owl`, registered with `services.add(...)`, consumed with `usePlugin(PluginClass)`. Replaces the older service API for new code.
- **Systray** — the navbar's right-hand item area (user menu, activities, and the offline queue indicator).
- **Relational model** — the client-side model in `addons/web/static/src/model/relational_model/` that loads records and stages edits for form, list, and kanban views.
- **PLS** — Predictive Lead Scoring: server-computed win probabilities for leads (`addons/crm/models/crm_lead_scoring_frequency.py`).
- **Forecast views** — date-grouped kanban/list/graph/pivot variants using `fill_temporal`, registered as `forecast_kanban` etc.
- **MRR** — Monthly Recurring Revenue, shown on kanban columns for teams with recurring plans.
- **Rainbowman** — the congratulation animation after winning a lead (`check_rainbowman_message`).

## Offline and PWA

- **Offline queue / sync queue** — the `orm-to-sync` IndexedDB table that `OfflinePlugin.scheduleORM()` writes queued server calls into, replayed on reconnection in timestamp order.
- **Replay** — `_syncORM()`: queued calls re-issued verbatim with `orm.silent.call`, 1s apart, dequeued on success, parked with `extras.error` on other failures.
- **Sync issues** — systray badge and parked-queue state for calls that failed replay; only the user can discard or retry them.
- **Last write wins** — the queue's only conflict policy: no write_date comparison, no merge, no dialog.
- **Secure context** — a browser condition (HTTPS or `localhost`) required for IndexedDB, crypto, and service workers. Outside it the framework disables offline entirely and raises `NonSecureContextError`.
- **`data-available-offline`** — the attribute on a `<button>` that keeps it clickable while offline; everything without it is disabled by the framework.
- **Available offline** — `OfflinePlugin.isAvailableOffline(actionId, viewType, resId)`: whether an action/view/record was visited while online, from the `_visited` set.
- **OfflineActionHelper** — the component that replaces a view when it was never visited online (`addons/web/static/src/views/offline_action_helper.js`).
- **Many2x cache** — `many2x_<model>` tables of `web_name_search` results kept by the framework so relational fields can suggest records offline.
- **Service worker** — `addons/web/static/src/service_worker.js`, one worker for all of `/odoo`: caches the homepage, serves it network-first, masks and re-injects session info.
- **Web manifest** — `/web/manifest.webmanifest`, served by `addons/web/controllers/webmanifest.py` and subclassed by crm for the share target and shortcuts.
- **Share target** — a PWA capability that lets the installed app receive text shared from the phone's share sheet; crm creates leads from it.
- **Bottom sheet** — the small-screen alternative to popovers and dialogs (`addons/web/static/src/core/bottom_sheet/`), used for the mobile quick create.

## The fork's CRM terms

- **QUEUE / SKIP / DISABLE** — the three dispositions of the offline surface inventory (`addons/crm/static/src/mobile/offline_inventory.md`): queue the write into the framework queue, skip the decorative read silently, or disable the control offline.
- **Chained id** — an id that only exists after another server call returns it (for example `name_create` before an attachment write). Anything needing one is DISABLE, never queued.
- **Offline guard** — a crm-side patch that disables or blocks a control offline because the framework does not queue what it does (wizards, group edits, reports, module installs).
- **useCrmOffline()** — crm's single hook over the framework's `OfflinePlugin` (`addons/crm/static/src/mobile/offline_hooks/offline_hooks.js`): offline state, pending marks, queue helpers.
- **Mobile pipeline** — the small-screen branch of the `crm_kanban` renderer showing one stage at full width with a fixed header; distinct from the mobile kanban *arch* (`view_crm_lead_kanban`).
- **Pending lead create** — a lead create still sitting in the queue; shown as a non-clickable card until it syncs.
- **Quick create** — the six-field bottom-sheet lead create on small screens; its save is one `web_save`, queued on connection loss like any form save.
- **`action_log_call`** — a `crm.lead` method that creates a Call activity and marks it done in a single server call, so logging a call offline queues exactly one call.
- **Milestones M1-M5** — the fork's five delivery phases: the surface inventory, offline fixes, data coverage, evidence/QA, and the mobile pipeline.

## Dev environment

- **`crm_offline`** — the dev database (crm, mail, demo data); log in as `admin` / `admin`.
- **Presets** — the JS test suites run twice: `desktop`, and `mobile` at 375x667 with touch.
- **Asset bundles** — the compiled JS/CSS packages (`web.assets_backend`, ...); rebuilt by `rebuild-assets.sh` and invalidated by asset registry changes.
- **`mockCrmOffline()`** — the test helper that flips connectivity in JS tests after the mail store settles, instead of the raw `mockOffline()`.
