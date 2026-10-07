# Background

This section records the "why" behind the offline, mobile-first CRM fork: the design
context a reader needs before changing it, and the traps that waste contributor time
when they don't know it. The fork added an offline-capable, mobile-first CRM strictly
inside `addons/crm/` (76 commits, 2026-09-30 to 2026-10-05, branch
`eval/factory-crm-offline`), on top of the offline and PWA framework that `addons/web/`
already provides. Most of the consequential choices were made once, written down as
rules, and are now binding for changes to this tree.

## Where the design context lives

Four records carry it, in decreasing order of authority:

- `AGENTS.md` at the repository root. Section 2 documents the `addons/web/` offline
  framework the fork consumes (queue semantics, encrypted local store, service worker,
  offline-availability attribute, plugin API). Section 4 turns the load-bearing choices
  into rules: never build a second offline engine, never change the queue's conflict
  semantics, gate every mobile behavior on the small-screen signal, keep changes inside
  `addons/crm/` so the fork stays rebasable onto upstream 20.0.
- `addons/crm/static/src/mobile/README.md`. The developer README for the offline and
  mobile CRM, including the 22-item "Known limits" list that functions as the fork's
  honest, maintained backlog.
- `addons/crm/static/src/mobile/offline_inventory.md`. The row-by-row classification of
  every CRM entry point that needs a server — QUEUE, SKIP, or DISABLE, 150 rows (26
  QUEUE, 9 SKIP, 115 DISABLE) — with supersession notes recording where the original
  plan changed mid-build (the VAL-INV-011 reclassification of the stage delete/reorder
  producers).
- The 76 fork commit messages. Each fix cites the user-review item (VAL-*) it closes, so
  `git log origin/20.0..HEAD` reads as a design narrative: what was tried, what the
  review rounds rejected, and what the final behavior is.

## Sub-pages

| Page | What it covers |
| --- | --- |
| [Design decisions](design-decisions.md) | Eight choices a reader will otherwise re-litigate — conflict-free queue semantics, consuming the `addons/web/` framework instead of duplicating it, no new queue producers, one-call server methods, the renderer-branch approach to mobile, PWA as "native", the rebasability scope, and why offline-created leads wait for sync — each with its why and its cost |
| [Pitfalls](pitfalls.md) | The danger zones, each with its symptom and its fix: secure-context degradation, stale asset bundles, three silent-success test modes, the `mockCrmOffline()` mail.store race, the poisoned `hasGroup` cache, the crashing offline systray, service-worker key mismatches, and the known baseline failures |

## Reading rules as rules

Several decisions on the sub-pages are not preferences. `AGENTS.md` section 4 makes
them binding: if a task seems to require breaking one, the right move is to raise it,
not to work around it quietly. The cost columns on the decisions page are the honest
part — every one of these choices gave something up, usually a capability that would
have needed a second offline engine or a change to framework-owned behavior.

## Related pages

- [Offline CRM](../apps/crm/offline-crm.md) and [mobile CRM](../apps/crm/mobile-crm.md)
  for what was built on these decisions
- [Sync queue](../features/offline-and-pwa/sync-queue.md) and
  [local store](../features/offline-and-pwa/local-store.md) for the subsystems the
  semantics govern
- [Lore](../lore.md) for the scrutiny-round history that shaped the inventory document
- [Cleanup opportunities](../cleanup-opportunities/index.md) for the maintenance debt
  this design leaves behind
