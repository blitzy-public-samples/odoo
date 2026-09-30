# Glossary

Project vocabulary for the Odoo core, the web client, and this fork's offline stack. Terms appear roughly in the order you meet them: platform, frontend, offline, CRM.

## Platform

- **Addon (module)**: a self-contained package under `addons/` (or `odoo/addons/` for framework modules) that adds models, views, data, or assets to Odoo. 642 live in `addons/`.
- **Manifest**: `__manifest__.py` at an addon root: name, `depends`, `data` (XML/CSV loaded in order), `demo`, `assets` (bundle declarations). Parsed by `odoo/modules/module.py`.
- **ORM**: the record-oriented layer in `odoo/orm/`. `odoo/models.py` and `odoo/fields.py` are re-export shims over it.
- **Recordset**: an ordered collection of records of one model; every ORM operation (`search`, `write`, `mapped`, `filtered`, ...) runs on recordsets.
- **Domain**: a search filter expression like `[('stage_id.name', '=', 'New')]`. In 20.0 a real AST (`odoo/orm/domains.py`) with optimization passes.
- **`_inherit` vs `_inherits`**: `_inherit` extends an existing model in place; `_inherits` is delegation, embedding a parent record per entry (like a composition with a shared id).
- **Environment**: the per-request context (`env`) carrying the cursor, user, and context; created in `odoo/orm/environments.py`.
- **Registry**: per-database map of model name → model class, built when the module graph loads (`odoo/orm/registry.py`). Invalidated across processes through PostgreSQL signaling.
- **`ir.access`**: the unified access model in 20.0: what used to be separate access rights (`ir.model.access`) and record rules (`ir.rule`) is now one model with an operation (create/read/write/unlink) and an optional domain.
- **`ir.cron`**: scheduled jobs, run by cron workers or cron threads.
- **`ir.config_parameter`**: key/value system parameters (e.g. `web.web_app_name`, the browser cache secret).
- **Savepoint**: a nested transaction point; tests run each method inside a savepoint of a shared transaction so they can roll back cheaply.
- **Prefork / Gevent servers**: the two multi-worker server modes: `PreforkServer` forks HTTP and cron workers; `GeventServer` runs greenlets for longpolling/websockets. The default dev server is threaded.
- **Test tags**: `--test-tags` selects tests, e.g. `/crm:WebSuite.test_unit_desktop` (module:Class.method). Python UI tests are tagged `post_install`/`-at_install`.
- **False-green**: a test run that reports success while testing nothing: zero collected tests still exit 0; JS suites are never collected without `-u crm,web`; browser tests self-skip on missing dependencies. `scripts/dev/` wrappers exist to catch all three.

## Web client

- **OWL**: Odoo's component framework, similar in spirit to Vue/React. The vendored library is OWL 3 with an Owl-2 compatibility layer; everything imports it as `@odoo/owl`.
- **Plugin**: the new service API: classes extending OWL `Plugin`, registered with `services.add(...)`, exposing reactive `signal` state, consumed with `usePlugin(PluginClass)`. `OfflinePlugin` is the reference implementation.
- **Legacy service bridge**: old-style named services (`"offline"`, `"ui"`, `"bottom_sheet"`) wrapped around plugins, kept until the OWL 3 migration finishes. New code must not build on them.
- **Registry**: named global maps (`registry.category("views")`, `"systray"`, `"services"`) that the client reads to wire behavior.
- **Action**: anything the client can open in its content area: a window view, a URL, a server report (`ir.actions.*`).
- **View / arch**: a model UI (form, list, kanban, ...). The XML is the *arch*; `js_class` on the arch binds it to a custom view object from the view registry.
- **Asset bundle**: a named set of JS/SCSS files declared in a manifest (e.g. `web.assets_backend`), compiled and served as attachments. `assets_backend_lazy` bundles load on demand.
- **`registry_hash`**: fingerprint of the asset bundles; the client wipes its offline storage when it changes.
- **Relational model**: `addons/web/static/src/model/relational_model/`, the JS data layer under the views (`record.js`, `dynamic_list.js`).

## Offline stack (this fork)

- **Secure context**: HTTPS or `localhost`. Offline storage, service workers, and crypto only exist inside one; outside it the stack degrades to no-ops and `scheduleORM` throws `NonSecureContextError`.
- **Service worker**: `/web/service-worker.js`, one worker for scope `/odoo`: caches the homepage and offline page, masks session info in the cached copy, serves them when the network fails.
- **Sync queue**: the `orm-to-sync` IndexedDB table holding queued `{model, method, args, kwargs, extras}` entries, replayed on reconnection in timestamp order.
- **`extras`**: queue entry metadata for the systray: `timeStamp`, `actionName`, `displayName(s)`, `changes`/`originalValues`, `actionId`, `viewType`, and `error` when a replay fails.
- **Visited-UI**: `visited-ui-items`, the record of actions/views/records seen online; `isAvailableOffline(actionId, viewType, resId)` reads it to decide what can be reopened offline.
- **Many2X cache**: encrypted `many2x_<model>` tables of relational-search results; offline, the autocomplete falls back to substring matching over them.
- **`data-available-offline`**: the attribute that keeps a button enabled while offline. It must sit on the interactive element itself, not a wrapper.
- **Parked entry / Sync issues**: a replayed call that failed with a non-connection error keeps its queue entry with `extras.error` set and surfaces as a danger badge in the offline systray.
- **Last write wins**: the queue's conflict semantics: timestamp-ordered verbatim replay, no `write_date` comparison, no merge, no conflict dialog. Deliberate.

## CRM

- **Lead vs opportunity**: two `type` values on `crm.lead`. Leads are unqualified contacts; opportunities sit in the pipeline with stages and probability. The lead stage is gated on the `crm.group_use_lead` group.
- **Stage**: a pipeline step (`crm.stage`); `is_won` marks the Won stage, `rotating_threshold_days` feeds the rotting kanban.
- **PLS**: Predictive Lead Scoring: a naive-Bayes model over per-team won/lost frequencies (`crm.lead.scoring.frequency`), recomputed by cron, shown in a tooltip on the form.
- **MRR / recurring plan**: monthly recurring revenue: `recurring_revenue` normalized by `crm.recurring.plan` months. Forecast views aggregate prorated MRR over future periods.
- **Forecast**: views (kanban/list/graph/pivot) that extend the CRM views with time-bucket filling (`fill_temporal_service.js`) to project revenue into the future.
- **Rainbowman**: the celebration animation when a lead is won (`check_rainbowman_message.js`).
- **Rotting kanban**: mail's kanban extension that colors cards by days without activity; CRM's pipeline kanban builds on it.
- **Share target**: PWA feature letting the mobile OS "Share to" the installed app; crm registers `crm_share_target_item.js` so sharing text creates a lead on a chosen team.
- **Scoped app**: an installable PWA per business app (routes under `/scoped_app`), with its own manifest and icon set.
