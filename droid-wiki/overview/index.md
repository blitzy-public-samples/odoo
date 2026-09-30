# Odoo 20.0 offline CRM fork

This repository is a fork of Odoo 20.0, the open-source business application suite. The fork exists for one purpose: an **offline-capable, installable-PWA CRM**. Sales people in the field open the CRM pipeline on a phone, go through tunnels and dead zones, and their edits survive: writes made offline are queued locally, encrypted, and replayed to the server when the connection returns.

Everything the offline stack needs lives in `addons/web`: encrypted IndexedDB storage, an ORM call sync queue, a service worker, PWA install plumbing. `addons/crm` only consumes it. The project rules in `AGENTS.md` are explicit: changes stay under `addons/crm/`, the fork stays rebasable onto upstream Odoo 20.0, and nobody builds a second offline engine.

## What the codebase is

- **`odoo/`**: the core server: an HTTP/WSGI stack with three server models (threaded, prefork, gevent longpolling), a full ORM (`odoo/orm/`), a module loader driven by manifests and a dependency graph, connection pooling, and an integrated test framework. See [systems](../systems/index.md).
- **`addons/`**: 642 business modules. The `base` module lives inside the core package at `odoo/addons/base` and defines the `ir.*`/`res.*` system models. Business apps cover CRM, sales, accounting, inventory, manufacturing, HR, websites, point of sale, marketing, and 229 country localizations. See [apps](../apps/index.md).
- **`addons/web`**: the OWL-based web client every addon uses, plus this fork's offline/PWA stack. See [web client](../apps/web/index.md) and [offline and PWA](../features/offline-and-pwa/index.md).
- **`scripts/dev/`**: a reproducible dev environment: PostgreSQL, a virtualenv, headless Chrome, a `crm_offline` demo database, and one wrapper script per task. See [getting started](getting-started.md).

Scale: roughly 1.36M lines of Python across 9,397 files, another ~1.2M lines of JavaScript (plus 250k vendored), 6,044 XML files, 20,189 translation catalogs. It is a monorepo with no CI pipelines; every test run is manual through `scripts/dev/` and its result is reported by hand.

## Who uses it

Two audiences share this repo. Engineers working on the fork add features to the CRM app and its offline behavior, gated by the rules in `AGENTS.md`. Anyone else reading the code is likely coming from upstream Odoo and needs to find where this fork diverges: the offline stack in `addons/web/static/src/core/offline/`, the share-target controller in `addons/crm/controllers/webmanifest.py`, the CRM custom views, and the dev scripts.

## Where to go next

- New to the codebase: [architecture](architecture.md), then [getting started](getting-started.md).
- Building offline features: [offline and PWA](../features/offline-and-pwa/index.md): start with the [sync queue](../features/offline-and-pwa/sync-queue.md).
- Working on CRM: [CRM app](../apps/crm/index.md) and its [custom views](../apps/crm/crm-views.md).
- Understanding the server: [ORM](../systems/orm.md), [HTTP server](../systems/http-server.md), [module system](../systems/module-system.md).
- Vocabulary: [glossary](glossary.md).
