/**
 * Small-screen, stage-at-a-time CRM pipeline.
 *
 * Registered as the view `crm_mobile_pipeline`, selected by `js_class="crm_mobile_pipeline"` on the
 * pipeline arch (`crm.crm_case_kanban_view_leads`). It is the CRM kanban view (`crmKanbanView`)
 * with two classes swapped in:
 *
 * - `CrmMobilePipeline`, the renderer: on small screens, while the pipeline is grouped by
 *   `stage_id`, it displays one stage at a time (fixed header with the stage name, lead count and
 *   revenue sum, previous/next navigation and swipe), the CRM mobile lead cards, the mobile quick
 *   create bottom sheet and the offline helpers. Everywhere else its template renders the standard
 *   `web.KanbanRenderer`, so desktop and every other grouping keep exactly the kanban DOM;
 * - `CrmMobilePipelineController`, the controller adapter: it keeps the displayed stage across
 *   reloads and breadcrumbs, restores the mobile scroll of that stage, and opens the framework quick
 *   create (New) in the displayed stage. Outside the mobile pipeline every override calls `super`.
 *
 * Model, arch parser, search model, control panel and button template stay the CRM kanban view's:
 * there is no second model.
 *
 * Offline rules this file keeps:
 * - It has no offline machinery of its own: offline and small-screen state come from
 *   `useCrmOffline()`, reads go through the framework disk cache (`loadActivityTypes`,
 *   `loadLeadActivities`) and nothing is persisted.
 * - It queues nothing itself. Stage moves go through the framework kanban move (`moveRecords`),
 *   which queues the stage write offline; lead and activity creates are queued by the child
 *   components through `runOrQueue`.
 * - Pending placement and pending-aware totals are derived from framework state only: the offline
 *   queue entries, each record's framework group, its `stage_id` and its `serverStageId` (set by
 *   the CRM kanban model's record class). The derivation is memoized until that state changes, so
 *   every reader shares one derivation per change. No correction is stored.
 * - Every read (activities, activity types, reconciliation reload) is issued only on small screens
 *   in the stage pipeline, so desktop RPC sequences are unchanged.
 */

import {
    computed,
    onPatched,
    onWillPatch,
    proxy,
    signal,
    status,
    untrack,
    useOnChange,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { getTabableElements } from "@web/core/utils/ui";
import { onWillRender, useSubEnv } from "@web/owl2/utils";
import { useSetupAction } from "@web/search/action_hook";
import { formatInteger, formatMonetary } from "@web/views/fields/formatters";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { CrmMobileLeadCard } from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
import { CrmMobileQuickCreate } from "@crm/mobile/crm_mobile_quick_create/crm_mobile_quick_create";
import {
    loadActivityTypes,
    loadLeadActivities,
    useCrmOffline,
} from "@crm/mobile/crm_offline_hooks";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { crmKanbanView } from "@crm/views/crm_kanban/crm_kanban_view";

/** Minimal horizontal distance, in CSS pixels, of a swipe that changes the displayed stage. */
const SWIPE_THRESHOLD = 50;

/**
 * @typedef {import("@web/model/relational_model/dynamic_group_list").DynamicGroupList} DynamicGroupList
 * @typedef {import("@web/model/relational_model/group").Group} Group
 * @typedef {import("@web/model/relational_model/record").Record} RelationalRecord
 * @typedef {{ key: string | number, value: { model: string, method: string, args: any[],
 *   kwargs: Object, extras: Object } }} QueueEntry an entry of the framework offline queue,
 *   exactly as the framework stores it
 * @typedef {{ cards: RelationalRecord[], pendingCreates: QueueEntry[], count: number,
 *   revenueAdjustments: number[] }} StageSummary what a stage displays: its cards (its own
 *   records first, then the records a queued write places there), its queued lead creates, its
 *   pending-aware lead count, and the signed sum-field amounts added, in order, to its loaded
 *   aggregate. The arrays are shared by every reader and must not be mutated.
 * @typedef {{ placement: Map<string, number | false | undefined>,
 *   groupsByValue: Map<number | false, Group[]>, byGroupId: Map<string, StageSummary> }}
 *   StageProjection the displayed stage of every loaded record (by record datapoint id), the
 *   groups of the pipeline by stage id, and the summary of every group (by group datapoint id)
 */

// -----------------------------------------------------------------------------
// Helpers shared by the renderer and the controller adapter
// -----------------------------------------------------------------------------

/**
 * The gate of every mobile behaviour: a small screen and a pipeline grouped by stage with at least
 * one stage group. Kanban views keep a single grouping level (`maxGroupByDepth: 1`), so the first
 * group-by field decides. False on desktop, for any other grouping (salesperson, team, a custom
 * group-by), for an ungrouped list (group-by cleared on a phone) and when there is no group, so no
 * non-stage group is ever treated as a stage.
 *
 * @param {DynamicGroupList | Object | undefined | null} list the root list of the view
 * @param {boolean} isSmall the small-screen signal
 * @returns {boolean}
 */
export function isCrmMobilePipeline(list, isSmall) {
    return Boolean(
        isSmall &&
            list?.isGrouped &&
            list.groupByField?.name === "stage_id" &&
            list.groups?.length > 0
    );
}

/**
 * The stage groups in display order, the same as `KanbanRenderer.getGroupsOrRecords()`: the group
 * without a value (no stage) first, then the groups in server order. Used for the navigation and
 * the stage lists.
 *
 * @param {DynamicGroupList} list
 * @returns {Group[]}
 */
export function orderedStageGroups(list) {
    return [...(list?.groups ?? [])].sort((a, b) =>
        a.value && !b.value ? 1 : !a.value && b.value ? -1 : 0
    );
}

/**
 * The displayed stage group: the group of the given stage when it exists, else the group the base
 * kanban controller opens a quick create in (the first unfolded group, else the first group), so
 * the initial displayed stage is the one the framework would have chosen.
 *
 * The displayed stage is stored as a stage id (`serverValue`, `false` for the no-stage group) and
 * never as a group datapoint id, because every reload rebuilds the groups with new ids.
 *
 * @param {DynamicGroupList} list
 * @param {number | false | null | undefined} serverValue the stage id, `null`/`undefined` if none
 * @returns {Group | undefined} always defined when the list has a group
 */
export function resolveDisplayedGroup(list, serverValue) {
    const groups = list?.groups ?? [];
    if (serverValue !== null && serverValue !== undefined) {
        const group = groups.find((candidate) => candidate.serverValue === serverValue);
        if (group) {
            return group;
        }
    }
    return groups.find((candidate) => !candidate.isFolded) ?? groups[0];
}

// -----------------------------------------------------------------------------
// Renderer
// -----------------------------------------------------------------------------

export class CrmMobilePipeline extends CrmKanbanRenderer {
    static template = "crm.CrmMobilePipeline";
    static components = {
        ...CrmKanbanRenderer.components,
        CrmMobileLeadCard,
        OfflineActionHelper,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.quickCreatePopover = usePopover(CrmMobileQuickCreate, {
            useBottomSheet: true,
            withScope: true,
        });
        this.mobileState = proxy({
            /** Lead whose form is not available offline: the stage body shows the helper. */
            unavailableLeadId: null,
            /**
             * Cached activities by lead id, as read by `loadLeadActivities`: a bounded page (the
             * loader's default limit, or the limit in `activityLimitsByLead`).
             */
            activitiesByLead: {},
            /**
             * The server's total count of each lead's activities, read with its page: when it
             * exceeds the page, the card shows the total and offers "Show all" online.
             */
            activityTotalsByLead: {},
            /**
             * Activity limit by lead id, set only by an explicit online "Show all": every later
             * revalidation of that lead reissues the same expanded request (answered by the cache
             * offline). A lead without an entry is read with the loader's default request.
             */
            activityLimitsByLead: {},
            /** Cached creatable activity types, `null` until read (or when not cached). */
            activityTypes: null,
            /**
             * Queue entries as they were when the current sync window began, `null` outside a
             * sync window. While set, a write replayed during the sync keeps its placement until
             * the reconciliation reload that incorporates it has landed.
             */
            syncEntries: null,
        });
        /**
         * Ids of the stage groups whose Load more is in flight (`onLoadMoreClick`), each mapped to
         * `true` until its load settles. Transient presentation state: the button is disabled and
         * busy meanwhile (`isLoadingMore`).
         */
        this.loadingMoreGroups = proxy({});
        // Provided by `CrmMobilePipelineController`; a local state keeps the renderer usable on
        // its own (it then starts on the framework's default stage).
        this.stageState = this.env.crmMobileStage ?? proxy({ serverValue: null });
        /** Touch gesture in progress on the stage body (swipe navigation). */
        this.touch = null;
        /**
         * Placement of every loaded record and summary of every stage, derived in one pass (see
         * `_computeStageProjection`). Lazy: derived on the first read after a change of the
         * framework state it reads, then shared by every reader until the next change; never
         * read outside the mobile pipeline.
         *
         * @type {() => StageProjection}
         */
        this._stageProjection = computed(() => this._computeStageProjection());
        /**
         * The stage groups in display order, one array until the groups or their order change,
         * so the navigation and every card share it.
         *
         * @type {() => Group[]}
         */
        this._orderedStageGroups = computed(() => orderedStageGroups(this.props.list), {
            equals: (previous, next) =>
                previous.length === next.length &&
                previous.every((group, index) => group === next[index]),
        });
        /** Back button of the unavailable-lead helper. */
        this.backRef = signal.ref();
        /**
         * Focus move pending for the unavailable-lead helper, consumed after a patch (see
         * `_setupHelperFocus`): `resId` is the lead whose card was tapped, `focus` is `"back"`
         * until the helper has focused Back, `"return"` once Back was chosen, `null` otherwise.
         * Transient and never rendered: `null` while the helper is not displayed.
         *
         * @type {{ resId: number, focus: "back" | "return" | null } | null}
         */
        this.helperFocus = null;

        this._setupActivityRevalidation();
        this._setupSyncReconciliation();
        this._setupHelperFocus();
        // After the helper focus: on a patch both handle, the helper's focus move comes first.
        this._setupNavFocus();
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    /** Whether the mobile markup is rendered (see `isCrmMobilePipeline`). */
    get isMobilePipeline() {
        return isCrmMobilePipeline(this.props.list, this.crmOffline.isSmall());
    }

    /**
     * @returns {Group[]} the stage groups in display order: the same array until the groups or
     *   their order change (shared, must not be mutated)
     */
    get stageGroups() {
        return this._orderedStageGroups();
    }

    /** @returns {Group | undefined} the displayed stage, always defined while the gate holds */
    get currentGroup() {
        return resolveDisplayedGroup(this.props.list, this.stageState.serverValue);
    }

    /** @returns {number} index of the displayed stage in `stageGroups`, -1 if none */
    get currentIndex() {
        const current = this.currentGroup;
        if (!current) {
            return -1;
        }
        return this.stageGroups.findIndex((group) => group.id === current.id);
    }

    get hasPrevStage() {
        return this.currentIndex > 0;
    }

    get hasNextStage() {
        const index = this.currentIndex;
        return index >= 0 && index < this.stageGroups.length - 1;
    }

    /**
     * Queue entries the placement and the totals are derived from: the live framework queue, plus,
     * during a sync window (and until its reconciliation reload has landed), the entries the window
     * began with that have left the queue since (replayed writes the loaded data does not include
     * yet). Entries are the framework's `{key, value}` objects, never copied into another shape and
     * never mutated; a live entry wins over a snapshot entry of the same key.
     *
     * Union rather than replacement: an entry queued while the snapshot is held (the connection
     * dropped again during the sync, for instance) is placed at once as well.
     *
     * @returns {readonly QueueEntry[]} a frozen array, so the hook readers index it once (only the
     *   array is frozen, never the entries)
     */
    get stageEntries() {
        const live = this.crmOffline.queuedEntries();
        const snapshot = this.mobileState.syncEntries;
        if (!snapshot?.length) {
            return Object.freeze(live);
        }
        const liveKeys = new Set(live.map((entry) => String(entry.key)));
        return Object.freeze([
            ...live,
            ...snapshot.filter((entry) => !liveKeys.has(String(entry.key))),
        ]);
    }

    /** Whether the arch declares a sum field (`expected_revenue` on the pipeline arch). */
    get hasRevenue() {
        return Boolean(this.props.progressBarState?.progressAttributes?.sumField);
    }

    /** Whether the header offers the mobile quick create. */
    get canAdd() {
        return Boolean(this.props.archInfo.activeActions?.create);
    }

    // -------------------------------------------------------------------------
    // Pending placement and pending-aware totals
    // -------------------------------------------------------------------------
    //
    // Derived from framework state alone: the queue entries (`stageEntries`) and each loaded
    // record's framework group, `stage_id` and `serverStageId`. `_computeStageProjection` derives
    // the placement of every record and the summary of every stage in one pass, and
    // `_stageProjection` memoizes it until one of those inputs changes, so the header, the card
    // loops, the helper, the remaining count and the activity revalidation share one derivation
    // per change. Nothing here writes any state, and the memo is never a stored correction: an
    // offline move returns from the framework save before the aggregates are refreshed, and every
    // reload rebuilds the groups and records from server or cache data that predate the queued
    // writes, so stored corrections would go stale, while derived ones survive a form → back, an
    // offline reload and a reconciliation that leaves a parked write. A parked entry
    // (`extras.error`) stays in the queue and keeps its placement; a systray discard removes the
    // entry and ends it.

    /**
     * The stage a loaded record is displayed in.
     *
     * - Not a lead built by the CRM kanban model, or `stage_id` not loaded (see `_tracksStage`):
     *   its framework group.
     * - `stage_id` differs from `serverStageId`: an offline commit on this record instance, after
     *   which the framework already moved the card in memory, so its framework group.
     * - Else, a queued `stage_id` write of the lead whose stage is a group of the pipeline: that
     *   stage. This is the state after a reload rebuilt the record from data predating the write.
     * - Else its framework group.
     *
     * Read from the stage projection; a record the list does not hold is placed on its own with
     * the same rules.
     *
     * @param {RelationalRecord} record
     * @returns {number | false | undefined} the stage id (`serverValue`)
     */
    displayStage(record) {
        const { placement, groupsByValue } = this._stageProjection();
        if (placement.has(record.id)) {
            return placement.get(record.id);
        }
        const entries = this.stageEntries;
        return this._placeRecord(record, groupsByValue, (resId) =>
            this.crmOffline.latestStageWrite(resId, entries)
        );
    }

    /**
     * The placement rules of `displayStage`, for one record.
     *
     * @private
     * @param {RelationalRecord} record
     * @param {Map<number | false, Group[]>} groupsByValue the groups of the pipeline by stage id
     * @param {(resId: number) => QueueEntry | undefined} latestStageWriteOf the latest queued
     *   stage write of a lead (`latestStageWrite` over the placement's queue entries)
     * @returns {number | false | undefined} the stage id (`serverValue`)
     */
    _placeRecord(record, groupsByValue, latestStageWriteOf) {
        const frameworkStage = record.group?.serverValue;
        if (!this._tracksStage(record)) {
            return frameworkStage;
        }
        const dataStage = record.data.stage_id?.id ?? false;
        if (dataStage !== record.serverStageId) {
            return frameworkStage;
        }
        if (record.resId) {
            const entry = latestStageWriteOf(record.resId);
            if (entry) {
                const stageValue = entry.value.args?.[1]?.stage_id;
                if (groupsByValue.has(stageValue)) {
                    return stageValue;
                }
            }
        }
        return frameworkStage;
    }

    /**
     * Derives the stage projection in one pass over the loaded records: the queue entries are
     * taken once (`stageEntries`, a frozen array), each loaded lead's latest stage write is looked
     * up once and each stage's queued creates once. Queue parsing stays in the shared hook
     * readers, which index the frozen entries in one traversal on the first lookup and answer the
     * others from that index, so a pass reads each entry once whatever the number of leads and
     * stages. Every record is then placed once and counted in the summaries of its framework group
     * and of the stage it is displayed in. The summaries follow `cardsFor`, `stageCount` and
     * `_stageRevenue`: same cards in the same order, same count, and the same revenue additions
     * and subtractions in the same order.
     *
     * Pure: it reads framework state and writes none (in particular, the progress bar state's
     * `getGroupInfo`, which registers aggregates, is called by `_stageAggregate`, outside).
     *
     * @private
     * @returns {StageProjection}
     */
    _computeStageProjection() {
        const groups = this.props.list.groups ?? [];
        const entries = this.stageEntries;
        const sumFieldName = this.hasRevenue
            ? this.props.progressBarState.progressAttributes.sumField.name
            : null;
        /** @type {Map<number | false, Group[]>} */
        const groupsByValue = new Map();
        const tallies = new Map();
        for (const group of groups) {
            const sameStage = groupsByValue.get(group.serverValue);
            if (sameStage) {
                sameStage.push(group);
            } else {
                groupsByValue.set(group.serverValue, [group]);
            }
            tallies.set(group.id, { own: [], placed: [], removed: 0, adjustments: [] });
        }
        const latestStageWriteOf = (resId) => this.crmOffline.latestStageWrite(resId, entries);

        const placement = new Map();
        for (const group of groups) {
            const tally = tallies.get(group.id);
            for (const record of group.list.records ?? []) {
                const stageValue = this._placeRecord(record, groupsByValue, latestStageWriteOf);
                placement.set(record.id, stageValue);
                if (stageValue !== group.serverValue) {
                    tally.removed++;
                }
                for (const target of groupsByValue.get(stageValue) ?? []) {
                    const targetTally = tallies.get(target.id);
                    (target.id === group.id ? targetTally.own : targetTally.placed).push(record);
                }
                // Displaced: out of the aggregate of its server stage (an empty group's aggregate
                // is already 0), into the stage it is displayed in.
                if (
                    sumFieldName !== null &&
                    this._tracksStage(record) &&
                    stageValue !== record.serverStageId
                ) {
                    const recordValue = Number(record.data[sumFieldName]) || 0;
                    for (const source of groupsByValue.get(record.serverStageId) ?? []) {
                        if (source.count !== 0) {
                            tallies.get(source.id).adjustments.push(-recordValue);
                        }
                    }
                    for (const target of groupsByValue.get(stageValue) ?? []) {
                        tallies.get(target.id).adjustments.push(recordValue);
                    }
                }
            }
        }

        /** @type {Map<string, StageSummary>} */
        const byGroupId = new Map();
        for (const group of groups) {
            const { own, placed, removed, adjustments } = tallies.get(group.id);
            const pendingCreates = this.crmOffline.pendingLeadCreates(group.serverValue, entries);
            if (sumFieldName !== null) {
                for (const entry of pendingCreates) {
                    adjustments.push(Number(entry.value.args?.[1]?.[sumFieldName]) || 0);
                }
            }
            byGroupId.set(group.id, {
                cards: [...own, ...placed],
                pendingCreates,
                count: Math.max(
                    0,
                    (group.count || 0) - removed + placed.length + pendingCreates.length
                ),
                revenueAdjustments: adjustments,
            });
        }
        return { placement, groupsByValue, byGroupId };
    }

    /**
     * The projection's summary of a stage. A group the current list does not hold (a datapoint of
     * a list a reload replaced, which no template renders) displays nothing: no card, no queued
     * create, a count of 0 and no revenue adjustment.
     *
     * @private
     * @param {Group} group
     * @returns {StageSummary}
     */
    _stageSummary(group) {
        return (
            this._stageProjection().byGroupId.get(group.id) ?? {
                cards: [],
                pendingCreates: [],
                count: 0,
                revenueAdjustments: [],
            }
        );
    }

    /**
     * Whether a record is displayed in another stage than the one the loaded aggregates count it
     * in, i.e. it has a stage write the aggregates do not include yet.
     *
     * @param {RelationalRecord} record
     * @returns {boolean}
     */
    isDisplaced(record) {
        return this._tracksStage(record) && this.displayStage(record) !== record.serverStageId;
    }

    /**
     * Whether a record carries a meaningful `serverStageId`: a lead built by the CRM kanban model
     * whose `stage_id` is among the loaded fields. Without the field in the view, `serverStageId`
     * is `false` whatever the stage, so such a record is placed by its framework group only.
     *
     * @private
     * @param {RelationalRecord} record
     * @returns {boolean}
     */
    _tracksStage(record) {
        return record.serverStageId !== undefined && Boolean(record.activeFields?.stage_id);
    }

    /**
     * Every record held in memory by a group, folded groups included: a card just moved into the
     * folded won stage is held there. (The list's own `records` getter skips folded groups.)
     *
     * @returns {RelationalRecord[]}
     */
    allLoadedRecords() {
        return this.props.list.groups.flatMap((group) => group.list.records ?? []);
    }

    /**
     * Records displayed in a stage: the group's own records first (framework order), then the
     * records of other groups that a queued write places there. Read from the stage projection
     * (shared array, must not be mutated).
     *
     * @param {Group} group
     * @returns {RelationalRecord[]}
     */
    cardsFor(group) {
        if (!group) {
            return [];
        }
        return this._stageSummary(group).cards;
    }

    /**
     * Queued `crm.lead` creates targeting a stage (rendered as pending cards, keyed by queue key).
     * Read from the stage projection (shared array, must not be mutated).
     *
     * @param {Group} group
     * @returns {QueueEntry[]}
     */
    pendingCreatesFor(group) {
        if (!group) {
            return [];
        }
        return this._stageSummary(group).pendingCreates;
    }

    /**
     * Lead count of a stage: the framework group count (already adjusted for in-memory moves),
     * minus the group's records a queued write places elsewhere, plus the other groups' records a
     * queued write places here, plus the queued creates of the stage. Read from the stage
     * projection.
     *
     * @param {Group} group
     * @returns {number}
     */
    stageCount(group) {
        if (!group) {
            return 0;
        }
        return this._stageSummary(group).count;
    }

    /**
     * The loaded aggregate of a stage for the sum field, `{ value, currencies }`.
     *
     * It is read exactly as the desktop column header reads it: `getGroupInfo` first, which
     * registers the group's loaded aggregates in the progress bar state, then `getAggregateValue`.
     * The progress bar counts (`read_progress_bar`) are not part of the framework disk cache, so
     * when the pipeline was loaded offline they are missing and `getGroupInfo` registers nothing:
     * `getAggregateValue` would then answer 0 whatever the loaded data. In that case only (no
     * progress bar data and no active bar filter), the group's own loaded aggregates, served by the
     * disk cache, are used instead, with the same semantics (0 for an empty group, the currencies
     * of a monetary sum field).
     *
     * @private
     * @param {Group} group
     * @returns {{ value: number, currencies?: number[] }}
     */
    _stageAggregate(group) {
        const progressBarState = this.props.progressBarState;
        const { sumField } = progressBarState.progressAttributes;
        const progressInfo = progressBarState.getGroupInfo(group);
        if (!progressInfo?.isReady && !progressBarState.activeBars?.[group.serverValue]) {
            const aggregates = group.aggregates || {};
            const value = group.count ? Number(aggregates[sumField.name]) || 0 : 0;
            if (sumField.type === "monetary" && sumField.currency_field) {
                const currencies = aggregates[sumField.currency_field];
                if (Array.isArray(currencies) && currencies.length) {
                    return {
                        value,
                        currencies: currencies.length > 1 ? currencies : [currencies[0]],
                    };
                }
            }
            return { value };
        }
        const aggregate = progressBarState.getAggregateValue(group, sumField);
        return { value: Number(aggregate.value) || 0, currencies: aggregate.currencies };
    }

    /**
     * Revenue of a stage with its currencies: the loaded aggregate (see `_stageAggregate`), minus
     * the sum field of the displaced records the aggregate counts here (nothing to subtract when
     * the group is empty: the aggregate of an empty group is already 0), plus that of the displaced
     * records displayed here, plus that of the queued creates of the stage. The adjustments come
     * from the stage projection; the aggregate is read here, outside it, because `getGroupInfo`
     * writes the progress bar state.
     *
     * @private
     * @param {Group} group
     * @returns {{ value: number, currencies?: number[] }}
     */
    _stageRevenue(group) {
        if (!group || !this.hasRevenue) {
            return { value: 0 };
        }
        const { value: loadedValue, currencies } = this._stageAggregate(group);
        let value = loadedValue;
        for (const adjustment of this._stageSummary(group).revenueAdjustments) {
            value += adjustment;
        }
        return { value, currencies };
    }

    /**
     * @param {Group} group
     * @returns {number} the pending-aware revenue sum of a stage (0 without a sum field)
     */
    stageRevenueValue(group) {
        return this._stageRevenue(group).value;
    }

    /**
     * The revenue sum of a stage, formatted exactly as the desktop column header formats it
     * (`AnimatedNumber.format`), so currency semantics are unchanged.
     *
     * @param {Group} group
     * @returns {string}
     */
    formatStageRevenue(group) {
        const { value, currencies } = this._stageRevenue(group);
        let currencyId = false;
        if (currencies?.length) {
            currencyId = currencies.length > 1 ? user.activeCompany.currency_id : currencies[0];
        }
        if (currencyId) {
            return formatMonetary(value, {
                currencyId,
                humanReadable: true,
                digits: [null, 0],
                minDigits: 3,
            });
        }
        return formatInteger(value, { humanReadable: true, minDigits: 3 });
    }

    /**
     * Offline, a stage that holds leads none of which is available: the body renders the offline
     * action helper in place of cards. The pending-aware count is used rather than the raw group
     * count, so a stage whose only lead a queued write moved elsewhere shows no helper.
     *
     * @param {Group} group
     * @returns {boolean}
     */
    isStageDataMissing(group) {
        if (!group || !this.crmOffline.isOffline() || !(group.count > 0)) {
            return false;
        }
        const { count, cards, pendingCreates } = this._stageSummary(group);
        return count > 0 && cards.length === 0 && pendingCreates.length === 0;
    }

    /**
     * Offline, the number of leads of a partly loaded stage that cannot be shown.
     *
     * @param {Group} group
     * @returns {number}
     */
    unavailableMoreCount(group) {
        if (!group || !this.crmOffline.isOffline() || this.isStageDataMissing(group)) {
            return 0;
        }
        const { count, cards, pendingCreates } = this._stageSummary(group);
        return Math.max(0, count - cards.length - pendingCreates.length);
    }

    /**
     * @param {Group} group
     * @param {number} [count] the stage's `unavailableMoreCount`, when the caller already has it
     * @returns {string}
     */
    unavailableMoreLabel(group, count = this.unavailableMoreCount(group)) {
        return _t("%(count)s more leads are not available offline", { count });
    }

    /**
     * Offline, whether the lead's form was not visited online (the card is dimmed and opening it
     * shows the offline helper).
     *
     * @param {RelationalRecord} record
     * @returns {boolean}
     */
    isCardUnavailable(record) {
        return Boolean(
            this.crmOffline.isOffline() &&
                !this.crmOffline.isAvailableOffline(
                    this.env.config?.actionId,
                    "form",
                    record?.resId
                )
        );
    }

    // -------------------------------------------------------------------------
    // Effects
    // -------------------------------------------------------------------------

    /**
     * Activity and activity-type revalidation.
     *
     * Dependencies: the gate; the displayed stage's list datapoint, a new object after every root
     * load, model replacement, filter change or reconciliation reload; the ids of the persisted
     * leads the displayed stage shows (stage navigation, Load more, queued moves); and the offline
     * signal. On each change, while the gate holds, every displayed lead's activities and the
     * activity types are read again through the framework disk cache: online that refreshes the
     * cache, and a changed server answer is delivered through the cache callback; offline the
     * cache answers. The per-lead request is the same on every trigger (the loader's bounded
     * default, or the expansion an online "Show all" chose for that lead), so a lead's activities
     * read online come back offline whichever stage, filter or page displayed it, and the types
     * are read again on reconnect, so a cold offline cache miss clears without a manual reload.
     * Each read carries the lead's total count, so a truncated page is shown as such. The
     * connection dropping alone triggers no read (what is in memory is what the cache would
     * answer).
     *
     * Outside the gate the dependencies are constants (plus the offline signal) and nothing is
     * read, so desktop issues no extra RPC.
     *
     * @private
     */
    _setupActivityRevalidation() {
        let previousDependencies = null;
        useOnChange(
            () => {
                const gated = this.isMobilePipeline;
                const group = gated ? this.currentGroup : null;
                const usesSampleData = gated && Boolean(this.props.list.model.useSampleModel);
                const leadIds =
                    gated && !usesSampleData
                        ? this.cardsFor(group)
                              .filter((record) => record.resId)
                              .map((record) => record.resId)
                              .join(",")
                        : "";
                return [
                    gated,
                    usesSampleData,
                    group?.list ?? null,
                    leadIds,
                    this.crmOffline.isOffline(),
                ];
            },
            (...dependencies) => {
                const [gated, usesSampleData, , leadIds, offline] = dependencies;
                const previous = previousDependencies;
                previousDependencies = dependencies;
                // Sample records carry fake ids: nothing is read for them.
                if (!gated || usesSampleData) {
                    return;
                }
                // The connection dropping, with nothing else changed, is not a revalidation
                // trigger: the activities and types in memory are those the cache would answer,
                // and the reads would only fail in the background.
                const onlyWentOffline =
                    previous &&
                    offline &&
                    !previous[4] &&
                    previous.slice(0, 4).every((value, index) => value === dependencies[index]);
                if (onlyWentOffline) {
                    return;
                }
                for (const resId of leadIds.split(",").filter(Boolean).map(Number)) {
                    this._loadLeadActivities(resId);
                }
                this._loadActivityTypes();
            }
        );
    }

    /**
     * Post-sync reconciliation.
     *
     * Going online first clears the offline signal, then the framework replays the queue inside a
     * sync window (`syncingORM`). When the window begins, the queue entries are copied
     * (`syncEntries`), so a write replayed during the sync keeps its presentation. When the
     * connection has returned and no sync is running, the pipeline reloads through the framework
     * model, then drops the copy: created leads and activities appear as server records, and only
     * the entries still in the queue (parked with `extras.error`) keep their pending presentation.
     *
     * The reload runs immediately after reconnecting when nothing is queued, otherwise when the
     * sync window ends; a window that replayed nothing (empty, or parked entries only) reloads only
     * if the reconnection has not been reloaded for yet, so one reconnection reloads once. No id
     * is remapped and nothing is persisted: the copy lives for one sync window, and the reload is
     * the framework model's own.
     *
     * @private
     */
    _setupSyncReconciliation() {
        let wasOffline = this.crmOffline.isOffline();
        let wasSyncing = this.crmOffline.syncingORM();
        // whether the connection came back and the pipeline has not been reloaded since
        let reloadPending = false;
        useOnChange(
            () => [this.crmOffline.isOffline(), this.crmOffline.syncingORM()],
            (offline, syncing) => {
                const previousOffline = wasOffline;
                const previousSyncing = wasSyncing;
                wasOffline = offline;
                wasSyncing = syncing;

                if (offline && !previousOffline) {
                    reloadPending = false;
                }
                if (syncing && !previousSyncing) {
                    this._takeSyncSnapshot();
                }
                if (!offline && previousOffline) {
                    this.mobileState.unavailableLeadId = null;
                    reloadPending = true;
                    if (!syncing && this.crmOffline.queuedEntries().length === 0) {
                        reloadPending = false;
                        this._reconcile();
                    }
                }
                if (!offline && !syncing && previousSyncing) {
                    const replayed = (this.mobileState.syncEntries ?? []).some(
                        (entry) => !entry.value?.extras?.error
                    );
                    if (replayed || reloadPending) {
                        reloadPending = false;
                        this._reconcile();
                    } else {
                        this.mobileState.syncEntries = null;
                    }
                }
            }
        );
    }

    /**
     * Copies the queue entries a sync window begins with, united with the entries of an earlier
     * window whose reconciliation did not land (the connection dropped again), deduplicated by
     * key, the live entry winning. The entries themselves are the framework's, never mutated.
     *
     * @private
     */
    _takeSyncSnapshot() {
        const live = this.crmOffline.queuedEntries();
        const previous = this.mobileState.syncEntries ?? [];
        const liveKeys = new Set(live.map((entry) => String(entry.key)));
        const snapshot = [...live, ...previous.filter((entry) => !liveKeys.has(String(entry.key)))];
        this.mobileState.syncEntries = snapshot.length ? snapshot : null;
    }

    /**
     * Reloads the pipeline through the framework model after a sync, then ends the sync window.
     * A reload that loses the connection keeps the copy, so the next window starts from it. Only
     * in the stage pipeline: elsewhere nothing is reloaded and the copy is dropped.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _reconcile() {
        if (!this.isMobilePipeline || this.props.list.model.useSampleModel) {
            this.mobileState.syncEntries = null;
            return;
        }
        try {
            await this.props.list.load();
            if (status(this) !== "destroyed") {
                this.mobileState.syncEntries = null;
            }
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        }
    }

    /**
     * Reads a lead's activities through the disk cache, with their total count; the first value
     * and any changed refresh are both applied. The request is the loader's default bounded one,
     * or the expanded one an online "Show all" chose for this lead. A value of a request whose
     * limit is no longer the lead's (a bounded read still in flight when "Show all" expanded it)
     * is dropped, so it never replaces the expanded page.
     *
     * @private
     * @param {number} resId
     * @returns {Promise<{ records: Object[], length: number } | null>} the value read, `null` when
     *   the connection is lost and nothing is cached
     */
    async _loadLeadActivities(resId) {
        const limit = this.mobileState.activityLimitsByLead[resId];
        const apply = (result) => {
            if (this.mobileState.activityLimitsByLead[resId] === limit) {
                this._applyActivities(resId, result);
            }
        };
        const activities = await loadLeadActivities(
            this.crmOffline.orm,
            resId,
            apply,
            limit ? { withLength: true, limit } : { withLength: true }
        );
        apply(activities);
        return activities;
    }

    /**
     * Reads the creatable activity types through the disk cache; the first value and any changed
     * refresh are both applied.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _loadActivityTypes() {
        const activityTypes = await loadActivityTypes(this.crmOffline.orm, (fresh) =>
            this._applyActivityTypes(fresh)
        );
        this._applyActivityTypes(activityTypes);
    }

    /**
     * @private
     * @param {Object[] | { records: Object[], length?: number } | null} result
     * @returns {Object[] | null} the records, `null` when there is nothing to apply
     */
    _normalizeRecords(result) {
        if (Array.isArray(result)) {
            return result;
        }
        return Array.isArray(result?.records) ? result.records : null;
    }

    /**
     * @private
     * @param {Object[] | { records: Object[], length?: number }} result a result that has records
     * @param {Object[]} records its records (`_normalizeRecords`)
     * @returns {number} the total count of matching records: the server's `length` when the result
     *   carries one, never less than the records it holds; the record count for a plain array
     */
    _normalizeLength(result, records) {
        const length =
            !Array.isArray(result) && Number.isInteger(result?.length) ? result.length : 0;
        return Math.max(length, records.length);
    }

    /**
     * Stores a lead's activities and their total count. A result arriving after the gate turned
     * false, or after the pipeline was destroyed, is dropped; `null` (connection lost, nothing
     * cached) keeps what is displayed.
     *
     * @private
     * @param {number} resId
     * @param {Object[] | { records: Object[], length: number } | null} result
     */
    _applyActivities(resId, result) {
        if (status(this) === "destroyed" || !this.isMobilePipeline) {
            return;
        }
        const records = this._normalizeRecords(result);
        if (records) {
            this.mobileState.activitiesByLead[resId] = records;
            this.mobileState.activityTotalsByLead[resId] = this._normalizeLength(result, records);
        }
    }

    /**
     * Stores the activity types, with the same rules as `_applyActivities`.
     *
     * @private
     * @param {Object[] | null} result
     */
    _applyActivityTypes(result) {
        if (status(this) === "destroyed" || !this.isMobilePipeline) {
            return;
        }
        const records = this._normalizeRecords(result);
        if (records) {
            this.mobileState.activityTypes = records;
        }
    }

    /**
     * Focus of the unavailable-lead helper, which replaces the stage body's cards when a lead
     * that is not available offline is tapped.
     *
     * - The patch that displays the helper focuses Back once. Back is described by the helper's
     *   sentence, so a screen reader announces why the lead did not open; nothing in the stage
     *   body is live-announced.
     * - A reload keeps the stage body, which is keyed by stage, and Back in it, so Back keeps the
     *   focus. A displayed stage that changes while the helper stays (stage navigation leaves the
     *   helper first, but a reload whose groups no longer hold that stage does not) rebuilds the
     *   stage body, Back included: the new Back takes the focus over when the old one held it. A
     *   re-render never takes the focus back to Back from another control.
     * - When the helper is left through Back, or while Back holds the focus (stage navigation,
     *   reconnection), the focus moves, after the patch that removes the helper, to the tapped
     *   card's first control, else a header control (see `_focusAfterHelper`), instead of
     *   dropping to the document body. A later reload, such as the reconciliation reload after
     *   reconnecting, re-creates the cards, whose keys carry the group datapoint id it renews,
     *   and so drops that focus, as it does for any focused card control.
     *
     * Requests are one-shot and consumed after the patch that renders them, once the DOM exists.
     *
     * @private
     */
    _setupHelperFocus() {
        let backHadFocus = false;
        onWillPatch(() => {
            const back = this.backRef();
            backHadFocus = Boolean(back?.contains(document.activeElement));
        });
        onPatched(() => {
            const request = this.helperFocus;
            if (!request) {
                return;
            }
            const back = this.backRef();
            if (back) {
                if (request.focus === "back" || (backHadFocus && document.activeElement !== back)) {
                    request.focus = null;
                    back.focus();
                }
                return;
            }
            if (this.mobileState.unavailableLeadId) {
                // The helper is requested but not rendered yet (not the mobile pipeline, or a
                // render that started earlier): the patch that renders it consumes the request.
                return;
            }
            this.helperFocus = null;
            if (request.focus === "return" || backHadFocus) {
                this._focusAfterHelper(request.resId);
            }
        });
    }

    /**
     * Focuses, once the unavailable-lead helper is left, the first control of the tapped lead's
     * card when the displayed stage shows it (the card itself has no tabindex), else the first
     * header control (previous, next, Add), else the first control of the pipeline. Nothing is
     * focused outside the mobile pipeline.
     *
     * @private
     * @param {number} resId the lead whose card opened the helper
     */
    _focusAfterHelper(resId) {
        const root = this.rootRef();
        if (!root || !this.isMobilePipeline) {
            return;
        }
        const record = this.cardsFor(this.currentGroup).find((card) => card.resId === resId);
        const cardEl =
            record &&
            [...root.querySelectorAll(".o_crm_mobile_pipeline_body .o_crm_mobile_lead_card")].find(
                (el) => el.dataset.id === record.id
            );
        const headerEl = root.querySelector(".o_crm_mobile_pipeline_header");
        const target =
            (cardEl && getTabableElements(cardEl)[0]) ||
            (headerEl && getTabableElements(headerEl)[0]) ||
            getTabableElements(root)[0];
        target?.focus();
    }

    /**
     * Focus of the stage navigation. The previous button is not rendered on the first stage, nor
     * the next button on the last one, so displaying that stage removes the button when it holds
     * the focus (Next activated to reach the last stage, Previous to reach the first one). After
     * the patch that removes it, the focus moves to the first header control, which is then the
     * remaining navigation button, else Add, else the first control of the pipeline, instead of
     * dropping to the document body.
     *
     * Only the removal of the focused navigation button moves the focus, whatever displayed the
     * stage (a button, a key, a swipe or a reload), and only when no other control took the focus
     * in that patch: the unavailable-lead helper's focus move (`_setupHelperFocus`, which runs
     * first) wins, and a focus held anywhere else is never moved. Nothing is focused outside the
     * mobile pipeline.
     *
     * @private
     */
    _setupNavFocus() {
        /** @type {Element | null} the navigation button holding the focus before the patch */
        let focusedNav = null;
        onWillPatch(() => {
            const active = document.activeElement;
            focusedNav =
                active?.matches(".o_crm_mobile_pipeline_prev, .o_crm_mobile_pipeline_next") &&
                this.rootRef()?.contains(active)
                    ? active
                    : null;
        });
        onPatched(() => {
            const removed = Boolean(focusedNav && !focusedNav.isConnected);
            focusedNav = null;
            const active = document.activeElement;
            if (!removed || (active && active !== document.body)) {
                // No focused navigation button was removed, or another control took the focus.
                return;
            }
            const root = this.rootRef();
            if (!root || !this.isMobilePipeline) {
                return;
            }
            const headerEl = root.querySelector(".o_crm_mobile_pipeline_header");
            const target =
                (headerEl && getTabableElements(headerEl)[0]) || getTabableElements(root)[0];
            target?.focus();
        });
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /**
     * Displays a stage. Online, a folded stage is loaded and unfolded through the inherited
     * `toggleGroup`. Offline, a folded stage is never loaded (no uncached read is attempted) and
     * its fold state is left alone: it is sent with the next `web_read_group`, so changing it
     * would change the cached request and break the next offline reload.
     *
     * @param {Group} group
     * @returns {Promise<void>}
     */
    async goToGroup(group) {
        if (!group) {
            return;
        }
        this.mobileState.unavailableLeadId = null;
        this.stageState.serverValue = group.serverValue;
        if (!this.crmOffline.isOffline() && group.isFolded) {
            try {
                await this.toggleGroup(group);
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
            }
        }
    }

    /**
     * Whether the Load more of a stage is in flight: its button is then disabled and busy.
     *
     * @param {Group} group
     * @returns {boolean}
     */
    isLoadingMore(group) {
        return Boolean(group && this.loadingMoreGroups[group.id]);
    }

    /**
     * Load more, online only, as the template renders it: a folded stage is loaded and unfolded
     * through the inherited `toggleGroup`, any other stage gets its next page through the inherited
     * `loadMore`. The stage is marked as loading until the load settles, so its button shows a
     * spinner, is busy and disabled meanwhile, and a second activation loads nothing. Offline
     * nothing is loaded (a folded stage is never loaded offline). A lost connection leaves the
     * stage as it was.
     *
     * @param {Group} group
     * @returns {Promise<void>}
     */
    async onLoadMoreClick(group) {
        if (!group || this.isLoadingMore(group) || this.crmOffline.isOffline()) {
            return;
        }
        const groupId = group.id;
        this.loadingMoreGroups[groupId] = true;
        try {
            if (group.isFolded) {
                await this.toggleGroup(group);
            } else {
                await this.loadMore(group);
            }
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        } finally {
            delete this.loadingMoreGroups[groupId];
        }
    }

    /**
     * Displays the previous stage; nothing on the first stage. Reaching the first stage removes
     * the previous button, whose focus then moves to the next one (see `_setupNavFocus`).
     */
    onPrev() {
        const index = this.currentIndex;
        if (index > 0) {
            return this.goToGroup(this.stageGroups[index - 1]);
        }
    }

    /**
     * Displays the next stage; nothing on the last stage. Reaching the last stage removes the next
     * button, whose focus then moves to the previous one (see `_setupNavFocus`).
     */
    onNext() {
        const index = this.currentIndex;
        const groups = this.stageGroups;
        if (index >= 0 && index < groups.length - 1) {
            return this.goToGroup(groups[index + 1]);
        }
    }

    /** @param {TouchEvent} ev */
    onTouchStart(ev) {
        const touch = ev?.touches?.[0];
        this.touch = touch
            ? { startX: touch.clientX, startY: touch.clientY, x: touch.clientX, y: touch.clientY }
            : null;
    }

    /** @param {TouchEvent} ev */
    onTouchMove(ev) {
        const touch = ev?.touches?.[0];
        if (this.touch && touch) {
            this.touch.x = touch.clientX;
            this.touch.y = touch.clientY;
        }
    }

    /**
     * A horizontal swipe on the stage body (more than `SWIPE_THRESHOLD` pixels, and more
     * horizontal than vertical) displays the adjacent stage: the next one for a swipe to the left,
     * the previous one for a swipe to the right.
     *
     * @param {TouchEvent} ev
     */
    onTouchEnd(ev) {
        const gesture = this.touch;
        this.touch = null;
        if (!gesture) {
            return;
        }
        const touch = ev?.changedTouches?.[0];
        const endX = touch ? touch.clientX : gesture.x;
        const endY = touch ? touch.clientY : gesture.y;
        const dx = endX - gesture.startX;
        const dy = endY - gesture.startY;
        if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            return dx < 0 ? this.onNext() : this.onPrev();
        }
    }

    /**
     * Opens a lead: its form online, or offline when the form was visited online. Otherwise the
     * stage body shows the offline action helper with a Back button, which takes the focus.
     *
     * @param {RelationalRecord} record
     */
    onCardOpen(record) {
        if (!record) {
            return;
        }
        const { isAvailableOffline, isOffline } = this.crmOffline;
        if (!isOffline() || isAvailableOffline(this.env.config?.actionId, "form", record.resId)) {
            this.mobileState.unavailableLeadId = null;
            return this.props.openRecord(record);
        }
        this.helperFocus = { resId: record.resId, focus: "back" };
        this.mobileState.unavailableLeadId = record.resId;
    }

    /**
     * Leaves the offline helper of an unavailable lead. The focus then moves to the lead's card
     * (or a header control), as Back disappears with the helper.
     */
    onBackFromHelper() {
        const resId = this.mobileState.unavailableLeadId;
        this.helperFocus = resId ? { resId, focus: "return" } : null;
        this.mobileState.unavailableLeadId = null;
    }

    /**
     * Moves a card to a stage through the framework kanban move, which the CRM model extends
     * (rainbowman online only, and cards held by a folded stage stay movable) and which queues the
     * stage write offline. Choosing the won stage is mark-won.
     *
     * A connection loss raised by the framework's reload of a truncated source group, after the
     * save was queued, leaves the queued save and the in-memory move in place. When the framework
     * did make the move, the target stage becomes the displayed one, so the moved card and its
     * pending badge are visible at once; a move it did not make changes nothing.
     *
     * @param {RelationalRecord} record
     * @param {Group} targetGroup
     * @returns {Promise<void>}
     */
    async onCardMove(record, targetGroup) {
        if (!record || !targetGroup || record.group === targetGroup) {
            return;
        }
        try {
            await this.props.list.moveRecords([record.id], null, targetGroup.id);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        }
        if (status(this) !== "destroyed" && record.group === targetGroup) {
            this.stageState.serverValue = targetGroup.serverValue;
        }
    }

    /**
     * Opens the mobile quick create in a bottom sheet, on the displayed stage. A lead created
     * online is added to its stage as the framework quick create does; a queued one appears as a
     * pending card as soon as it is queued.
     *
     * @param {MouseEvent} [ev]
     */
    onAddClick(ev) {
        const group = this.currentGroup;
        if (!this.isMobilePipeline || !group || !this.canAdd) {
            return;
        }
        this.quickCreatePopover.open(ev?.currentTarget ?? this.rootRef(), {
            list: this.props.list,
            group,
            onCreated: (resId, targetGroup) =>
                this.validateQuickCreate(resId, "close", targetGroup),
        });
    }

    /**
     * Called by a card after an online activity create or mark-done: reads the lead's activities
     * again, with the lead's current request (bounded, or expanded by "Show all"), only while
     * this pipeline is alive and the displayed stage shows the lead (the same placement the
     * activity revalidation reads for). A card can call it after it was destroyed (stage
     * navigation, a filter, a move or a reload re-keyed or removed it): a lead no longer
     * displayed is not read now, and is read again when a stage displays it.
     *
     * @param {number} resId
     * @returns {Promise<{ records: Object[], length: number } | null> | undefined} the read, if any
     */
    onActivitiesChanged(resId) {
        if (
            !resId ||
            status(this) === "destroyed" ||
            !this.isMobilePipeline ||
            this.props.list.model.useSampleModel
        ) {
            return;
        }
        if (!this.cardsFor(this.currentGroup).some((record) => record.resId === resId)) {
            return;
        }
        return this._loadLeadActivities(resId);
    }

    /**
     * Called by a card's "Show all": online, when the lead has more activities than its loaded
     * page, reads all of them (the known total) and keeps that limit for every later revalidation
     * of the lead. Offline, or when nothing is missing, it does nothing: the expanded request was
     * never cached. When the connection drops during the read and nothing is cached for it, the
     * lead's previous request is restored, so later revalidations keep the one the cache answers.
     *
     * @param {number} resId
     * @returns {Promise<void>}
     */
    async onShowAllActivities(resId) {
        if (
            !resId ||
            !this.isMobilePipeline ||
            this.props.list.model.useSampleModel ||
            this.crmOffline.isOffline()
        ) {
            return;
        }
        const { activitiesByLead, activityLimitsByLead, activityTotalsByLead } = this.mobileState;
        const total = activityTotalsByLead[resId];
        if (!Number.isInteger(total) || total <= (activitiesByLead[resId]?.length ?? 0)) {
            return;
        }
        const previousLimit = activityLimitsByLead[resId];
        activityLimitsByLead[resId] = total;
        const result = await this._loadLeadActivities(resId);
        if (result === null && activityLimitsByLead[resId] === total) {
            if (previousLimit === undefined) {
                delete activityLimitsByLead[resId];
            } else {
                activityLimitsByLead[resId] = previousLimit;
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Controller adapter
// -----------------------------------------------------------------------------

export class CrmMobilePipelineController extends crmKanbanView.Controller {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        /**
         * The displayed stage (stage id), shared with the renderer through the env. Seeded from the
         * restored state, where `false` is the group without stage; `null` when none was saved.
         * Only read in the mobile pipeline.
         */
        this.crmMobileStage = proxy({
            serverValue: this.props.state?.crmMobileStage ?? null,
        });
        useSubEnv({ crmMobileStage: this.crmMobileStage });

        // Restored column scroll. The base layout effect restores, once the model is ready (at
        // mount, or at the patch that follows a lazy first load), the saved scroll of every saved
        // `[serverValue, scrollTop]` pair whose group exists, and dereferences that group's column
        // node without a null guard. The mobile pipeline renders the displayed stage as its only
        // column, so in the mobile pipeline the restored pairs are reduced to the displayed
        // stage's, whichever layout saved them and whether or not a stage was saved. Anywhere else
        // (desktop, another grouping, ungrouped, no group) the restored state is left exactly as
        // received. The gate needs the loaded root and the current screen size, so this runs once,
        // at the start of the first render with a ready model, which precedes that base effect.
        let isRestoredScrollAdapted = false;
        onWillRender(() => {
            if (isRestoredScrollAdapted || !this.model.isReady()) {
                return;
            }
            isRestoredScrollAdapted = true;
            untrack(() => {
                const scrollPositions = this.props.state?.scrollPositions;
                if (!this.isMobilePipeline || !Array.isArray(scrollPositions?.columnScrollTops)) {
                    return;
                }
                const displayed = resolveDisplayedGroup(
                    this.model.root,
                    this.crmMobileStage.serverValue
                );
                scrollPositions.columnScrollTops = scrollPositions.columnScrollTops.filter(
                    ([serverValue]) => serverValue === displayed.serverValue
                );
            });
        });

        // Merged by the action service with the base controller's local state.
        useSetupAction({
            getLocalState: () => {
                if (!this.isMobilePipeline) {
                    return {};
                }
                const group = resolveDisplayedGroup(
                    this.model.root,
                    this.crmMobileStage.serverValue
                );
                return { crmMobileStage: group ? group.serverValue : null };
            },
        });
    }

    /** Whether the mobile pipeline is rendered (see `isCrmMobilePipeline`). */
    get isMobilePipeline() {
        return isCrmMobilePipeline(this.model.root, this.crmOffline.isSmall());
    }

    /**
     * New: in the mobile pipeline, the framework quick create opens in the displayed stage instead
     * of the first unfolded one, so it is visible. Everything else is the base behaviour.
     *
     * Online, a folded displayed stage is loaded and unfolded first. The view may change while
     * that load runs, so once it lands the quick create opens only if the controller is still
     * alive, the mobile pipeline is still rendered and the displayed stage is still the one New
     * was pressed on; otherwise nothing changes (the stage the user moved to stays displayed). It
     * then opens in that stage's group of the current root, because a reload during the load
     * rebuilds the groups with new datapoint ids.
     *
     * @override
     */
    async createRecord() {
        const { onCreate } = this.props.archInfo;
        if (!this.isMobilePipeline || !(this.canQuickCreate && onCreate === "quick_create")) {
            return super.createRecord(...arguments);
        }
        let group = resolveDisplayedGroup(this.model.root, this.crmMobileStage.serverValue);
        if (group.isFolded && !this.crmOffline.isOffline()) {
            const requestedStage = group.serverValue;
            await group.toggle();
            if (status(this) === "destroyed" || !this.isMobilePipeline) {
                return;
            }
            group = resolveDisplayedGroup(this.model.root, this.crmMobileStage.serverValue);
            if (group.serverValue !== requestedStage) {
                return;
            }
        }
        this.crmMobileStage.serverValue = group.serverValue;
        await this.quickCreateState.openQuickCreate(group.id);
    }
}

registry.category("views").add("crm_mobile_pipeline", {
    ...crmKanbanView,
    Controller: CrmMobilePipelineController,
    Renderer: CrmMobilePipeline,
});
