# Odoo, offline and mobile CRM fork

Odoo is an open-source suite of business applications: CRM, accounting, inventory, manufacturing, website building, HR, point of sale, marketing, and project management. A Python server stores everything in PostgreSQL, and a large OWL-based JavaScript client renders every screen. The server code lives in the `odoo/` package and in 642 addon directories under `addons/`, each contributing models, views, controllers, and front-end assets.

This repository is a fork of Odoo 20.0 with one mission: an offline-capable, mobile-first CRM. The offline and PWA framework lives in `addons/web` (sync queue, encrypted local store, service worker, offline user interface). All of the fork's own work lives in `addons/crm` and consumes that framework: queued offline writes for leads and activities, offline guards for everything that needs a live server, a small-screen mobile pipeline, and PWA shortcuts and share target. The fork must stay rebasable on upstream 20.0, so changes are confined to `addons/crm` (plus this wiki and the dev scripts).

If you are new here, three files carry the ground truth:

- `AGENTS.md` — the rules agents and developers follow in this fork: commands, the offline framework's API, crm conventions, and project rules.
- `scripts/dev/README.md` — the reproducible dev environment and every test command.
- `addons/crm/static/src/mobile/README.md` — developer notes for the offline and mobile CRM itself, including its known limits.

## What is where

| Area | Where |
| --- | --- |
| Server core (ORM, HTTP, fields, module loading) | `odoo/` |
| Addons, including the CRM | `addons/` |
| Offline/PWA framework (queue, store, service worker, offline UI) | `addons/web/static/src/core/offline/`, `addons/web/static/src/core/pwa/` |
| The fork's offline/mobile CRM | `addons/crm/static/src/mobile/`, `addons/crm/static/src/views/view_components/` |
| The offline surface inventory (every crm server touchpoint classified) | `addons/crm/static/src/mobile/offline_inventory.md` |
| Dev environment and test scripts | `scripts/dev/` |
| Offline QA skill for browser testing | `.factory/skills/odoo-offline-qa/SKILL.md` |

## Where to read next

- [Architecture](architecture.md) — how the server, the web client, and the offline stack fit together.
- [Getting started](getting-started.md) — prerequisites, setup, running, and testing.
- [The offline and PWA framework](../features/offline-and-pwa/index.md) — the queue, the local store, and the service worker that crm builds on.
- [Offline CRM](../apps/crm/offline-crm.md) and [Mobile CRM](../apps/crm/mobile-crm.md) — what the fork added to the CRM.
- [Glossary](glossary.md) — the vocabulary this wiki uses.
