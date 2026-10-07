# Patterns and conventions

How code is written in this repository, with the offline-specific rules the fork adds. `AGENTS.md` is the authoritative version of these rules; this page is the wiki's copy.

## Server side

- **Extension over modification.** To change behavior owned by another addon, extend it from inside `addons/crm/`: Python `_inherit` on a model, subclassing a controller, JS `patch()`, or XML view/template inheritance. This keeps the fork rebasable on upstream 20.0.
- **Minimal overrides.** A Python `_inherit` should call `super()` and amend the result, not replace it. `addons/crm/models/mail_activity.py` does exactly this for `action_create_calendar_event`.
- **One method, one queued call.** Anything meant to run offline must be a single server call whose arguments are fully known on the client. `action_log_call` in `addons/crm/models/crm_lead.py` creates the activity and marks it done in one call, precisely so it can be queued.
- **Every model or controller file is imported in its package `__init__.py`**, and every XML data file is in `__manifest__.py` in dependency order. Missing imports are the most common silent failure.

## Client side

- **One directory per component.** Front-end source lives under `addons/crm/static/src/`, grouped by kind (`views/`, `components/`, `webclient/`, `mobile/`), then one directory per component, files named after the directory: `views/crm_kanban/` holds `crm_kanban_view.js`, `crm_kanban_model.js`, `crm_kanban_renderer.js`, ... Scss sits next to its js.
- **JS patching.** `patch(ImportedComponent.prototype, { method() { if (my case) {...} else { return super.method(...arguments); } } })` with `patch` from `@odoo/core/utils/patch`. Keep the super path for everything outside your case. `addons/crm/static/src/activity_menu_patch.js` is the reference.
- **Plugin API, not the legacy bridge.** New code uses `Plugin` classes, `usePlugin(PluginClass)`, and `signal` state. The legacy `"offline"` service bridge is temporary and deprecated. State is read by calling the signal: `const offline = usePlugin(OfflinePlugin); offline.isOffline()`.
- **Mobile is a signal, not a device check.** Every small-screen behavior is gated on `usePlugin(UIPlugin)`'s `isSmall()`. Desktop behavior must not change. The mobile quick create, pipeline, and card all follow this.
- **View objects and js_class.** A custom view is registered in `registry.category("views")` and selected from the arch with `js_class`, e.g. `js_class="crm_kanban"` on the lead kanban. Every new view must have both (the registration and the arch reference), or it is never reached.

## Offline rules

- **No second offline stack.** Never add a new queue, store, worker, cache, encryption helper, connectivity detector, or conflict resolver in crm. Everything goes through `addons/web`'s framework; a parallel stack would lose its encryption, locking, and error parking.
- **Queue semantics are fixed.** Timestamp-ordered replay, last write wins, failures parked in the systray. No conflict detection, no write_date comparison, no merge, no dialogs.
- **The three dispositions.** Every crm entry point that needs a server is QUEUE (bare, client-resolvable write on `crm.lead`, `crm.stage`, `crm.team`, or a lead's `mail.activity`), SKIP (decorative read, silently dropped), or DISABLE (everything else). The classification lives in `addons/crm/static/src/mobile/offline_inventory.md`; new entry points get a row there.
- **Chained ids and onchanges kill queueability.** Anything needing a server onchange, a transient-model wizard, or an id produced by another call is disabled offline, never queued.
- **A control is usable offline only if its own DOM node** carries `data-available-offline`. Wrappers do not count; the framework disables buttons by selector.
- **crm does not queue what the framework does not.** Where the framework has no producer (group delete, resequence, `_multiSave` cell edits), crm disables the control offline instead of writing a new producer.

## Testing conventions

- New JS tests use `test`/`expect` from `@odoo/hoot`, view helpers from `@web/../tests/web_test_helpers`, and the shared fixtures in `addons/crm/static/tests/crm_test_helpers.js` and `addons/crm/static/tests/crm_mock_server.js`.
- Every JS test passes under **both** presets (`./scripts/dev/test-js.sh desktop` and `... mobile`).
- Never `only(` or `debug()` in a `.test.js` file; `./scripts/dev/test-guard.sh` fails the run on either.
- Python test modules run only when imported in `addons/crm/tests/__init__.py`. UI tests extend `HttpCase`, are tagged `@tagged('post_install', '-at_install')`, and drive the browser with `self.start_tour(...)`.
- Rebuild assets after any front-end change, before testing.

## Security and scope

- No new access rules, record rules, or groups; the offline cache must not widen what a user can see.
- No new dependencies: no Python or JS packages, no new addon in `depends`, no build tooling.
- No fields added to `crm.lead`, `crm.stage`, or `crm.team`.
- Never delete, skip, retag, or weaken an existing test.

For the branch-and-PR cycle and the test commands, see [Development workflow](development-workflow.md) and [Testing](testing.md).
