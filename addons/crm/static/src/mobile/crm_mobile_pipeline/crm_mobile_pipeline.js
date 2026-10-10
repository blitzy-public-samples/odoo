/**
 * Small-screen, stage-at-a-time CRM pipeline.
 *
 * Registered as the view `crm_mobile_pipeline`, selected by `js_class` on the pipeline arch
 * (`crm.crm_case_kanban_view_leads`): the CRM kanban view (`crmKanbanView`) with its renderer and
 * controller swapped, and no second model.
 *
 * - `CrmMobilePipeline`, the renderer, renders the mobile markup only while `isCrmMobilePipeline`
 *   holds (small screen, grouped by `stage_id`, at least one stage group). Everywhere else it
 *   renders the standard `web.KanbanRenderer`, so desktop and every other grouping keep exactly
 *   the kanban DOM.
 * - `CrmMobilePipelineController`, the controller adapter, keeps the displayed stage across reloads
 *   and breadcrumbs, restores that stage's scroll and opens New's quick create in it. Outside the
 *   mobile pipeline every override calls `super`. At every screen size its root keeps the CRM
 *   kanban root class (`o_crm_kanban_view`) in place of the one derived from this `js_class`.
 *
 * Offline rules:
 * - No offline machinery of its own: offline and small-screen state come from `useCrmOffline()`,
 *   reads go through the framework disk cache and nothing is persisted.
 * - It queues nothing itself: stage moves go through the framework `moveRecords`, lead and
 *   activity creates through the child components' `runOrQueue`.
 * - Placement and totals are derived from framework state only, memoized per change of that
 *   state. No correction is stored.
 * - Every read is issued only in the small-screen stage pipeline, so desktop RPC sequences are
 *   unchanged.
 *
 * Status-region announcements: see `_setupPendingCreateAnnouncements`, `onCardMove` and
 * `_announce`.
 */

import {
    computed,
    onPatched,
    onWillPatch,
    onWillUnmount,
    proxy,
    signal,
    status,
    untrack,
    useEffect,
    useListener,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError, RPCError, rpcBus } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { getTabableElements } from "@web/core/utils/ui";
import { onWillRender, useSubEnv } from "@web/owl2/utils";
import { useSetupAction } from "@web/search/action_hook";
import { formatInteger, formatMonetary } from "@web/views/fields/formatters";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import {
    CrmMobileLeadCard,
    stopKanbanSpaceHotkey,
} from "@crm/mobile/crm_mobile_lead_card/crm_mobile_lead_card";
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
 * Methods of the calls the framework offline queue holds (the ones its systray displays): during a
 * sync window, a successful silent call of one of them is a replay of a queued write.
 */
const QUEUED_METHODS = ["web_save", "web_unlink", "unlink", "action_archive", "action_unarchive"];

/**
 * @typedef {import("@web/model/relational_model/dynamic_group_list").DynamicGroupList} DynamicGroupList
 * @typedef {import("@web/model/relational_model/group").Group} Group
 * @typedef {import("@web/model/relational_model/record").Record} RelationalRecord
 * @typedef {{ key: string | number, value: { model: string, method: string, args: any[],
 *   kwargs: Object, extras: Object } }} QueueEntry an entry of the framework offline queue,
 *   exactly as the framework stores it
 * @typedef {{ cards: RelationalRecord[], pendingCreates: QueueEntry[], count: number,
 *   revenueAdjustments: number[], isAdjusted: boolean, loadedCount: number,
 *   addedCurrencies: number[] }} StageSummary what a stage displays: its cards (its own
 *   records first, then the records a queued write places there), its queued lead creates, its
 *   pending-aware lead count, and the signed sum-field amounts added, in order, to its loaded
 *   aggregate; whether a displaced record (in or out) or a queued create adjusts its totals at
 *   all, how many of the records its loaded aggregate counts it still displays, and the distinct
 *   currencies of the amounts added to it (a monetary sum field with a currency field only). The
 *   arrays are shared by every reader and must not be mutated.
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

/**
 * The displayed-stage state of one pipeline: shared by the controller adapter with the renderer
 * through the env (`env.crmMobileStage`), or kept by a renderer used without that adapter.
 * - `serverValue`: the displayed stage (see `resolveDisplayedGroup`).
 * - `unfolding`: the loads in flight that unfold a folded stage (see `unfoldStage`), so the
 *   renderer shows that stage as loading whichever control started its load.
 *
 * @param {number | false | null} serverValue the stage id, `null` if none
 * @returns {{ serverValue: number | false | null, unfolding: WeakMap<Object, Promise<void>> }}
 */
export function createStageState(serverValue) {
    return proxy({ serverValue, unfolding: new WeakMap() });
}

/**
 * Loads and unfolds a folded stage once: the first request runs `unfold` (the inherited
 * `toggleGroup`, or `Group.toggle`), and every request for the same stage made while that load
 * is in flight gets its promise instead of toggling the group again. `Group.toggle` flips the
 * fold state once its load lands, so a second toggle would fold the stage back.
 *
 * The loads are kept in `stageState.unfolding` by the stage's group config, which a reload keeps
 * while it rebuilds the group datapoints with new ids; each leaves as it settles.
 *
 * @param {{ unfolding: WeakMap<Object, Promise<void>> }} stageState see `createStageState`
 * @param {Group} group a folded stage group
 * @param {(group: Group) => Promise<void>} unfold
 * @returns {Promise<void>} the load in flight, resolved or rejected as it settles
 */
export function unfoldStage(stageState, group, unfold) {
    const { unfolding } = stageState;
    const stage = group.config;
    let load = unfolding.get(stage);
    if (!load) {
        load = Promise.resolve(unfold(group)).finally(() => unfolding.delete(stage));
        unfolding.set(stage, load);
    }
    return load;
}

/**
 * The name the status region gives a lead: the name its card shows, or a generic label when it
 * has none.
 *
 * @param {string | false | undefined | null} name
 * @returns {string}
 */
function leadName(name) {
    return name || _t("Unnamed lead");
}

/**
 * The entry of the sync-window copy that a successful replay answer belongs to, among the entries
 * its call matched: the only one, else the earliest by timestamp that has no recorded id yet, the
 * order the framework replays entries of equal arguments in.
 *
 * @param {QueueEntry[]} matches the entries the replayed call matched
 * @param {Map<string, number>} recordedIds the ids already recorded, by queue key
 * @returns {QueueEntry | undefined}
 */
function replayedEntryOf(matches, recordedIds) {
    const byKey = new Map(matches.map((entry) => [String(entry.key), entry]));
    if (byKey.size === 1) {
        return byKey.values().next().value;
    }
    return [...byKey.values()]
        .filter(({ key }) => !recordedIds.has(String(key)))
        .sort((a, b) => (a.value.extras?.timeStamp ?? 0) - (b.value.extras?.timeStamp ?? 0))[0];
}

/**
 * The order of `loadLeadActivities` (`date_deadline ASC, id ASC`, an activity without deadline
 * last, as the database sorts null values in ascending order), so the rows the server sent keep
 * their place among those a confirmed write adds, and a bounded read tells which activities its
 * page would list.
 *
 * @param {{ id: number, date_deadline?: string | false }} a
 * @param {{ id: number, date_deadline?: string | false }} b
 * @returns {number}
 */
function compareLeadActivities(a, b) {
    const deadlineA = a.date_deadline || null;
    const deadlineB = b.date_deadline || null;
    if (deadlineA !== deadlineB) {
        if (deadlineA === null || deadlineB === null) {
            return deadlineA === null ? 1 : -1;
        }
        return deadlineA < deadlineB ? -1 : 1;
    }
    return a.id - b.id;
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
        /** Body of the open quick-create sheet, filled by the bottom sheet. */
        this.quickCreateSheetRef = signal.ref();
        this.quickCreatePopover = usePopover(CrmMobileQuickCreate, {
            useBottomSheet: true,
            withScope: true,
            ref: this.quickCreateSheetRef,
            onClose: () => this._focusAfterQuickCreate(),
        });
        /**
         * True once the pipeline starts unmounting. Registered after `usePopover`, so it runs
         * before that hook closes the open sheet: the closing it then reports moves no focus.
         */
        this._isUnmounting = false;
        onWillUnmount(() => {
            this._isUnmounting = true;
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
             * While a sync-window copy is held, the number of the activity request
             * (`_activityReadSequence`) whose server answer each lead's loaded activities and
             * total are: lead id → request number, `0` for a cached value of unknown age. Written
             * with the rows it describes (or by the answer that confirms them unchanged), in the
             * same turn, so a card drops a replayed create's row in the render that shows that
             * answer (see `_isActivityReplayReflected`). A rejected request writes nothing: its
             * answer brings no rows. Pruned with the rows and emptied with the copy.
             */
            activityAnswersByLead: {},
            /**
             * Activity limit by lead id, set only by an explicit online "Show all": every later
             * revalidation of that lead reissues the same expanded request (answered by the cache
             * offline). A lead without an entry is read with the loader's default request.
             */
            activityLimitsByLead: {},
            /**
             * Activity writes of the cards that the server confirmed online and that no activity
             * read of the lead has reflected yet, by lead id: an array in the order the server
             * confirmed them, each `{ created, delta: 1 }` (the activity created, in the loader's
             * record shape) or `{ doneId, row, delta: -1 }` (the activity marked done, with the
             * row the card showed for it, `undefined` when it showed none). The cards show them
             * over the stored page (`activitiesFor`, `activityTotalFor`), so a write whose
             * re-read loses the connection, or is answered by the cache with the rows from
             * before it, stays visible offline, across remounts and stage navigation, until a
             * read reflects it (`_forgetReadActivityWrites`). In memory only, never persisted,
             * and kept for the loaded leads only (`_pruneActivities`).
             */
            activityWritesByLead: {},
            /** Cached creatable activity types, `null` until read (or when not cached). */
            activityTypes: null,
            /**
             * Queue entries as they were when the current sync window began (or when the
             * pipeline entered it), plus those that reached the queue during the window (another
             * tab's), less those discarded from the systray since; `null` outside a sync window
             * and outside the stage pipeline. While set, a write replayed during the sync keeps
             * its placement, and a replayed activity call its row on the card (see
             * `cardQueueEntries`), until the reconciliation reload that incorporates it has
             * landed.
             */
            syncEntries: null,
            /**
             * Last message of the status region (see `_announce`); a new `sequence` renders it in
             * a new node, so a message equal to the previous one is announced again.
             */
            announcement: { message: "", sequence: 0 },
        });
        /**
         * What `activitiesFor` and `activityTotalFor` derived for a lead with confirmed writes,
         * by the writes it was derived from, with the stored page and total it was derived over:
         * `{ stored, storedTotal, rows, total }`. Every card render reuses it until one of them
         * changes, so a card's props keep their identity. Not reactive, never persisted.
         *
         * @type {WeakMap<Object, Object>}
         */
        this._activityOverlays = new WeakMap();
        /**
         * Ids of the stage groups whose Load more is in flight (`onLoadMoreClick`), each mapped to
         * `true` until its load settles. Transient presentation state: the button is disabled and
         * busy meanwhile (`isLoadingMore`).
         */
        this.loadingMoreGroups = proxy({});
        // Provided by `CrmMobilePipelineController`; a local state keeps the renderer usable on
        // its own (it then starts on the framework's default stage).
        this.stageState = this.env.crmMobileStage ?? createStageState(null);
        /** Touch gesture in progress on the stage body (swipe navigation). */
        this.touch = null;
        /**
         * Keyboard focus to move once the stage body is patched: the Stage button of the lead's
         * card after a stage was chosen from its stage list (`{ leadId, control: "stage" }`);
         * `null` when none is requested. The unavailable-lead helper's focus (Back, then the
         * card's open control) is `helperFocus`'s.
         */
        this.pendingFocus = null;
        onPatched(() => this._applyPendingFocus());
        /**
         * The card moves in flight (see `onCardMove`), in the order they started: each
         * `{ record, targetGroup }` from just before the framework move is called until it
         * returns. Transient and never persisted; a signal holding the moves as given (never made
         * reactive), so the displayed stage follows their start and end (see `currentGroup`).
         *
         * @type {() => Array<{ record: RelationalRecord, targetGroup: Group }>}
         */
        this._cardMoves = signal([]);
        /**
         * `[key, name]` of the queued lead creates the status region last compared (see
         * `_readPendingLeadCreates`), or `null` before the first comparison in the mobile
         * pipeline: the queue the pipeline mounts (or enters the gate) with is never announced.
         *
         * @type {Array<[string, string]> | null}
         */
        this._pendingCreatesBaseline = null;
        /**
         * Bumped by every sync window that may replay writes the loaded data do not include, and
         * by every replay the pipeline observes (see `_setupConnectionAttribution`), so a
         * reconciliation reload issued before that window or that replay never ends it (see
         * `_reconcile`).
         */
        this.syncGeneration = 0;
        /**
         * The reconciliation reload in flight, `{ generation, lost, recovery }`, `null` when none
         * is: `lost` is set once one of the reload's own requests answers with a lost connection,
         * and `recovery` tells a reload a reconnection owed, whose requests are recovery requests
         * (see `_setupConnectionAttribution`).
         */
        this.reconciliation = null;
        /**
         * The groups of the root list the last reconciliation reload produced (`list.groups` once
         * its load has landed), `null` before one has: the reconciliation effect does not count
         * that landing, nor the commit of the reload in flight (`reconciliation`), as a load that
         * makes the data shown staler than at a connection loss.
         *
         * @type {Group[] | null}
         */
        this.reconciledGroups = null;
        /**
         * The groups of the root list the last recovery reload produced (a reload a reconnection
         * owed, see `_reconcile`) once it has landed, until the next revalidation run that reads:
         * when that run is the first to read them, its reads are recovery requests (see
         * `_setupActivityRevalidation`); `null` otherwise.
         *
         * @type {Group[] | null}
         */
        this.recoveryGroups = null;
        /**
         * What `_setupConnectionAttribution` reads off the framework's own answers (nothing here
         * probes the network):
         * - `offline`: the offline signal as last observed (by an answer, or by an effect for a
         *   change made without one);
         * - `recoveryLoss`: whether the current, or last, connection loss was reported by one of
         *   the pipeline's recovery requests (those it issues to recover from a reconnection: the
         *   reads of the revalidation that handles it and of the first one after its reload,
         *   `_issueRecoveryReads`, and the requests of the reload it owed) and confirmed by no
         *   other request;
         * - `recoveryReconnection`: whether the last reconnection ended such a loss;
         * - `replays`: how many replays of queued writes it observed, whichever tab queued them.
         */
        this._connection = {
            offline: untrack(() => this.crmOffline.isOffline()),
            recoveryLoss: false,
            recoveryReconnection: false,
            replays: 0,
        };
        /** Depth of the recovery read calls in progress (see `_issueRecoveryReads`). */
        this._recoveryReadDepth = 0;
        /**
         * The lead each replayed `crm.lead` create of the sync-window copy created, as the
         * framework's replay answer gave it: queue key → lead id. Kept while the copy holds the
         * entry and emptied with the copy (see `_setupSyncWindowDiscards`); read only by
         * `_computeStageProjection`, for the pending creates of each stage. Not reactive and
         * never persisted: it is written just before the entry leaves the queue, and every change
         * that makes it matter (the entry leaving the queue, a load bringing the lead) is one the
         * stage projection follows.
         *
         * @type {Map<string, number>}
         */
        this.replayedCreateIds = new Map();
        /**
         * The `mail.activity` calls of the sync-window copy replayed on a lead, as the framework's
         * replay answer told them (see `_onActivityCallReplayed`): queue key → `{ resId, method,
         * activityId, replaySeq }`, the lead, the method, the activity created (`web_save`, when
         * the answer gave its id) or marked done (`action_archive`), and the number of the last
         * activity request sent when the replay answered (`_activityReadSequence`): a request
         * numbered above it was sent after the replay committed. Emptied with the copy, like
         * `replayedCreateIds`; read by `_computeCardQueueEntries` and `_awaitsActivityRows` (see
         * `_isActivityReplayReflected`). Not reactive and never persisted, for the same reasons.
         *
         * @type {Map<string, { resId: number, method: string, activityId: number | undefined,
         *   replaySeq: number }>}
         */
        this.replayedActivityCalls = new Map();
        /**
         * Number of the last activity request an activity read sent (`_loadLeadActivities`): a
         * read that sends its own request takes the next one, so a request numbered above the
         * value taken at some moment was sent after it (see `_reconcile`). Not reactive.
         */
        this._activityReadSequence = 0;
        /**
         * The number of the last request sent for each activity request of a lead (lead id and
         * limit, see `_loadLeadActivities`): a read the cache joins to the identical request in
         * flight is answered by that request, and takes its number. Not reactive and never
         * persisted.
         *
         * @type {Map<string, number>}
         */
        this._activityRequestNumbers = new Map();
        /**
         * Leads whose activities a waiting reconciliation reload has read again in the next task
         * (see `_onActivityReadSettled`), each until that read goes. Not reactive.
         *
         * @type {Set<number>}
         */
        this._scheduledActivityReads = new Set();
        /**
         * While a sync-window copy is held, the highest number of the requests for each lead's
         * activities (`_activityReadSequence`) that the server answered, the answer changed or
         * not: lead id → request number. It bounds the wait of a reconciliation reload (see
         * `_awaitsActivityRows`). Emptied with the copy, like `replayedActivityCalls`; not
         * reactive and never persisted.
         *
         * @type {Map<number, number>}
         */
        this._settledActivityReads = new Map();
        /**
         * While a sync-window copy is held, the number of the last request for each activity
         * request of a lead (lead id and limit) that the server answered with rows: the framework
         * cache answers the next read of that request with those rows first, so they keep that
         * number (`activityAnswersByLead`). Emptied with the copy; not reactive and never
         * persisted.
         *
         * @type {Map<string, number>}
         */
        this._activityAnswerNumbers = new Map();
        /**
         * The reconciliation reloads waiting for the server rows of replayed activity calls (see
         * `_reconcile`): for each, the number of the last activity request sent before its reload
         * began (`since`) and its resolver, called once no displayed lead waits for it any more
         * under that bound (`_releaseActivityRowWaiters`), or when the copy is dropped.
         *
         * @type {Array<{ since: number, resolve: () => void }>}
         */
        this._activityRowWaiters = [];
        /**
         * Queue entries placement, totals and cards are derived from (see `stageEntries`): one
         * frozen array until the queue or the sync-window copy changes. Never read outside the
         * mobile pipeline.
         *
         * @type {() => readonly QueueEntry[]}
         */
        this._stageEntries = computed(() => this._computeStageEntries());
        /**
         * Queue entries the record cards derive their queued activity rows from (see
         * `_computeCardQueueEntries`): one frozen array until the queue, the sync-window copy or,
         * once an activity create was replayed, its lead's loaded activities or the answer they
         * come from (`activityAnswersByLead`) change, so a card derives its rows again only then.
         * Never read outside the mobile pipeline.
         *
         * @type {() => readonly QueueEntry[]}
         */
        this._cardQueueEntries = computed(() => this._computeCardQueueEntries());
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

        // First: the revalidation and reconciliation effects read the attribution it keeps.
        this._setupConnectionAttribution();
        this._setupAggregateRegistration();
        this._setupActivityRevalidation();
        this._setupActivityPruning();
        this._setupSyncReconciliation();
        this._setupSyncWindowDiscards();
        this._setupHelperFocus();
        // After the helper focus: on a patch both handle, the helper's focus move comes first.
        this._setupNavFocus();
        this._setupPendingCreateAnnouncements();
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

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

    /**
     * The displayed stage: the stored one (`stageState`), except while a card move that the
     * framework has already made in memory is in flight, when it is that move's target stage (the
     * latest such move's). The framework moves the card into its target group before its save
     * returns, and the stored stage changes only once the move returns (see `onCardMove`): in
     * between, the source stage would show without the card. A move the framework undoes (an
     * online save rejected, a record refused) puts the card back in its group, and the stored
     * stage shows again; a move it does not make changes nothing.
     *
     * @returns {Group | undefined} always defined while the gate holds
     */
    get currentGroup() {
        // Resolved first, so that every render reads the stored stage, also while a move in
        // flight overrides it: its change when the move returns renders again.
        const stored = resolveDisplayedGroup(this.props.list, this.stageState.serverValue);
        const moves = this._cardMoves();
        for (let index = moves.length - 1; index >= 0; index--) {
            const { record, targetGroup } = moves[index];
            if (record.group === targetGroup && this.props.list.groups?.includes(targetGroup)) {
                return targetGroup;
            }
        }
        return stored;
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
     * began with or that reached the queue during it (another tab's) that have left the queue since
     * by replay (replayed writes the loaded data does not include yet). An entry discarded from the
     * systray leaves the copy as well (see `_setupSyncWindowDiscards`), so it stops placing its card
     * at once. Entries are the framework's `{key, value}` objects, never copied into another shape
     * and never mutated; a live entry wins over a snapshot entry of the same key.
     *
     * Union rather than replacement: an entry queued while the snapshot is held (the connection
     * dropped again during the sync, for instance) is placed at once as well.
     *
     * Memoized (`_stageEntries`): one array per change of the queue or of the copy, shared by the
     * stage projection and the cards (`cardQueueEntries`), so the live queue is read once per
     * change and the hook readers index that one array once.
     *
     * @returns {readonly QueueEntry[]} a frozen array, so the hook readers index it once (only the
     *   array is frozen, never the entries)
     */
    get stageEntries() {
        return this._stageEntries();
    }

    /**
     * See `stageEntries`.
     *
     * @private
     * @returns {readonly QueueEntry[]}
     */
    _computeStageEntries() {
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

    /**
     * Queue entries the record cards derive their queued activity rows from (prop
     * `queueEntries`): `stageEntries`, so that during a sync window a replayed activity create
     * keeps its row and the Activities count, and a replayed mark done keeps its row without Mark
     * done, until the reconciliation reload has landed (see `_reconcile`); less each replayed
     * create the lead's loaded activities already account for (see `_isActivityReplayReflected`):
     * they show its server row, or are a server answer to a request sent after its replay, so the
     * card follows the server in the render that shows them. The cards' "Pending sync" badges
     * read the live queue, so they clear as each call replays.
     *
     * @returns {readonly QueueEntry[]} a frozen array, the same until the queue, the sync-window
     *   copy or, once an activity create was replayed, its lead's loaded activities or the answer
     *   they come from change (shared, must not be mutated)
     */
    get cardQueueEntries() {
        return this._cardQueueEntries();
    }

    /**
     * See `cardQueueEntries`. Each replayed create is judged on its own, by what its replay
     * answer told (`replayedActivityCalls`, see `_isActivityReplayReflected`): no queued call is
     * rewritten and nothing is persisted. The judgement reads the reactive state it depends on
     * (the lead's rows and `activityAnswersByLead`), so a server answer that changes nothing in
     * the rows still recomputes the entries.
     *
     * @private
     * @returns {readonly QueueEntry[]}
     */
    _computeCardQueueEntries() {
        const entries = this.stageEntries;
        if (!this.replayedActivityCalls.size) {
            return entries;
        }
        const kept = entries.filter((entry) => {
            const call = this.replayedActivityCalls.get(String(entry.key));
            return !call || call.method !== "web_save" || !this._isActivityReplayReflected(call);
        });
        return kept.length === entries.length ? entries : Object.freeze(kept);
    }

    /**
     * Whether the loaded activities of a lead already account for a replayed activity call (see
     * `replayedActivityCalls`):
     * - a mark done, once its activity is no longer among the lead's rows;
     * - a create, once the activity it created is among them, or once the rows and total loaded
     *   are the server's answer to an activity request numbered above the create's `replaySeq`
     *   (`activityAnswersByLead`). Such a request was sent after the replay committed, so its
     *   answer is the server's state with the create: the activity is among the rows, or beyond
     *   the bounded page and counted by the total, or no longer on the server. The card then
     *   follows the server. An answer to a request sent earlier proves nothing about this
     *   create, whatever it shows of the lead's other activities or total: two creates replayed
     *   on one lead are each judged by their own activity and request number.
     *
     * Reads only reactive state, so the cards follow every answer applied (see
     * `_computeCardQueueEntries`).
     *
     * @private
     * @param {{ resId: number, method: string, activityId: number | undefined,
     *   replaySeq: number }} call
     * @returns {boolean}
     */
    _isActivityReplayReflected({ resId, method, activityId, replaySeq }) {
        const rows = this.mobileState.activitiesByLead[resId];
        const loaded = Array.isArray(rows);
        const holdsActivity = loaded && rows.some((activity) => activity.id === activityId);
        if (method !== "web_save") {
            return !holdsActivity;
        }
        return (
            holdsActivity ||
            (loaded && (this.mobileState.activityAnswersByLead[resId] ?? 0) > replaySeq)
        );
    }

    /**
     * Whether a reconciliation reload that began after activity request `since` (see
     * `_reconcile`) still waits for the server rows of a replayed activity call: a call replayed
     * on a lead the displayed stage shows, whose activities are loaded, that those activities do
     * not account for yet (see `_isActivityReplayReflected`), and for whose lead the server has
     * not yet answered a request numbered above `since` (`_settledActivityReads`). Its server
     * rows are still to come, from the re-read its replay asked for or the revalidation that
     * follows the reload.
     *
     * The bound: a request numbered above `since` was sent after the reload began, hence after
     * every replay of the window (each call's `replaySeq` is at most `since`). The revalidation
     * that follows the reload reads each displayed lead; a read the cache joins to an identical
     * request still in flight takes that request's number, and when an answer to a request sent
     * before the reload began leaves the lead waited for, the lead is read again
     * (`_onActivityReadSettled`). A create stops being waited for at the first answer with rows
     * to a request sent after its replay, which then accounts for it. A mark done is waited for
     * until its activity leaves the rows, or until the server has answered a request sent after
     * the reload began: the server may have unarchived that activity. The server rejecting a
     * request sent after the reload began ends the wait of either as well, though that answer
     * brings no rows. The call is then waited for no more, and the copy the reload drops takes
     * its row away. Leads no card shows are never waited for.
     *
     * @private
     * @param {number} since the number of the last activity request sent before the reload
     *   began (`_activityReadSequence`)
     * @param {number} [resId] only the calls replayed on this lead, when given
     * @returns {boolean}
     */
    _awaitsActivityRows(since, resId) {
        if (!this.replayedActivityCalls.size || !this.isMobilePipeline) {
            return false;
        }
        const shown = new Set(this.cardsFor(this.currentGroup).map((record) => record.resId));
        const { activitiesByLead } = this.mobileState;
        for (const call of this.replayedActivityCalls.values()) {
            if (
                (resId === undefined || call.resId === resId) &&
                shown.has(call.resId) &&
                Array.isArray(activitiesByLead[call.resId]) &&
                (this._settledActivityReads.get(call.resId) ?? 0) <= since &&
                !this._isActivityReplayReflected(call)
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Resumes each reconciliation reload waiting for the server rows of replayed activity calls
     * (see `_reconcile`) once no displayed lead waits for them any more under its own bound (see
     * `_awaitsActivityRows`), or every one at once with `force` (the copy was dropped). A reload
     * still waiting keeps its place.
     *
     * @private
     * @param {boolean} [force]
     */
    _releaseActivityRowWaiters(force = false) {
        if (!this._activityRowWaiters.length) {
            return;
        }
        const released = [];
        const waiting = [];
        for (const waiter of this._activityRowWaiters) {
            if (!force && this._awaitsActivityRows(waiter.since)) {
                waiting.push(waiter);
            } else {
                released.push(waiter);
            }
        }
        this._activityRowWaiters = waiting;
        for (const { resolve } of released) {
            resolve();
        }
    }

    get hasRevenue() {
        return Boolean(this.props.progressBarState?.progressAttributes?.sumField);
    }

    get canAdd() {
        return Boolean(this.props.archInfo.activeActions?.create);
    }

    /**
     * Whether the no-content helper is rendered over the pipeline. The framework rule counts
     * server records only (`!model.hasData()`), and a queued lead create raises no group count:
     * on a pipeline without any lead, the helper would cover the pending card of a lead just
     * created offline. So, in the stage pipeline, it is not rendered while a stage has a pending
     * create, and comes back by itself once the entry leaves the queue (replayed and reconciled,
     * or discarded from the systray) and the pipeline is empty again. Sample data keeps the
     * framework helper, which labels the sample cards. Everywhere else, the framework rule.
     *
     * @override
     * @returns {boolean}
     */
    get showNoContentHelper() {
        if (
            this.isMobilePipeline &&
            !this.props.list.model.useSampleModel &&
            this.stageGroups.some((group) => this.pendingCreatesFor(group).length > 0)
        ) {
            return false;
        }
        return super.showNoContentHelper;
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
    // (`extras.error`) stays in the queue and keeps its placement. A systray discard removes the
    // entry, which ends at once the placement the queue derives (a queued stage write, a pending
    // create and their share of the totals), during a held sync window too. A move the framework
    // already applied in memory on this record instance is placed by its framework group, not by
    // the queue: it keeps its placement until the reload that runs on every reconnection.

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
     * An amount added to a stage also brings its currency, for a monetary sum field with a
     * currency field (the only one whose aggregate carries currencies): a displaced record's own,
     * and for a queued create the one its pending card formats its amount with (the stage's first
     * loaded lead's, else the user's company's), the values of a queued create carrying none.
     * Without them, a stage the server reports empty, whose aggregate carries no currency, would
     * show the amounts a pending write adds to it without the currency its synced header shows.
     *
     * Pure: it reads framework state and writes none (in particular, the progress bar state's
     * `getGroupInfo`, which registers aggregates, is called outside, by
     * `_setupAggregateRegistration` and `_stageAggregate`).
     *
     * @private
     * @returns {StageProjection}
     */
    _computeStageProjection() {
        const groups = this.props.list.groups ?? [];
        const entries = this.stageEntries;
        const sumField = this.hasRevenue
            ? this.props.progressBarState.progressAttributes.sumField
            : null;
        const sumFieldName = sumField ? sumField.name : null;
        const currencyField =
            sumField?.type === "monetary" && sumField.currency_field
                ? sumField.currency_field
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
            tallies.set(group.id, {
                own: [],
                placed: [],
                removed: 0,
                adjustments: [],
                displacedIn: 0,
                displacedOut: 0,
                currencies: new Set(),
            });
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
                // is already 0), into the stage it is displayed in, with its currency.
                if (this._tracksStage(record) && stageValue !== record.serverStageId) {
                    const recordValue =
                        sumFieldName !== null ? Number(record.data[sumFieldName]) || 0 : 0;
                    for (const source of groupsByValue.get(record.serverStageId) ?? []) {
                        const sourceTally = tallies.get(source.id);
                        sourceTally.displacedOut++;
                        if (sumFieldName !== null && source.count !== 0) {
                            sourceTally.adjustments.push(-recordValue);
                        }
                    }
                    const currencyId =
                        currencyField !== null
                            ? record.data[currencyField]?.id ?? user.activeCompany?.currency_id
                            : null;
                    for (const target of groupsByValue.get(stageValue) ?? []) {
                        const targetTally = tallies.get(target.id);
                        targetTally.displacedIn++;
                        if (sumFieldName !== null) {
                            targetTally.adjustments.push(recordValue);
                        }
                        if (currencyId) {
                            targetTally.currencies.add(currencyId);
                        }
                    }
                }
            }
        }

        const isShownPending = this._pendingCreateFilter();
        /** @type {Map<string, StageSummary>} */
        const byGroupId = new Map();
        for (const group of groups) {
            const { own, placed, removed, adjustments, displacedIn, displacedOut, currencies } =
                tallies.get(group.id);
            let pendingCreates = this.crmOffline.pendingLeadCreates(group.serverValue, entries);
            if (isShownPending) {
                pendingCreates = pendingCreates.filter(isShownPending);
            }
            if (sumFieldName !== null) {
                for (const entry of pendingCreates) {
                    adjustments.push(Number(entry.value.args?.[1]?.[sumFieldName]) || 0);
                }
            }
            if (currencyField !== null && pendingCreates.length) {
                // The currency the pending cards of this stage format their amounts with.
                const currencyId =
                    group.list.records?.[0]?.data?.[currencyField]?.id ??
                    user.activeCompany?.currency_id;
                if (currencyId) {
                    currencies.add(currencyId);
                }
            }
            const count = Math.max(
                0,
                (group.count || 0) - removed + placed.length + pendingCreates.length
            );
            byGroupId.set(group.id, {
                cards: [...own, ...placed],
                pendingCreates,
                count,
                revenueAdjustments: adjustments,
                isAdjusted: displacedIn > 0 || displacedOut > 0 || pendingCreates.length > 0,
                // The displayed leads the loaded aggregate counts: the count less the queued
                // creates and the records displaced here, i.e. the loaded leads not displaced away.
                loadedCount: Math.max(0, count - pendingCreates.length - displacedIn),
                addedCurrencies: [...currencies],
            });
        }
        return { placement, groupsByValue, byGroupId };
    }

    /**
     * Which queued creates the projection presents as pending cards.
     *
     * A create replayed during a sync window keeps its pending card from the window's copy until
     * the reconciliation reload, unless a load already holds the lead it created: a load that
     * lands inside the window (the fresh answer of a remounted pipeline's cache-first load, a
     * filter change, a regroup back to stages, `list.load()`) reads data that include the lead,
     * so its server card shows it and the loaded aggregates count it. Such a held entry is left
     * out, and with it out of the count and the revenue, so the lead is presented once. Its id
     * is the one the framework's own replay answer gave (`replayedCreateIds`, recorded by
     * `_setupSyncWindowDiscards`). This is not id remapping: no queued call is rewritten and
     * nothing is persisted; the answer only tells the window's copy that its create is now a
     * loaded server record. An entry still in the live queue is always pending. Sample records
     * hold no server record, whatever their fake ids.
     *
     * @private
     * @returns {((entry: QueueEntry) => boolean) | null} the filter, `null` when no created id is
     *   recorded (as outside every sync window) or the pipeline shows sample data: every queued
     *   create is then pending
     */
    _pendingCreateFilter() {
        if (!this.replayedCreateIds.size || this.props.list.model.useSampleModel) {
            return null;
        }
        const loadedIds = new Set(this.allLoadedRecords().map((record) => record.resId));
        const liveKeys = new Set(this.crmOffline.queuedEntries().map((entry) => String(entry.key)));
        return (entry) => {
            const key = String(entry.key);
            const createdId = this.replayedCreateIds.get(key);
            return liveKeys.has(key) || createdId === undefined || !loadedIds.has(createdId);
        };
    }

    /**
     * The projection's summary of a stage. A group the current list does not hold (a datapoint of
     * a list a reload replaced, which no template renders) displays nothing: no card, no queued
     * create, a count of 0 and no revenue adjustment, so its revenue is its loaded aggregate.
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
                isAdjusted: false,
                loadedCount: 0,
                addedCurrencies: [],
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
     * Read from the stage projection (shared array, must not be mutated). A replayed create a load
     * already holds as a server record is not among them (see `_pendingCreateFilter`).
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
     * The loaded aggregate of a stage for the sum field, `{ value, currencies }`: the sum and the
     * currencies of the records the server counts in the stage, so an empty stage carries no
     * currency, as on the desktop header.
     *
     * It is read exactly as the desktop column header reads it: `getGroupInfo` first, which
     * registers the group's loaded aggregates in the progress bar state (already done at render
     * for every stage, see `_setupAggregateRegistration`), then `getAggregateValue`.
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
     * Currencies are those the header of the synced stage would carry, so the pending-aware sum is
     * formatted as the desktop header formats it once the writes are on the server:
     * - nothing pending adjusts the stage: the loaded aggregate's, exactly as on desktop;
     * - otherwise, the loaded aggregate's while the stage still displays a lead it counts, joined
     *   with those of the amounts pending writes add here (see `_computeStageProjection`). A stage
     *   the server reports empty thus shows a moved or queued amount in its currency, and a stage
     *   whose counted leads all moved away carries none, as an empty stage on desktop.
     * Only a monetary sum field with a currency field has currencies.
     *
     * @private
     * @param {Group} group
     * @returns {{ value: number, currencies?: number[] }}
     */
    _stageRevenue(group) {
        if (!group || !this.hasRevenue) {
            return { value: 0 };
        }
        const { value: loadedValue, currencies: loadedCurrencies } = this._stageAggregate(group);
        const { revenueAdjustments, isAdjusted, loadedCount, addedCurrencies } =
            this._stageSummary(group);
        let value = loadedValue;
        for (const adjustment of revenueAdjustments) {
            value += adjustment;
        }
        if (!isAdjusted) {
            return { value, currencies: loadedCurrencies };
        }
        const currencies = new Set(loadedCount > 0 ? loadedCurrencies ?? [] : []);
        for (const currencyId of addedCurrencies) {
            currencies.add(currencyId);
        }
        return currencies.size ? { value, currencies: [...currencies] } : { value };
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
     * (`AnimatedNumber.format`), so currency semantics are unchanged: in the stage's single
     * currency, in the user's company currency when it holds several, and as a plain integer when
     * it carries none (an empty stage, a sum field without currency). The currencies of a
     * pending-aware sum are those of the synced stage (see `_stageRevenue`).
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

    /**
     * The hint of a displayed stage that shows no lead while other stages hold some, such as after
     * a search whose only matches are in other stages: the displayed stage is kept across reloads,
     * so the hint says how many leads the other stages hold and offers to display the first of
     * them, in display order, that holds a lead. The counts are the pending-aware counts of the
     * header (`stageCount`).
     *
     * Shown online and offline (displaying a stage is local, and a folded stage is never loaded
     * offline), but only while the stage shows nothing else: no lead, no card, no pending create,
     * no framework quick create and no unavailable-lead helper. Never with sample data, nor when
     * the no-content helper covers an empty pipeline. Reads no server data.
     *
     * @param {Group} group the displayed stage
     * @returns {{ target: Group, targetCount: number, otherCount: number } | null} the stage the
     *   hint displays and its lead count, and the lead count of every other stage together; `null`
     *   when no hint is shown
     */
    emptyStageHint(group) {
        if (
            !group ||
            this.props.list.model.useSampleModel ||
            this.mobileState.unavailableLeadId ||
            this.props.quickCreateState?.id === group.id ||
            this.stageCount(group) !== 0 ||
            this.cardsFor(group).length > 0 ||
            this.pendingCreatesFor(group).length > 0 ||
            this.showNoContentHelper
        ) {
            return null;
        }
        let target = null;
        let targetCount = 0;
        let otherCount = 0;
        for (const other of this.stageGroups) {
            const count = other.id === group.id ? 0 : this.stageCount(other);
            if (count > 0) {
                if (!target) {
                    target = other;
                    targetCount = count;
                }
                otherCount += count;
            }
        }
        return target ? { target, targetCount, otherCount } : null;
    }

    /**
     * @param {{ otherCount: number }} hint the displayed stage's `emptyStageHint`
     * @returns {string} the sentence of the hint: the stage has no lead, and how many leads the
     *   other stages hold
     */
    emptyStageHintLabel({ otherCount }) {
        if (otherCount === 1) {
            return _t("No lead in this stage. 1 lead is in another stage.");
        }
        return _t("No lead in this stage. %(count)s leads are in other stages.", {
            count: otherCount,
        });
    }

    /**
     * @param {{ target: Group, targetCount: number }} hint the displayed stage's `emptyStageHint`
     * @returns {string} the label of the hint's button: the stage it displays, with its lead count
     */
    emptyStageHintAction({ target, targetCount }) {
        return _t("Show %(stage)s (%(count)s)", {
            stage: target.displayName,
            count: targetCount,
        });
    }

    // -------------------------------------------------------------------------
    // Effects
    // -------------------------------------------------------------------------

    /**
     * Connection-loss attribution and observed replays.
     *
     * The framework sets its offline signal from every answer (a `ConnectionLostError` sets it,
     * any other answer clears it), so a single request of the pipeline that keeps failing (a
     * background read or its reload; one endpoint unreachable, a flaky network) takes the whole
     * client offline, and the next successful answer brings it back. The pipeline recovers from
     * every reconnection (it re-reads and reloads, see `_setupActivityRevalidation` and
     * `_setupSyncReconciliation`), which reissues the request that failed: once, as a retry; a
     * recovery that failed in turn must not recover again, or it loops. So the pipeline records,
     * without probing the network, what each status change of the framework comes from
     * (`_connection`), one retry per failure:
     *
     * - Recovery requests are those the pipeline issues to recover from a reconnection. The
     *   reads of a revalidation run that handles a reconnection, or that first reads what a
     *   recovery reload produced, are: the network layer announces every request on `rpcBus`
     *   (`RPC:REQUEST`) while the loader is still being called, which `_issueRecoveryReads`
     *   brackets. Every other read (at mount, on stage navigation, Show all, a list change) is
     *   not, so a loss it reports is recovered from once.
     * - The requests of the list's model issued while a reconciliation reload is in flight
     *   (`reconciliation`), but for the silent ones, which are the framework's replays, are the
     *   reload's: the framework model issues them (`read_progress_bar`, `web_read_group`) after
     *   asynchronous steps, so they are told by their model rather than by bracketing. Each of
     *   them that answers with a lost connection marks the reload (`reconciliation.lost`), which
     *   then does not reconcile the copy (see `_reconcile`). They are recovery requests when a
     *   reconnection owed that reload (`reconciliation.recovery`), so a recovery reload whose
     *   request keeps failing does not make the next answer a reconnection to reload on.
     * - On each answer (`RPC:RESPONSE`, after the framework has applied it): a loss is a
     *   recovery loss when the answer that caused it is the connection-lost answer of a recovery
     *   request; a reconnection is a recovery reconnection when it ends such a loss, and is not
     *   recovered from. While offline, a connection-lost answer to any other request (the
     *   framework's reconnection check, the pipeline's other reads) confirms the loss, which is
     *   then no longer a recovery loss, so a real outage that a recovery request happened to
     *   report first still reloads and re-reads on reconnection.
     * - A change made without an answer (see `_observeConnection`) is taken at face value.
     *
     * The same listener counts the replays of queued writes (`replays`). The framework replays
     * each entry through a silent ORM call of the entry's model and method while its sync window
     * runs (`syncingORM`), so a successful silent call of a method the queue holds
     * (`QUEUED_METHODS`) during a window is one. That includes the entries another tab queued,
     * which the framework reads from its persisted queue only once the window has begun, after
     * the pipeline copied the queue (`_takeSyncSnapshot`). Each replay also starts a new
     * generation (`syncGeneration`): a reconciliation reload already in flight predates that
     * write. The queue itself is never read here, so desktop does no work.
     *
     * The record is read by the revalidation and reconciliation effects only. The listeners are
     * registered during setup, not at mount, so no answer in between is missed.
     *
     * @private
     */
    _setupConnectionAttribution() {
        // the RPC payloads of the recovery requests: the recovery reads', and the requests of the
        // reconciliation reloads a reconnection owed
        const recoveryRequests = new WeakSet();
        // the RPC payloads of the reconciliation reloads' requests → that reload's record
        const reloadRequests = new WeakMap();
        useListener(rpcBus, "RPC:REQUEST", (ev) =>
            untrack(() => {
                const { data, settings } = ev.detail ?? {};
                if (!data) {
                    return;
                }
                if (this._recoveryReadDepth > 0) {
                    recoveryRequests.add(data);
                    return;
                }
                const reconciliation = this.reconciliation;
                if (
                    reconciliation &&
                    !settings?.silent &&
                    data.params?.model &&
                    data.params.model === this.props.list?.resModel
                ) {
                    reloadRequests.set(data, reconciliation);
                    if (reconciliation.recovery) {
                        recoveryRequests.add(data);
                    }
                }
            })
        );
        useListener(rpcBus, "RPC:RESPONSE", (ev) =>
            untrack(() => {
                const { data, settings, error } = ev.detail ?? {};
                const connection = this._connection;
                const offline = this.crmOffline.isOffline();
                const lost = error instanceof ConnectionLostError;
                const recovery = Boolean(data) && recoveryRequests.has(data);
                if (lost && data) {
                    const reconciliation = reloadRequests.get(data);
                    if (reconciliation) {
                        reconciliation.lost = true;
                    }
                }
                if (offline !== connection.offline) {
                    if (offline) {
                        connection.recoveryLoss = lost && recovery;
                    } else {
                        connection.recoveryReconnection = connection.recoveryLoss;
                    }
                    connection.offline = offline;
                } else if (offline && lost && !recovery) {
                    connection.recoveryLoss = false;
                }
                const params = data?.params;
                if (
                    !error &&
                    settings?.silent &&
                    params?.model &&
                    QUEUED_METHODS.includes(params.method) &&
                    this.crmOffline.syncingORM()
                ) {
                    connection.replays++;
                    this.syncGeneration++;
                }
            })
        );
    }

    /**
     * Brings the connection attribution up to date with the offline signal, for a change the
     * framework made without an answer (a reconnection or loss set directly, the framework's
     * handler of an uncaught connection loss): a reconnection made that way ends whatever loss
     * there was, so it is never a recovery reconnection; a loss made that way keeps the
     * attribution of the last loss, which it re-reports when it comes from an uncaught
     * connection-lost answer. Called, untracked, by the effects before they decide.
     *
     * @private
     * @returns {{ offline: boolean, recoveryLoss: boolean, recoveryReconnection: boolean,
     *   replays: number }} `_connection`
     */
    _observeConnection() {
        const connection = this._connection;
        const offline = this.crmOffline.isOffline();
        if (offline !== connection.offline) {
            if (!offline) {
                connection.recoveryLoss = false;
                connection.recoveryReconnection = false;
            }
            connection.offline = offline;
        }
        return connection;
    }

    /**
     * Calls the read loaders of a recovery revalidation run, so that the requests they issue
     * count as recovery requests (see `_setupConnectionAttribution`). The loaders issue their
     * request before their first `await`, and the network layer announces it synchronously, so
     * bracketing the calls themselves marks exactly those requests.
     *
     * @private
     * @param {() => void} read issues the reads
     */
    _issueRecoveryReads(read) {
        this._recoveryReadDepth++;
        try {
            read();
        } finally {
            this._recoveryReadDepth--;
        }
    }

    /**
     * Registration of every stage's loaded aggregates in the progress bar state, at each render.
     *
     * The progress bar state seeds a group's aggregates from the group's loaded ones at the first
     * `getGroupInfo` of that group, replacing whatever it holds for the stage. The desktop kanban
     * calls it for every column as it first renders it, and the progress bar refresh registers
     * the unfolded groups only. The mobile pipeline renders one stage at a time, so a stage first
     * displayed after an aggregate refresh (a folded won stage displayed by an online mark-won,
     * whose save refreshes the aggregates) would have its refreshed aggregates replaced by the
     * stale loaded ones, and keep them until the next load. So, before the template reads any
     * aggregate, every stage of the pipeline, folded ones included, is registered as the desktop
     * columns are: once per group datapoint (later calls only answer), from the data the model
     * holds (an active progress bar filter left without lead is cleared, as a desktop column
     * clears it at its first render). The progress bar state keeps one aggregate entry per stage
     * id, so a stage the server answers in several groups is registered through its first group
     * only: registering the others would replace that entry with theirs. While the progress bar
     * data are missing (a pipeline loaded offline), nothing is registered, and the loaded
     * aggregates are read instead (see `_stageAggregate`). Runs inside the render, so the
     * registration follows the progress bar data and the groups it reads. Outside the stage
     * pipeline, or without progress bar, it does nothing, so desktop is unchanged.
     *
     * @private
     */
    _setupAggregateRegistration() {
        onWillRender(() => {
            const progressBarState = this.props.progressBarState;
            if (!progressBarState || !this.isMobilePipeline) {
                return;
            }
            const registeredStages = new Set();
            for (const group of this.props.list.groups) {
                if (!registeredStages.has(group.serverValue)) {
                    registeredStages.add(group.serverValue);
                    progressBarState.getGroupInfo(group);
                }
            }
        });
    }

    /**
     * Activity and activity-type revalidation.
     *
     * One effect with four dependencies, compared with those of its previous run: the gate; the
     * displayed stage's list datapoint, a new object after every root load, model replacement,
     * filter change or reconciliation reload; the ids of the persisted leads the displayed stage
     * shows (stage navigation, Load more, queued moves); and the offline signal. On each change,
     * while the gate holds, every displayed lead's activities and the activity types are read
     * again through the framework disk cache: online that refreshes the cache, and a changed
     * server answer is delivered through the cache callback; offline the cache answers. The
     * per-lead request is the same on every trigger (the loader's bounded default, or the
     * expansion an online "Show all" chose for that lead), so a lead's activities read online
     * come back offline whichever stage, filter or page displayed it, and the types are read
     * again on reconnect, so a cold offline cache miss clears without a manual reload. Each read
     * carries the lead's total count, so a truncated page is shown as such. The connection
     * dropping alone triggers no read (what is in memory is what the cache would answer).
     *
     * A run that handles a reconnection (its previous run saw the connection lost), or that is
     * the first to read the groups a recovery reload produced (while that reload is in flight,
     * which may commit them before it lands, or once it has landed: `recoveryGroups`), recovers:
     * its reads are recovery requests (`_issueRecoveryReads`, see
     * `_setupConnectionAttribution`). The connection coming back alone, with nothing else
     * changed, from a loss that a recovery request reported triggers no read: that would reissue
     * the retry that just failed, so a read that keeps failing is retried once per failure, never
     * in a loop. Sample records, whose ids are fake, are never read for. Sample mode suspends the
     * effect: it forgets the previous dependencies, and leaving sample mode (the reconciliation
     * reload, the quick create) re-runs it, so the first run on loaded data reads every displayed
     * lead and the types.
     *
     * The activities kept in memory are limited to the loaded leads by `_setupActivityPruning`.
     *
     * Outside the gate the dependencies are constants (plus the offline signal) and nothing is
     * read, so desktop issues no extra RPC.
     *
     * @private
     */
    _setupActivityRevalidation() {
        let previous = null;
        // the root list's groups at the previous run, so that a run tells whether it is the
        // first to read the groups a load produced
        let previousGroups = null;
        useEffect(() => {
            const gated = this.isMobilePipeline;
            // Sample records carry fake ids: nothing is read for them. The flag is tracked, so
            // leaving sample mode re-runs the effect, which then reads everything.
            if (gated && this.props.list.model.useSampleModel) {
                previous = null;
                previousGroups = null;
                return;
            }
            const group = gated ? this.currentGroup : null;
            const leadIds = gated
                ? this.cardsFor(group)
                      .filter((record) => record.resId)
                      .map((record) => record.resId)
                      .join(",")
                : "";
            const dependencies = [gated, group?.list ?? null, leadIds, this.crmOffline.isOffline()];
            const last = previous;
            if (last && dependencies.every((value, index) => Object.is(value, last[index]))) {
                return;
            }
            previous = dependencies;
            untrack(() => {
                const offline = dependencies[3];
                const connection = this._observeConnection();
                const groups = gated ? this.props.list.groups : null;
                const firstOnGroups = groups !== previousGroups;
                previousGroups = groups;
                if (!gated) {
                    return;
                }
                const onlyConnectionChanged =
                    last && last.slice(0, 3).every((value, index) => value === dependencies[index]);
                // The connection dropping, with nothing else changed, is not a revalidation
                // trigger: the activities and types in memory are those the cache would answer,
                // and the reads would only fail in the background.
                if (onlyConnectionChanged && offline && !last[3]) {
                    return;
                }
                const reconnection = Boolean(last?.[3]) && !offline;
                // Nor is the connection coming back, with nothing else changed, from a loss that
                // a recovery request reported: that would reissue the retry that failed.
                if (onlyConnectionChanged && reconnection && connection.recoveryReconnection) {
                    return;
                }
                // the first run to read the groups a recovery reload produced, in flight or
                // landed; the landed reload's groups are read once, by this run or never
                const afterRecoveryReload =
                    firstOnGroups &&
                    (Boolean(this.reconciliation?.recovery) || this.recoveryGroups === groups);
                this.recoveryGroups = null;
                const read = () => {
                    for (const resId of leadIds.split(",").filter(Boolean).map(Number)) {
                        this._loadLeadActivities(resId);
                    }
                    this._loadActivityTypes();
                };
                if (reconnection || afterRecoveryReload) {
                    this._issueRecoveryReads(read);
                } else {
                    read();
                }
            });
        });
    }

    /**
     * Activities kept in memory follow the loaded leads.
     *
     * One effect, while the gate holds, follows the ids of every record a group of the pipeline
     * holds (`allLoadedRecords`, folded groups included) and compares them with its previous run.
     * When they change, the activities of the leads no group holds any more are forgotten
     * (`_pruneActivities`). That covers a new list datapoint (root load, model replacement,
     * filter change, reconciliation reload) and an in-place reload of a group's records (its
     * list reloaded, Load more), which replaces the records but keeps the datapoint. A lead
     * loaded again later gets its activities back from the disk cache, and a late answer for a
     * lead no group holds is dropped (`_applyActivities`).
     *
     * Outside the gate it reads no record, so desktop does no work.
     *
     * @private
     */
    _setupActivityPruning() {
        // ids of the loaded records at the previous run, `null` outside the gate
        let previousIds = null;
        useEffect(() => {
            if (!this.isMobilePipeline) {
                previousIds = null;
                return;
            }
            const ids = this.allLoadedRecords()
                .map((record) => record.resId)
                .join(",");
            if (ids === previousIds) {
                return;
            }
            previousIds = ids;
            untrack(() => this._pruneActivities());
        });
    }

    /**
     * Forgets the activities, their total counts, the answers they came from and their confirmed
     * writes not read yet, of the leads no group of the pipeline holds any more. The limit an
     * online "Show all" chose for a lead (`activityLimitsByLead`) is kept, so a lead loaded again
     * reissues the same expanded request, which the cache answers offline.
     *
     * @private
     */
    _pruneActivities() {
        const loadedIds = new Set(this.allLoadedRecords().map((record) => record.resId));
        const {
            activitiesByLead,
            activityTotalsByLead,
            activityAnswersByLead,
            activityWritesByLead,
        } = this.mobileState;
        for (const byLead of [
            activitiesByLead,
            activityTotalsByLead,
            activityAnswersByLead,
            activityWritesByLead,
        ]) {
            for (const resId of Object.keys(byLead)) {
                if (!loadedIds.has(Number(resId))) {
                    delete byLead[resId];
                }
            }
        }
        // a lead no longer loaded waits for no activity rows
        this._releaseActivityRowWaiters();
    }

    /**
     * Post-sync reconciliation.
     *
     * Going online first clears the offline signal, then the framework replays the queue inside a
     * sync window (`syncingORM`). One effect follows the gate, the offline signal and the sync
     * signal, and compares them with its previous run. While the gate holds:
     *
     * - When a window begins, or when the pipeline is mounted or enters the gate while one runs,
     *   the queue entries are copied (`syncEntries`), so a write replayed during the sync keeps
     *   its presentation. The entries that reach the queue while the window runs (another tab's,
     *   which the framework reads from its persisted queue only then) join the copy (see
     *   `_setupSyncWindowDiscards`). Entered inside a running window, the pipeline may have been
     *   loaded before some of its writes were replayed, so it owes a reload even with nothing to
     *   copy.
     * - When the connection has returned and no sync is running, the pipeline reloads through the
     *   framework model, then drops the copy (`_reconcile`): created leads and activities appear
     *   as server records, and only the entries still in the queue (parked with `extras.error`)
     *   keep their pending presentation. The reload runs immediately after reconnecting when
     *   nothing is queued, otherwise when the sync window ends. A window that replayed writes
     *   (counted as they are answered, see `_setupConnectionAttribution`, so the writes another
     *   tab queued count too) reloads when it ends, after a reconnection that already reloaded
     *   at once included: that reload predates the replays. A window that replayed nothing
     *   (empty, or parked entries only) reloads only if a reload is still owed, and a reload
     *   already in flight that no later window or replay outdates ends the window itself, so one
     *   reconnection reloads once.
     * - A window that ends because the connection dropped again keeps the copy, and the next
     *   window starts from it.
     *
     * Outside the gate the queue is never read and no copy is taken; every window that begins
     * there outdates the reloads in flight. Leaving the gate releases the copy; the reload owed
     * then (a copy was held or a sync was running), after a reconnection or after a window that
     * replays writes outside the gate, runs as soon as the gate holds again online with no sync
     * running. A window that replays nothing there, such as the framework's start-up window on a
     * wide screen, owes no reload, so entering the gate later only reads the activities and
     * types. Going offline drops an owed reload: the next reconnection owes its own.
     *
     * The reload a reconnection owes is a recovery reload (`_reconcile`): its requests are
     * recovery requests (see `_setupConnectionAttribution`), as are the reads of the revalidation
     * that handles the reconnection and of the first one after that reload. A connection loss
     * that a recovery request reported is not a reconnection to reconcile: the recovery was the
     * retry. Its end owes no reload while the root list is the one shown at the loss and its
     * groups are those shown then, or those a reconciliation reload produced: the last one that
     * landed (`reconciledGroups`, even when the disk cache answered it: that reload then kept the
     * copy), or the one still in flight, which commits its groups before it lands. Any other load
     * that landed offline (a filter, a model replacement) may hold cached data, so it still owes
     * one. The loss keeps any reload already owed, which its end then runs as any reconnection
     * would. After such a reconnection, a copy kept from an earlier window does not by itself
     * make the window end with a reload: it waits for a reconnection that is not a recovery
     * reconnection, while a window that replays writes, or a reload still owed, reloads as after
     * any reconnection. Every other loss, one the pipeline's other reads reported included, is
     * recovered from once: a request that keeps failing, a read or the reload's, makes the
     * pipeline reload and re-read once per failure, never in a loop. The reconnection still
     * clears the unavailable-lead helper.
     *
     * No id is remapped and nothing is persisted: the copy is an in-memory list of framework
     * entries, and the reload is the framework model's own.
     *
     * @private
     */
    _setupSyncReconciliation() {
        let wasGated = false;
        let wasOffline = untrack(() => this.crmOffline.isOffline());
        let wasSyncing = false;
        // whether the pipeline owes a reload: the connection came back, or its data may predate
        // replayed writes, and it has not been reloaded since
        let reloadPending = false;
        // whether a reconnection (one that is not a recovery reconnection) made the reload owed:
        // that reload is then a recovery reload
        let reloadRecovery = false;
        // the root list and its groups when the connection was last lost: a load landing while
        // offline (which the disk cache may answer) replaces them
        let loadedAtLoss = null;
        // the replays observed when the current, or last, sync window began
        let replaysAtWindowStart = this._connection.replays;
        // whether the last reconnection ended a loss that a recovery request reported
        let lastRecoveryReconnection = false;
        useEffect(() => {
            const gated = this.isMobilePipeline;
            const offline = this.crmOffline.isOffline();
            const syncing = this.crmOffline.syncingORM();
            if (gated === wasGated && offline === wasOffline && syncing === wasSyncing) {
                return;
            }
            const previousGated = wasGated;
            const previousOffline = wasOffline;
            const previousSyncing = wasSyncing;
            wasGated = gated;
            wasOffline = offline;
            wasSyncing = syncing;
            untrack(() => {
                const connection = this._observeConnection();
                const reconnected = !offline && previousOffline;
                // a window that ends while connected (a window the connection loss interrupts
                // ends offline)
                const windowEnded = !offline && !syncing && previousSyncing && !previousOffline;
                if (syncing && !previousSyncing) {
                    replaysAtWindowStart = connection.replays;
                }
                // a window that ended having replayed writes, whichever tab queued them
                const windowReplayed = windowEnded && connection.replays > replaysAtWindowStart;
                if (offline && !previousOffline) {
                    loadedAtLoss = [this.props.list, this.props.list?.groups];
                    // a loss that a recovery request reported keeps the reload owed
                    if (!connection.recoveryLoss) {
                        reloadPending = false;
                        reloadRecovery = false;
                    }
                }
                // the end of such a loss, with the pipeline still showing what it showed then, or
                // what a reconciliation reload brought (the last one that landed, or the one in
                // flight, which may have committed its groups before it lands): nothing it shows
                // is staler than before the loss, so it owes no new reload
                const groups = this.props.list?.groups;
                const recoveryReconnection =
                    reconnected &&
                    connection.recoveryReconnection &&
                    loadedAtLoss?.[0] === this.props.list &&
                    (loadedAtLoss[1] === groups ||
                        this.reconciledGroups === groups ||
                        Boolean(this.reconciliation));
                if (reconnected) {
                    lastRecoveryReconnection = recoveryReconnection;
                }
                if (!gated) {
                    if (syncing && !previousSyncing) {
                        // what the window replays is not known without reading the queue
                        this.syncGeneration++;
                    }
                    if (previousGated) {
                        if (this.mobileState.syncEntries || syncing) {
                            reloadPending = true;
                        }
                        this.mobileState.syncEntries = null;
                        this.mobileState.unavailableLeadId = null;
                    }
                    if (reconnected && !recoveryReconnection) {
                        reloadPending = true;
                        reloadRecovery = true;
                    }
                    if (windowReplayed) {
                        reloadPending = true;
                    }
                    return;
                }
                // ends the window, unless the reload in flight does: no window outdated it
                const reconcile = () => {
                    const recovery = reloadRecovery;
                    reloadPending = false;
                    reloadRecovery = false;
                    if (this.reconciliation?.generation !== this.syncGeneration) {
                        this._reconcile(recovery);
                    }
                };
                if (syncing && (!previousSyncing || !previousGated)) {
                    this._takeSyncSnapshot();
                    if (!previousGated) {
                        reloadPending = true;
                    }
                }
                if (reconnected) {
                    this.mobileState.unavailableLeadId = null;
                    if (!recoveryReconnection) {
                        reloadPending = true;
                        reloadRecovery = true;
                    }
                    if (reloadPending && !syncing && this.crmOffline.queuedEntries().length === 0) {
                        // the data shown offline may come from the disk cache: reloaded at once
                        const recovery = reloadRecovery;
                        reloadPending = false;
                        reloadRecovery = false;
                        this._reconcile(recovery);
                    }
                } else if (windowEnded) {
                    // what a copy kept from an earlier window (one the connection loss
                    // interrupted, or whose reload did not reconcile it) still places
                    const keptCopy = (this.mobileState.syncEntries ?? []).some(
                        (entry) => !entry.value?.extras?.error
                    );
                    // A kept copy alone waits for a reconnection that is not a recovery
                    // reconnection: after one, its reload may be the very request that keeps
                    // failing.
                    if (
                        windowReplayed ||
                        reloadPending ||
                        (keptCopy && !lastRecoveryReconnection)
                    ) {
                        reconcile();
                    } else if (!keptCopy) {
                        this.mobileState.syncEntries = null;
                    }
                } else if (!previousGated && !offline && !syncing && reloadPending) {
                    reconcile();
                }
            });
        });
    }

    /**
     * The entries that join a sync-window copy, and the systray discards that leave it.
     *
     * While a window runs in the stage pipeline, the live entries the copy does not hold join it
     * (`_joinSyncArrivals`), a copy being created when none is held: the effect joins them on
     * every change of the live queue and, whenever the effect runs, a successful silent call of a
     * live entry's model and method joins them before it marks anything, while the framework
     * still holds the entry it replays. Those entries reached the queue after the copy was taken,
     * chiefly the ones another tab queued, which the framework reads from its persisted queue
     * once the window has begun. Joined, a write of theirs replayed during the sync keeps its
     * presentation until the reconciliation reload, as the window's own entries do.
     *
     * The copy keeps placing an entry that has left the queue until the reconciliation reload:
     * right for a replayed write, wrong for a discarded one, which stops placing its card and
     * counting in the totals at once. They are told apart by the replay itself, not by timing.
     * The framework replays an entry through a silent ORM call carrying the entry's model, method
     * and very `args` object, and deletes the entry only once that call has succeeded; the
     * network layer announces every answer on `rpcBus` (`RPC:RESPONSE`) before the caller
     * resumes. So, while a copy is held and a sync runs, each successful silent call marks as
     * replayed the entries, among the live entries last seen and the copy, of its model and
     * method whose arguments are that same object (else, when none is, equal to it).
     *
     * An entry that leaves the queue stays in the copy only when it was marked replayed (the mark
     * is then spent). Every other departure, a systray discard whenever it happens and whether or
     * not the entry was parked (`extras.error`), is removed from the copy at once: a new list of
     * the same framework entries, `null` once empty. Two consequences:
     * - the framework still sends every call it listed when the window began, the call of an
     *   entry discarded since included, so such a write can reach the server after its
     *   presentation has ended: the reconciliation reload that ends the window then shows the
     *   server state;
     * - a window the pipeline enters mid-way holds only the entries still queued at entry (see
     *   `_takeSyncSnapshot`); the reload it owes covers the writes replayed before.
     *
     * A replayed `crm.lead` create (`web_save` with no id) answers the records it created: the id
     * of the first is recorded for the entry the answer marked (`replayedCreateIds`, by queue
     * key). When entries of equal arguments match, the earliest by timestamp still without an id
     * gets it, the order the framework replays them in. The id outlives the spent mark: it lasts
     * while the copy holds the entry and is emptied with the copy. `_pendingCreateFilter` reads
     * it, so a lead that a load already holds is presented once. This is not id remapping: no
     * queued call is rewritten and nothing is persisted; the framework's own replay answer only
     * tells the window's copy that its create is now a loaded server record.
     *
     * A replayed `mail.activity` call of a lead goes to `_onActivityCallReplayed`, which records
     * it the same way (`replayedActivityCalls`, emptied with the copy too, as are the answered
     * activity reads that bound a reconciliation reload's wait, `_settledActivityReads`, and the
     * answers the loaded activities come from, `_activityAnswerNumbers` and
     * `activityAnswersByLead`; dropping the copy also resumes a reconciliation reload waiting for
     * its rows) and has the lead's activities read again, so the card's server rows replace the
     * replayed call's rows inside the window.
     *
     * Whether a window replayed anything at all, entries the copy never held included, is counted
     * apart, without a copy (see `_setupConnectionAttribution`).
     *
     * Without a copy, neither the listener nor the effect reads anything else, but while a window
     * runs in the stage pipeline, so desktop and every session outside a sync window do no work.
     *
     * @private
     */
    _setupSyncWindowDiscards() {
        // live entries by key at the previous run, with those a replay answer joined since;
        // `null` while no copy is held
        let seen = null;
        // keys of the entries a successful replay call carried, not yet seen leaving the queue
        const replayed = new Set();
        // Registered during setup, not at mount: a pipeline set up inside a window misses no
        // answer.
        useListener(rpcBus, "RPC:RESPONSE", (ev) =>
            untrack(() => {
                let copy = this.mobileState.syncEntries;
                if (!this.crmOffline.syncingORM() || (!copy && !this.isMobilePipeline)) {
                    return;
                }
                const { data, settings, error, result } = ev.detail ?? {};
                const params = data?.params;
                if (
                    error ||
                    !settings?.silent ||
                    !params?.model ||
                    !params.method ||
                    !Array.isArray(params.args)
                ) {
                    return;
                }
                if (this.isMobilePipeline) {
                    // The effect may not have followed the live queue since the framework read
                    // its persisted queue: a replay of a live entry, which the framework deletes
                    // only once this call has succeeded, joins it to the copy now, with every
                    // other live entry the copy lacks, and they all count as seen.
                    const live = this.crmOffline.queuedEntries();
                    if (
                        live.some(
                            ({ value }) =>
                                value?.model === params.model && value.method === params.method
                        )
                    ) {
                        copy = this._joinSyncArrivals(live);
                        seen ??= new Map();
                        for (const entry of live) {
                            seen.set(String(entry.key), entry);
                        }
                    }
                    if (!copy) {
                        return;
                    }
                }
                const candidates = [...(seen?.values() ?? []), ...copy].filter(
                    ({ value }) => value?.model === params.model && value.method === params.method
                );
                let matches = candidates.filter(({ value }) => value.args === params.args);
                if (!matches.length && candidates.length) {
                    const args = JSON.stringify(params.args);
                    matches = candidates.filter(({ value }) => JSON.stringify(value.args) === args);
                }
                for (const entry of matches) {
                    replayed.add(String(entry.key));
                }
                if (!matches.length) {
                    return;
                }
                if (params.model === "mail.activity") {
                    this._onActivityCallReplayed(params, result, matches);
                    return;
                }
                // a replayed lead create: the lead it created, for `pendingCreatesFor`
                const createdId = Array.isArray(result) ? result[0]?.id : undefined;
                if (
                    params.model !== "crm.lead" ||
                    params.method !== "web_save" ||
                    !Array.isArray(params.args[0]) ||
                    params.args[0].length !== 0 ||
                    !Number.isInteger(createdId)
                ) {
                    return;
                }
                const target = replayedEntryOf(matches, this.replayedCreateIds);
                if (target) {
                    this.replayedCreateIds.set(String(target.key), createdId);
                }
            })
        );
        const release = () => {
            seen = null;
            replayed.clear();
            this.replayedCreateIds.clear();
            this.replayedActivityCalls.clear();
            this._settledActivityReads.clear();
            this._activityAnswerNumbers.clear();
            untrack(() => {
                this.mobileState.activityAnswersByLead = {};
            });
            // nothing is held any more: a reconciliation reload waiting for rows goes on
            this._releaseActivityRowWaiters(true);
        };
        useEffect(() => {
            const held = this.mobileState.syncEntries;
            // while a window runs in the stage pipeline, the live queue is followed even without a
            // copy: the entries that reach it join the copy (see `_joinSyncArrivals`)
            const joining = this.crmOffline.syncingORM() && this.isMobilePipeline;
            if (!held && !joining) {
                release();
                return;
            }
            const live = this.crmOffline.queuedEntries();
            untrack(() => {
                const copy = joining ? this._joinSyncArrivals(live) : held;
                if (!copy) {
                    release();
                    return;
                }
                const previousSeen = seen;
                seen = new Map(live.map((entry) => [String(entry.key), entry]));
                if (!previousSeen) {
                    return;
                }
                const discarded = new Set();
                for (const key of previousSeen.keys()) {
                    if (seen.has(key)) {
                        continue;
                    }
                    if (replayed.has(key)) {
                        replayed.delete(key);
                    } else {
                        discarded.add(key);
                    }
                }
                if (!discarded.size) {
                    return;
                }
                const remaining = copy.filter((entry) => !discarded.has(String(entry.key)));
                if (remaining.length !== copy.length) {
                    this.mobileState.syncEntries = remaining.length ? remaining : null;
                }
            });
        });
    }

    /**
     * A `mail.activity` call of the sync window was replayed successfully (see
     * `_setupSyncWindowDiscards`, which matched it to `matches`), and its entry is about to leave
     * the queue while the copy keeps its row on the card (see `cardQueueEntries`).
     *
     * - The call is recorded for its entry (`replayedActivityCalls`, the entry chosen as for
     *   `replayedCreateIds`): its lead, the activity its answer created (an activity create on a
     *   lead: `web_save` without id, `res_model` `crm.lead`) or the activity it marked done
     *   (`action_archive`), and `replaySeq`, the number of the last activity request sent so far
     *   (`_activityReadSequence`), taken before the re-read below is sent: every request numbered
     *   above it is sent after this replay committed. The cards drop the pending row of a create
     *   once the lead's loaded activities account for it, and the reconciliation reload ends the
     *   window only once the displayed leads' activities account for every recorded call (see
     *   `_isActivityReplayReflected`), or the server answered a read of their lead issued after
     *   the reload began (see `_awaitsActivityRows`).
     * - The lead's activities are read again, as after an online activity write
     *   (`onActivitiesChanged`, which reads only a lead the displayed stage shows): when that read
     *   sends its own request, its answer accounts for the call, and the server rows replace the
     *   replayed call's rows in one render, inside the window; the cache-first read after the
     *   reconciliation reload answers with them. A read the cache joins to a request sent before
     *   (numbered at most `replaySeq`) does not account for it.
     *
     * The lead of a mark done is the one whose loaded activities hold the activity. A call whose
     * lead is unknown (a mark done no loaded lead holds, another model's activity) changes
     * nothing.
     *
     * @private
     * @param {{ method: string, args: any[] }} params the replayed call
     * @param {any} result its answer (`web_save`: the records it created)
     * @param {QueueEntry[]} matches the entries the call matched (at least one)
     */
    _onActivityCallReplayed({ method, args }, result, matches) {
        const [ids, vals] = args;
        if (!Array.isArray(ids)) {
            return;
        }
        let resId;
        let activityId;
        if (method === "web_save" && ids.length === 0 && vals?.res_model === "crm.lead") {
            resId = vals.res_id;
            const createdId = Array.isArray(result) ? result[0]?.id : undefined;
            activityId = Number.isInteger(createdId) ? createdId : undefined;
        } else if (method === "action_archive") {
            activityId = ids[0];
            const lead = Object.entries(this.mobileState.activitiesByLead).find(([, rows]) =>
                rows?.some((activity) => activity.id === activityId)
            );
            resId = lead ? Number(lead[0]) : undefined;
        }
        if (!Number.isInteger(resId)) {
            return;
        }
        const target = replayedEntryOf(matches, this.replayedActivityCalls);
        if (target) {
            this.replayedActivityCalls.set(String(target.key), {
                resId,
                method,
                activityId,
                // taken before the re-read below takes the next number
                replaySeq: this._activityReadSequence,
            });
        }
        this.onActivitiesChanged(resId);
    }

    /**
     * Copies the queue entries a sync window begins with (or holds when the pipeline enters it),
     * united with the entries of an earlier window whose reconciliation did not land (the
     * connection dropped again), deduplicated by key, the live entry winning; `null` when that
     * leaves nothing. The entries themselves are the framework's, never mutated.
     *
     * Every window takes the copy. Only a window with a write to replay (a live entry not parked)
     * starts a new generation (`syncGeneration`): a reload issued before it no longer ends the
     * window. A window with nothing to replay keeps the generation, so a reload already in flight
     * still ends it, and one reconnection reloads once.
     *
     * The copy is taken as the window begins, before the framework reads its persisted queue
     * again, so it holds none of the entries another tab queued: they join it as they reach the
     * live queue (`_joinSyncArrivals`), so their replayed writes keep their presentation too, and
     * their replays, counted as they are answered, start a generation each and make the window end
     * with a reload (see `_setupConnectionAttribution`).
     *
     * @private
     */
    _takeSyncSnapshot() {
        const live = this.crmOffline.queuedEntries();
        const previous = this.mobileState.syncEntries ?? [];
        const liveKeys = new Set(live.map((entry) => String(entry.key)));
        const entries = [...live, ...previous.filter((entry) => !liveKeys.has(String(entry.key)))];
        this.mobileState.syncEntries = entries.length ? entries : null;
        if (live.some((entry) => !entry.value?.extras?.error)) {
            this.syncGeneration++;
        }
    }

    /**
     * Joins to the sync-window copy the live queue entries it does not hold, while a window runs
     * in the stage pipeline (see `_setupSyncWindowDiscards`): those reached the live queue after
     * the copy was taken, chiefly the entries another tab queued, which the framework reads from
     * its persisted queue once the window has begun. A copy is created when none is held. The
     * copy becomes a new list of the same framework entries, never mutated, one per key; the
     * entries it already holds stay as they are. As for the live entries a copy is taken with
     * (`_takeSyncSnapshot`), an arrival with a write to replay (not parked) starts a new
     * generation (`syncGeneration`): a reload already in flight predates it.
     *
     * @private
     * @param {QueueEntry[]} live the entries of the live queue
     * @returns {QueueEntry[] | null} the copy now held, `null` when none is
     */
    _joinSyncArrivals(live) {
        const copy = this.mobileState.syncEntries;
        const heldKeys = new Set((copy ?? []).map((entry) => String(entry.key)));
        const arrivals = live.filter((entry) => !heldKeys.has(String(entry.key)));
        if (!arrivals.length) {
            return copy;
        }
        this.mobileState.syncEntries = [...(copy ?? []), ...arrivals];
        if (arrivals.some((entry) => !entry.value?.extras?.error)) {
            this.syncGeneration++;
        }
        return this.mobileState.syncEntries;
    }

    /**
     * Reloads the pipeline through the framework model after a sync, then ends the sync window by
     * dropping the copy. Only in the stage pipeline: outside it nothing is reloaded and the copy is
     * left to the reconciliation effect, which owes the reload until the gate holds again. A
     * pipeline showing sample data is reloaded too, and leaves sample mode once the reload has
     * landed, as the framework kanban controller does after its own reload: a lead created
     * outside the pipeline and replayed then shows as a server card. A reload rejected for a lost
     * connection keeps the sample data.
     *
     * The copy is kept when the reload does not reconcile it:
     * - the reload lost the connection, one of its own requests answered with a lost connection
     *   (`reconciliation.lost`, see `_setupConnectionAttribution`), or the connection dropped
     *   while it ran: the disk cache may then have answered it, and another answer may already
     *   have brought the client back online; the next window starts from the copy. No reload is
     *   owed for it: the next reconnection that is not a recovery reconnection reloads, as every
     *   one does, so a request that keeps failing never makes the pipeline reload in a loop;
     * - a window with a write to replay began, or a write was replayed, while the reload ran (it
     *   started a new generation, `syncGeneration`): the reload predates those writes, and that
     *   window's end reconciles it;
     * - the gate no longer holds once the reload has landed.
     * Every window takes the copy, but only a window with a write to replay, or a replay, starts
     * a new generation: one running with the generation unchanged replays nothing the reload
     * lacks, so it does not keep the copy.
     *
     * A recovery reload (`recovery`, one a reconnection owed) is the retry of that reconnection:
     * its requests are recovery requests, and so are the reads of the first revalidation run on
     * the groups it produced, which are recorded once it has landed (`recoveryGroups`) for a run
     * that comes after (see `_setupConnectionAttribution`).
     *
     * Activities are not part of the reload: they come from the re-read each replayed activity
     * call asked for and from the revalidation that follows the reload. While the loaded
     * activities of a displayed lead do not account for an activity call replayed during the
     * window yet (`_awaitsActivityRows`), the reload is not over: the copy keeps the call's row (a
     * create without badge, a mark done without Mark done) until they do, so the row neither
     * vanishes nor offers Mark done again in between. The wait is bounded: the number of the last
     * activity request sent before the reload begins is taken first, and a call stops being
     * waited for once its lead's activities account for it (for a create, the first answer with
     * rows to a request sent after its replay does) or once the server has answered a request
     * for that lead numbered above that first number, which the revalidation after the reload
     * sends, or the read that follows an answer to an earlier request (see
     * `_awaitsActivityRows`). The server may never show the call (its activity deleted or
     * unarchived meanwhile, or beyond a bounded page): the card then shows the lead as the
     * server has it. The applied activities and the answered reads resume the reload
     * (`_releaseActivityRowWaiters`), and so does the copy being dropped.
     *
     * A root the view replaced while the reload ran (a new search, for instance) is reconciled in
     * turn, by a reload of the same kind. Reloads never overlap: the framework model's mutex
     * serializes list loads. While one is in flight, `reconciliation` holds its generation, so a
     * window it still covers issues no second reload. Whatever answered it, the groups a landed
     * reload produced are recorded (`reconciledGroups`), so that landing never counts as a load
     * that makes the data shown staler than at a connection loss (see
     * `_setupSyncReconciliation`).
     *
     * @private
     * @param {boolean} [recovery=false] whether a reconnection owed the reload
     * @returns {Promise<void>}
     */
    async _reconcile(recovery = false) {
        const list = this.props.list;
        if (!this.isMobilePipeline) {
            return;
        }
        const generation = this.syncGeneration;
        const reconciliation = { generation, lost: false, recovery };
        this.reconciliation = reconciliation;
        // every activity request numbered above this one is sent after the reload began
        const since = this._activityReadSequence;
        try {
            await list.load();
            // The reload carries no activity: the copy also keeps the rows of the activity calls
            // replayed during the window until the displayed leads' activities show them, or
            // until the server has answered a request for their leads sent since the reload
            // began.
            if (this._awaitsActivityRows(since)) {
                await new Promise((resolve) => this._activityRowWaiters.push({ since, resolve }));
            }
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return;
            }
            throw error;
        } finally {
            if (this.reconciliation === reconciliation) {
                this.reconciliation = null;
            }
        }
        // The root now holds loaded data (server or disk cache), whatever happens next.
        this.reconciledGroups = list.groups;
        if (recovery) {
            this.recoveryGroups = list.groups;
        }
        if (list.model.useSampleModel) {
            list.model.useSampleModel = false;
        }
        if (
            status(this) === "destroyed" ||
            generation !== this.syncGeneration ||
            reconciliation.lost ||
            this.crmOffline.isOffline()
        ) {
            return;
        }
        if (this.props.list !== list) {
            return this._reconcile(recovery);
        }
        if (this.isMobilePipeline) {
            this.mobileState.syncEntries = null;
        }
    }

    /**
     * Reloads the pipeline through the framework model for a lead created online that no live
     * group received (see `onQuickCreated`). A lost connection leaves the pipeline as it is (the
     * lead exists on the server, and the next load shows it) and rejects with a
     * `ConnectionLostError`, so the quick create tells the user the lead was saved:
     * - the reload itself lost the connection;
     * - offline, the disk cache answered it with data from before the lead.
     * A pipeline destroyed or outside the stage pipeline once the reload ends shows no lead to
     * miss: it returns quietly.
     *
     * @private
     * @param {() => boolean} isLoaded whether a group of the pipeline holds the created lead
     * @returns {Promise<void>}
     */
    async _reloadAfterQuickCreate(isLoaded) {
        try {
            await this.props.list.load();
        } catch (error) {
            if (
                error instanceof ConnectionLostError &&
                (status(this) === "destroyed" || !this.isMobilePipeline)
            ) {
                return;
            }
            throw error;
        }
        if (
            status(this) !== "destroyed" &&
            this.isMobilePipeline &&
            this.crmOffline.isOffline() &&
            !isLoaded()
        ) {
            throw new ConnectionLostError();
        }
    }

    /**
     * Status-region announcements of the queued lead creates.
     *
     * A queued `crm.lead` create (`web_save` without id) is shown as a pending card, created when
     * its entry appears, so no card can announce that. The card leaves with its entry or, after a
     * replay, at the reconciliation reload, and its own status region stays silent throughout,
     * also while the sync window keeps it on screen (see `CrmMobileLeadCard._readSyncSnapshot`).
     * The pipeline compares the creates of the live queue by queue key and announces each one that
     * appeared ("new lead pending sync") or left ("new lead no longer pending sync", after a replay
     * or a systray discard), whatever stage it targets. The live queue is read, never the
     * sync-window copy, so a replay is announced as it happens, before the reconciliation reload;
     * the key survives the framework re-reading the queue from its storage, and a parked replay
     * keeps its key, hence stays pending.
     *
     * The first comparison in the mobile pipeline is the baseline: the queue at mount, and again
     * after a remount (form → back), is never announced. Outside the gate the queue is not read
     * (desktop reads nothing here), and entering the gate again takes a new baseline.
     *
     * @private
     */
    _setupPendingCreateAnnouncements() {
        // the creates read at the previous run, serialized so that an unchanged queue compares
        // equal; `null` before the first run, which never equals a snapshot, so the first run
        // always reaches the comparison
        let previousSnapshot = null;
        useEffect(() => {
            const snapshot = JSON.stringify(this._readPendingLeadCreates());
            if (snapshot === previousSnapshot) {
                return;
            }
            previousSnapshot = snapshot;
            // the comparison writes the status region and reads its sequence: never tracked
            untrack(() => this._announcePendingLeadCreates(JSON.parse(snapshot)));
        });
    }

    /**
     * @private
     * @returns {Array<[string, string]> | null} `[key, name]` of every `crm.lead` create of the
     *   live queue, sorted by key; `null` outside the mobile pipeline
     */
    _readPendingLeadCreates() {
        if (!this.isMobilePipeline) {
            return null;
        }
        return this.crmOffline
            .queuedEntries()
            .filter(
                ({ value }) =>
                    value?.model === "crm.lead" &&
                    value.method === "web_save" &&
                    Array.isArray(value.args?.[0]) &&
                    value.args[0].length === 0
            )
            .map(({ key, value }) => [String(key), leadName(value.args[1]?.name)])
            .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
    }

    /**
     * Announces, in one message, the queued lead creates that appeared and those that left since
     * the last comparison. The first comparison in the mobile pipeline only becomes the baseline,
     * and leaving the gate drops it.
     *
     * @private
     * @param {Array<[string, string]> | null} creates see `_readPendingLeadCreates`
     */
    _announcePendingLeadCreates(creates) {
        const previous = this._pendingCreatesBaseline;
        this._pendingCreatesBaseline = creates;
        if (!previous || !creates) {
            return;
        }
        const previousKeys = new Set(previous.map(([key]) => key));
        const keys = new Set(creates.map(([key]) => key));
        this._announce([
            ...creates
                .filter(([key]) => !previousKeys.has(key))
                .map(([, lead]) => _t("%(lead)s: new lead pending sync.", { lead })),
            ...previous
                .filter(([key]) => !keys.has(key))
                .map(([, lead]) => _t("%(lead)s: new lead no longer pending sync.", { lead })),
        ]);
    }

    /**
     * Shows sentences in the status region as one message, in a new node, so it is announced even
     * when equal to the previous one. Nothing without a sentence, or once destroyed.
     *
     * @private
     * @param {string[]} sentences
     */
    _announce(sentences) {
        if (!sentences.length || status(this) === "destroyed") {
            return;
        }
        this.mobileState.announcement = {
            message: sentences.join(" "),
            sequence: this.mobileState.announcement.sequence + 1,
        };
    }

    /**
     * Reads a lead's activities through the disk cache, with their total count; the first value
     * and any changed refresh are both applied. The request is the loader's default bounded one,
     * or the expanded one an online "Show all" chose for this lead. A value of a request whose
     * limit is no longer the lead's (a bounded read still in flight when "Show all" expanded it)
     * is dropped, so it never replaces the expanded page. The request is issued before the first
     * `await`, so a recovery revalidation run can mark it (see `_issueRecoveryReads`).
     *
     * Each read is numbered by the request that answers it (`_activityReadSequence`): a read
     * that sends its own request takes the next number, and a read the cache joins to the
     * identical request in flight takes that request's (`_activityRequestNumbers`), so the
     * number tells when the answer's request was sent. The framework network layer announces a
     * request on `rpcBus` (`RPC:REQUEST`) while the loader is called, before the loader returns,
     * which tells the two apart. While a sync-window copy is held, every server answer to a read
     * of the lead's current request, changed or not, records its number for the lead
     * (`_settledActivityReads`) and for the request (`_activityAnswerNumbers`), numbers the rows
     * shown (`activityAnswersByLead`: a changed answer's rows as they are applied, an unchanged
     * answer's as they are), and is handled by `_onActivityReadSettled`, all in the turn the
     * answer's rows are applied. An answer that comes before the promise delivers its value
     * (nothing was cached) is recorded and handled once that value is applied, so the rows it
     * brings are shown before the reload drops the copy, and a card never drops a replayed
     * create's row before the rows that account for it are shown. A cached value the promise
     * delivers first is numbered by the last answer to the request (`0` when none came during
     * the window), whose rows the framework cache holds. A request the server rejects answers no
     * read, the cache tells none of them, and the rows stay as they are: the server's error is
     * its answer to that request, recorded for the lead and handled the same way
     * (`_watchActivityRequestError`), so a reload never waits for a request that will not
     * answer; it numbers no rows.
     *
     * @private
     * @param {number} resId
     * @returns {Promise<{ records: Object[], length: number } | null>} the value read, `null` when
     *   the connection is lost and nothing is cached
     */
    async _loadLeadActivities(resId) {
        const limit = this.mobileState.activityLimitsByLead[resId];
        const requestKey = `${resId}:${limit ?? ""}`;
        // the number of the request that answers this read, set once the loader is called
        let read = 0;
        // whether the promise's value was applied, and whether the server answered before
        let delivered = false;
        let answeredEarly = false;
        /**
         * @param {{ records: Object[], length: number } | null} result
         * @param {number} answer the number of the server answer `result` is, `0` if unknown
         */
        const apply = (result, answer) => {
            if (this.mobileState.activityLimitsByLead[resId] === limit) {
                this._applyActivities(resId, result, answer);
            }
        };
        // Records the server's answer to request `read` (its rows are applied, or unchanged) and
        // handles it, while a copy is held and the request is still the lead's.
        const record = () => {
            if (
                !this.mobileState.syncEntries ||
                this.mobileState.activityLimitsByLead[resId] !== limit
            ) {
                return;
            }
            if ((this._settledActivityReads.get(resId) ?? 0) < read) {
                this._settledActivityReads.set(resId, read);
            }
            if ((this._activityAnswerNumbers.get(requestKey) ?? 0) < read) {
                this._activityAnswerNumbers.set(requestKey, read);
            }
            // An unchanged answer applies nothing: the rows shown are its own, so they take its
            // number in this same turn, as a changed answer's rows did (`apply` just before).
            const { activitiesByLead, activityAnswersByLead } = this.mobileState;
            if (
                Array.isArray(activitiesByLead[resId]) &&
                (activityAnswersByLead[resId] ?? 0) < read
            ) {
                activityAnswersByLead[resId] = read;
            }
            this._onActivityReadSettled(resId, read, requestKey);
        };
        const settle = () => {
            if (delivered) {
                record();
            } else {
                // nothing was cached: the promise delivers this answer next, and the answer is
                // recorded with the rows it brings, never before them
                answeredEarly = true;
            }
        };
        // a changed answer: the server's rows of request `read`, applied before `settle` runs
        const onUpdate = (fresh) => apply(fresh, read);
        // the request the loader sent, `null` when the cache joined the read to one in flight
        let sent = null;
        const onRequest = ({ detail }) => {
            const params = detail?.data?.params;
            if (params?.model === "mail.activity" && params.method === "web_search_read") {
                sent = detail.data;
            }
        };
        rpcBus.addEventListener("RPC:REQUEST", onRequest);
        let loading;
        try {
            loading = loadLeadActivities(this.crmOffline.orm, resId, onUpdate, {
                withLength: true,
                onSettled: settle,
                ...(limit ? { limit } : {}),
            });
        } finally {
            rpcBus.removeEventListener("RPC:REQUEST", onRequest);
        }
        if (sent) {
            read = ++this._activityReadSequence;
            this._activityRequestNumbers.set(requestKey, read);
            this._watchActivityRequestError(sent, resId, read, requestKey, limit);
        } else {
            read = this._activityRequestNumbers.get(requestKey) ?? 0;
        }
        const activities = await loading;
        delivered = true;
        if (answeredEarly) {
            // the server's answer itself, recorded in the turn its rows are applied
            apply(activities, read);
            record();
        } else {
            // the cached value, which the framework cache keeps from the last answer to this
            // request: the rows of that answer, numbered when it came during the window
            apply(activities, this._activityAnswerNumbers.get(requestKey) ?? 0);
        }
        return activities;
    }

    /**
     * Follows the answer to an activity request a read sent (see `_loadLeadActivities`): when
     * the server rejects it while a sync-window copy is held and the request is still the
     * lead's, the error is recorded as that request's answer (`_settledActivityReads`) and
     * handled by `_onActivityReadSettled`. A lost or aborted connection is no answer: it records
     * nothing, and the next connection reads again. The listener leaves with the request's
     * answer, which the framework network layer announces once for every request.
     *
     * @private
     * @param {Object} request the request's data, as `rpcBus` announced it
     * @param {number} resId
     * @param {number} read the request's number
     * @param {string} requestKey the lead's request (lead id and limit)
     * @param {number | undefined} limit the lead's limit when the request was sent
     */
    _watchActivityRequestError(request, resId, read, requestKey, limit) {
        const onResponse = ({ detail }) => {
            if (detail?.data !== request) {
                return;
            }
            rpcBus.removeEventListener("RPC:RESPONSE", onResponse);
            if (
                !(detail.error instanceof RPCError) ||
                status(this) === "destroyed" ||
                !this.mobileState.syncEntries ||
                this.mobileState.activityLimitsByLead[resId] !== limit
            ) {
                return;
            }
            if ((this._settledActivityReads.get(resId) ?? 0) < read) {
                this._settledActivityReads.set(resId, read);
            }
            this._onActivityReadSettled(resId, read, requestKey);
        };
        rpcBus.addEventListener("RPC:RESPONSE", onResponse);
    }

    /**
     * The server answered a request for a lead's activities, numbered `read` (see
     * `_loadLeadActivities`), while a sync-window copy is held: resumes the reconciliation
     * reloads it no longer keeps waiting (`_releaseActivityRowWaiters`). A reload still waiting
     * for the lead whose bound this answer's request predates (sent before that reload began, it
     * may predate the replays) gets the lead read again, once, unless a request sent since that
     * reload began is in flight. The read goes in the next task, once the cache has let go of the
     * answered request, so it sends a request of its own, whose answer ends that wait (see
     * `_awaitsActivityRows`); the answers to the reads joined to that request schedule no other
     * (`_scheduledActivityReads`), and a read no longer needed by then is not sent.
     *
     * @private
     * @param {number} resId
     * @param {number} read the number of the request that answered
     * @param {string} requestKey the lead's request (lead id and limit)
     */
    _onActivityReadSettled(resId, read, requestKey) {
        this._releaseActivityRowWaiters();
        // whether a reload still waits for the lead with no request sent since it began
        const readAgain = () => {
            const lastSent = this._activityRequestNumbers.get(requestKey) ?? 0;
            return this._activityRowWaiters.some(
                ({ since }) =>
                    read <= since && lastSent <= since && this._awaitsActivityRows(since, resId)
            );
        };
        if (this._scheduledActivityReads.has(resId) || !readAgain()) {
            return;
        }
        this._scheduledActivityReads.add(resId);
        setTimeout(() => {
            this._scheduledActivityReads.delete(resId);
            if (readAgain()) {
                this.onActivitiesChanged(resId);
            }
        });
    }

    /**
     * Reads the creatable activity types through the disk cache; the first value and any changed
     * refresh are both applied. The request is issued before the first `await`, so a recovery
     * revalidation run can mark it (see `_issueRecoveryReads`).
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
     * Stores a lead's activities and their total count, and resumes a reconciliation reload that
     * waited for them (see `_reconcile`). A result arriving after the gate turned false, after the
     * pipeline was destroyed, or for a lead no group of the pipeline holds any more (another
     * filter or a reload replaced it), is dropped; `null` (connection lost, nothing cached) keeps
     * what is displayed. The confirmed writes the result reflects are forgotten
     * (`_forgetReadActivityWrites`). While a sync-window copy is held, the number of the server
     * answer the result is goes with it, in the same turn (`activityAnswersByLead`).
     *
     * @private
     * @param {number} resId
     * @param {Object[] | { records: Object[], length: number } | null} result
     * @param {number} [answer=0] the number of the activity request whose server answer
     *   `result` is, `0` when unknown (a value cached before the sync window)
     */
    _applyActivities(resId, result, answer = 0) {
        if (status(this) === "destroyed" || !this.isMobilePipeline) {
            return;
        }
        if (!this.allLoadedRecords().some((record) => record.resId === resId)) {
            return;
        }
        const records = this._normalizeRecords(result);
        if (records) {
            const total = this._normalizeLength(result, records);
            this._forgetReadActivityWrites(resId, records, total);
            this.mobileState.activitiesByLead[resId] = records;
            this.mobileState.activityTotalsByLead[resId] = total;
            if (this.mobileState.syncEntries) {
                this.mobileState.activityAnswersByLead[resId] = answer;
            }
            this._releaseActivityRowWaiters();
        }
    }

    /**
     * Forgets the confirmed activity writes of a lead (`activityWritesByLead`) that a read about
     * to be stored reflects, before its page and total replace the stored ones.
     *
     * A read (or the cache entry that answers it) holds every write the server confirmed before
     * it was issued, and maybe some confirmed while it was in flight: it reflects the first `k`
     * writes of the lead, in their order, for some `k`. The writes are therefore judged
     * together, never one by one:
     * - the rows prove the writes up to the last one they show reflected: an activity created
     *   that the read lists, or one the stored page held, marked done, that the read no longer
     *   lists although its page would (`withinPage`);
     * - `k` is the largest count, from there, that both the rows allow (`reflects`: each activity
     *   the writes touch is listed exactly when it exists after them and the page would list it)
     *   and the total confirms (the stored total plus the deltas of those writes is the total
     *   read);
     * - with no such count (activities changed elsewhere meanwhile), or before any total was
     *   stored, the writes the rows prove reflected.
     * The others stay, in order. So a read the cache answered with the page from before the
     * writes keeps them all, a fresh read after them forgets them all, and a read issued between
     * two writes forgets only the first, whether its bounded page shows them or not.
     *
     * @private
     * @param {number} resId
     * @param {Object[]} records the activities read
     * @param {number} total the total count read with them
     */
    _forgetReadActivityWrites(resId, records, total) {
        const writes = this.mobileState.activityWritesByLead[resId];
        if (!writes) {
            return;
        }
        const readIds = new Set(records.map((activity) => activity.id));
        const lastRead = records.at(-1);
        // Whether the read would list an existing activity of that row: its page holds them all,
        // or the row sorts before the last one it lists. An activity marked done whose row the
        // card did not show (`undefined`) counts as within the page.
        const withinPage = (row) =>
            !row ||
            records.length >= total ||
            (lastRead !== undefined && compareLeadActivities(row, lastRead) < 0);
        // Each activity the writes touch: the index of the write that created it (-1: one the
        // stored page held), of the write that marked it done (-1: none), and its row.
        const touched = new Map();
        writes.forEach((write, index) => {
            const id = write.created ? write.created.id : write.doneId;
            const activity = touched.get(id) ?? { createdAt: -1, doneAt: -1, row: undefined };
            if (write.created) {
                activity.createdAt = index;
                activity.row = write.created;
            } else {
                activity.doneAt = index;
                activity.row ??= write.row;
            }
            touched.set(id, activity);
        });
        // whether the rows read are those of the first `count` writes
        const reflects = (count) =>
            [...touched].every(([id, { createdAt, doneAt, row }]) => {
                const exists = createdAt < count && !(doneAt >= 0 && doneAt < count);
                return readIds.has(id) ? exists : !exists || !withinPage(row);
            });
        let proven = 0;
        for (const [id, { createdAt, doneAt, row }] of touched) {
            if (readIds.has(id) && createdAt >= 0) {
                proven = Math.max(proven, createdAt + 1);
            } else if (!readIds.has(id) && createdAt < 0 && withinPage(row)) {
                proven = Math.max(proven, doneAt + 1);
            }
        }
        let count = proven;
        const storedTotal = this.mobileState.activityTotalsByLead[resId] ?? null;
        if (storedTotal !== null) {
            // `totals[n]`: the total once the first `n` writes are reflected
            const totals = [storedTotal];
            for (const write of writes) {
                totals.push(totals.at(-1) + write.delta);
            }
            for (let candidate = writes.length; candidate >= proven; candidate--) {
                if (totals[candidate] === total && reflects(candidate)) {
                    count = candidate;
                    break;
                }
            }
        }
        if (!count) {
            return;
        }
        if (count < writes.length) {
            this.mobileState.activityWritesByLead[resId] = writes.slice(count);
        } else {
            delete this.mobileState.activityWritesByLead[resId];
        }
    }

    /**
     * Records an activity write a card made online and the server confirmed, after the lead's
     * earlier ones, so the card shows it at once, whatever the re-read that follows answers (see
     * `activityWritesByLead`). Only for a lead a group of the pipeline holds: the write is
     * forgotten with its lead.
     * - `created`: the activity created; the same activity is recorded once.
     * - `doneId`: the activity marked done, with the row the card shows for it, which tells
     *   whether a bounded read would list it (`_forgetReadActivityWrites`). Marking done again an
     *   activity already marked done changes nothing on the server, so it is recorded once. An
     *   activity created by an earlier write keeps both writes: it is no longer shown, and their
     *   deltas cancel out.
     *
     * @private
     * @param {number} resId
     * @param {{ created?: Object, doneId?: number } | undefined} write
     */
    _recordActivityWrite(resId, write) {
        if (!write || !this.allLoadedRecords().some((record) => record.resId === resId)) {
            return;
        }
        const writes = this.mobileState.activityWritesByLead[resId] ?? [];
        let recorded;
        if (write.created?.id) {
            if (writes.some((entry) => entry.created?.id === write.created.id)) {
                return;
            }
            recorded = { created: write.created, delta: 1 };
        } else if (write.doneId) {
            if (writes.some((entry) => entry.doneId === write.doneId)) {
                return;
            }
            const row = this.activitiesFor(resId)?.find((activity) => activity.id === write.doneId);
            recorded = { doneId: write.doneId, row, delta: -1 };
        } else {
            return;
        }
        this.mobileState.activityWritesByLead[resId] = [...writes, recorded];
    }

    /**
     * The lead's activities a card shows, in the loader's order (deadline, then id): the stored
     * page less the activities marked done, plus the activities created and not marked done,
     * by the writes no read reflected yet (see `activityWritesByLead`). The stored page itself
     * when there is no such write.
     *
     * @param {number} resId
     * @returns {Object[] | null} `null` when nothing was read and nothing was created
     */
    activitiesFor(resId) {
        const overlay = this._activityOverlay(resId);
        return overlay ? overlay.rows : this.mobileState.activitiesByLead[resId] ?? null;
    }

    /**
     * The lead's total count of activities a card shows: the stored total plus the deltas of the
     * writes no read reflected yet (one per activity created, minus one per activity marked
     * done), never below 0.
     *
     * @param {number} resId
     * @returns {number | null} `null` while no total was read
     */
    activityTotalFor(resId) {
        const overlay = this._activityOverlay(resId);
        return overlay ? overlay.total : this.mobileState.activityTotalsByLead[resId] ?? null;
    }

    /**
     * @private
     * @param {number} resId
     * @returns {{ rows: Object[] | null, total: number | null } | null} the activities and total
     *   shown with the lead's confirmed writes applied, `null` when it has none
     */
    _activityOverlay(resId) {
        const writes = this.mobileState.activityWritesByLead[resId];
        if (!writes) {
            return null;
        }
        const stored = this.mobileState.activitiesByLead[resId] ?? null;
        const storedTotal = this.mobileState.activityTotalsByLead[resId] ?? null;
        const memo = this._activityOverlays.get(writes);
        if (memo && memo.stored === stored && memo.storedTotal === storedTotal) {
            return memo;
        }
        const storedIds = new Set((stored ?? []).map((activity) => activity.id));
        const doneIds = new Set(
            writes.filter((write) => !write.created).map((write) => write.doneId)
        );
        const added = writes
            .map((write) => write.created)
            .filter((row) => row && !storedIds.has(row.id) && !doneIds.has(row.id));
        const kept = (stored ?? []).filter((activity) => !doneIds.has(activity.id));
        const rows =
            stored || added.length ? [...kept, ...added].sort(compareLeadActivities) : null;
        const delta = writes.reduce((sum, write) => sum + write.delta, 0);
        const total = storedTotal === null ? null : Math.max(0, storedTotal + delta);
        const overlay = { stored, storedTotal, rows, total };
        this._activityOverlays.set(writes, overlay);
        return overlay;
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
     *   card's open control, else a header control (see `_focusAfterHelper`), instead of
     *   dropping to the document body. A later reload, such as the reconciliation reload after
     *   reconnecting, keeps that card (its key is made of the stage and lead ids, which a reload
     *   keeps), so the focus stays on it, as on any focused card control.
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
     * Focuses, once the unavailable-lead helper is left, the open control of the tapped lead's
     * card, its first control, when the displayed stage shows it (the card itself has no
     * tabindex), else the first header control (previous, next, Add), else the first control of
     * the pipeline. Nothing is focused outside the mobile pipeline.
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
            cardEl?.querySelector(".o_crm_mobile_lead_card_open") ||
            (cardEl && getTabableElements(cardEl)[0]) ||
            (headerEl && getTabableElements(headerEl)[0]) ||
            getTabableElements(root)[0];
        target?.focus();
    }

    /**
     * Focus of the stage navigation. The previous button is not rendered on the first stage, nor
     * the next button on the last one, so displaying that stage removes the button when it holds
     * the focus (Next activated to reach the last stage, Previous to reach the first one). The
     * button of the empty-stage hint (`emptyStageHint`) leaves with the stage it was shown in, so
     * activating it removes it as well. After the patch that removes it, the focus moves to the
     * first header control, which is then the remaining navigation button, else Add, else the
     * first control of the pipeline, instead of dropping to the document body.
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
                active?.matches(
                    ".o_crm_mobile_pipeline_prev, .o_crm_mobile_pipeline_next, .o_crm_mobile_pipeline_empty_stage_target"
                ) && this.rootRef()?.contains(active)
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

    /**
     * Focus as the quick-create sheet closes, whatever closes it: a save (created or queued),
     * Discard, or a dismissal (Escape, the backdrop, the handle, a swipe). The sheet reports its
     * closing before it is removed, so a focus inside it, or one already fallen to the document
     * body (Save is disabled while it saves), moves at once to Add, else to the first header
     * control, else to the first control of the pipeline, instead of dropping to the body with the
     * sheet. A focus the user or the framework put on any other control is left where it is.
     * Nothing is focused outside the mobile pipeline, nor once the pipeline is unmounting.
     *
     * @private
     */
    _focusAfterQuickCreate() {
        const root = this.rootRef();
        if (this._isUnmounting || status(this) !== "mounted" || !root || !this.isMobilePipeline) {
            return;
        }
        const doc = root.ownerDocument;
        const active = doc.activeElement;
        const sheetEl = this.quickCreateSheetRef()?.closest(".o_bottom_sheet");
        if (active && active !== doc.body && !sheetEl?.contains(active)) {
            return;
        }
        const headerEl = root.querySelector(".o_crm_mobile_pipeline_header");
        const headerControls = headerEl ? getTabableElements(headerEl) : [];
        const target =
            headerControls.find((el) => el.matches(".o_crm_mobile_pipeline_add")) ??
            headerControls[0] ??
            getTabableElements(root)[0];
        target?.focus();
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /**
     * Displays a stage. Online, a folded stage is loaded and unfolded through the inherited
     * `toggleGroup`, once (see `unfoldStage`): entering it again while that load is in flight
     * awaits the same load. Offline, a folded stage is never loaded (no uncached read is
     * attempted) and its fold state is left alone: it is sent with the next `web_read_group`, so
     * changing it would change the cached request and break the next offline reload.
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
                await unfoldStage(this.stageState, group, (folded) => this.toggleGroup(folded));
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
            }
        }
    }

    /**
     * Whether the Load more of a stage is in flight, or a load that unfolds the stage, whichever
     * control started it (see `unfoldStage`): its button is then disabled and busy.
     *
     * @param {Group} group
     * @returns {boolean}
     */
    isLoadingMore(group) {
        return Boolean(
            group &&
                (this.loadingMoreGroups[group.id] || this.stageState.unfolding.has(group.config))
        );
    }

    /**
     * Load more, online only, as the template renders it: a folded stage is loaded and unfolded
     * through the inherited `toggleGroup` (see `unfoldStage`), any other stage gets its next page
     * through the inherited `loadMore`. The stage is marked as loading until the load settles, so
     * its button shows a spinner, is busy and disabled meanwhile, and a second activation loads
     * nothing; so does an activation while a load that unfolds the stage is in flight. Offline
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
                await unfoldStage(this.stageState, group, (folded) => this.toggleGroup(folded));
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
     * stage body shows the offline action helper with a Back button, which takes the focus (the
     * card's focused open control is no longer rendered; see `_setupHelperFocus`).
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
     * Leaves the offline helper of an unavailable lead. As Back disappears with the helper, the
     * focus returns to the open control of that lead's card when the displayed stage renders it,
     * else to a header control (see `_focusAfterHelper`).
     */
    onBackFromHelper() {
        const resId = this.mobileState.unavailableLeadId;
        this.helperFocus = resId ? { resId, focus: "return" } : null;
        this.mobileState.unavailableLeadId = null;
    }

    /**
     * Keeps the native Space activation of every control of the mobile pipeline (header
     * navigation and Add, the offline helpers and Back, the empty-stage hint, Load more, the
     * framework quick create): the inherited kanban Space hotkeys, scoped to this root, would
     * cancel it. Bound on the mobile root only, so the desktop kanban keeps its Space record
     * selection.
     *
     * @param {KeyboardEvent} ev
     */
    onPipelineKeydown(ev) {
        stopKanbanSpaceHotkey(ev);
    }

    /**
     * Moves the focus requested by `onCardMove` (see `pendingFocus`) once the pipeline is patched
     * after the move: the Stage button of the lead's card, looked up in the displayed stage. Only
     * in the mobile pipeline; a request whose element is not rendered (another stage displayed, a
     * reload that dropped the card) is dropped, and the focus stays where it is.
     *
     * @private
     */
    _applyPendingFocus() {
        const request = this.pendingFocus;
        if (!request) {
            return;
        }
        this.pendingFocus = null;
        const root = this.rootRef();
        if (!root || !this.isMobilePipeline) {
            return;
        }
        const record = this.cardsFor(this.currentGroup).find(
            (candidate) => candidate.resId === request.leadId
        );
        const cards = [...root.querySelectorAll(".o_crm_mobile_lead_card")];
        const card = record && cards.find((el) => el.dataset.id === record.id);
        card?.querySelector(".o_crm_mobile_card_stage")?.focus();
    }

    /**
     * Moves a card to a stage through the framework kanban move, which the CRM model extends
     * (rainbowman online only, and cards held by a folded stage stay movable) and which queues the
     * stage write offline. Choosing the won stage is mark-won.
     *
     * A connection loss raised by the framework's reload of a truncated source group, after the
     * save was queued, leaves the queued save and the in-memory move in place. When the framework
     * did make the move, the target stage becomes the displayed one, so the moved card and its
     * pending badge are visible at once: from the framework's in-memory move on, while its save
     * is still running (the move is held in flight, see `currentGroup`), and as the stored stage
     * once the move returns. A move it did not make changes nothing, and a move it undid (an
     * online save rejected, a record refused) displays the source stage again.
     *
     * The moved card is a new card in the target stage, which takes its badge as its mount state
     * and announces nothing. So when the framework made the move and it left a lead that was not
     * pending sync with a queued write (offline, mark-won included, or a connection that dropped
     * during the save), the pipeline's status region announces it. An online move leaves nothing
     * queued, and the live stage title already announces the new stage.
     *
     * When the focus was in the record's card as the move started (the stage was chosen from its
     * stage list with the keyboard, or with a tap that focused the option), it goes to that
     * card's Stage button once the move is over: in the target stage when the framework made the
     * move, in the displayed stage otherwise. The chosen option is no longer rendered, so the
     * focus would otherwise fall to the page. A focus elsewhere is left where it is.
     *
     * @param {RelationalRecord} record
     * @param {Group} targetGroup
     * @returns {Promise<void>}
     */
    async onCardMove(record, targetGroup) {
        if (!record || !targetGroup || record.group === targetGroup) {
            return;
        }
        // Read before the move re-renders the cards, while the chosen option still has the focus.
        const root = this.rootRef();
        const focusedCard = root?.ownerDocument.activeElement?.closest(".o_crm_mobile_lead_card");
        const keepCardFocus = Boolean(
            focusedCard && root.contains(focusedCard) && focusedCard.dataset.id === record.id
        );
        const wasPendingSync = this.crmOffline.isRecordPendingSync(record);
        // In flight until the framework move returns: once the framework has moved the card in
        // memory, the target stage is displayed with it (see `currentGroup`).
        const move = { record, targetGroup };
        this._cardMoves.set([...this._cardMoves(), move]);
        try {
            await this.props.list.moveRecords([record.id], null, targetGroup.id);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        } finally {
            this._cardMoves.set(this._cardMoves().filter((candidate) => candidate !== move));
        }
        if (status(this) === "destroyed") {
            return;
        }
        const moved = record.group === targetGroup;
        if (moved) {
            this.stageState.serverValue = targetGroup.serverValue;
            if (!wasPendingSync && this.crmOffline.isRecordPendingSync(record)) {
                const lead = leadName(record.data.name);
                this._announce([_t("%(lead)s: changes pending sync.", { lead })]);
            }
        }
        if (keepCardFocus) {
            // The end of the move in flight renders the pipeline again (every render reads the
            // moves in flight, see `currentGroup`), so the focus moves once the stage body is
            // patched, onto the card wherever it is displayed by then: in the target stage, or
            // back in its stage after a move the framework undid, whose card the move in flight
            // had displayed in the target stage.
            this.pendingFocus = { leadId: record.resId, control: "stage" };
        }
    }

    /**
     * Opens the mobile quick create in a bottom sheet, on the displayed stage. A lead created
     * online is added to its stage as the framework quick create does; a queued one appears as a
     * pending card as soon as it is queued. A pipeline showing sample data leaves sample mode as
     * the sheet opens, as the framework kanban controller does when its quick create opens: the
     * lead created never shows among sample cards nor counts with them, and a Discard does not
     * bring them back. The sheet focuses its lead name input, and its closing hands the focus back
     * to Add (see `_focusAfterQuickCreate`).
     *
     * @param {MouseEvent} [ev]
     */
    onAddClick(ev) {
        const group = this.currentGroup;
        if (!this.isMobilePipeline || !group || !this.canAdd) {
            return;
        }
        const { model } = this.props.list;
        if (model.useSampleModel) {
            model.removeSampleDataInGroups();
            model.useSampleModel = false;
        }
        this.quickCreatePopover.open(ev?.currentTarget ?? this.rootRef(), {
            list: this.props.list,
            group,
            onCreated: (resId, targetGroup) => this.onQuickCreated(resId, targetGroup),
        });
    }

    /**
     * Adds a lead the mobile quick create made online to its stage, as the framework quick create
     * does (inherited `validateQuickCreate`). The sheet resolves the group when the call returns:
     * the live group of the stage written at that moment, or `undefined` when that stage is no
     * longer listed.
     * - Model work queued before (a reload still loading, such as the reconciliation that follows
     *   a reconnection) lands first: the lead is handled once the model mutex is idle, on the list
     *   as that work left it. The insertion queues on the same mutex, so a reload queued before it
     *   would otherwise rebuild the groups first and leave the lead in a detached group.
     * - Destroyed, or outside the stage pipeline, before or after that wait: nothing to do, the
     *   next load shows the lead.
     * - Already loaded, by a reload that ran after the server created it: nothing is added, so
     *   the card and the count are not doubled.
     * - A group a reload has replaced gives way to the live group of the same stage. When no
     *   group of that stage is listed, or the sheet found none, the list is reloaded instead.
     * - A reload queued after the wait but before the insertion detaches the group the lead was
     *   added to: when that reload did not load the lead either, the list is reloaded once more.
     * Nothing is created again. When the connection is lost before the lead could be shown (the
     * read that adds it, or a reload, see `_reloadAfterQuickCreate`), the pipeline stays as it is
     * and the promise rejects with that `ConnectionLostError`: the quick create then tells the
     * user the lead was saved. Every other failure rejects as it is.
     *
     * @param {number} resId the created lead
     * @param {Group | undefined} group the live group of the lead's stage when the call returned
     * @returns {Promise<void>}
     */
    async onQuickCreated(resId, group) {
        if (status(this) === "destroyed" || !this.isMobilePipeline) {
            return;
        }
        await this.props.list.model.mutex.getUnlockedDef();
        const isLoaded = () => this.allLoadedRecords().some((record) => record.resId === resId);
        if (status(this) === "destroyed" || !this.isMobilePipeline || isLoaded()) {
            return;
        }
        const groups = this.props.list.groups;
        const liveGroup =
            group &&
            (groups.includes(group)
                ? group
                : groups.find((candidate) => candidate.serverValue === group.serverValue));
        if (!liveGroup) {
            await this._reloadAfterQuickCreate(isLoaded);
            return;
        }
        await this.validateQuickCreate(resId, "close", liveGroup);
        if (
            status(this) !== "destroyed" &&
            this.isMobilePipeline &&
            !this.props.list.groups.includes(liveGroup) &&
            !isLoaded()
        ) {
            await this._reloadAfterQuickCreate(isLoaded);
        }
    }

    /**
     * Called by a card after an online activity create or mark-done, for a replayed one by the
     * sync window (see `_onActivityCallReplayed`), and for a lead a reconciliation reload still
     * waits for after an answer older than that reload (see `_onActivityReadSettled`), while this
     * pipeline is alive and shows the stage pipeline:
     * - the write the server confirmed, when the card gives it, is shown at once on every card
     *   of a lead a group holds (`_recordActivityWrite`), until a read reflects it, so a re-read
     *   that loses the connection, or that the cache answers with the rows from before it, never
     *   hides it;
     * - the lead's activities are read again, with its current request (bounded, or expanded by
     *   "Show all"), only when the displayed stage shows the lead (the same placement the
     *   activity revalidation reads for).
     * A card can call it after it was destroyed (stage navigation, a move, a regroup or a load
     * that no longer shows the lead re-keyed or removed it; a reload that still shows the lead in
     * the stage keeps the card): a lead no longer displayed is not read now, and is read again
     * when a stage displays it.
     *
     * @param {number} resId
     * @param {{ created?: Object, doneId?: number }} [write] the activity created, in the loader's
     *   record shape, or the id of the activity marked done
     * @returns {Promise<{ records: Object[], length: number } | null> | undefined} the read, if any
     */
    onActivitiesChanged(resId, write) {
        if (
            !resId ||
            status(this) === "destroyed" ||
            !this.isMobilePipeline ||
            this.props.list.model.useSampleModel
        ) {
            return;
        }
        this._recordActivityWrite(resId, write);
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
         * The displayed stage (stage id), shared with the renderer through the env, with the loads
         * in flight that unfold a folded stage (see `createStageState`). Seeded from the restored
         * state, where `false` is the group without stage; `null` when none was saved. Only read
         * in the mobile pipeline.
         */
        this.crmMobileStage = createStageState(this.props.state?.crmMobileStage ?? null);
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
     * The root classes: the base ones, with the class the framework derives from this view's
     * `js_class` (`o_crm_mobile_pipeline_view`) replaced in place by the one it derived from the
     * CRM kanban's (`o_crm_kanban_view`), so the root keeps exactly the classes, in the same order,
     * it had as a `crm_kanban` view. As the framework keeps one occurrence of each class, at the
     * `js_class` position, a CRM kanban class the arch also carries is not repeated. Applies at
     * every screen size, as the CRM kanban class did; every other class (the arch's, the action's,
     * the base small-screen scroll delegation) is kept as it is, and a view registered under
     * another name with this controller keeps its classes unchanged.
     *
     * @override
     */
    get className() {
        const className = super.className || "";
        const classList = className.split(" ");
        const index = classList.indexOf("o_crm_mobile_pipeline_view");
        if (index === -1) {
            return className;
        }
        classList[index] = "o_crm_kanban_view";
        return classList
            .filter((cls, position) => cls !== "o_crm_kanban_view" || position === index)
            .join(" ");
    }

    /**
     * New: in the mobile pipeline, the framework quick create opens in the displayed stage instead
     * of the first unfolded one, so it is visible. Everything else is the base behaviour.
     *
     * Online, a folded displayed stage is loaded and unfolded first, once (see `unfoldStage`): a
     * load of that stage already in flight, from the renderer's navigation or Load more, is
     * awaited instead of a second toggle. The view may change while that load runs, so once it
     * lands the quick create opens only if the controller is still alive, the mobile pipeline is
     * still rendered and the displayed stage is still the one New was pressed on; otherwise
     * nothing changes (the stage the user moved to stays displayed). It then opens in that
     * stage's group of the current root, because a reload during the load rebuilds the groups
     * with new datapoint ids.
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
            await unfoldStage(this.crmMobileStage, group, (folded) => folded.toggle());
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
