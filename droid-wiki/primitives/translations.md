# Translations

Active contributors: Martin, Christophe, Chong

## Purpose

Every addon ships its own translations as gettext `.po` files under `i18n/`. The working tree contains 20,257 `.po` files and 603 `.pot` templates; `addons/crm/i18n/` alone has 62 `.po` language files (plus its `crm.pot` template). Odoo 20.0 splits translated strings into two kinds with different storage: **code terms**, read straight from the `.po` files at runtime, and **model terms**, stored per language inside the record's own jsonb column. There is no `ir.translation` table in this version.

## Directory layout

```text
odoo/tools/translate.py                     # the whole i18n toolchain (2,759 lines)
odoo/cli/i18n.py                            # odoo-bin i18n import|export|loadlang
odoo/addons/base/models/ir_module.py        # _load_module_terms at install/upgrade
odoo/addons/base/models/res_lang.py         # language activation
addons/web/controllers/webclient.py         # /web/webclient/translations
addons/web/static/src/core/l10n/translation.js   # _t() in the client
addons/<module>/i18n/<lang>.po              # per-addon, per-language terms
addons/<module>/i18n_extra/<lang>.po        # optional overrides
```

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| Code terms | `odoo/tools/translate.py` | Strings wrapped in `_()`, `env._()`, `_lt()` in Python or `_t()` in JS; looked up in `.po` at runtime. |
| Model terms | `odoo/orm/fields.py` | Values of fields declared `translate=True` (or `xml_translate` / `html_translate`), stored in a jsonb column keyed by language. |
| `CodeTranslations` | `odoo/tools/translate.py` | Process-level cache of code terms per `(module, lang)`, split into Python and web dictionaries. |
| `TranslationImporter` | `odoo/tools/translate.py` | Reads `.po` / `.csv` and writes terms, honouring `overwrite` and `noupdate`. |
| `get_po_paths` | `odoo/tools/translate.py` | Resolves which files to load for a language, across `i18n/` and `i18n_extra/`. |
| `_load_module_terms` | `odoo/addons/base/models/ir_module.py` | Loads a module's `.po` files for the active languages at install and upgrade. |

## How it works

### Two storages

A field marked `translate` gets a `jsonb` column instead of its native type (`odoo/orm/fields.py`), holding one entry per language, so a record's translations follow it without a side table. `ir.ui.view.arch_db` uses `translate=xml_translate`, which walks the XML and translates only text nodes and translatable attributes; `ir.actions.actions.name` and `ir.ui.menu.name` are plain `translate=True`. The only trace of the old design is `_get_translation_upgrade_queries` in `odoo/tools/translate.py`, which migrates data out of the legacy `_ir_translation` table.

Code terms are never stored in the database. `CodeTranslations._get_code_translations` opens the module's `.po` files and keeps the entries whose PO comments carry a marker: `odoo-python` for Python terms, `odoo-javascript` for web terms. The result is memoized per `(module, lang)`. `_lt` (`LazyGettext`) covers strings defined at import time, before any environment exists; `odoo/addons/base/models/ir_access.py` uses it for its access-error templates.

### Reading and writing a field's translations

A field's translations go through methods on `Model` in `odoo/orm/models.py`: `get_field_translations(field_name, langs=None)` returns a `(translations, context)` pair, where `translations` is a list of `{"lang", "source", "value"}` dicts, and `update_field_translations(field_name, translations, source_lang="")` — with the private `_update_field_translations` doing the work — writes them back into the jsonb column. There is no `_get_field_translations` method in 20.0; those two are the current entry points.

### Loading

`get_po_paths(module, lang)` yields candidates for each base language before the exact code, so `fr_BE` loads `fr` then `fr_BE`, and it looks in both `i18n/` and `i18n_extra/`. `get_base_langs` encodes two special chains: Latin-American Spanish variants also load `es_419`, and `zh_HK` also loads `zh_TW`.

At install or upgrade, `_load_module_terms` feeds every matching `.po` file plus the module's XML/CSV data files into a `TranslationImporter`, then calls `save(overwrite=...)`; records marked `noupdate` keep their existing terms unless the overwrite is forced. Activating a new language goes through the `base.language.install` wizard, which `load_language()` wraps; `--load-language` on the command line reaches it from `odoo/modules/loading.py`.

### Client side

`/web/webclient/translations` (`addons/web/controllers/webclient.py`, `type='http'`, `auth='public'`, `readonly=True`, `cors='*'`) calls `ir.http._get_translations_for_webclient`, which returns the web-marked terms per module plus the language parameters. Terms are fetched at runtime per module; they are not baked into the asset bundles.

`addons/web/static/src/core/l10n/localization_plugin.js` fetches that route (or `session.translationURL`), fills `translatedTerms` keyed by module and `translatedTermsGlobal` as the fallback, then flips `translatedTerms[translationLoaded] = true`. In the browser, `_t(source, ...substitutions)` in `addons/web/static/src/core/l10n/translation.js` looks the source string up and interpolates: iterables are rendered with `Intl`-based list formatting, and if any substitution is markup the whole result is escaped and returned as markup. The transpiler rewrites each `_t(...)` call into `appTranslateFn(source, moduleName, ...)`, so a term resolves in its own module's namespace first and the same word can translate differently in `pos` and `spreadsheet`. A `LazyTranslatedString` created before loading throws if it is evaluated before `translatedTerms[translationLoaded]` is set. `ir.http._get_web_translations_hash` (`@api.ormcache`) keys the cached payload on the module list and the language.

QWeb templates use `t-lang`, which the parser rewrites to `t-options-lang` and accepts only on the same node as `t-call` (`odoo/addons/base/models/ir_qweb.py:2746`) — it is an argument to a called template, not a general attribute.

### Tooling

`odoo-bin i18n` (`odoo/cli/i18n.py`) has three subcommands: `import` (`.po`, `.csv`), `export` (`.po`, `.pot`, `.tgz`, `.csv`, written into each module's `i18n` folder), and `loadlang`. Language codes follow the XPG locale format, so `sr@latin` rather than a BCP-47 tag. Export runs through `TranslationModuleReader`, with extractors for QWeb templates (`babel_extract_qweb`) and spreadsheet formulas (`extract_spreadsheet_terms`).

Two support addons exercise this machinery: `odoo/addons/test_translation` for the import/export and field-translation paths, and `addons/test_translation_mode`, an interactive in-context translation mode backed by Weblate whose manifest warns that it injects invisible metadata into translated strings and must not run on production databases.

## Integration points

- View archs are translated through `ir.ui.view.arch_db`, so translation interacts with view inheritance (see [actions, views, and menus](actions-views-menus.md)).
- QWeb report templates accept `t-lang` to render a called template in another language, which is how a report or mail can be printed in the customer's language rather than the user's.
- Menu and template caches are keyed on language; `ir.ui.menu.load_menus` is ormcached on `self.env.lang`.

## Entry points for modification

Wrap new user-facing Python strings in `self.env._(...)` and new client strings in `_t(...)`, then regenerate the module's `.pot` with `odoo-bin i18n export`; never hand-edit `.po` entries that come from source. To make a field translatable, add `translate=True` and let the jsonb column do the rest.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/tools/translate.py` | Readers, writers, `CodeTranslations`, `TranslationImporter`, `get_po_paths`, XML/HTML term walking. |
| `odoo/cli/i18n.py` | The `odoo-bin i18n` command: `import`, `export`, `loadlang`. |
| `odoo/orm/fields.py` | jsonb storage for `translate` fields. |
| `odoo/addons/base/models/ir_module.py` | `_load_module_terms` at install and upgrade. |
| `odoo/addons/base/models/res_lang.py` | Language records and activation. |
| `odoo/addons/base/models/ir_ui_view.py` | `arch_db` with `translate=xml_translate`. |
| `odoo/orm/models.py` | `get_field_translations` / `update_field_translations` for model terms. |
| `addons/web/static/src/core/l10n/localization_plugin.js` | Fetches and installs the web terms; `translationLoaded` flag. |
| `addons/web/controllers/webclient.py` | `/web/webclient/translations`. |
| `addons/web/static/src/core/l10n/translation.js` | `_t()` and substitution handling. |
| `odoo/addons/test_translation/` | Framework tests for translation import/export. |
| `addons/test_translation_mode/` | Interactive in-context translation mode (not for production). |
| `addons/crm/i18n/` | 62 `.po` language files (plus `crm.pot`), the shape every addon follows. |

## Related pages

- [Actions, views, and menus](actions-views-menus.md)
- [Module system](../systems/module-system.md)
- [CLI and maintenance](../systems/cli-and-maintenance.md)
- [base addon](../apps/base.md)
- [Glossary](../overview/glossary.md)
