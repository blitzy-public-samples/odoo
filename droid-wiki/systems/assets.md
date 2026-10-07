# Assets
Active contributors: Christophe, Krzysztof, Raphael

## Purpose

Odoo turns JavaScript, stylesheets, and QWeb templates declared by installed addons into named web asset bundles. The bundle resolver and compiler live in `odoo/addons/base/models/ir_asset.py` and `odoo/addons/base/models/assetsbundle.py`; generated output is stored as public `ir.attachment` records rather than committed build files. This page covers the server side of that pipeline; the client-side consumer of the resulting bundles is the web client in [addons/web](../apps/web/index.md).

## Directory layout

```text
odoo/addons/base/models/
├── ir_asset.py          # manifest and ir.asset directive resolution
├── assetsbundle.py      # bundle compilation, checksums, attachment creation
├── ir_qweb.py           # HTML asset links and bundle pregeneration
└── ir_attachment.py     # deletes generated bundles for regeneration
addons/crm/__manifest__.py
scripts/dev/rebuild-assets.sh
```

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| `ir.asset` | `odoo/addons/base/models/ir_asset.py` | Model and resolver for manifest declarations and database asset directives. |
| `AssetPaths` | `odoo/addons/base/models/ir_asset.py` | Ordered, de-duplicated list on which asset directives operate. |
| `AssetsBundle` | `odoo/addons/base/models/assetsbundle.py` | Compiles JS, CSS, templates, and binary assets and persists output. |
| `ir.qweb` | `odoo/addons/base/models/ir_qweb.py` | Builds asset links used by rendered pages and pregenerates referenced bundles. |
| `ir.attachment` | `odoo/addons/base/models/ir_attachment.py` | Stores generated bundles; `regenerate_assets_bundles()` drops them. |

## How it works

An addon manifest's `assets` mapping contributes paths or directives to a named bundle. `IrAsset._get_asset_paths()` first applies low-sequence `ir.asset` records, then installed addons' manifests in topological order, then remaining records. A directive is one of `append`, `prepend`, `after`, `before`, `remove`, `replace`, or `include` (`odoo/addons/base/models/ir_asset.py:17-24`); `after`/`before`/`replace`/`remove` take a target path, and every path must resolve inside an installed addon's `static/` directory. `AssetPaths` keeps the result ordered and de-duplicated.

`AssetsBundle` separates source files by extension, compiles stylesheets (SCSS to CSS), combines JavaScript and QWeb templates, and gives each output a checksum-derived URL such as `/web/assets/<version>/...`. `save_attachment()` creates a public `ir.attachment` linked to `ir.ui.view` with `res_id=0`, then removes obsolete versions. `ir.qweb` requests those bundles while rendering pages, creating them when absent; `_pregenerate_assets_bundles()` (`odoo/addons/base/models/ir_qweb.py:3047`) builds every bundle referenced by a template up front, which is what an update does.

```mermaid
graph LR
    M["Addon manifest assets"] -->|"paths and directives"| IA["ir.asset resolver"]
    R["ir.asset records"] -->|"ordered directives"| IA
    IA -->|"ordered source list"| B["AssetsBundle"]
    B -->|"JS CSS templates"| A["ir.attachment"]
    Q["ir.qweb page rendering"] -->|"request links"| B
    A -->|"versioned URLs"| C["Browser"]
```

The backend bundle is normally `web.assets_backend`; `web.assets_backend_lazy` contains code fetched later. Test tours belong in `web.assets_tests`, and browser unit-test sources in `web.assets_unit_tests`. The CRM manifest, `addons/crm/__manifest__.py`, demonstrates all four. Its backend declaration adds `crm/static/src/**`, then removes feature directories that are declared again in `web.assets_backend_lazy`. Keep that paired `('remove', ...)` plus lazy declaration pattern when moving a directory out of the initial backend load, otherwise it can be shipped twice or not at all.

### registry_hash

`addons/web/models/ir_http.py` exposes `registry_hash` in browser session information. It is an HMAC over the registry sequence, so clients can distinguish a changed registry. In this fork, the browser's offline local store uses `session.registry_hash + CRYPTO_ALGO` as its `IndexedDB` version, so a changed bundle registry also drops queued writes along with the caches. See [local store](../features/offline-and-pwa/local-store.md) for that client-side behavior.

## Integration points

- The module loader reads manifest asset declarations as part of installed-addon resolution. See [module system](module-system.md).
- QWeb templates call assets through `odoo/addons/base/models/ir_qweb.py`; `ir.attachment.regenerate_assets_bundles()` (`odoo/addons/base/models/ir_attachment.py:998`) deletes every generated asset attachment.
- The web client's `registry_hash`, `session.js` and service worker consume the resulting URLs; see [web client](../apps/web/index.md) and [service worker and install](../features/offline-and-pwa/service-worker-and-install.md).
- `scripts/dev/rebuild-assets.sh` stops the development server, deletes generated bundles, pregenerates them, and commits the result. It exists because the server can retain assets in memory.

## Entry points for modification

Add ordinary CRM front-end source below `addons/crm/static/src/`; its existing glob already includes it in `web.assets_backend`. Change `addons/crm/__manifest__.py` only when selecting a bundle, adding test-only assets, or making an intentional lazy split. Do not judge a front-end change with old generated attachments: run `scripts/dev/rebuild-assets.sh` after every JS, CSS, SCSS, or XML change, then run tests. A module upgrade or server restart also regenerates bundles, but stale bundles can otherwise produce false failures.

## Key source files

| File | Purpose |
| --- | --- |
| `odoo/addons/base/models/ir_asset.py` | Resolves bundle directives and static-file paths. |
| `odoo/addons/base/models/assetsbundle.py` | Compiles, versions, saves, and cleans bundle attachments. |
| `odoo/addons/base/models/ir_qweb.py` | Produces asset links and pregenerates required bundles. |
| `odoo/addons/base/models/ir_attachment.py` | Removes generated asset attachments for a rebuild. |
| `addons/web/models/ir_http.py` | Places `registry_hash` in session information. |
| `addons/crm/__manifest__.py` | CRM bundle declarations and lazy exclusion pairs. |
| `scripts/dev/rebuild-assets.sh` | Fork wrapper that regenerates development database assets. |

## Related pages

- [Module system](module-system.md)
- [Server runtime](server-runtime.md)
- [Web client](../apps/web/index.md)
- [Local store](../features/offline-and-pwa/local-store.md)
- [Service worker and install](../features/offline-and-pwa/service-worker-and-install.md)
- [Testing](../how-to-contribute/testing.md)
