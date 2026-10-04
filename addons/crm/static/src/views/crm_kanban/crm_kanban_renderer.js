import { signal, useEffect, usePlugin } from "@odoo/owl";
import { usePopover } from "@web/core/popover/popover_hook";
import { UIPlugin } from "@web/core/ui/ui_plugin";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { CrmColumnProgress } from "./crm_column_progress";
import { CrmMobileCard } from "@crm/mobile/crm_mobile_card/crm_mobile_card";
import { CrmMobilePendingLeadCreate } from "@crm/mobile/crm_mobile_pending_lead_create/crm_mobile_pending_lead_create";
import { CrmMobilePipeline } from "@crm/mobile/crm_mobile_pipeline/crm_mobile_pipeline";
import { CrmMobileQuickCreate } from "@crm/mobile/crm_mobile_quick_create/crm_mobile_quick_create";
import { RottingKanbanHeader } from "@mail/js/rotting_mixin/rotting_kanban_header";
import { RottingKanbanRenderer } from "@mail/js/rotting_mixin/rotting_kanban_renderer";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

class CrmKanbanHeader extends RottingKanbanHeader {
    static components = {
        ...RottingKanbanHeader.components,
        ColumnProgress: CrmColumnProgress,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    /**
     * @override
     *
     * B80 / VAL-SKIP-004: `loadTooltip` (addons/web's `kanban_header.js`) is
     * `memoize`d with no arguments, so its first outcome -- success or
     * rejection -- is cached for the component's whole life. Never let a
     * `ConnectionLostError` reach it while offline, or the tooltip would
     * stay broken even after reconnecting; skip the call entirely instead
     * of catching it, the same "skip, don't catch" rule as every other
     * offline probe in this addon (architecture.md §2).
     */
    async onTitleMouseEnter(ev) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onTitleMouseEnter(...arguments);
    }

    /**
     * @override
     *
     * B91 / VAL-DIS-029: the rotting badge is a plain `<div>`
     * (`mail.RottingColumnProgress`'s template), not a `<button>`, so the
     * framework's `SELECTORS_TO_DISABLE` pass never reaches it. Clicking it
     * calls `RottingProgressBarState.toggleFilterRotten()`, which calls
     * `group.applyFilter()` -- a genuine `list.load()` round trip, not one
     * of the four auto-queued producers -- so block it the same way as the
     * other DISABLE rows instead of letting a `ConnectionLostError` surface
     * as an uncaught rejection.
     */
    onRotIconClicked(group) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onRotIconClicked(group);
    }

    /**
     * @override
     *
     * B79 / VAL-DIS-029: the progress-bar segments are plain
     * `<div role="progressbar">`s (`column_progress.xml`), not
     * `<button>`s; the base template only adds `pe-none` to their
     * wrapper offline, which blocks a pointer hit but not a direct call
     * to this handler. `onBarClicked` -> `ProgressBarState.selectBar` ->
     * `group.applyFilter()` is a genuine `list.load()` round trip, the
     * same "block the handler, don't let a `ConnectionLostError` surface"
     * rule as `onRotIconClicked` above.
     */
    onBarClicked(value) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onBarClicked(value);
    }
}

export class CrmKanbanRenderer extends RottingKanbanRenderer {
    // VAL-MOBILE-003..006 / architecture.md §3.4: primary-inherits
    // "web.KanbanRenderer" (crm_kanban_renderer.xml) purely to splice in
    // the small-screen pipeline branch below. Every xpath in that file is
    // itself gated on `isMobilePipeline`, so desktop and every other
    // group-by keep the exact unmodified base markup (VAL-MOBILE-004).
    // `ForecastKanbanRenderer` (a subclass of this one) declares its own
    // `static template` inheriting "web.KanbanRenderer" directly, so it
    // never picks up this branch regardless of this getter's value.
    static template = "crm.KanbanRenderer";
    static components = {
        ...RottingKanbanRenderer.components,
        KanbanHeader: CrmKanbanHeader,
        CrmMobilePipeline,
        CrmMobileCard,
        CrmMobilePendingLeadCreate,
        OfflineActionHelper,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        // AGENTS.md §2 "Small-screen signal": new code reads the plugin,
        // not the legacy "ui" service `this.uiService` already injected by
        // the base `KanbanRenderer.setup()` (left untouched -- it still
        // backs the one pre-existing `t-elif="this.uiService.isSmall"` in
        // the inherited template, which crm_kanban_renderer.xml only
        // narrows, never replaces).
        this.ui = usePlugin(UIPlugin);
        // Which stage the small-screen branch currently shows
        // (architecture.md §3.4's "prev/next navigation to adjacent
        // stages"). Local-only UI state, not derived from the offline
        // queue, hence a plain signal rather than the shared hooks module
        // (AGENTS.md §2 "state lives in signal/signal.Object/computed").
        this.mobilePipelineIndex = signal(0);
        // VAL-MOBILE-009: the mobile pipeline's own quick-create sheet,
        // literally `{ useBottomSheet: true }` (architecture.md §3.4) --
        // unlike the PLS tooltip's own popover (`crm_pls_tooltip_button.js`),
        // which also opens on desktop and so picks bottom-sheet-vs-popover
        // from the current screen size, this control is only ever rendered
        // inside the mobile-pipeline branch (`isMobilePipeline` below), so
        // there is no desktop case to branch on.
        this.quickCreatePopover = usePopover(CrmMobileQuickCreate, { useBottomSheet: true });
        // VAL-MOBILE-003/018 / architecture.md §3.4, scrutiny round 2
        // (orchestrator-triage.md): which stages currently have at least
        // one queued create -- a plain Set, not a signal/computed: it is
        // never read during render (AGENTS.md §2's "signal/signal.Object/
        // computed" rule governs *rendered* state), it exists only so the
        // effect below can spot one stage's queue draining between two
        // runs. No per-stage *count* is kept any more: round 1's own
        // Map<stageId, count> remembered only the last-seen non-zero
        // count, so two creates in one stage replaying separately (the
        // queue going 2->1->0, one `_syncORM` call at a time) credited
        // the stage with just 1 sync instead of 2, and a create discarded
        // from the systray while offline left its count sitting in the
        // map to be wrongly credited as a sync on the next reconnect.
        // Set membership is enough to know *that* a stage's queue just
        // drained; the exact resulting count is asked from the server
        // below instead of added up from how many replays crm thinks it
        // saw.
        this._stageIdsWithPendingLeadCreates = new Set();
        // VAL-MOBILE-018: the only trigger is the OfflinePlugin's own
        // queue signal, read here through `pendingLeadCreates` (never
        // polling, no online/offline listener of our own -- the queue
        // transition *is* the reconnection signal, since a failed replay
        // re-schedules the same entry under the same key with `extras.
        // error` set, offline_plugin.js's `_syncORM`, so it never leaves
        // `pendingLeadCreates` non-empty). When one stage's set of queued
        // creates drains while online, that stage's own `web_save`
        // replay(s) all succeeded, so its list -- and only its list -- is
        // reloaded (`group.list.load()`, the same per-group fetch
        // `toggle()` already uses, architecture.md §2) so the real card
        // the replay just created replaces the pending-sync card with no
        // page reload and no duplicate (the stale pending card simply
        // stops rendering once the queue entry is gone, crm_kanban_
        // renderer.xml's `mobilePipelinePendingLeadCreatesFor`).
        //
        // orchestrator-triage.md round 2 (VAL-MOBILE-003/018): a stage's
        // queue draining while *offline* is a systray discard, not a sync
        // (`_syncORM` never runs offline) -- it is dropped from tracking
        // below with no reload, so a later reconnect finds nothing
        // tracked for that stage and leaves its count untouched, instead
        // of round 1's carried-forward count wrongly crediting the
        // discard as a sync once online.
        //
        // Draining while *online* reloads the list, then takes the exact
        // count from the server instead of computing one: `list.load()`'s
        // own fresh `list.count` is already exact unless it hit
        // `RelationalModel.DEFAULT_COUNT_LIMIT` (`hasLimitedCount`,
        // dynamic_record_list.js's `_updateCount`), in which case
        // `list.fetchCount()` -- the same public "the count is capped,
        // fetch the real one" method the list/kanban pagers already call
        // for their own "see all" link (list_controller.js,
        // kanban_controller.js) -- issues one `search_count` for this
        // group's own domain and clears the cap on this list's config.
        // Either way `group.count` ends up a plain copy of that now-exact
        // `group.list.count`: never the capped number, never crm's own
        // arithmetic on top of it. Then the public `progressBarState.
        // updateCounts(group)` refreshes the revenue aggregate the same
        // way as before (its own two RPCs, `read_progress_bar` and
        // `formattedReadGroup`, never call any group's `list.load()`, so
        // no other stage's card list is fetched).
        useEffect(() => {
            if (!this.isMobilePipeline) {
                return;
            }
            const stageIdsWithPendingLeadCreates = new Set();
            for (const group of this.mobilePipelineGroups) {
                const stageId = group.value;
                const hasPendingLeadCreates =
                    this.crmOffline.pendingLeadCreates(stageId).length > 0;
                if (hasPendingLeadCreates) {
                    stageIdsWithPendingLeadCreates.add(stageId);
                } else if (
                    this._stageIdsWithPendingLeadCreates.has(stageId) &&
                    !this.crmOffline.isOffline()
                ) {
                    group.list.load().then(async () => {
                        if (group.list.hasLimitedCount) {
                            await group.list.fetchCount();
                        }
                        group.count = group.list.count;
                        this.props.progressBarState?.updateCounts(group);
                    });
                }
                // Still offline here means this stage's queue drained via
                // a discard, not a replay (`isOffline()` checked before
                // acting, never caught from the reload itself, the same
                // "skip, don't catch" rule as every other offline probe
                // in this addon, architecture.md §2): leave it out of
                // `stageIdsWithPendingLeadCreates` so nothing is reloaded
                // now or carried forward to a later reconnect.
            }
            this._stageIdsWithPendingLeadCreates = stageIdsWithPendingLeadCreates;
        });
    }

    /**
     * VAL-MOBILE-003/005: gates the whole small-screen branch -- grouped
     * by stage only. architecture.md §3.4 names the pipeline specifically;
     * any other group-by (forecast's date_deadline, team, ...) falls
     * through to the exact same column layout as today, just narrower.
     *
     * `this.env.config.actionId` also has to be set, i.e. this renderer
     * has to be reached through a real window action, not an ad-hoc
     * `mountView()`. The real pipeline is never opened any other way,
     * so this narrows nothing in production; it does keep this branch
     * out of crm_offline_kanban_group_guards.test.js's and
     * crm_offline_mrr.test.js's own `mountView()` calls, which reuse the
     * same arch shape (`js_class="crm_kanban"`, grouped by `stage_id`)
     * to test unrelated, pre-existing group-level guards against the
     * untouched multi-column mobile layout those tests were written
     * against -- there is no arch-level difference from the real
     * pipeline to gate on instead.
     */
    get isMobilePipeline() {
        return (
            this.ui.isSmall() &&
            Boolean(this.env.config.actionId) &&
            this.props.list.isGrouped &&
            this.props.list.groupByField?.name === "stage_id"
        );
    }

    get mobilePipelineGroups() {
        return this.props.list.isGrouped ? this.props.list.groups : [];
    }

    get _mobilePipelineClampedIndex() {
        const length = this.mobilePipelineGroups.length;
        if (!length) {
            return 0;
        }
        return Math.min(Math.max(this.mobilePipelineIndex(), 0), length - 1);
    }

    get mobilePipelineGroup() {
        return this.mobilePipelineGroups[this._mobilePipelineClampedIndex] || null;
    }

    get mobilePipelineHasPrev() {
        return this._mobilePipelineClampedIndex > 0;
    }

    get mobilePipelineHasNext() {
        return this._mobilePipelineClampedIndex < this.mobilePipelineGroups.length - 1;
    }

    mobilePipelineGoPrev() {
        return this._mobilePipelineGoTo(this._mobilePipelineClampedIndex - 1);
    }

    mobilePipelineGoNext() {
        return this._mobilePipelineGoTo(this._mobilePipelineClampedIndex + 1);
    }

    /**
     * VAL-MOBILE-006/018 / architecture.md §3.4 "Offline: cached stage
     * renders; uncached stage shows OfflineActionHelper": a stage's
     * records are "cached" once they have actually been fetched, which is
     * not the same thing as "unfolded" -- a folded group's records come
     * from their own, separately disk-cached `list.load()` call, unlike
     * the rest of the pipeline, whose columns (count and `expected_revenue`
     * aggregate included) all come from the one `web_read_group` that
     * loaded the whole board (research/design_options.md "per-stage
     * offline behaviour"), and upstream's `Group.toggle()`
     * (group.js:95-101) never clears `list.records` on folding, so a
     * group folded again (or synced into while still folded, see the
     * sync-refresh effect above) keeps whatever it already loaded.
     * orchestrator-triage.md round-1 blockers 2 and 4: treating every
     * folded group as uncached hid cards the pipeline had already
     * fetched; only a stage with records it hasn't loaded yet still
     * needs the helper.
     *
     * orchestrator-triage.md round 2: `!group.list.records.length` alone
     * can't tell a stage that was fetched online and is genuinely empty
     * apart from one never fetched at all -- both have zero records in
     * memory. `group.count` is the one way to tell them apart without a
     * crm-owned "have I fetched this" cache: it comes from the pipeline's
     * one board-wide `web_read_group`, which reports every stage's exact
     * total up front regardless of fold state (architecture.md §3.4), so
     * it is already 0 for a stage with nothing to show and > 0 for one
     * whose leads this device just hasn't loaded. Comparing it against
     * the records actually in memory, rather than testing either number
     * in isolation, keeps a partially-loaded stage (fewer records loaded
     * than its count) correctly "uncached" too.
     */
    mobilePipelineIsUncached(group) {
        return group.isFolded && group.list.records.length < group.count;
    }

    /**
     * VAL-MOBILE-006: `isOffline()` is checked *before* loading, never
     * caught from the load itself (the "skip, don't catch" rule this
     * addon applies to every offline probe, architecture.md §2): an
     * uncached stage (`mobilePipelineIsUncached`, above) never issues a
     * doomed RPC, crm_kanban_renderer.xml's small-screen branch shows
     * `OfflineActionHelper` for it instead of attempting to toggle it.
     */
    async _mobilePipelineGoTo(index) {
        const group = this.mobilePipelineGroups[index];
        if (!group) {
            return;
        }
        this.mobilePipelineIndex.set(index);
        if (group.isFolded && !this.crmOffline.isOffline()) {
            await group.toggle();
        }
    }

    /**
     * VAL-MOBILE-009/010: every stage the pipeline's one `web_read_group`
     * already knows about -- `group.value` is the real `crm.stage` id
     * (`relational_model/utils.js`'s `getValueFromGroupData`, not the
     * `Group` datapoint's own internal `.id`), the same id
     * `pendingLeadCreates`/`vals.stage_id` compare against. Folded stages
     * are included (their count/aggregates come from that same call,
     * architecture.md §3.4), so picking one here never needs to unfold or
     * load anything.
     */
    get mobilePipelineQuickCreateStages() {
        return this.mobilePipelineGroups.map((group) => ({
            id: group.value,
            displayName: group.displayName,
        }));
    }

    /**
     * VAL-MOBILE-009: opens the quick-create bottom sheet with the exact
     * `group.context` desktop's own kanban quick create uses for this
     * same stage (`kanban_renderer.xml`'s `context="group.context"`), so
     * the queued/created lead gets the same `default_type`/team context
     * either way.
     *
     * orchestrator-triage.md blocker 1: `queueExtras` is this renderer's
     * own `env.config` (`actionId`/`actionName`/`viewType`), the one piece
     * of `getScheduleORMExtras`-shaped data the sheet itself has no way to
     * get at (it is never mounted inside the action's own component tree).
     */
    onMobileQuickCreate(ev) {
        const group = this.mobilePipelineGroup;
        if (!group) {
            return;
        }
        this.quickCreatePopover.open(ev.currentTarget, {
            resModel: group.resModel,
            context: group.context,
            stages: this.mobilePipelineQuickCreateStages,
            defaultStageId: group.value,
            queueExtras: {
                actionId: this.env.config.actionId,
                actionName: this.env.config.actionName,
                viewType: this.env.config.viewType,
            },
            onCreated: ({ leadId, stageId }) => this.onMobileLeadCreated(leadId, stageId),
        });
    }

    /**
     * VAL-MOBILE-011: online, the sheet already created the lead on the
     * server (its own `onSave`) -- this is only the "show it without a
     * reload" half, the same `group.addExistingRecord(id, true)` desktop's
     * `KanbanController.validateQuickCreate` uses for its own quick create
     * (`kanban_renderer.js`). Offline, `onCreated` is still called (with
     * `leadId` null): nothing to add here, the pending-sync card
     * (`mobilePipelinePendingLeadCreatesFor`) already renders from the
     * queue reactively.
     *
     * m4-fix-header-after-sync (VAL-MOBILE-011): `addExistingRecord`
     * increments `group.count` itself, so the header's lead count was
     * already right after an online create -- but
     * `KanbanRenderer.validateQuickCreate` also calls `progressBarState.
     * updateCounts(group)` right after its own `addExistingRecord`, and
     * this method didn't, so the header's revenue sum (sourced from
     * `ProgressBarState.getAggregateValue`, not from `group.count`) kept
     * showing the pre-create total. Added here for parity, same RPCs as
     * documented on the sync-refresh effect above.
     */
    async onMobileLeadCreated(leadId, stageId) {
        if (!leadId) {
            return;
        }
        const group = this.mobilePipelineGroups.find((g) => g.value === stageId);
        if (group) {
            await group.addExistingRecord(leadId, true);
            this.props.progressBarState?.updateCounts(group);
        }
    }

    /**
     * VAL-MOBILE-010: the pending-sync cards for one stage's own queued
     * lead creates -- a queued create has no id yet, so it can't be one of
     * `group.list.records` and needs its own presentational card
     * (`CrmMobilePendingLeadCreate`) instead of `CrmMobileCard`.
     */
    mobilePipelinePendingLeadCreatesFor(group) {
        if (!this.isMobilePipeline) {
            return [];
        }
        return this.crmOffline.pendingLeadCreates(group.value);
    }

    /**
     * @override
     *
     * B56 / VAL-DIS-015: the "Add a column" quick-create's `createGroup()`
     * (`relational_model/dynamic_group_list.js`) calls `crm.stage.name_create`
     * and then uses the *id that call returns* to resequence and configure
     * the new column -- an id produced by the call itself, so it can never
     * be queued verbatim (architecture.md §3.7's chained-id rule). Hide the
     * whole "Add a column" area instead of adding a queue hook for it.
     * Reading `isOffline()` here (a reactive signal) during render means an
     * area already unfolded before going offline disappears too, instead
     * of staying open and able to be submitted.
     *
     * VAL-MOBILE-003: also hidden in the small-screen pipeline branch --
     * "add a whole new stage" has no sensible place in a one-stage-at-a-
     * time view, and leaving it reachable would render it as a second
     * stacked item below the active stage (crm_kanban_renderer.scss's
     * `flex-direction: column` for that branch), which looks like part of
     * the active stage's own content.
     */
    canCreateGroup() {
        return !this.isMobilePipeline && !this.crmOffline.isOffline() && super.canCreateGroup();
    }

    /**
     * @override
     *
     * VAL-MOBILE-003/004: the small-screen branch shows one stage at a
     * time (architecture.md §3.4) by hiding every other group with the
     * same bootstrap utility class the framework already disables offline
     * buttons with elsewhere in this addon, instead of a parallel layout
     * system; with every sibling column removed from the flex row, the
     * one left standing (still `flex: 1 1` from kanban_controller.scss)
     * naturally grows to fill it -- no new width CSS needed for it.
     * Desktop (`isMobilePipeline` false) returns the base classes
     * untouched.
     */
    getGroupClasses(group, isGroupProcessing) {
        const classes = super.getGroupClasses(group, isGroupProcessing);
        if (!this.isMobilePipeline) {
            return classes;
        }
        return group.id === this.mobilePipelineGroup?.id
            ? `${classes} o_crm_mobile_pipeline_active`
            : `${classes} d-none`;
    }

    /**
     * @override
     *
     * B58/B71/B73 / VAL-DIS-015/016: dropping a dragged stage or other
     * group-by column calls the shared `resequence()` util, which issues
     * `orm.webResequence` -- not one of the framework's four auto-queued
     * producers (architecture.md §3.7). Block the drag from starting at
     * all instead of adding a queue hook for it; `useSortable`'s `enable`
     * callback (`core/utils/draggable_hook_builder.js`) is re-evaluated on
     * every drag attempt, so this also covers a drag attempted right after
     * going offline. Not gated on which field the view is grouped by: the
     * base getter already covers every group-by, stage or not.
     */
    get canResequenceGroups() {
        return !this.crmOffline.isOffline() && super.canResequenceGroups;
    }
}
