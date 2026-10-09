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
 * - Pending placement and pending-aware totals are derived on every render from framework state
 *   only: the offline queue entries, each record's framework group, its `stage_id` and its
 *   `serverStageId` (set by the CRM kanban model's record class). No correction is stored.
 * - Every read (activities, activity types, reconciliation reload) is issued only on small screens
 *   in the stage pipeline, so desktop RPC sequences are unchanged.
 */

import { proxy, status, useOnChange } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useSubEnv } from "@web/owl2/utils";
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
            /** Cached activities by lead id, as read by `loadLeadActivities`. */
            activitiesByLead: {},
            /** Cached creatable activity types, `null` until read (or when not cached). */
            activityTypes: null,
            /**
             * Queue entries as they were when the current sync window began, `null` outside a
             * sync window. While set, a write replayed during the sync keeps its placement until
             * the reconciliation reload that incorporates it has landed.
             */
            syncEntries: null,
        });
        // Provided by `CrmMobilePipelineController`; a local state keeps the renderer usable on
        // its own (it then starts on the framework's default stage).
        this.stageState = this.env.crmMobileStage ?? proxy({ serverValue: null });
        /** Touch gesture in progress on the stage body (swipe navigation). */
        this.touch = null;

        this._setupActivityRevalidation();
        this._setupSyncReconciliation();
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    /** Whether the mobile markup is rendered (see `isCrmMobilePipeline`). */
    get isMobilePipeline() {
        return isCrmMobilePipeline(this.props.list, this.crmOffline.isSmall());
    }

    /** @returns {Group[]} the stage groups in display order */
    get stageGroups() {
        return orderedStageGroups(this.props.list);
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
     * @returns {QueueEntry[]}
     */
    get stageEntries() {
        const live = this.crmOffline.queuedEntries();
        const snapshot = this.mobileState.syncEntries;
        if (!snapshot?.length) {
            return live;
        }
        const liveKeys = new Set(live.map((entry) => String(entry.key)));
        return [...live, ...snapshot.filter((entry) => !liveKeys.has(String(entry.key)))];
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
    // Recomputed on every render from framework state alone; nothing here writes any state. An
    // offline move returns from the framework save before the aggregates are refreshed, and every
    // reload rebuilds the groups and records from server or cache data that predate the queued
    // writes, so stored corrections would go stale: derived ones survive a form → back, an
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
     * @param {RelationalRecord} record
     * @returns {number | false | undefined} the stage id (`serverValue`)
     */
    displayStage(record) {
        const frameworkStage = record.group?.serverValue;
        if (!this._tracksStage(record)) {
            return frameworkStage;
        }
        const dataStage = record.data.stage_id?.id ?? false;
        if (dataStage !== record.serverStageId) {
            return frameworkStage;
        }
        if (record.resId) {
            const entry = this.crmOffline.latestStageWrite(record.resId, this.stageEntries);
            if (entry) {
                const stageValue = entry.value.args?.[1]?.stage_id;
                if (this.props.list.groups.some((group) => group.serverValue === stageValue)) {
                    return stageValue;
                }
            }
        }
        return frameworkStage;
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
     * records of other groups that a queued write places there.
     *
     * @param {Group} group
     * @returns {RelationalRecord[]}
     */
    cardsFor(group) {
        if (!group) {
            return [];
        }
        const stageValue = group.serverValue;
        const own = (group.list.records ?? []).filter(
            (record) => this.displayStage(record) === stageValue
        );
        const placedHere = this.props.list.groups
            .filter((other) => other.id !== group.id)
            .flatMap((other) =>
                (other.list.records ?? []).filter(
                    (record) => this.displayStage(record) === stageValue
                )
            );
        return [...own, ...placedHere];
    }

    /**
     * Queued `crm.lead` creates targeting a stage (rendered as pending cards, keyed by queue key).
     *
     * @param {Group} group
     * @returns {QueueEntry[]}
     */
    pendingCreatesFor(group) {
        if (!group) {
            return [];
        }
        return this.crmOffline.pendingLeadCreates(group.serverValue, this.stageEntries);
    }

    /**
     * Lead count of a stage: the framework group count (already adjusted for in-memory moves),
     * minus the group's records a queued write places elsewhere, plus the other groups' records a
     * queued write places here, plus the queued creates of the stage.
     *
     * @param {Group} group
     * @returns {number}
     */
    stageCount(group) {
        if (!group) {
            return 0;
        }
        const stageValue = group.serverValue;
        let count = group.count || 0;
        for (const record of group.list.records ?? []) {
            if (this.displayStage(record) !== stageValue) {
                count--;
            }
        }
        for (const other of this.props.list.groups) {
            if (other.id === group.id) {
                continue;
            }
            for (const record of other.list.records ?? []) {
                if (this.displayStage(record) === stageValue) {
                    count++;
                }
            }
        }
        return Math.max(0, count + this.pendingCreatesFor(group).length);
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
     * records displayed here, plus that of the queued creates of the stage.
     *
     * @private
     * @param {Group} group
     * @returns {{ value: number, currencies?: number[] }}
     */
    _stageRevenue(group) {
        if (!group || !this.hasRevenue) {
            return { value: 0 };
        }
        const fieldName = this.props.progressBarState.progressAttributes.sumField.name;
        const stageValue = group.serverValue;
        const { value: loadedValue, currencies } = this._stageAggregate(group);
        let value = loadedValue;
        for (const record of this.allLoadedRecords()) {
            if (!this.isDisplaced(record)) {
                continue;
            }
            const recordValue = Number(record.data[fieldName]) || 0;
            if (record.serverStageId === stageValue && group.count !== 0) {
                value -= recordValue;
            }
            if (this.displayStage(record) === stageValue) {
                value += recordValue;
            }
        }
        for (const entry of this.pendingCreatesFor(group)) {
            value += Number(entry.value.args?.[1]?.[fieldName]) || 0;
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
        return Boolean(
            group &&
                this.crmOffline.isOffline() &&
                group.count > 0 &&
                this.stageCount(group) > 0 &&
                this.cardsFor(group).length === 0 &&
                this.pendingCreatesFor(group).length === 0
        );
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
        return Math.max(
            0,
            this.stageCount(group) -
                this.cardsFor(group).length -
                this.pendingCreatesFor(group).length
        );
    }

    /**
     * @param {Group} group
     * @returns {string}
     */
    unavailableMoreLabel(group) {
        return _t("%(count)s more leads are not available offline", {
            count: this.unavailableMoreCount(group),
        });
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
     * cache answers. The per-lead request never changes, so a lead's activities read online come
     * back offline whichever stage, filter or page displayed it, and the types are read again on
     * reconnect, so a cold offline cache miss clears without a manual reload. The connection
     * dropping alone triggers no read (what is in memory is what the cache would answer).
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
     * Reads a lead's activities through the disk cache; the first value and any changed refresh
     * are both applied.
     *
     * @private
     * @param {number} resId
     * @returns {Promise<void>}
     */
    async _loadLeadActivities(resId) {
        const activities = await loadLeadActivities(this.crmOffline.orm, resId, (fresh) =>
            this._applyActivities(resId, fresh)
        );
        this._applyActivities(resId, activities);
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
     * @param {Object[] | { records: Object[] } | null} result
     * @returns {Object[] | null} the records, `null` when there is nothing to apply
     */
    _normalizeRecords(result) {
        if (Array.isArray(result)) {
            return result;
        }
        return Array.isArray(result?.records) ? result.records : null;
    }

    /**
     * Stores a lead's activities. A result arriving after the gate turned false, or after the
     * pipeline was destroyed, is dropped; `null` (connection lost, nothing cached) keeps what is
     * displayed.
     *
     * @private
     * @param {number} resId
     * @param {Object[] | null} result
     */
    _applyActivities(resId, result) {
        if (status(this) === "destroyed" || !this.isMobilePipeline) {
            return;
        }
        const records = this._normalizeRecords(result);
        if (records) {
            this.mobileState.activitiesByLead[resId] = records;
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

    /** Displays the previous stage; nothing on the first stage. */
    onPrev() {
        const index = this.currentIndex;
        if (index > 0) {
            return this.goToGroup(this.stageGroups[index - 1]);
        }
    }

    /** Displays the next stage; nothing on the last stage. */
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
     * stage body shows the offline action helper with a Back button.
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
        this.mobileState.unavailableLeadId = record.resId;
    }

    /** Leaves the offline helper of an unavailable lead. */
    onBackFromHelper() {
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
        if (!record || !targetGroup || record.group?.id === targetGroup.id) {
            return;
        }
        try {
            await this.props.list.moveRecords([record.id], null, targetGroup.id);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        }
        if (status(this) !== "destroyed" && record.group?.id === targetGroup.id) {
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
     * again.
     *
     * @param {number} resId
     */
    onActivitiesChanged(resId) {
        if (!resId || !this.isMobilePipeline || this.props.list.model.useSampleModel) {
            return;
        }
        return this._loadLeadActivities(resId);
    }
}

// -----------------------------------------------------------------------------
// Controller adapter
// -----------------------------------------------------------------------------

export class CrmMobilePipelineController extends crmKanbanView.Controller {
    setup() {
        // Before the base setup: its layout effect restores, at mount, the saved scroll of every
        // saved stage column and dereferences each column's node without a null guard. The mobile
        // pipeline renders the displayed stage only, which is the restored one, so only that
        // stage's entry (`[serverValue, scrollTop]` pairs) is kept. A state without
        // `crmMobileStage` was saved by the standard layout and restores into it: left untouched.
        const state = this.props.state;
        const hasMobileStage = Boolean(state && Object.hasOwn(state, "crmMobileStage"));
        const columnScrollTops = state?.scrollPositions?.columnScrollTops;
        if (hasMobileStage && Array.isArray(columnScrollTops)) {
            state.scrollPositions.columnScrollTops = columnScrollTops.filter(
                ([serverValue]) => serverValue === state.crmMobileStage
            );
        }

        super.setup();
        this.crmOffline = useCrmOffline();
        /** The displayed stage (stage id), shared with the renderer through the env. */
        this.crmMobileStage = proxy({
            serverValue: hasMobileStage ? state.crmMobileStage : null,
        });
        useSubEnv({ crmMobileStage: this.crmMobileStage });
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
     * of the first unfolded one (unfolded first when online), so it is visible. Everything else is
     * the base behaviour.
     *
     * @override
     */
    async createRecord() {
        const { onCreate } = this.props.archInfo;
        if (!this.isMobilePipeline || !(this.canQuickCreate && onCreate === "quick_create")) {
            return super.createRecord(...arguments);
        }
        const group = resolveDisplayedGroup(this.model.root, this.crmMobileStage.serverValue);
        if (group.isFolded && !this.crmOffline.isOffline()) {
            await group.toggle();
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
