# Patterns and conventions

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

How code is written in this repo, and the rules specific to this fork. The authoritative sources are `AGENTS.md` (project rules, untracked in git), `skills/odoo-guidelines/` and `skills/odoo-web-guidelines/` (rule packs), and the code itself.

## Scope rules for fork work

- Changes go only under `addons/crm/`. The fork must stay rebasable onto upstream Odoo 20.0. To change behavior owned by another addon, extend it from inside `addons/crm/` with Python `_inherit`, controller subclassing, JS `patch()`, or XML view/template inheritance.
- Make only the changes the task needs. No refactors of code the task does not touch.
- No new dependencies: no Python or JS packages, no new addon in the manifest's `depends`, no npm or bundler tooling. No new fields on `crm.lead`, `crm.stage`, or `crm.team`. No changes to access rules, record rules, or groups.

## The offline rules

- Never build a second offline engine. No new sync queue, IndexedDB wrapper, service worker, cache layer, encryption helper, connectivity detector, or conflict resolver. A duplicate stack would not inherit the existing encryption, multi-tab locking, and error parking, and would diverge from the real one. Everything already exists in `addons/web/static/src/core/offline/`, `addons/web/static/src/core/utils/indexed_db.js`, and `addons/web/static/src/core/crypto.js`.
- The queue replays `model, method, args, kwargs` verbatim with no id remapping. Anything needing a server onchange, a transient wizard, or an id produced by another call cannot be queued.
- Do not change conflict semantics: timestamp-ordered replay, last write wins, failures parked in the offline systray. No conflict detection, `write_date` comparison, field merge, or conflict dialog.
- A control stays usable offline only if it carries `data-available-offline` on the interactive element itself (the `<button>`), not on a wrapper.
- The offline cache must never widen what a user can see.
- New OWL code uses the plugin API (`Plugin`, `usePlugin`, `signal`), not the legacy `"offline"` service bridge.

## Python conventions

- A model file defines one model (or a small family); it must be imported in the addon's `models/__init__.py` or it silently never loads. The same applies to controllers and to test modules in `tests/__init__.py`.
- Extend, don't copy: `_inherit = "mail.activity"` in `addons/crm/models/mail_activity.py` overrides `action_create_calendar_event`, calls `super()`, and amends the returned action. Keep the `super` path intact for everything outside your case.
- Controller subclassing: `addons/crm/controllers/webmanifest.py` subclasses web's `WebManifest` and flips only `_has_share_target()`. That single override is what enables the PWA share target for CRM.
- Data files load in manifest order; dependency order matters. Security CSVs are `security/ir.access.csv` in 20.0 (the old `ir.model.access.csv` and `ir.rule` are gone).
- The ORM API surface: `search`, `browse`, `create`, `write`, `unlink`, `read_group`, computed fields with `@api.depends`, `@api.constrains`, `onchange` for form-time defaults. Record rules/access are enforced in `odoo/addons/base/models/ir_access.py`.
- Ruff is the linter (`ruff.toml`, target py312, runbot-generated rule set). Run it before calling anything done.

## JavaScript conventions

- **Patch** to extend a method: `patch(ImportedComponent.prototype, { method() { if (my case) {...} else { return super.method(...arguments); } } })` with `patch` from `@web/core/utils/patch`; see `addons/crm/static/src/activity_menu_patch.js`. Always keep the `super` path.
- **Subclass** to swap a whole class: `CrmFormModel extends formView.Model`, registered as `registry.category("views").add("crm_form", { ...formView, Model: CrmFormModel })`; see `addons/crm/static/src/views/crm_form/crm_form.js`.
- **Directory per component**: `static/src/views/crm_kanban/` holds `crm_kanban_view.js`, `crm_kanban_model.js`, `crm_kanban_renderer.js`, `crm_kanban_arch_parser.js`, and co-located `.xml`/`.scss`. Files are named after the directory.
- The manifest's `assets_backend` glob `crm/static/src/**` already covers new source files. Add an exclusion pair (`('remove', ...)` in `assets_backend` plus the same path in `assets_backend_lazy`) only to lazily load something, as crm does for `crm_activity`, `crm_graph`, `crm_pivot`, `forecast_graph`, `forecast_pivot`.
- Plugin API for new services; registries for extensions; `signal`/`computed` for reactive state.
- A component that exists but is never reached is the most common wiring failure. Every new view must be registered in the view registry *and* bound by a `js_class` in the addon's lead views; every new component must be reachable from a rendered parent, not only from its unit test.

## XML views

- `addons/crm/views/crm_lead_views.xml` binds custom views to archs with `js_class="crm_kanban"`, `"crm_form"`, `"crm_list"`, `"crm_activity"`, `"crm_calendar"`; forecast variants override the attribute in place.
- Template inheritance (`<xpath expr="..." position="inside|after|replace">`) extends other addons' templates instead of copying them.

## Mobile

- Gate every mobile behavior on the small-screen signal: `const ui = usePlugin(UIPlugin); if (ui.isSmall()) {...}` (`addons/web/static/src/core/ui/ui_plugin.js`). Desktop behavior must not change.
- The bottom sheet (`addons/web/static/src/core/bottom_sheet/`) is the mobile alternative to floating popovers: opt in with `usePopover(component, { useBottomSheet: true })`.
- "Native mobile" means the installable PWA this fork already supports. Never introduce a native app project.

## Testing conventions

- Python: `tests/test_*.py` on the shared base `TestCrmCommon` (`addons/crm/tests/common.py`); UI tests extend `HttpCase`, are tagged `@tagged('post_install', '-at_install')`, and drive the browser with `self.start_tour("/odoo", "tour_name", login=...)`.
- JS: `static/tests/*.test.js` with `test`/`expect` from `@odoo/hoot` and helpers from `@web/../tests/web_test_helpers`; every new JS test must pass under both the desktop and the mobile preset. Never `only()` or `debug()` in a `.test.js` (a guard suite fails the run).
- Never delete, skip, retag, or weaken an existing test. The only existing test file that may change is `tests/__init__.py`.

Details on running everything: [testing](testing.md). The rules for where work happens: [development workflow](development-workflow.md).
