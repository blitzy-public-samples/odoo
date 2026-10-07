# Base and core system addons

Active contributors: Christophe Simonis, Krzysztof Magusiak, Raphael Collet (upstream, by commit count on `odoo/addons/base/`)

## Purpose

`base` is the kernel module: the `ir.*` system models that make Odoo configurable at runtime, the `res.*` resource models every other module builds on, and the mixins (`image.mixin`, `avatar.mixin`, `format.address.mixin`) that business models reuse. It defines the vocabulary, models, groups, views, actions, sequences, crons, that every addon extends. It lives inside the core package at `odoo/addons/base/`, is `auto_install: True` in `odoo/addons/base/__manifest__.py`, and cannot be disabled: every database starts from it. Ten small `base_*` addons in `addons/` bolt framework services onto it (import, automation, settings, report engines), and `web_tour` sits in the same layer; they are covered below.

## Directory layout

```text
odoo/addons/base/
├── __manifest__.py     # name 'Base', category 'Hidden', auto_install True
├── models/             # ir.* and res.* system models
├── views/              # XML for the back-end settings screens
├── wizard/             # language install/import, module update/uninstall, partner merge
├── report/             # model-reference report, print layouts
├── security/           # base_groups.xml + ir.access.csv
├── data/               # countries, currencies, languages, crons (XML/CSV/SQL)
├── rng/                # RelaxNG schemas that validate view archs
├── populate/           # database population scripts
├── static/             # scss for res.users/res.partner, icons
├── i18n/               # .po translation files
└── tests/              # 39 test modules (plus __init__.py)
```

## The `base_*` family

Ten addons in `addons/` hang off `base`, plus `web_tour`, which belongs here for the same reason (`base`-adjacent framework plumbing that ships `auto_install`). Each is small and each extends a system model rather than defining an app.

| Addon | What it adds | Key models |
| --- | --- | --- |
| `addons/base_setup` | The Settings app itself: the `res.config.settings` screens, KPI providers, and the user-facing defaults (company, language, email). Depends on `base`, `web`, `auto_install`. | `res.config.settings` (`addons/base_setup/models/res_config_settings.py`), `ir.http` |
| `addons/base_import` | The CSV/XLSX/ODS import wizard behind every list view's Import button; file parsing, field mapping, and the "load" step. `auto_install`. | `base_import.import`, `base_import.mapping` (`addons/base_import/models/base_import.py`) |
| `addons/base_import_module` | Installs a module from an uploaded `.zip`; also the "Import Module" client action. `auto_install`. | `base.import.module` |
| `addons/base_install_request` | "Module Install Request": when a user hits a feature whose module is absent, posts the request (mail template) and tracks its review. `auto_install`, depends on `mail`. | `base.module.install.request`, `base.module.install.review` (`addons/base_install_request/wizard/base_module_install_request.py`), `ir.module.module` extension |
| `addons/base_sparse_field` | Declares fields stored in one JSON column instead of a real column each: the `Serialized` field class plus the `_get_attrs` / `_compute_sparse` / `_inverse_sparse` monkey-patch that materialises the individual keys. | `Serialized` (`addons/base_sparse_field/models/fields.py`) |
| `addons/base_automation` | Automation rules: run a server action on create/write, on a field change, or on a time condition. Depends on `base`, `digest`, `resource`, `mail`, `sms`. | `base.automation` (`addons/base_automation/models/base_automation.py`) |
| `addons/base_geolocalize` | Address geocoding: converts `res.partner` addresses to coordinates through OpenStreetMap, with the provider registry and the map widget. | `base.geocoder`, `base.geo_provider` (`addons/base_geolocalize/models/base_geocoder.py`) |
| `addons/base_address_extended` | Splits the free-text address into `street_name`, `street_number`, `street_number2` and adds the `res.city` model with per-country city lists. | `res.city` (`addons/base_address_extended/models/res_city.py`), `res.partner` |
| `addons/base_report_wkhtmltox`, `addons/base_report_paper_muncher` | Report engines: the two external renderers (`wkhtmltopdf` and the Paper Muncher/Chrome path) that turn QWeb HTML into PDF. `base_report_wkhtmltox` is `auto_install`. | `ir.actions.report` extensions only |
| `addons/web_tour` | The onboarding tour engine: `web_tour.tour` records plus the step model, driven from the web client. `auto_install`, depends on `web`. See [onboarding tours](../features/onboarding-tours.md). | `web_tour.tour`, `web_tour.tour.step` (`addons/web_tour/models/tour.py`) |

## Key abstractions

`ir.*` models:

| Model | File | What it does |
| --- | --- | --- |
| `ir.access` | `odoo/addons/base/models/ir_access.py` | One record per model, group, and CRUD subset; with a domain it restricts, without one it permits. Replaces `ir.model.access` and `ir.rule`; the ORM consults it on every call. See [security](../security.md). |
| `ir.model`, `ir.model.fields` | `odoo/addons/base/models/ir_model.py` | Introspection rows for every model and field; `ir.model.data` stores external IDs (xmlids). |
| `ir.ui.view`, `ir.ui.menu` | `odoo/addons/base/models/ir_ui_view.py`, `odoo/addons/base/models/ir_ui_menu.py` | View archs (validated against `odoo/addons/base/rng/`) and the menu tree. |
| `ir.actions.*` | `odoo/addons/base/models/ir_actions.py`, `odoo/addons/base/models/ir_actions_report.py` | Window, URL, client, server, and report actions. |
| `ir.cron` + `ir.cron.trigger` | `odoo/addons/base/models/ir_cron.py` | Scheduled jobs; `_process_jobs` runs in the cron worker. |
| `ir.http` | `odoo/addons/base/models/ir_http.py` | Builds the routing map from all loaded controllers, handles auth (`user`, `public`, `none`, `bearer`) and dispatch. |
| `ir.attachment` + bundles | `odoo/addons/base/models/ir_attachment.py`, `odoo/addons/base/models/assetsbundle.py` | Binary storage in the filestore; `AssetsBundle` compiles JS/SCSS into the bundles served to the browser. |
| `ir.asset` | `odoo/addons/base/models/ir_asset.py` | Asset declarations stored as records: bundle name, directive (append/prepend/before/after/remove/replace/include), path or glob, target, sequence. `_get_asset_paths` merges them with each module's manifest `assets` list — low-sequence `ir.asset` rows first, then the manifests, then the rest. See [assets](../systems/assets.md). |
| `ir.qweb` + `ir.qweb.field.*` | `odoo/addons/base/models/ir_qweb.py`, `odoo/addons/base/models/ir_qweb_fields.py` | The QWeb template engine and its field renderers. |
| `ir.config_parameter` | `odoo/addons/base/models/ir_config_parameter.py` | Key/value system parameters, e.g. `web.web_app_name`. |

`res.*` models:

| Model | File | What it does |
| --- | --- | --- |
| `res.partner` | `odoo/addons/base/models/res_partner.py` | Companies and contacts; inherits `format.address.mixin`, `format.vat.label.mixin`, `avatar.mixin`, `properties.base.definition.mixin`. |
| `res.company` | `odoo/addons/base/models/res_company.py` | Companies, the root of multi-company. |
| `res.users` | `odoo/addons/base/models/res_users.py` | Login users, preferences, API keys, sessions. |
| `res.groups` + `res.groups.privilege` | `odoo/addons/base/models/res_groups.py`, `odoo/addons/base/models/res_groups_privilege.py` | Access groups; 20.0 groups them under "privileges" (`odoo/addons/base/security/base_groups.xml`). |
| `res.lang`, `res.currency`, `res.country` | `odoo/addons/base/models/res_lang.py`, `odoo/addons/base/models/res_currency.py`, `odoo/addons/base/models/res_country.py` | Localization vocabulary loaded from `odoo/addons/base/data/`. |
| `res.config.settings` | `odoo/addons/base/models/res_config.py` | Transient settings model; apps add fields by `_inherit` bound to `config_parameter` keys or `related` company fields. |

## How it works

`base` loads before every other module; everything downstream assumes its tables exist.

```mermaid
graph TD
    start["odoo-bin start"] --> load["load_modules() (odoo/modules/loading.py)"]
    load -->|"loads base first"| models["ir.model / ir.model.fields rows<br/>(odoo/addons/base/models/ir_model.py)"]
    models --> registry["per-database Registry (odoo/orm/registry.py)"]
    registry --> http["ir.http routing map (odoo/addons/base/models/ir_http.py)"]
    registry --> access["ir.access rows (odoo/addons/base/models/ir_access.py)"]
    request["HTTP request"] --> http
    http --> orm["ORM call"]
    orm -->|"every CRUD checks"| access
    orm --> db[("PostgreSQL")]
```

The settings pattern every app copies: `_inherit` of `res.config.settings` adds a field, and its `config_parameter` or `related` binding writes through to `ir.config_parameter` or `res.company` on save (`execute` in `odoo/addons/base/models/res_config.py`). CRM's copy is `addons/crm/models/res_config_settings.py`.

Two things older Odoo documentation still mentions are gone in 20.0:

- `ir.rule` no longer exists; access rights and record rules are unified in `ir.access`, enforced through per-model access domains in the ORM.
- `ir.translation` no longer exists. Translated field values live as JSONB on the model's own table (`odoo/orm/fields.py:891`); code and UI terms load from each module's `i18n/*.po` files via `odoo/tools/translate.py`.

## Integration points

- The registry builds model classes from the loaded modules, and HTTP dispatch goes through `ir.http`.
- Every addon's security file is an `ir.access.csv` referencing `base.group_*` groups from `odoo/addons/base/security/base_groups.xml`; the whole model, including what the ORM checks on every call, is in [security](../security.md).
- `addons/web` stores compiled asset bundles as `ir.attachment` rows and reads `ir.config_parameter` for `web.web_app_name`.
- The `base_*` addons extend `ir.actions.server` (`addons/base_automation/models/ir_actions_server.py`), `ir.module.module` (`addons/base_install_request/models/ir_module_module.py`, `addons/base_import_module/models/ir_module.py`) and `ir.actions.report` (both report engines). That is the pattern to copy: a system service adds a model near zero business code.
- Other modules extend base models from outside: `addons/mail/models/ir_access.py` (chatter tracking on `ir.access`), `addons/mail/models/ir_cron.py` (chatter and `_notify_admin`), `addons/crm/models/res_partner.py` (CRM partner fields).

## Entry points for modification

In this fork `odoo/addons/base/` is off-limits: `AGENTS.md` restricts changes to `addons/crm/` so the fork stays rebasable on upstream 20.0. Extend base behavior with `_inherit` inside `addons/crm/models/`, add settings through `res.config.settings`, and never add or change access rules or groups; the offline cache must not widen what a user can see.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/addons/base/models/ir_access.py` | The unified access model. |
| `odoo/addons/base/models/ir_model.py` | Model and field introspection, external IDs. |
| `odoo/addons/base/models/ir_ui_view.py` | View archs, inheritance, validation. |
| `odoo/addons/base/models/ir_ui_menu.py` | Menu tree and visibility filtering. |
| `odoo/addons/base/models/ir_actions.py` | Action primitives used by every app. |
| `odoo/addons/base/models/ir_cron.py` | Scheduled jobs and triggers. |
| `odoo/addons/base/models/ir_http.py` | Routing map, auth methods, dispatch. |
| `odoo/addons/base/models/ir_asset.py` | `ir.asset` records and `_get_asset_paths`, which merges them with the manifests. |
| `odoo/addons/base/models/ir_attachment.py` | Attachments and the filestore. |
| `odoo/addons/base/models/assetsbundle.py` | JS/CSS bundle compilation. |
| `odoo/addons/base/models/ir_qweb.py` | QWeb template engine. |
| `odoo/addons/base/models/res_partner.py` | Partners plus the address and VAT mixins. |
| `odoo/addons/base/models/res_users.py` | Users, groups, API keys, sessions. |
| `odoo/addons/base/models/res_config.py` | `res.config.settings`, the settings pattern. |
| `odoo/addons/base/security/base_groups.xml` | The `base.group_*` groups every access CSV references. |
| `addons/base_setup/models/res_config_settings.py` | The Settings app's own fields and defaults. |
| `addons/base_import/models/base_import.py` | `base_import.import`: file parsing, field mapping, load. |
| `addons/base_automation/models/base_automation.py` | `base.automation` rules and their triggers. |
| `addons/base_geolocalize/models/base_geocoder.py` | `base.geocoder` / `base.geo_provider` and the OSM request. |
| `addons/base_address_extended/models/res_partner.py` | `street_name`, `street_number`, `street_number2`. |
| `addons/web_tour/models/tour.py` | `web_tour.tour` and `web_tour.tour.step`. |

## Related pages

- [Mail and messaging](mail.md), the chatter and activity layer built on these groups and users.
- [CRM](crm/index.md), the app consuming the settings and mixin patterns.
- [Web client](web/index.md), the asset bundles `ir.attachment` serves.
- [Module system](../systems/module-system.md), how `base` loads first.
- [ORM](../systems/orm.md), the access checks `ir.access` feeds.
- [Security](../security.md), the four layers around `ir.access` and `res.users`.
- [Assets](../systems/assets.md), how `ir.asset`, the manifests and `AssetsBundle` combine.
- [Onboarding tours](../features/onboarding-tours.md), the `web_tour` engine in use.
- [Users, groups and access](../primitives/users-groups-and-access.md)
- [Actions, views and menus](../primitives/actions-views-menus.md)
- [Companies and multi-company](../primitives/companies-and-multi-company.md)
- [Cron and scheduled actions](../primitives/cron-and-scheduled-actions.md)
- [Translations](../primitives/translations.md)
