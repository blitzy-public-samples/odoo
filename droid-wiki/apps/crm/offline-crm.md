# Offline CRM

Active contributors: bobbyabbott421-glitch (fork)

## Purpose

This page is what a CRM user can actually do without a network, and what the fork deliberately turns off instead. Everything offline in `addons/crm` is consumption of the framework in `addons/web` (see [Offline and PWA](../../features/offline-and-pwa/index.md)): every write goes through `OfflinePlugin.scheduleORM` into the encrypted IndexedDB store, every decorative read is skipped rather than left to fail, and everything else is disabled or blocked. The per-control decisions come from the 150-row classification in `addons/crm/static/src/mobile/offline_inventory.md` ([Offline surface inventory](offline-surface-inventory.md)); the mobile-only UI built on the same state is [Mobile CRM](mobile-crm.md). Offline data behavior (mark won, activities, pending-sync marks) applies at every screen size; only the mobile pipeline layout is small-screen-only.

## Directory layout

The offline surface is spread across the module, one directory per concern:

```text
addons/crm/
├── static/src/
│   ├── mobile/offline_hooks/            # useCrmOffline(), the shared hook
│   ├── views/view_components/           # the 12 guard patches on web components
│   ├── views/crm_form/                  # Won/Restore producers, activity panel, PLS guards
│   ├── views/crm_kanban/                # renderer guards, header guards, mobile branch
│   ├── views/crm_list/, views/crm_activity/, views/crm_calendar/
│   │                                    # list guards, activity-view guards, calendar guard
│   ├── views/crm_search_model.js        # offline search state, cached team data
│   ├── components/team_switcher/        # blocked switcher, hardened manager probe
│   ├── webclient/                       # offline_systray_patch.js, share target item
│   └── chatter/, core/common/           # chatter and composer upload guards
├── models/
│   ├── crm_lead.py                      # action_log_call(), won/lost semantics
│   └── mail_activity.py                 # res_model_id derivation for queued creates
└── tests/
    ├── test_crm_offline.py              # replay semantics on the server
    ├── test_crm_offline_tour.py         # the end-to-end offline tour
    └── test_crm_offline_webmanifest.py  # PWA shortcuts and share target
```

## Key abstractions

| Name | File | Description |
| --- | --- | --- |
| `useCrmOffline()` | `addons/crm/static/src/mobile/offline_hooks/offline_hooks.js` | The one hook crm code reads offline state through: `isOffline`, `isLeadAvailableOffline`, `queueCall`, `pendingForLead`, `pendingLeadCreates`, `pendingActivities`, `cachedMany2XRecords`. |
| `CrmFormController.beforeExecuteActionButton()` | `addons/crm/static/src/views/crm_form/crm_form.js` | Offline Won/Restore queueing and AI-switch blocking on the lead form. |
| `CrmLeadActivityPanel` | `addons/crm/static/src/views/crm_form/crm_lead_activity_panel.js` | The offline-only activities widget: schedule, done, log a call. |
| `action_log_call()` | `addons/crm/models/crm_lead.py` | Creates the Call activity and marks it done in one server call, so it can be queued verbatim. |
| `mail.activity.create()` override | `addons/crm/models/mail_activity.py` | Derives `res_model_id` for `crm.lead` when a `res_id` is given, so a client-built activity create replays. |
| `CrmSearchModel._initSwitcher()` | `addons/crm/static/src/views/crm_search_model.js` | Disk-cached team data with the "All Teams" cache-miss fallback. |
| `TeamSwitcher` | `addons/crm/static/src/components/team_switcher/team_switcher.js` | Blocked offline, with the hardened manager probe. |
| `offline_systray_patch.js` | `addons/crm/static/src/webclient/offline_systray_patch.js` | Systray labels for every method crm queues itself. |
| The guard patches | `addons/crm/static/src/views/view_components/` | Twelve `patch()` files enforcing the DISABLE rows. |

## How it works

### The lifecycle of an offline write

```mermaid
sequenceDiagram
    participant U as User action
    participant V as crm view (form, kanban, activity panel)
    participant P as OfflinePlugin
    participant IDB as encrypted IndexedDB ("orm-to-sync")
    participant SY as Offline systray
    participant R as replay on reconnect
    U->>V: save, mark won, schedule activity, drag card
    V->>V: optimistic UI (ribbon, pending card, panel row)
    V->>P: RPC rejects with ConnectionLostError
    P->>IDB: scheduleORM(model, method, args, kwargs, extras)
    IDB-->>SY: queue renders Created/Edited/Won/... badge
    Note over P,IDB: extras: timeStamp, changes, originalValues, displayName, actionId, viewType
    R->>IDB: reconnected: entries sorted by extras.timeStamp
    R->>P: orm.silent.call verbatim, 1s between calls
    P-->>IDB: success dequeues; other errors re-queue with extras.error
    R-->>V: server state matches the optimistic UI
```

Two producers feed the queue. The framework's own (`addons/web/static/src/model/relational_model/record.js`, `.../dynamic_list.js`) covers `web_save`, `web_unlink`, `action_archive`, `action_unarchive`. Everything else crm queues goes through `useCrmOffline().queueCall()`, which wraps `scheduleORM` and always stamps `extras.timeStamp` — the field that orders the replay and sorts the systray.

### What queues, and its optimistic UI

- **Form saves.** A lead form save goes through `CrmFormRecord._save()` (`addons/crm/static/src/views/crm_form/crm_form.js`) into the framework's `web_save` producer, including the email/phone force-save staging for partner synchronization. Repeated saves of one record overwrite one queue entry (the producer keys the entry on its caller id). The statusbar's stage buttons are tagged `data-available-offline` by the controller, so a stage move via the statusbar still works offline: the click stages `stage_id`, Save queues one `web_save`.
- **Lead create.** The control panel's New button and the form's save on a new record queue `web_save` with an empty id list. The pipeline kanban's per-column quick-add button is framework-disabled offline (no `data-available-offline`), so the New button is the desktop entry point; the mobile quick-create sheet ([Mobile CRM](mobile-crm.md)) is the small-screen one. A queued create has no id until it replays — the reason leads created offline cannot take activities or be marked won yet.
- **Stage moves.** A kanban drag goes through `CrmKanbanDynamicGroupList.moveRecords()` (`addons/crm/static/src/views/crm_kanban/crm_kanban_model.js`) into the per-record `web_save({stage_id})` producer; the rainbowman lookup after the move is skipped offline (`addons/crm/static/src/views/check_rainbowman_message.js`). Dragging a card on a `date_deadline` column of an already-rendered forecast board queues the same way, just with a different field.
- **Mark won.** The form's Won button is intercepted offline by `beforeExecuteActionButton`: it saves pending edits first (so a dirty form queues its `web_save` with an earlier timestamp), queues `action_set_won` — the plain method, not the arch-bound `action_set_won_rainbowman` wrapper, whose rainbowman read needs a live round trip — and skips the real RPC. No rainbowman plays offline. The optimistic UI mirrors only `won_status = "won"` directly into `record.data` (never into `_changes`, which would make a later `web_save` send a compute+store field the server rejects), so the Won ribbon shows immediately; the stage and probability update when the queued call replays. A lead created offline (no server id yet) cannot be marked won at all — the button is disabled for it.
- **Restore.** The same path queues `action_restore` and mirrors `active = true`, `won_status = "pending"`, so the Lost/Restore buttons flip immediately.
- **Archive, unarchive, delete.** The selected-record action menu's Archive/Unarchive/Delete on `crm.lead`, `crm.stage`, `crm.team` are marked `availableOffline: true` by the list and form controllers, so they queue `action_archive`, `action_unarchive`, `web_unlink`. The kanban card-menu Delete is blocked offline (its menu toggler is framework-disabled and the handler is guarded); the action menu is the offline delete path. A salesman's queued delete is parked with an `AccessError` by the replay, matching online rights — no access rule was changed.
- **Activities.** The offline activity panel (`<widget name="crm_lead_activity_panel"/>`, `addons/crm/static/src/views/crm_form/crm_lead_activity_panel.js`) renders only while offline. It loads activity types through the RPC disk cache (`orm.cache({type: "disk"})` on `mail.activity.type`, excluding meeting/upload categories) and assignable users from data this device already has: the current user, the lead's salesperson, and the `res.users` rows an earlier online search cached in the many2x cache. Schedule queues one `mail.activity` `create` with client-built vals (`res_model: "crm.lead"`, `res_id`, type, summary, deadline, assignee); Done queues one `mail.activity` `action_done([[activityId]])`; Log a call queues one `crm.lead` `action_log_call` — the server method that creates the Call activity and marks it done in a single call, enforcing the Call category server-side. Queued rows show in the panel with a "Pending sync" badge; a queued create or log-a-call cannot be marked done until it syncs. `addons/crm/models/mail_activity.py` derives `res_model_id` from `res_model`/`res_id` on create, so the queued vals replay consistently.
- **Contact lookup.** Picking a partner works offline through the framework's many2x cache (`searchMany2XRecords` — a normalized substring match over decrypted cached display names, `addons/web/static/src/views/fields/relational_utils.js`); ids already on the record are served without a search. On small screens, `addons/crm/static/src/views/view_components/many2x_autocomplete_offline_patch.js` swaps the lead form's `partner_id` to the typed-search branch offline, because the framework's small-screen dialog path never reaches the many2x cache.
- **Team switcher.** The dropdown itself is blocked offline (`onSelect` and "Manage Teams" guards in `addons/crm/static/src/components/team_switcher/team_switcher.js`), but the data survives: `_initSwitcher()` (`addons/crm/static/src/views/crm_search_model.js`) always routes `crm.team.get_team_switcher_data()` through the RPC disk cache, so a disk hit resolves the load even while the network leg rejects. A true cache miss (this device never loaded the switcher data online) degrades to "All Teams" — flagged `switcherOfflineFallback` so the switcher still renders — instead of aborting the view. The manager probe (`user.hasGroup`) is skipped offline; if it was ever issued during a brief false-online moment and rejected, the rejected promise poisons `user.hasGroup`'s cache permanently, so the component re-probes through a fresh `orm.silent.call("res.users", "has_group", ...)` bypass on the next online flip.
- **Remembered searches and the team facet.** Offline, the offline search bar lists the search states used on that view; `CrmSearchModel.getCurrentSearch()` exports the selected team as a facet plus `teamId`, and `applySearch()` restores both (facets first with notifications blocked, then the team through `_updateSwitcherSelection`), so switching teams offline works through the remembered-searches list rather than the dropdown.
- **Cold start.** Because the switcher data, the search context, and the selected team's `switcher_domain` all come from disk-cached requests with stable keys, a cold offline start of the pipeline renders the cached board with the selected team instead of the offline helper. The selected team persists through `exportState()`/`_importState()` and localStorage.
- **Uncached leads and views.** Opening a lead whose form was never visited online sets `offlineUncachedClick` in the kanban/list controllers, and the templates (`addons/crm/static/src/views/crm_kanban/crm_kanban_view.xml`, `addons/crm/static/src/views/crm_list/crm_list_view.xml`) show `OfflineActionHelper` with the remembered searches instead of the grid. The calendar routes an offline open through `switchView("form", ...)` to reuse the action's cache identity; the activity view swallows the offline load error and shows the helper.

### What is disabled, and why

- **Wizards.** Lost (reason + closing note), Convert to Opportunity, mass convert, merge, mass mail, blacklist removal, the PLS-update wizard, and mail's schedule-activity wizard are transient models — the queue replays `model, method, args, kwargs` verbatim, and transient-model wizards cannot be replayed. The buttons carry no offline tag, so the framework's disable pass turns them off.
- **Module installs and lead generation.** The Generate Leads dropdown's flows (`ir.module.module` lookups and `button_immediate_install`, the CSV/Excel import client action, the `base.module.install.request` access wizard) are all DISABLE rows; the Generate button is framework-disabled, and the access-probe and install handlers are unreachable.
- **Reports and forecast reads.** The activity and opportunity report lists, and the forecast views' `fill_temporal` read-groups, are server-computed reads that are never cached — entering them offline shows the offline helper (the activity view's own load is swallowed in `CrmActivityModel`, `addons/crm/static/src/views/crm_activity/crm_activity_model.js`). The activity report's grouped-list Delete/resequence are also disabled.
- **Group edits.** Stage and team column create, edit, delete, and resequence are disabled: the framework has no queue producer for group-level `orm.unlink`/`orm.webResequence`, and the fork must not build one ([Offline surface inventory](offline-surface-inventory.md) has the VAL-INV-011 history). The stage list's handle drag is blocked the same way.
- **Cell edits.** List cell editing on the Leads, Opportunities, Stages, and Sales Team lists is disabled offline: the edits go through `DynamicList._multiSave`, which the framework does not queue, so the record is edited from its form instead. A row already mid-edit when the connection drops is forced out of edition with its changes discarded, and the `crm.recurring.plan`/`crm.lost.reason` lists are readonly offline entirely.
- **Tag color popover.** The lead form's tag color-edit and "Hide in Kanban" write `crm.tag` directly — out of the QUEUE rule's model scope — so `onTagClick` is guarded, the write handlers are guarded, and an already-open popover is closed reactively on going offline.
- **PLS.** The PLS tooltip and the AI-probability switch are disabled: the probability only recomputes on the server, so there is no optimistic UI possible. The tooltip button is framework-disabled and its handler is guarded; the AI switch is a plain `<a>` the framework never reaches, so the controller blocks the method and keeps the element visually disabled.
- **Navigation.** Team dashboard links, report links, the activity menu's CRM entry, Duplicate (a `copy` that lands on a server-created id), the share-target create (a chained `name_create` → attachment write), many2one open/edit links, and chatter attachment uploads for `crm.lead` are all blocked offline. The uploads are guarded at both drop targets (`addons/crm/static/src/core/common/composer_patch.js`, `addons/crm/static/src/chatter/web_portal_project/chatter_patch.js`).
- **Already-open menus and dialogs.** The framework's disable pass only reaches `<button>`s, so an already-open dropdown's `<span>`/`<a>` items, a confirmation dialog's confirm closure, and a popover's callbacks stay clickable after the drop. Those are covered by handler-level guards (`addons/crm/static/src/views/view_components/kanban_record_offline_patch.js`, `.../kanban_controller_offline_patch.js`, `.../group_config_menu_patch.js`, `.../action_menus_patch.js`, `.../many2many_tags_field_patch.js`), each re-checking offline at execution time.

### Queue semantics from crm's perspective

- **Labels.** Web's systray only assigns a status to the four built-in methods; any other queued method crashes its dropdown on `element.status.color`. `addons/crm/static/src/webclient/offline_systray_patch.js` patches the systray instance's `groupEntries` computed to fill in the labels for everything crm queues itself: Won, Restored, Call logged (`crm.lead`), Activity scheduled, Activity done (`mail.activity`).
- **Ordering.** Replay is timestamp-ordered, last write wins, no conflict detection — unchanged framework semantics. The one crm-side wrinkle is the tie-break in `_queueLeadCallOffline`: a Won/Restore queued right after a save of the same lead reads the pending save's actual queued timestamp back from the queue and stamps itself strictly after it, so the two cannot replay out of order on an equal-millisecond tie.
- **Restore/dequeue.** An entry can be discarded from the systray (confirmation dialog) — the pending cards and panel rows that render from the queue disappear with it. Opening a queued form save in its form while online also dequeues it. A failed replay re-queues the same entry with `extras.error`, which parks it out of the replay and lights the systray's "Sync issues" badge; the user acts on it from there.
- **Visibility.** Every mobile pipeline/panel/card element that renders from the queue reads it through `useCrmOffline()` (`pendingForLead`, `pendingLeadCreates`, `pendingActivities`), so the queue draining updates the UI without any custom event.

### Known limits

From `addons/crm/static/src/mobile/README.md`:

- Leads created offline can't take activities or be marked won until they sync.
- Partner search offline only finds partners cached by earlier online searches.
- The external partner-autocomplete lookup is still attempted offline and fails silently.
- If the VAT script never loaded before going offline, Enter/Tab partner selection hangs.
- The mobile `view_crm_lead_kanban` arch backs the Leads action, not the pipeline; the mobile pipeline is a `crm_kanban` branch.
- Stage delete and reorder (and team/stage group delete/reorder) are disabled offline.
- The `addons/web` offline systray crashes on unknown queued methods; crm patches the labels.
- `addons/mail` composer and follower actions on non-crm.lead chatters still fail offline.
- List cell editing is disabled offline; edit records from their form.
- Opening an uncached lead offline replaces the grid with `OfflineActionHelper`.
- Kanban action-menu Archive/Unarchive/Delete are greyed out offline; use the list or form.
- Offline, the view switcher only allows view types already mounted in this session.
- Offline, the team switcher shows only "All Teams" if the team list was never loaded.
- On phones the list has no selection checkboxes; archive and unarchive from the form.
- One2many sub-lists, such as team members, are read-only offline.
- Mark won offline updates stage and probability only after the queued call replays.
- On phones, contact lookup offline uses only partners cached on this device.
- The manifest `start_url` opens the first app, not CRM; a full offline relaunch shows web's offline page.
- If CRM was first opened by typing /odoo/crm, the CRM shortcut shows a blank page offline (the action is cached under the string key `crm`; the app tile and menus cache the numeric id). Opening CRM from the tile or menu avoids it.
- The "New Lead" shortcut offline shows the cached pipeline instead of a new lead form.
- After an offline save, the Save/Discard indicator can stay visible (cosmetic, `addons/web`).
- A brief false-online flip can leave the offline UI showing after reconnect; reload clears it.

## Integration points

- The framework: `OfflinePlugin` (queue, `isAvailableOffline`, many2x cache, `searchMany2XRecords`), the offline systray, `OfflineActionHelper`, the `data-available-offline` disable pass, the RPC disk cache — all from `addons/web` ([Offline and PWA](../../features/offline-and-pwa/index.md)).
- Mail: `mail.activity` (queued creates, `action_done`), `Many2OneAvatarUserField` (patched `m2oProps`), mail's `ActivityController`/`ActivityModel`/`ActivityCell` (patched for `crm.lead`), the chatter and composer upload guards ([Mail](../mail.md)).
- The view framework: `formView`'s `beforeExecuteActionButton` chain, `RelationalModel`'s producers in `record.js`/`dynamic_list.js`, `Many2XAutocomplete` ([Relational model](../web/relational-model.md), [Views framework](../web/views-framework.md)).
- sales_team: the team switcher's manager probe (`sales_team.group_sale_manager`) and the inherited team views and dashboard guarded by `kanban_action_button_patch.js`.
- `addons/web/controllers/webmanifest.py`: the manifest controller crm subclasses for the share target and shortcuts ([CRM views](crm-views.md)).

## Entry points for modification

Two rules govern any new offline behavior. First, check the inventory (`addons/crm/static/src/mobile/offline_inventory.md`) — an entry point with a QUEUE row needs a `queueCall` producer plus optimistic UI plus a test under both presets; a DISABLE row needs a guard; a SKIP row needs a skip-don't-catch probe (never a caught-and-ignored RPC, because `user.hasGroup` and memoized reads cache rejections permanently). Second, never reach for the framework directly: all state goes through `useCrmOffline()`, all queueing through its `queueCall`, and a control that must stay clickable offline carries `data-available-offline` on the interactive element itself. Offline needs a secure context — over plain HTTP on a non-localhost host the framework raises `NonSecureContextError` on queued calls.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/crm/static/src/mobile/offline_hooks/offline_hooks.js` | `useCrmOffline()`: the API every producer, guard, and UI element shares. |
| `addons/crm/static/src/views/crm_form/crm_form.js` | Offline Won/Restore queueing, AI-switch and statusbar handling. |
| `addons/crm/static/src/views/crm_form/crm_lead_activity_panel.js` | Offline activities: schedule, done, log a call. |
| `addons/crm/static/src/views/crm_kanban/crm_kanban_model.js` | The stage-drag save path and the skipped rainbowman. |
| `addons/crm/static/src/views/crm_search_model.js` | Team switcher state, disk-cached load, offline search restore. |
| `addons/crm/static/src/components/team_switcher/team_switcher.js` | The blocked switcher and the hardened manager probe. |
| `addons/crm/static/src/views/view_components/` | The twelve DISABLE-row guard patches. |
| `addons/crm/static/src/views/view_components/many2x_autocomplete_offline_patch.js` | Small-screen offline typed partner search. |
| `addons/crm/static/src/webclient/offline_systray_patch.js` | Systray labels for crm's queued methods. |
| `addons/crm/models/crm_lead.py` | `action_log_call()` and the won/lost methods behind the queued calls. |
| `addons/crm/models/mail_activity.py` | `res_model_id` derivation for queued activity creates. |
| `addons/crm/static/src/views/check_rainbowman_message.js` | The rainbowman SKIP probe shared by form and kanban. |
| `addons/crm/static/tests/crm_offline_*.test.js` | 46 test files covering the producers and guards. |
| `addons/crm/tests/test_crm_offline.py` | Server-side replay semantics of the queued methods. |
| `addons/crm/tests/test_crm_offline_tour.py` | The end-to-end offline tour (mobile viewport, `start_tour("/odoo", "crm_offline_e2e_tour")`). |

## Related pages

- [CRM](index.md): the module this behavior is layered on.
- [Offline surface inventory](offline-surface-inventory.md): the QUEUE/SKIP/DISABLE classification behind every decision here.
- [Mobile CRM](mobile-crm.md): the mobile pipeline, card, and quick create that render this state on small screens.
- [CRM views](crm-views.md): the view family the guards patch.
- [Sync queue](../../features/offline-and-pwa/sync-queue.md): the queue engine and replay semantics.
- [Local store](../../features/offline-and-pwa/local-store.md): the encrypted IndexedDB store underneath.
- [Offline UI](../../features/offline-and-pwa/offline-ui.md): the disable pass, systray, and offline action helper.
- [Views framework](../web/views-framework.md) and [Relational model](../web/relational-model.md): the layers the producers hook into.
- [Testing](../../how-to-contribute/testing.md): the offline test suites and the both-preset rule.
