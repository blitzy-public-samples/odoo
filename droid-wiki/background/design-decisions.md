# Design decisions

These are the choices a reader will otherwise re-litigate, each with its recorded why
and its real cost. The rules come from `AGENTS.md` (sections 2 and 4); the mechanics
come from the code; the costs are visible in the 22-item "Known limits" list of
`addons/crm/static/src/mobile/README.md` and in the commit history that closed each
gap. Nothing here is a refactor proposal — section 4 of `AGENTS.md` makes the headline
decisions binding for changes to this fork.

## The queue has no conflict handling, on purpose

`OfflinePlugin.scheduleORM()` stores `{model, method, args, kwargs, extras}` verbatim,
keyed by the caller's `options.id` or a payload hash, so repeated saves of one record
overwrite one entry. `_syncORM()` replays entries sorted by `extras.timeStamp`
ascending with a one-second pause between calls; success dequeues, a
`ConnectionLostError` aborts the loop, any other error re-queues the entry with
`extras.error` (`addons/web/static/src/core/offline/offline_plugin.js:271-279` and
`:436-456`).

**Why.** `AGENTS.md` states the rule flatly: "Conflict behavior: none, by design.
Timestamp-ordered replay, last write wins, no `write_date` comparison, no field merge,
no conflict dialog", and section 4 forbids adding any of those. The rationale has two
legs. First, the workload: a `crm.lead` carries one assigned salesperson (`user_id`),
so the same record is rarely edited by two people at once; the queue's job is to
replay one device's pending writes, not to merge concurrent authors. Second, the
architecture: a merge dialog, `write_date` comparison, or field-level merge would be a
second conflict engine beside the queue, and section 4 forbids building one — "A
duplicate stack won't inherit the existing encryption, multi-tab locking, and error
parking, and the two will diverge."

**Cost.** A stale offline write silently overwrites a newer server-side change; the
only user-visible recovery path is for calls that *fail* on replay (parked as "Sync
issues" in the systray), not for calls that succeed but conflict. See
[sync queue](../features/offline-and-pwa/sync-queue.md).

## CRM consumes the `addons/web` framework instead of building its own

Every offline write goes into the `addons/web` `OfflinePlugin` queue and its encrypted
IndexedDB store; CRM adds no queue, store, service worker, cache, encryption helper,
connectivity detector, or conflict resolver. CRM reaches the framework only through
Python `_inherit`, controller subclassing, JS `patch()` or subclassing, and XML
inheritance, and reads offline state through the single `useCrmOffline()` hook, which
wraps `usePlugin(OfflinePlugin)` and keeps no state of its own
(`addons/crm/static/src/mobile/offline_hooks/offline_hooks.js`).

**Why.** `AGENTS.md` section 4: "Never build a second offline engine: no new sync
queue, IndexedDB wrapper, service worker, cache layer, encryption helper, connectivity
detector, offline-state store, or conflict resolver." A parallel stack would not
inherit the existing AES-GCM encryption, the multi-tab Web Locks serialization, or
the error-parking behavior, and the two implementations would drift apart. The mobile
README makes the same statement from the consuming side: "crm builds no second offline
stack."

**Cost.** When the framework has a defect CRM cannot fix in place, CRM works around it
from its own side and lists the defect as a known limit. Two shipped examples: the
offline systray crashes on any queued method it does not produce itself, so CRM ships
a label patch instead of fixing `addons/web` (see [pitfalls](pitfalls.md)); and web's
`user.hasGroup` never evicts a rejected promise from its cache, so the team switcher
bypasses it with a fresh `orm.silent.call` after a poisoned probe
(`addons/crm/static/src/components/team_switcher/team_switcher.js`).

## CRM adds no producers for things the framework does not queue

The framework auto-queues exactly four methods: `web_save` (form and list saves),
`web_unlink` (delete), and `action_archive`/`action_unarchive`. Group-level stage
delete (`orm.unlink` on a group), column resequence (`webResequence`), and
`DynamicList._multiSave` (list cell edits) have no producer. For all of them CRM
disables the control offline rather than calling `scheduleORM` itself.

**Why.** The offline surface inventory originally spelled out queue recipes for the
stage-column controls and left them "to milestone 2"; the milestone-2 user review
superseded that plan (VAL-INV-011): "no such producer was ever written or scheduled —
B57/B58/B59 were reclassified DISABLE... the framework has no queue producer for
`orm.unlink`/`webResequence` on a group, so crm adds no new producer at all, there,
and none is planned" (`addons/crm/static/src/mobile/offline_inventory.md`). The
principle behind the reversal, recorded in the same document: "when the framework does
not queue something (`orm.unlink` on a group, `webResequence`, ...), CRM does NOT add a
queue hook; it disables the control offline." List cell edits got the same treatment
for the same reason (`_multiSave` is not a queue producer; offline, records are edited
from their form).

**Cost.** Stage delete and reorder, team/stage group delete and reorder, and list cell
editing are all offline gaps, each listed in the mobile README's known limits
("edit records from their form").

## Server methods are shaped for one-call replay

Two server-side additions exist purely so a single queued call can do the whole job.

- `action_log_call` (`addons/crm/models/crm_lead.py:1083`) creates a Call activity and
  marks it done in one server call, "so the whole thing is a single scheduleORM entry
  the offline queue can replay verbatim -- the queue never chains two calls together
  or remaps an id from one call into the next". It runs without sudo, so replay is
  held to the caller's real access rights.
- `mail.activity`'s `create()` override (`addons/crm/models/mail_activity.py`) derives
  `res_model_id` for `crm.lead` when a `res_id` is given: the offline Schedule panel
  resolves `res_model` to the literal string `'crm.lead'` client-side, with no cheap
  way to look up the matching `ir.model` id without a round trip.

**Why.** `AGENTS.md`: "The queue replays model, method, arguments, and kwargs verbatim,
with no id remapping between calls. Anything that needs a server onchange, a
transient-model wizard, or an id produced by another call can't be queued." A two-step
client flow (create the activity, then mark it done) would need the created activity's
id inside the second queued call, which verbatim replay cannot provide.

**Cost.** Extra server surface that needs parity tests against the online path. The
`res_model_id` override itself bit back once: without the `res_id` guard it forced
`res_model_id` on creates that previously resolved to harmless orphan activities,
raising a `CheckViolation` that never happened before the override existed; an M5
user-testing round caught it and narrowed the guard (commit `c925b018097`,
VAL-REPO-013).

## The mobile pipeline is a branch of the `crm_kanban` renderer, not a new view

On small screens the pipeline kanban shows one stage at full width with a fixed header
(previous/next, stage count, expected revenue) — implemented as a branch inside
`CrmKanbanRenderer`, gated on `UIPlugin.isSmall()`. The renderer's own comment states
the contract: its template inherits `web.KanbanRenderer` "purely to splice in the
small-screen pipeline branch", and every xpath in `crm_kanban_renderer.xml` is itself
gated on `isMobilePipeline`, "so desktop and every other group-by keep the exact
unmodified base markup"
(`addons/crm/static/src/views/crm_kanban/crm_kanban_renderer.js:82-99`).

**Why.** `AGENTS.md`: "Gate every mobile behavior on the small-screen signal. Desktop
behavior must not change." One renderer carrying both layouts means one view
registration, one model, one control panel to maintain, and no new `js_class` to wire
into the view registry; `ForecastKanbanRenderer`, a subclass, inherits the gate and
never picks up the branch.

**Cost.** The renderer now owns two layouts and must be tested under both presets
(`./scripts/dev/test-js.sh desktop` and `mobile`). The mobile arch
`view_crm_lead_kanban` backs the Leads action, not the pipeline — a known limit that
confuses anyone expecting the branch to be a separate view.

## "Native mobile" means the installable PWA

The fork's mobile story is the web app installed as a PWA: the manifest, service
worker, install prompt, and per-app scoped installs all come from `addons/web`.
`AGENTS.md` rules the alternative out: "'Native mobile' means the installable PWA this
fork already supports. Never create a native app project (React Native, Flutter, Swift,
Kotlin, Gradle, Xcode, Capacitor)." CRM's only additions are controller-side: the
`WebManifest` subclass adds "My Pipeline" and "New Lead" shortcuts resolved from XML
ids at request time, and flips `_has_share_target()` to enable the PWA share target
(`addons/crm/controllers/webmanifest.py`).

**Why.** The framework already provides the entire install path — `pwa_service.js`
captures `beforeinstallprompt`, the manifest controller serves `/web/manifest.webmanifest`,
the shared service worker caches `/odoo` and `/odoo/offline` — so a native shell would
duplicate offline plumbing that the queue, the encrypted store, and the worker already
coordinate.

**Cost.** Browser PWA limits are the ceiling, and several are known limits: the
manifest's `start_url` opens the first app, not CRM (`addons/web/controllers/webmanifest.py:47`
serves `'start_url': '/odoo'`); a full offline relaunch lands on web's offline page;
and the "New Lead" shortcut shows the cached pipeline instead of a new-lead form while
offline.

## All changes stay inside `addons/crm/`

`AGENTS.md` scopes every change to `addons/crm/` with one sentence of justification:
"The fork must stay rebasable onto upstream 20.0." Behavior owned by another addon is
reached by extension — Python `_inherit`, controller subclassing, JS `patch()`, XML
view or template inheritance. The fork's own history confirms the discipline held: 74
of its 76 commits touch nothing outside `addons/crm/`; the other two add the dev
scripts and this wiki.

**Why.** A small patch surface that extends upstream components is far cheaper to
rebase than edits scattered across `addons/web/` or `odoo/`, and the offline framework
itself lives in `addons/web/`, where an uncoordinated edit would fork the framework
the whole design depends on.

**Cost.** Patches on upstream components instead of edits to them. Each patch is
fragile against upstream changes to the patched method, and none can fix a root cause
in another addon: the mail composer on non-`crm.lead` chatters still fails offline
(`addons/mail` owns it), the systray crash is patched around rather than fixed
(`addons/web` owns it), and both stay on the known-limits list. Patching also carries
a wiring burden that `AGENTS.md` section 4 calls out explicitly: a component that
exists but is never reached is the most common failure.

## Offline-created leads wait for sync before they can do anything

A lead created offline is a queued `web_save` with an empty id list — "the producer's
shape for a brand-new record" (`addons/crm/static/src/mobile/offline_hooks/offline_hooks.js`,
`pendingLeadCreates`). The record's id does not exist until the queue replays.

**Why.** The chained-id rule again: "Anything that needs... an id produced by another
call can't be queued." An activity on that lead would have to carry the not-yet-existing
lead id in its vals at queue time (`mail.activity` `create` vals name the lead via
`res_id`), and mark-won would need the same id. So the mobile pipeline renders queued
creates as non-clickable pending cards (`crm_mobile_pending_lead_create`), and the
first known limit in the README states it: "Leads created offline can't take activities
or be marked won until they sync."

**Cost.** A user-visible gap: while a queued create is pending, the lead cannot be
opened, scheduled against, or won. The pending card can be discarded, but the record
itself is a promise until reconnect.

## Key sources

| Source | What it records |
| --- | --- |
| `AGENTS.md` | The framework contract (section 2) and the binding project rules (section 4) |
| `addons/crm/static/src/mobile/README.md` | The consuming-side restatement, the offline behavior summary, and the known-limits costs |
| `addons/crm/static/src/mobile/offline_inventory.md` | The QUEUE/SKIP/DISABLE classification and the VAL-INV-011 supersession of the producer plan |
| `addons/web/static/src/core/offline/offline_plugin.js` | The queue mechanics the decisions govern |
| `addons/crm/models/crm_lead.py`, `addons/crm/models/mail_activity.py` | The one-call server methods |
| `addons/crm/static/src/views/crm_kanban/crm_kanban_renderer.js` | The renderer-branch contract for mobile |

## Related pages

- [Pitfalls](pitfalls.md) for the failure modes these choices produce
- [Background](index.md) for where the reasoning is recorded
- [Sync queue](../features/offline-and-pwa/sync-queue.md) and
  [local store](../features/offline-and-pwa/local-store.md) for the subsystems
- [Offline CRM](../apps/crm/offline-crm.md) and
  [mobile CRM](../apps/crm/mobile-crm.md) for what was built on these decisions
- [Offline surface inventory](../apps/crm/offline-surface-inventory.md) for the
  row-by-row classification
