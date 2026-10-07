# Reference

## Purpose

This directory is the lookup shelf of the wiki. The pages here answer
"which knob do I turn", "where does this model live", and "what does the
codebase depend on" — without retelling how a subsystem works (that lives
in [systems](../systems/index.md) and [features](../features/index.md)).
Who maintains what lives in a separate root page, [Maintainers](../maintainers.md).

## What is here

| Page | One-liner |
| --- | --- |
| [Configuration](configuration.md) | Every knob: `odoo-bin` flags, the `odoo.conf` file, environment variables, the `scripts/dev/` overrides and `--https` mode, Odoo system parameters, and the browser-side session config. |
| [Data models](data-models.md) | The data layer as a map: model definition attributes, field types, constraints, the core `ir.*` / `res.*` / `crm.*` / `mail.*` / `account.*` models, inheritance patterns, and where schema changes happen. |
| [Dependencies](dependencies.md) | What the codebase needs to run: `requirements.txt` pins per Ubuntu/Debian release, vendored JS libraries, PostgreSQL minimum, PDF engines, asset compilation, and the external services CRM can call. |

## Where to look first

| Task | Go to |
| --- | --- |
| Add or change a server option | [Configuration](configuration.md), then `odoo/tools/config.py` |
| Point the server at another database or port | [Configuration](configuration.md) (process options), or `scripts/dev/_common.sh` for the dev environment |
| Find the model behind a table, field, or constraint | [Data models](data-models.md) |
| Extend a model owned by another addon | [Data models](data-models.md), and the conventions in `AGENTS.md` |
| Check whether a Python package or JS library is already available | [Dependencies](dependencies.md) |
| Find who last touched a subsystem | [Maintainers](../maintainers.md) |

## Neighboring reference material

The wiki keeps other lookup-style material outside this directory:

- [Glossary](../overview/glossary.md) — short definitions of the terms used everywhere.
- [Primitives](../primitives/index.md) — cross-cutting mechanisms (actions/views/menus, users/groups, companies, cron, translations).
- [Systems](../systems/index.md) — how the server actually works: [ORM](../systems/orm.md), [module system](../systems/module-system.md), [HTTP server](../systems/http-server.md), [assets](../systems/assets.md), [test framework](../systems/test-framework.md), [CLI and maintenance](../systems/cli-and-maintenance.md).
- [Security](../security.md) — how secrets and access control are handled; the configuration page defers to it for secret handling.
- [Deployment](../deployment.md) and [By the numbers](../by-the-numbers.md) — running the server elsewhere and repository-wide counts (including dependency counts).

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/tools/config.py` | All process options: CLI flags, config file, environment mapping, defaults, precedence. |
| `odoo/addons/base/models/ir_config_parameter.py` | Per-database system parameters (`ir.config_parameter`). |
| `odoo/release.py` | Version constants: `MIN_PY_VERSION`, `MAX_PY_VERSION`, `MIN_PG_VERSION`. |
| `requirements.txt` | The pinned Python dependencies, per Ubuntu/Debian release. |
| `addons/web/__manifest__.py` | Web asset bundles and where vendored JS libraries ship. |
| `addons/crm/models/res_config_settings.py` | The CRM settings and the `crm.*` system parameters they write. |
| `scripts/dev/_common.sh` | The dev-environment variable defaults (`ODOO_DB`, ports, credentials). |

## Related pages

- [Configuration](configuration.md)
- [Data models](data-models.md)
- [Dependencies](dependencies.md)
- [Maintainers](../maintainers.md)
- [Getting started](../overview/getting-started.md)
