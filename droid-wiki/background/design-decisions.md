# Design decisions

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

## Purpose

These are the choices a reader will otherwise re-litigate: why the offline sync queue has no conflict handling, why the queue cannot carry wizard calls, why the fork is scoped to `addons/crm/`, why the offline store wipes itself, and the upstream architecture moves visible in the code. Each entry cites the file that records it, and says plainly when the reasoning itself is not in the record.

## Fork decisions

### The sync queue is last-write-wins, with no conflict dialog

`scheduleORM()` in `addons/web/static/src/core/offline/offline_plugin.js` stores each queued ORM call verbatim, keyed by the caller's `options.id` or a hash of the payload, so repeated saves of one record overwrite one entry. `_syncORM()` replays entries sorted by `extras.timeStamp` ascending: a later save lands after (and over) an earlier one. A replay failure is re-queued with `extras.error` and parked in the offline systray ("Sync issues") until the user opens or discards it; `AGENTS.md` states this as a rule: "Conflict behavior: none, by design", and forbids adding `write_date` comparison, field merging, or a conflict dialog.

Why this shape: the record does not argue it. What the mechanism shows is that timestamp-ordered verbatim replay needs no server round-trip to compare versions, and that parking failures in the systray leaves the resolution with the user instead of guessing. Simultaneous edits to the same record by one offline user are also rare in the CRM pipeline this fork targets, which is a plausible reason the simpler rule was judged enough, but that is inference. See [sync queue](../features/offline-and-pwa/sync-queue.md).

### Verbatim replay forbids onchange and wizard calls

The queue persists `{model, method, args, kwargs, extras}` exactly as the caller passed it and replays it with `orm.silent.call(model, method, args, kwargs)`, with no id remapping between calls. An entry that needed a server onchange result, a transient-model wizard step, or an id produced by an earlier queued create would be replayed against values that do not exist at replay time, and the queue has no machinery to substitute them. `AGENTS.md` draws the consequence explicitly: "Anything that needs a server onchange, a transient-model wizard, or an id produced by another call can't be queued." This is a hard constraint on what can be made offline-capable, not a stylistic preference.

### All changes stay in `addons/crm/`

`AGENTS.md` scopes every change to `addons/crm/` and gives the reason in one sentence: "The fork must stay rebasable onto upstream 20.0." A small patch surface that extends other addons from inside `addons/crm/` (Python `_inherit`, controller subclassing, JS `patch()`, view inheritance) is far cheaper to rebase than edits scattered across `addons/web/`. The honest caveat: the offline framework itself already lives in `addons/web/`, fused into the fork's single squashed base commit, so the rule governs new work on top of a base that already modifies web. Who added that framework, and when, is unrecorded.

### The offline store wipes itself when the registry hash changes

The `IndexedDB` wrapper checks a `__DBVersion__` record on open (`addons/web/static/src/core/utils/indexed_db.js`, `_checkVersion`) and deletes the whole database when it differs. The plugin opens the store with `session.registry_hash + CRYPTO_ALGO` (`addons/web/static/src/core/offline/offline_plugin.js`), so an asset-registry change or a crypto-algorithm change drops every table. This buys format and schema evolution without client-side migrations: cached visited-UI and many2x data is only valid for the assets that produced it, so it is regenerated from what the user re-visits. The cost is real and worth knowing: the `orm-to-sync` queue lives in the same database, so a registry change also drops queued writes. The code records the mechanism; the migration-avoidance reading is consistent with it but not spelled out anywhere. See [local store](../features/offline-and-pwa/local-store.md).

### Offline degrades totally rather than partially outside a secure context

Outside a secure context, both gates fail together: the plugin's store is a no-op `FakeIndexedDB` and its crypto is unset (`window.isSecureContext` guards both in `addons/web/static/src/core/offline/offline_plugin.js`), because the `Crypto` class in `addons/web/static/src/core/crypto.js` is built on `window.crypto.subtle` and the replay lock on `navigator.locks`, which are themselves secure-context APIs. Storing anything then would mean storing it unencrypted, so the stack turns off entirely, and `scheduleORM()` throws `NonSecureContextError` (`addons/web/static/src/core/errors/non_secure_context_error.js`) instead of queueing in the clear. The in-code comment on `FakeIndexedDB` says exactly this: "used in non secure context to disable the offline features as data can't be encrypted". This is platform constraint more than choice: the APIs it needs are simply absent there. The point-of-sale addon exploits the same lever deliberately, neutralizing the plugin by setting `_crypto = false` ([pitfalls](pitfalls.md)).

### Why the base history is squashed: unknown

The `20.0` branch is a single commit, "[FIX] mail: duplicate notifications", whose `X-original-commit` trailer points at upstream Odoo commit `ca58f5676aa5874c24b79c834b1f5f7918b2b076`, and it contains the entire codebase plus this fork's offline framework with no attribution of the framework's origin. `eval/base` adds one commit, the `scripts/dev/` environment. No document explains why the history was squashed, so `git log` and `git blame` cannot date or attribute any part of the offline stack; see [lore](../lore.md) for what can and cannot be reconstructed.

## Upstream decisions visible in code

### The ORM lives in `odoo/orm/`, with shims at the old paths

`odoo/models/__init__.py` states the reason in one line: "This is a `__init__.py` file to avoid merge conflicts on `odoo/models.py`." The implementation is split across focused files (`odoo/orm/models.py`, `odoo/orm/fields.py`, `odoo/orm/domains.py`, ...), while the classic import paths, `odoo/models.py`, `odoo/fields.py`, `odoo/api.py`, remain as re-export shims so addons keep importing `odoo.models`. The comment is the whole recorded rationale.

### OWL 3 runs behind a compatibility layer

The header of `addons/web/static/src/owl2/owl3_compatibility_layer.js` says it "is intended as a temporary bridge to ease incremental migration from Owl 2 to Owl 3": it patches the vendored OWL 3 (`addons/web/static/lib/owl/owl.js`) so Owl 2 code keeps running, and everything imports `@odoo/owl` through it. The migration plan is documented in that same header: migrate templates and hooks gradually, then delete the layer. The fork's own temporary bridges follow the same pattern, each marked `@todo owl3 migration` (for example the legacy `offline` service at the bottom of `addons/web/static/src/core/offline/offline_plugin.js`). See [web client](../apps/web/index.md).

### Access rules are unified in `ir.access`

One model, `ir.access` (`odoo/addons/base/models/ir_access.py`), covers both what earlier branches split into `ir.model.access` (per-model ACLs) and `ir.rule` (record rules): each row is an `operation` (a subset of `crud`), a `group_id`, and an optional `domain`, checked in `BaseModel.check_access` / `_access_domain` (`odoo/orm/models.py`). The file does not argue the why; what the code shows is a single cached access check (`AccessInfo`, "for caching purpose"). The rename breaks every pre-20.0 tutorial and security CSV, which is a documented [pitfall](pitfalls.md). See [users, groups, and access](../primitives/users-groups-and-access.md).

### Domains are an AST

`odoo/orm/domains.py` represents a domain as "an AST which is a predicate using boolean operators" (n-ary AND/OR, unary NOT, TRUE/FALSE constants, condition triplets), rather than only a legacy nested list. The module docstring is the record: the stated duty is representing filter conditions and easing their rewriting, and the class supports algebraic composition that a raw list cannot express (`&`, `|`, `~` operators, `Domain.AND`/`Domain.OR` constructors, `Domain.TRUE`/`Domain.FALSE`). The historical motivation beyond the docstring is not elaborated.

## When a decision is a rule

`AGENTS.md` section 4 ("Project rules") turns several of these into binding constraints: never build a second offline stack, never change the queue's conflict semantics, no new dependencies, no fields on `crm.lead`/`crm.stage`/`crm.team`, no native app project. Treat those as settled. The reasoning above explains where it is recorded; where it is not, raise the question instead of relitigating silently in code.

## Related pages

- [Pitfalls](pitfalls.md), the failure modes these choices produce
- [Sync queue](../features/offline-and-pwa/sync-queue.md), [local store](../features/offline-and-pwa/local-store.md), and [offline and PWA](../features/offline-and-pwa/index.md) for the subsystems themselves
- [ORM](../systems/orm.md), [web client](../apps/web/index.md), and [users, groups, and access](../primitives/users-groups-and-access.md) for the upstream decisions in context
- [Lore](../lore.md) for the squashed history and what it means for attribution
