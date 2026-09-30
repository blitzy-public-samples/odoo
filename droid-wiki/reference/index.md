# Reference
Active contributors: Odoo SA (upstream)

## Purpose

These pages are lookup material for engineers working in the Odoo 20.0
offline-CRM fork. They cover server configuration, the core data model, and
the Python and JavaScript dependency boundaries without attempting to document
every option, model, or package.

## Directory layout

```text
droid-wiki/reference/
  index.md
  configuration.md
  data-models.md
  dependencies.md
```

## Key abstractions

| Topic | Source | Use |
|---|---|---|
| Configuration manager | `odoo/tools/config.py` | Maps CLI, environment, config files, and defaults into a ChainMap. |
| Database parameters | `odoo/addons/base/models/ir_config_parameter.py` | Stores database-specific string parameters with typed accessors. |
| Registry models | `odoo/addons/base/models/` | Defines `ir.*` and `res.*` records used by every addon. |
| Dependency boundary | `requirements.txt` and addon `static/lib/` trees | Keeps Python pins and browser libraries explicit, with no npm build layer. |

## How it works

The reference pages follow the path from process startup to a loaded database:
configuration selects the server and database, the registry exposes model
schemas, and declared Python or vendored browser dependencies provide runtime
behavior. The [module system](../systems/module-system.md) then loads addon
manifests and data into that registry.

## Integration points

Configuration is consumed by the [server runtime](../systems/server-runtime.md)
and development scripts. The model page complements the [base
addon](../apps/base.md), [ORM](../systems/orm.md), and [CRM](../apps/crm/index.md)
pages. Dependency choices affect [assets](../systems/assets.md) and the
fork's [tooling](../how-to-contribute/tooling.md).

## Entry points for modification

Use `configuration.md` before adding a server flag or environment override,
and check `requirements.txt` before changing a Python pin. Use
`data-models.md` and the ORM introspection examples before adding or altering
model fields.

## Key source files

| File | Purpose |
|---|---|
| `odoo/tools/config.py` | CLI, environment, config-file, and default option handling. |
| `odoo/addons/base/models/ir_config_parameter.py` | Database parameter storage and typed access. |
| `requirements.txt` | Repository Python dependencies and version markers. |
| `addons/populate/requirements.txt` | The only addon-specific Python dependency file. |
| `addons/web/__manifest__.py` | Web asset declarations and vendored libraries. |
| `addons/crm/models/crm_lead.py` | CRM schema reference. |

## Related pages

- [Configuration](configuration.md)
- [Data models](data-models.md)
- [Dependencies](dependencies.md)
- [Base](../apps/base.md)
- [ORM](../systems/orm.md)
