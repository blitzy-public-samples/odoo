# Primitives

Active contributors: Krzysztof, Rémy, Raphael

## Purpose

Primitives are the domain objects that every Odoo addon builds on. They are defined once in the `base` module (`odoo/addons/base/`) and the ORM, and then reused by all 642 addons: an action opens a view, a view belongs to a menu, a menu is filtered by groups, a group grants access through `ir.access`, records are scoped by company, background work runs through `ir.cron`, and every user-visible string passes through the translation machinery.

These pages describe each primitive from the server model outward: the record that stores it, the code that enforces or interprets it, and the point where the web client consumes it. They are cross-cutting, so the same concepts reappear in `addons/crm` and in `addons/web` without being redefined there.

## The primitives

| Page | What it covers |
| --- | --- |
| [Actions, views, and menus](actions-views-menus.md) | `ir.actions.*` record types, `ir.ui.view` arch and xpath inheritance, `ir.ui.menu` trees, and how the web client turns an action into a rendered view with a `js_class`. |
| [Users, groups, and access](users-groups-and-access.md) | `res.users`, `res.groups` with implied groups, the unified `ir.access` model that replaced `ir.model.access` plus `ir.rule` in 20.0, field-level `groups=`, and `sudo()` / `with_user()`. |
| [Companies and multi-company](companies-and-multi-company.md) | `res.company`, the allowed-companies context, `company_dependent` fields stored as jsonb, the standard company-isolation access domain, and per-company sequences and defaults. |
| [Cron and scheduled actions](cron-and-scheduled-actions.md) | The `ir.cron` model delegating to `ir.actions.server`, `_process_jobs` job acquisition, `ir.cron.trigger` with the `cron_trigger` PostgreSQL notification, and the CRM assignment and scoring crons. |
| [Translations](translations.md) | `.po` files per addon, code terms versus model terms (jsonb columns, no `ir.translation` table in 20.0), `odoo-bin i18n`, and `_t()` in the web client. |

## Where they are defined

Every primitive lives in `base` or the ORM; addons only ship data for them. The full paths, all repo-root relative:

| Primitive | Main source |
| --- | --- |
| Actions | `odoo/addons/base/models/ir_actions.py`, `odoo/addons/base/models/ir_actions_report.py` |
| Views | `odoo/addons/base/models/ir_ui_view.py` |
| Menus | `odoo/addons/base/models/ir_ui_menu.py` |
| Users | `odoo/addons/base/models/res_users.py` |
| Groups and access | `odoo/addons/base/models/res_groups.py`, `odoo/addons/base/models/ir_access.py`, `odoo/orm/models.py` |
| Companies | `odoo/addons/base/models/res_company.py`, `odoo/orm/environments.py` |
| Scheduled actions | `odoo/addons/base/models/ir_cron.py`, `odoo/service/server.py` |
| Translations | `odoo/tools/translate.py`, `odoo/orm/fields.py` |

## Related pages

- [ORM](../systems/orm.md)
- [Module system](../systems/module-system.md)
- [base addon](../apps/base.md)
- [Data models](../reference/data-models.md)
- [Glossary](../overview/glossary.md)
