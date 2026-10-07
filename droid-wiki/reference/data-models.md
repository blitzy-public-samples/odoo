# Data models

## Purpose

A map of the data layer, at reference depth: how models are declared, which
field types and constraint kinds exist, where the core models live, which
inheritance pattern to pick for a given extension, and where schema changes
happen. It points into the code; it does not catalog every field. For how the
ORM executes all this, read [ORM](../systems/orm.md); for how models get
loaded into the registry, [Module system](../systems/module-system.md).

## Model definition attributes

Models are Python classes inheriting `Model`, `AbstractModel`, or
`TransientModel` (exported from `odoo/models/__init__.py`, defined in
`odoo/orm/models.py` and `odoo/orm/models_transient.py`). The class
attributes the ORM reads (`odoo/orm/models.py:428-482`):

| Attribute | Default | Meaning |
| --- | --- | --- |
| `_name` | — | Model name in dot-notation (e.g. `crm.lead`). Absent on `_inherit`-only extensions. |
| `_description` | `None` | Informal name used in logs and the UI. |
| `_inherit` | `()` | Model(s) to extend: a string, or a list for mixins. Same `_name` (or none) extends in place; a new `_name` + `_inherit` creates a copy under a new name. |
| `_inherits` | `{}` | Delegation: `{parent_model: m2o_field}` — parent columns readable/writable through the child. Example: `res.users` → `{'res.partner': 'partner_id'}` (`odoo/addons/base/models/res_users.py`). |
| `_rec_name` | `'name'` | Field used as the record label (`display_name` builds on it). |
| `_rec_names_search` | `()` | Extra fields searched by `name_search`. |
| `_order` | `'id'` | Default `search()` order. Example: `crm.lead` uses `"priority desc, id desc"` (`addons/crm/models/crm_lead.py`). |
| `_parent_name` | `'parent_id'` | The many2one used as the tree parent (`res.partner`, `crm.stage`...). |
| `_parent_store` | `False` | Maintain `parent_path` for subtree reads on parent-structured models. |
| `_active_name` | `None` | Archiving field if not `active`. |
| `_auto` / `_transient` | `True` / per class | Table creation; `TransientModel` sets `_transient=True` (auto-vacuumed, see `odoo/orm/models_transient.py`). |

`AbstractModel` classes are the mixins: `mail.thread`, `mail.activity.mixin`,
`utm.mixin`, ... A concrete model lists them in `_inherit` — `crm.lead`
inherits `mail.thread.subject.suggested`, `mail.thread.blacklist`,
`mail.thread.phone`, `mail.activity.mixin`, `utm.mixin`,
`format.address.mixin`, `mail.tracking.duration.mixin`
(`addons/crm/models/crm_lead.py`).

## Field types

`odoo/fields/__init__.py` is the public import surface
(`from odoo import fields`); the implementations live in
`odoo/orm/fields_*.py`:

| Module | Types |
| --- | --- |
| `odoo/orm/fields_misc.py` | `Id`, `Json`, `Boolean` |
| `odoo/orm/fields_numeric.py` | `Integer`, `Float`, `Monetary` |
| `odoo/orm/fields_textual.py` | `Char`, `Text`, `Html` |
| `odoo/orm/fields_selection.py` | `Selection` |
| `odoo/orm/fields_temporal.py` | `Date`, `Datetime` |
| `odoo/orm/fields_relational.py` | `Many2one`, `One2many`, `Many2many` |
| `odoo/orm/fields_reference.py` | `Reference`, `Many2oneReference` |
| `odoo/orm/fields_binary.py` | `Binary`, `Image` |
| `odoo/orm/fields_properties.py` | `Properties`, `PropertiesDefinition` |

`Command` (write commands for relational fields) and `Domain` are
imported from `odoo/orm/commands.py` and `odoo/orm/domains.py` through the
same package.

### Field behavior flags

Common constructor arguments with their file anchor
(`odoo/orm/fields.py:264-315`):

| Flag | Effect |
| --- | --- |
| `compute` / `compute_sudo` / `precompute` / `compute_sql` | Computed fields; `compute_sudo` recomputes as superuser, `precompute` forces computation at creation, `compute_sql` pushes the computation into SQL. |
| `store` | Persist in the database (default `True`). Non-stored computes are request-time values. |
| `related` | Follow a field path (e.g. `alias_full_name = fields.Char(related='alias_id.alias_full_name')` on `crm.team`). |
| `company_dependent` | One value per company: stored on the model table as a jsonb dict keyed by company id, with `ir.default` values as fallback (`odoo/orm/fields.py`). |
| `translate` | Per-language values: stored as jsonb on the model table (no separate `ir.translation` table in 20.0). |
| `groups` | Restrict visibility to given security groups. |
| `config_parameter` (settings fields) | On `res.config.settings`, mirror the value into an `ir.config_parameter` key — see [Configuration](configuration.md). |
| `default`, `required`, `readonly`, `copy`, `index`, `help` | The usual suspects. |

## Constraints

Three kinds, all verified in the 20.0 tree:

| Kind | Declaration | Example |
| --- | --- | --- |
| SQL constraint | Class attribute `models.Constraint('<sql>', '<message>')` — `CHECK (...)`, `UNIQUE (...)`, `FOREIGN KEY ...` (`odoo/orm/table_objects.py:88`). The legacy `_sql_constraints` list is no longer supported (`odoo/orm/model_classes.py` logs a warning). | `_key_uniq = models.Constraint('unique (key)', "Key must be unique.")` in `odoo/addons/base/models/ir_config_parameter.py`. |
| SQL index | `models.Index(...)` / `models.UniqueIndex(...)` class attributes, same file. | `_user_id_ref_id = models.Index('(user_id, ref_id)')` in `odoo/addons/base/models/ir_ui_view.py`. |
| Python constraint | `@api.constrains('field', ...)` method raising `ValidationError` (`odoo/orm/decorators.py`). | `_check_model_name` in `odoo/addons/base/models/ir_access.py`. |

There are also `@api.ondelete(at_uninstall=...)` hooks controlling unlink
behavior, and `@api.onchange` for form-time recomputation. SQL constraint
names must start with `_` on the class and must not end with `_not_null`
(PostgreSQL 18 reserves that suffix — `odoo/orm/table_objects.py:118-128`).

## Core models map

| Area | Models | Source |
| --- | --- | --- |
| Identity | `res.partner`, `res.users`, `res.company`, `res.groups`, `res.lang`, `res.currency`, `res.country` | `odoo/addons/base/models/res_*.py` |
| System | `ir.model`, `ir.model.fields`, `ir.module.module`, `ir.ui.view`, `ir.ui.menu`, `ir.actions.*` (window/report/server/url), `ir.cron`, `ir.sequence`, `ir.attachment`, `ir.asset`, `ir.config_parameter`, `ir.default`, `ir.exports`, `ir.filters`, `ir.mail_server`, `ir.http`, `ir.qweb`, `ir.actions.report` | `odoo/addons/base/models/` |
| Access control | `ir.access` — one model that replaces the old `ir.model.access` + `ir.rule` pair: a record with `model_id`, an optional `group_id` (set = permission, unset = global restriction), a `domain`, and per-operation flags (`odoo/addons/base/models/ir_access.py`) | same directory; the fork rule: never widen it — see [Users, groups, and access](../primitives/users-groups-and-access.md) |
| CRM | `crm.lead`, `crm.stage`, `crm.team`, `crm.team.member`, `crm.recurring.plan`, `crm.lost.reason`, `crm.lead.scoring.frequency`, `crm.lead.scoring.frequency.field` | `addons/crm/models/` |
| Messaging | `mail.message`, `mail.activity`, `mail.thread` (+ other mixins), `mail.mail`, `mail.template`, `mail.alias`, `discuss.*` | `addons/mail/models/` |
| Accounting | `account.move`, `account.move.line`, `account.account`, `account.journal`, ... | `addons/account/models/` |

## Inheritance patterns, with the fork's example

Which pattern to use is decided by what must change:

| Pattern | Declaration | When |
| --- | --- | --- |
| Extend in place | `_inherit = "some.model"` | Add fields or override methods on an existing model. |
| Mixin composition | `_inherit = ['mail.thread', ...]` | Attach generic behavior to a new model. |
| Delegation | `_inherits = {'parent.model': 'field'}` | Split storage over tables (`res.users` → `res.partner`). |
| Extension module | a new addon whose manifest `depends` on the owner | Any change to another addon's behavior — the only option this fork allows outside `addons/crm/`. |

The fork's canonical example is `addons/crm/models/mail_activity.py`:
`_inherit = "mail.activity"`, overriding `create` (with
`@api.model_create_multi`) so a queued offline
`mail.activity.create` — which replays `{res_model: 'crm.lead', res_id}`
verbatim, with no `res_model_id` — gets `res_model_id` mapped server-side,
only when `res_model == 'crm.lead'` and `res_id` is set; every other input
takes the stock `super().create()` path unchanged. The same file overrides
`action_create_calendar_event` to amend the returned action's context for
meetings scheduled from a lead. This is the shape every cross-addon override
in the fork follows: catch your case, delegate the rest to `super()`.

## Where schema changes happen

- **Install/update**: declaring or changing fields is enough. The ORM
  creates tables and columns during module load (`_auto`, registry setup in
  `odoo/orm/registry.py`); `ir.model` / `ir.model.fields` records track the
  schema for the UI. No handwritten DDL for ordinary column adds.
- **Data or destructive changes** (backfills, renames, splits) use migration
  scripts, handled by the `MigrationManager` in
  `odoo/modules/migration.py`: a `<module>/migrations/<version>/` folder with
  `pre-*.py`, `post-*.py`, `end-*.py` files defining
  `migrate(cr, installed_version)`. Version folders may be module versions
  or server-prefixed (`9.0.1.1` runs only on a 9.0 server); the special
  `0.0.0` folder runs on every version change (pre first, post/end last).
- **Upgrade service scripts** come from `<module>/upgrades/` and the
  server-side `--upgrade-path`; the in-tree `odoo/upgrade/` directory is
  empty (`.gitkeep`) in the community tree — Odoo SA's official data-upgrade
  scripts are not shipped here.
- **Source-code migration** is separate: `odoo/upgrade_code/*.py`
  (e.g. `owl3-migration.py`, `19.4-00-ir-access.py`) are applied by
  `odoo-bin upgrade_code` to rewrite module source across versions, not to
  migrate database content.

Verified: beyond `odoo/modules/migration.py` and per-module `migrations/`
folders, there is no schema-version framework (no Alembic-style tooling) in
this tree; the ORM's own setup is the primary schema mechanism.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/orm/models.py` | `BaseModel`, `Model`, model attributes, create/write/unlink. |
| `odoo/orm/fields.py` + `odoo/orm/fields_*.py` | Field class, behavior flags, all concrete field types. |
| `odoo/fields/__init__.py` | Public import surface (`from odoo import fields`). |
| `odoo/orm/table_objects.py` | `Constraint`, `Index`, `UniqueIndex` declarations. |
| `odoo/orm/model_classes.py` | Registry class assembly (definitions → model classes). |
| `odoo/orm/models_transient.py` | `TransientModel` and vacuum behavior. |
| `odoo/modules/migration.py` | Migration script discovery and execution. |
| `odoo/addons/base/models/ir_access.py` | `ir.access`, the 20.0 access model. |
| `addons/crm/models/mail_activity.py` | The fork's reference `_inherit` extension. |
| `addons/crm/models/crm_lead.py` | `crm.lead` and its mixin list. |

## Related pages

- [Reference](index.md)
- [ORM](../systems/orm.md)
- [Module system](../systems/module-system.md)
- [Base](../apps/base.md)
- [CRM](../apps/crm/index.md)
- [Users, groups, and access](../primitives/users-groups-and-access.md)
- [Companies and multi-company](../primitives/companies-and-multi-company.md)
