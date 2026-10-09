/**
 * Shared CRM offline hooks, queue readers, constants and DISABLE enforcement.
 *
 * This module is the single place where production CRM code reads the offline state of the web
 * client. The mobile pipeline, lead card and quick create, `team_switcher.js`,
 * `lead_generation_dropdown.js`, `crm_column_progress.js`, `crm_pls_tooltip_button.js`,
 * `activity_menu_patch.js`, `crm_share_target_item.js`, `crm_form.js` and `crm_kanban_model.js`
 * import it as `@crm/mobile/crm_offline_hooks`; none of them resolves the offline plugin by
 * itself. Tests may inspect the framework plugin and its queue directly. It provides:
 *
 * - `useCrmOffline()`: a component hook exposing the offline signals, the small-screen signal,
 *   readers over the framework's offline queue and `runOrQueue`, the one helper through which new
 *   CRM code schedules a write;
 * - plain helpers for code that holds a framework model or record (`isOfflineModel`,
 *   `targetsCrmLead`) and two bounded, disk-cached loaders for the mobile pipeline
 *   (`loadActivityTypes`, `loadLeadActivities`);
 * - the constants naming the CRM models, buttons, selectors and mail dialog forms the offline
 *   rules apply to;
 * - module-level patches that make the shared DISABLE entry points of the offline inventory
 *   (`static/src/mobile/offline_inventory.md`) inert while offline (view buttons, list and kanban
 *   header buttons, the Actions and Cog menus, saves of mail dialog forms targeting a lead, the
 *   team dashboard card and activity report rows), that render the DISABLE anchors drawn by view
 *   buttons disabled while offline (wherever they are rendered, overlays such as the team card
 *   menu included), that keep the forecast views and the activity report unreachable offline, and
 *   that let phones search cached partners offline.
 *
 * Component-owned DISABLE paths and SKIP probes are guarded in their own files, not patched here.
 * The team switcher, the recurring-revenue probe, lead generation (its Install confirmation
 * callback included), the PLS tooltip button, the activity-menu entry, the share-target team read
 * and the lead-form chatter check the hook's `isOffline()`; the mobile lead card's activity
 * handlers check their own predicates over the cached activity types and the queue readers.
 *
 * Design constraints:
 * - No offline machinery of its own. Reads go through the ORM plugin and the framework RPC disk
 *   cache; writes go only through `OfflinePlugin.scheduleORM` (directly in `runOrQueue`, or through
 *   framework record saves). Replay order, coalescing, parking and the systray stay the
 *   framework's.
 * - New CRM code queues only `web_save` and `action_archive`: the shared offline systray renders
 *   a status for `web_save`, `unlink`/`web_unlink`, `action_archive` and `action_unarchive` only.
 * - Online behaviour never changes. One patch skips its parent online too: the availability
 *   registration (`RelationalModel._setAvailableOffline`) never registers the forecast views or
 *   the activity report, online or offline, while their online loading and rendering stay as
 *   before. Every event-handler and save patch calls `super` with the original arguments unless
 *   the client is offline and the target is a CRM model, a listed CRM button or a mail dialog form
 *   targeting a lead. The only widening patch (`Many2One`, `dropdown: false` in its autocomplete
 *   props) applies offline, on small screens, in `crm.lead` views only.
 */

import { computed, untrack, useEffect, usePlugin } from "@odoo/owl";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { ORM } from "@web/core/orm_plugin";
import { UIPlugin } from "@web/core/ui/ui_plugin";
import { patch } from "@web/core/utils/patch";
import { Record as RelationalRecord } from "@web/model/relational_model/record";
import { RelationalModel } from "@web/model/relational_model/relational_model";
import { useEnv } from "@web/owl2/utils";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { Many2One } from "@web/views/fields/many2one/many2one";
import { KanbanRecord } from "@web/views/kanban/kanban_record";
import { ListController } from "@web/views/list/list_controller";
import { MultiRecordViewButton } from "@web/views/view_button/multi_record_view_button";
import { ViewButton } from "@web/views/view_button/view_button";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Models whose server-backed (`object`/`action`) buttons and Actions-menu actions are DISABLE
 * offline. Every such button that `addons/crm` renders for them is a DISABLE row of the offline
 * inventory; buttons other addons add to these models' views get the same guard, which takes
 * nothing away offline because object and action buttons have no offline path.
 *
 * @type {readonly string[]}
 */
export const CRM_OFFLINE_MODELS = Object.freeze([
    "crm.lead",
    "crm.team",
    "crm.stage",
    "crm.lost.reason",
    "crm.lead.lost",
    "crm.lead.pls.update",
    "crm.lead2opportunity.partner.mass",
    "crm.merge.opportunity",
    "crm.activity.report",
]);

/**
 * `[model, button name]` pairs of the DISABLE buttons that CRM views render on models CRM does not
 * own. Action buttons are matched by xmlid, so the settings "Update Probabilities" button names its
 * action `crm.crm_lead_pls_update_action` rather than by database id.
 *
 * @type {readonly (readonly [string, string])[]}
 */
export const CRM_FOREIGN_DISABLED_BUTTONS = Object.freeze(
    [
        ["res.partner", "action_view_opportunity"],
        ["utm.campaign", "action_redirect_to_leads_opportunities"],
        ["res.config.settings", "action_crm_assign_leads"],
        ["res.config.settings", "crm.crm_recurring_plan_action"],
        ["res.config.settings", "crm.crm_lead_pls_update_action"],
    ].map((pair) => Object.freeze(pair))
);

/**
 * DISABLE controls that are not `<button>` elements, so the framework's offline selector does not
 * dim them: the automated-probability anchors of the lead form, the team dashboard anchors and
 * cards, and the CRM entry of the activity menu. They are appended to
 * `OfflinePlugin.SELECTORS_TO_DISABLE` below. The selectors reach only the elements they describe:
 * the `.o_crm_team_kanban` descendants miss the team dashboard card menu, whose overlay is rendered
 * outside the dashboard, and no selector describes the UTM campaign card's leads/opportunities
 * anchor. The DISABLE anchors drawn by view buttons therefore also get the same disabled state from
 * the `ViewButton` patch, keyed on its click guard's predicate, wherever they are rendered.
 *
 * @type {readonly string[]}
 */
export const CRM_OFFLINE_DISABLED_SELECTORS = Object.freeze([
    'a[type="object"][name="action_set_automated_probability"]',
    ".o_crm_team_kanban a[type]",
    ".o_crm_team_kanban .o_kanban_record",
    '.o-mail-ActivityGroup[data-model_name="crm.lead"]',
]);

/**
 * Mail dialog forms the lead chatter opens, each mapped to the field that names its target model.
 * A form of one of these models targeting `crm.lead` is read-only offline: its footer buttons are
 * inert and its save never enters the offline queue (see `targetsCrmLead`).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CRM_MAIL_FORM_TARGETS = Object.freeze({
    "mail.activity": "res_model",
    "mail.activity.schedule": "res_model",
    "mail.followers.edit": "res_model",
    "mail.compose.message": "model",
});

/** Methods new CRM code may queue: the offline systray renders a status for both. */
const CRM_QUEUEABLE_METHODS = ["web_save", "action_archive"];

/** Queued methods that leave a record with a write the server has not received yet. */
const PENDING_RECORD_METHODS = [
    "web_save",
    "web_unlink",
    "unlink",
    "action_archive",
    "action_unarchive",
];

/** Button types that call the server; `special` buttons (save, discard, cancel) have no type. */
const SERVER_BUTTON_TYPES = ["object", "action"];

/** Static Actions-menu items that call the server (copy and export), by item key. */
const SERVER_STATIC_MENU_ITEMS = ["duplicate", "export"];

/**
 * Activity categories never offered for creation: a meeting needs a calendar round-trip and an
 * upload needs a file transfer, neither of which is possible offline.
 */
const NON_CREATABLE_ACTIVITY_CATEGORIES = ["meeting", "upload_file"];

/** Activities read per lead by default: Odoo's default kanban and x2many page size. */
const LEAD_ACTIVITIES_LIMIT = 40;

/** Activity types read at most: Odoo's default list page size. */
const ACTIVITY_TYPES_LIMIT = 80;

// -----------------------------------------------------------------------------
// Plain helpers
// -----------------------------------------------------------------------------

/**
 * Whether the client is offline, read from a framework model. Meant for non-component code that
 * already holds a `RelationalModel` (e.g. a record or a group list subclass), which cannot call
 * `useCrmOffline()`.
 *
 * @param {RelationalModel | undefined | null} model
 * @returns {boolean}
 */
export function isOfflineModel(model) {
    return Boolean(model?.offlinePlugin?.isOffline());
}

/**
 * Whether a framework record is a mail dialog form (see `CRM_MAIL_FORM_TARGETS`) whose target model
 * is `crm.lead`. The target is the record's own target field when it holds a value; when that field
 * is empty, it is the context's `default_res_model`, and `default_model` (the composer's key) only
 * when `default_res_model` is absent (`null` or `undefined`). An explicit `false` or empty
 * `default_res_model` is the target, so it never falls through to `default_model`.
 *
 * @param {RelationalRecord | undefined | null} record
 * @returns {boolean}
 */
export function targetsCrmLead(record) {
    const resModel = record?.resModel;
    if (!resModel || !Object.hasOwn(CRM_MAIL_FORM_TARGETS, resModel)) {
        return false;
    }
    const targetField = CRM_MAIL_FORM_TARGETS[resModel];
    const target =
        record.data?.[targetField] ||
        (record.context?.default_res_model ?? record.context?.default_model);
    return target === "crm.lead";
}

/**
 * @param {{ records?: Object[] } | undefined} result a `web_search_read` result
 * @returns {Object[]} the activity types that can be created offline
 */
function creatableActivityTypes(result) {
    return (result?.records ?? []).filter(
        (activityType) => !NON_CREATABLE_ACTIVITY_CATEGORIES.includes(activityType.category)
    );
}

/**
 * Reads the activity types usable on leads through the framework disk cache, meeting and upload
 * categories excluded. The request is identical on every call, so it is a stable cache key: the
 * cached list answers offline, and every online call refreshes it.
 *
 * The read is bounded to the first `ACTIVITY_TYPES_LIMIT` (80) types in the model's own order
 * (`sequence ASC, id ASC`, made explicit so the bound is deterministic), so a database with an
 * unusual number of types never buffers, caches and decrypts all of them on every refresh.
 *
 * The promise resolves with the first available value: the cached list when one exists, otherwise
 * the server's. When the server answer later differs from the cached list, `onUpdate` receives
 * the fresh list. Callers re-invoke the loader on each revalidation trigger, because an
 * `update: "always"` cache refreshes only when a read is issued.
 *
 * @param {ORM} orm the ORM of the calling component (`useCrmOffline().orm`)
 * @param {(activityTypes: Object[]) => void} [onUpdate]
 * @returns {Promise<Object[] | null>} `{id, display_name, category}` records, or `null` when the
 *   connection is lost and nothing is cached
 */
export async function loadActivityTypes(orm, onUpdate) {
    try {
        const result = await orm
            .cache({
                type: "disk",
                update: "always",
                callback: (freshResult, hasChanged) => {
                    if (hasChanged) {
                        onUpdate?.(creatableActivityTypes(freshResult));
                    }
                },
            })
            .webSearchRead("mail.activity.type", [["res_model", "in", [false, "crm.lead"]]], {
                specification: { display_name: {}, category: {} },
                order: "sequence ASC, id ASC",
                limit: ACTIVITY_TYPES_LIMIT,
            });
        return creatableActivityTypes(result);
    } catch (error) {
        if (error instanceof ConnectionLostError) {
            return null;
        }
        throw error;
    }
}

/**
 * Reads the activities of one lead through the framework disk cache. There is one request per
 * lead, with a fixed specification, order and limit, so the request is a stable cache key: a
 * lead's activities read online stay available offline whichever stage, filter or page displayed
 * it.
 *
 * The read is bounded: by default it returns the lead's first `LEAD_ACTIVITIES_LIMIT` (40)
 * activities by deadline, so a lead with many activities never buffers, caches and decrypts all
 * of them on every refresh. Nothing is dropped silently: with `withLength`, the result also
 * carries the server's total count of the lead's activities (`web_search_read` counts them all
 * when the limit is reached), so the caller can tell a truncated read (`length > records.length`)
 * and continue it explicitly with a larger `limit`. Such a continuation is a separate request,
 * hence a separate cache entry; the default request, identical on every call, stays the lead's
 * stable key.
 *
 * Resolution and refresh behave as in `loadActivityTypes`: `onUpdate` receives the same shape as
 * the promise.
 *
 * @param {ORM} orm the ORM of the calling component (`useCrmOffline().orm`)
 * @param {number} resId the lead id
 * @param {(activities: Object[] | { records: Object[], length: number }) => void} [onUpdate]
 * @param {Object} [options]
 * @param {number} [options.limit=40] the number of activities to read, a positive integer; any
 *   other value throws before a request is issued
 * @param {boolean} [options.withLength=false] whether the promise and `onUpdate` receive
 *   `{records, length}` (`length` being the server's total count of the lead's activities)
 *   rather than the records alone
 * @returns {Promise<Object[] | { records: Object[], length: number } | null>} the `mail.activity`
 *   records (or `{records, length}` with `withLength`), or `null` when the connection is lost and
 *   nothing is cached
 */
export async function loadLeadActivities(orm, resId, onUpdate, options = {}) {
    const { limit = LEAD_ACTIVITIES_LIMIT, withLength = false } = options ?? {};
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("loadLeadActivities: `limit` must be a positive integer");
    }
    /**
     * @param {{ records?: Object[], length?: number } | undefined} result a `web_search_read`
     *   result
     * @returns {Object[] | { records: Object[], length: number }} the value callers receive
     */
    const toValue = (result) => {
        const records = result?.records ?? [];
        if (!withLength) {
            return records;
        }
        const length = Number.isInteger(result?.length) ? result.length : 0;
        return { records, length: Math.max(length, records.length) };
    };
    try {
        const result = await orm
            .cache({
                type: "disk",
                update: "always",
                callback: (freshResult, hasChanged) => {
                    if (hasChanged) {
                        onUpdate?.(toValue(freshResult));
                    }
                },
            })
            .webSearchRead(
                "mail.activity",
                [
                    ["res_model", "=", "crm.lead"],
                    ["res_id", "=", resId],
                ],
                {
                    specification: {
                        activity_type_id: { fields: { display_name: {} } },
                        activity_category: {},
                        summary: {},
                        date_deadline: {},
                        state: {},
                        user_id: { fields: { display_name: {} } },
                    },
                    order: "date_deadline ASC, id ASC",
                    limit,
                }
            );
        return toValue(result);
    } catch (error) {
        if (error instanceof ConnectionLostError) {
            return null;
        }
        throw error;
    }
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * @typedef {{ model: string, method: string, args: any[], kwargs: Object, extras: Object }} QueuedCall
 * @typedef {{ key: string | number, value: QueuedCall }} QueueEntry an entry of the framework
 *   offline queue, exactly as `OfflinePlugin._ormToSync()` stores it
 */

/** The greatest array index: a property name that is a canonical integer up to it is an index. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * @param {string | number} key a queue key
 * @returns {number | undefined} the array index the key is as a property name, if it is one
 */
function arrayIndexOf(key) {
    const name = String(key);
    const index = Number(name);
    const isIndex =
        Number.isInteger(index) && index >= 0 && index <= MAX_ARRAY_INDEX && String(index) === name;
    return isIndex ? index : undefined;
}

/**
 * Orders two queue entries as `OfflinePlugin._syncORM` replays them. The replay first rebuilds the
 * queue from IndexedDB (`Object.fromEntries` over the stored entries), then stable-sorts
 * `Object.values` of it by `extras.timeStamp`. Entries with equal timestamps therefore replay in
 * the enumeration order of their keys: keys that are array indices first, in ascending numeric
 * order, then the other keys in IndexedDB key order, numbers ascending before strings compared by
 * UTF-16 code unit. Of two tied writes, the one ranked later is applied later and is the one the
 * server keeps. The order of any array holding the entries plays no part.
 *
 * @param {QueueEntry} entryA
 * @param {QueueEntry} entryB
 * @returns {number} negative when `entryA` replays before `entryB`, positive when after, `0` when
 *   both have the same timestamp and key
 */
function compareReplayOrder(entryA, entryB) {
    const timeStampA = entryA.value.extras?.timeStamp ?? 0;
    const timeStampB = entryB.value.extras?.timeStamp ?? 0;
    if (timeStampA !== timeStampB) {
        return timeStampA - timeStampB;
    }
    const { key: keyA } = entryA;
    const { key: keyB } = entryB;
    const indexA = arrayIndexOf(keyA);
    const indexB = arrayIndexOf(keyB);
    if (indexA !== undefined && indexB !== undefined) {
        return indexA - indexB;
    }
    if (indexA !== undefined || indexB !== undefined) {
        return indexA !== undefined ? -1 : 1;
    }
    const isNumberA = typeof keyA === "number";
    const isNumberB = typeof keyB === "number";
    if (isNumberA !== isNumberB) {
        return isNumberA ? -1 : 1;
    }
    if (isNumberA) {
        return keyA - keyB;
    }
    const nameA = String(keyA);
    const nameB = String(keyB);
    if (nameA === nameB) {
        return 0;
    }
    return nameA < nameB ? -1 : 1;
}

/**
 * @typedef {{ latestStageWrites: Map<number, QueueEntry>,
 *   leadCreates: Map<number | false | undefined, QueueEntry[]> }} StageIndex what the stage
 *   readers look up in an array of queue entries: by lead id, the queued `stage_id` write of the
 *   lead that comes last in replay order; by stage id, the queued `crm.lead` creates targeting the
 *   stage, in replay order. It holds the entries themselves.
 */

/**
 * The stage index of every frozen entries array a stage reader was given, held weakly: it lives
 * as long as its array.
 *
 * @type {WeakMap<readonly QueueEntry[], StageIndex>}
 */
const stageIndexes = new WeakMap();

/**
 * Indexes an array of queue entries for the stage readers in one traversal that reads each
 * entry's `value` once. The index answers exactly as the direct scans of `pendingLeadCreates` and
 * `latestStageWrite` do: the same entries, in the same order, stage-write ties resolved by
 * `compareReplayOrder` and the first entry kept on an exact tie. A stage id that is `NaN` is not
 * indexed, because it equals no stage id.
 *
 * @param {readonly QueueEntry[]} entries
 * @returns {StageIndex}
 */
function buildStageIndex(entries) {
    /** @type {Map<number, { key: string | number, value: QueuedCall, entry: QueueEntry }>} */
    const latest = new Map();
    /** By stage id, the creates targeting it, each held as `{ key, value, entry }` like above. */
    const creates = new Map();
    for (const entry of entries) {
        const { key, value } = entry;
        if (value?.model !== "crm.lead" || value.method !== "web_save") {
            continue;
        }
        const [ids, vals] = value.args ?? [];
        if (!Array.isArray(ids)) {
            continue;
        }
        if (ids.length === 0) {
            const stageId = vals?.stage_id ?? value.kwargs?.context?.default_stage_id;
            if (Number.isNaN(stageId)) {
                continue;
            }
            // Sorted on the value read above, so the traversal reads it once per entry.
            const create = { key, value, entry };
            const stageCreates = creates.get(stageId);
            if (stageCreates) {
                stageCreates.push(create);
            } else {
                creates.set(stageId, [create]);
            }
        } else if (vals && Object.hasOwn(vals, "stage_id")) {
            // Ranked on the value read above, so the traversal reads it once per entry.
            const candidate = { key, value, entry };
            for (const resId of ids) {
                const current = latest.get(resId);
                if (!current || compareReplayOrder(candidate, current) > 0) {
                    latest.set(resId, candidate);
                }
            }
        }
    }
    const latestStageWrites = new Map();
    for (const [resId, { entry }] of latest) {
        latestStageWrites.set(resId, entry);
    }
    const leadCreates = new Map();
    for (const [stageId, stageCreates] of creates) {
        stageCreates.sort(compareReplayOrder);
        leadCreates.set(
            stageId,
            stageCreates.map(({ entry }) => entry)
        );
    }
    return { latestStageWrites, leadCreates };
}

/**
 * The stage index of a frozen entries array, built on its first use and reused for every later
 * reader call on the same array. A frozen array cannot change, and the framework replaces a queue
 * entry rather than mutating it, so the index cannot go stale.
 *
 * @param {readonly QueueEntry[]} entries
 * @returns {StageIndex | null} `null` unless `entries` is a frozen array: any other array may
 *   change between two calls, so the readers scan it on each call
 */
function frozenStageIndex(entries) {
    if (!Array.isArray(entries) || !Object.isFrozen(entries)) {
        return null;
    }
    let index = stageIndexes.get(entries);
    if (!index) {
        index = buildStageIndex(entries);
        stageIndexes.set(entries, index);
    }
    return index;
}

/**
 * Component hook giving CRM code its offline state. Call it from a component `setup` (or from a
 * patched `setup`, or while a component's setup runs), like any hook.
 *
 * Every queue reader reads the `_ormToSync` signal, so a component that calls one while rendering
 * re-renders whenever the queue changes: a call is scheduled, replayed or discarded from the
 * systray. Readers return the framework's `{key, value}` entries as stored, never a copy and never
 * mutated, so each result carries its queue key (for `t-key`) next to its value.
 *
 * The stage readers (`pendingLeadCreates`, `latestStageWrite`) index a frozen `entries` array in
 * one traversal on its first use and answer every later call on that array from the index, so a
 * caller looking up many leads and stages in one frozen array reads each entry once. Any other
 * array, the live queue included, is scanned on each call.
 *
 * @example
 * setup() {
 *     this.crmOffline = useCrmOffline();
 * }
 * get isPendingSync() {
 *     return this.crmOffline.isRecordPendingSync(this.props.record);
 * }
 */
export function useCrmOffline() {
    const env = useEnv();
    const offline = usePlugin(OfflinePlugin);
    const ui = usePlugin(UIPlugin);
    const orm = usePlugin(ORM);

    /** @returns {QueueEntry[]} */
    function queuedEntries() {
        return Object.values(offline._ormToSync());
    }

    /**
     * Whether a record has a queued write the server has not received yet. The record's
     * `offlineId` counts only while that key is still in the queue, because the record keeps it
     * after replay or a systray discard removed the entry.
     *
     * @param {RelationalRecord | undefined | null} record
     * @returns {boolean}
     */
    function isRecordPendingSync(record) {
        if (!record) {
            return false;
        }
        const queue = offline._ormToSync();
        const offlineId = record.offlineId;
        if (offlineId !== undefined && offlineId !== null && queue[offlineId]) {
            return true;
        }
        const { resModel, resId } = record;
        if (!resId) {
            return false;
        }
        return Object.values(queue).some(
            ({ value }) =>
                value?.model === resModel &&
                PENDING_RECORD_METHODS.includes(value.method) &&
                Array.isArray(value.args?.[0]) &&
                value.args[0].includes(resId)
        );
    }

    /**
     * Queued `crm.lead` creates targeting a stage: the stage written in the values, or else the
     * default stage of the context they were created with.
     *
     * @param {number | false} stageValue the stage id (a group's `serverValue`)
     * @param {QueueEntry[]} [entries] defaults to the live queue; a frozen array is indexed once
     *   (see `frozenStageIndex`)
     * @returns {QueueEntry[]} a new array on every call, in replay order (see
     *   `compareReplayOrder`): the order the leads were created in, whatever the order of `entries`
     *   and the enumeration order of their queue keys
     */
    function pendingLeadCreates(stageValue, entries = queuedEntries()) {
        const index = frozenStageIndex(entries);
        if (index) {
            // A new array, so that no caller can change the index.
            return [...(index.leadCreates.get(stageValue) ?? [])];
        }
        return entries
            .filter(({ value }) => {
                if (value?.model !== "crm.lead" || value.method !== "web_save") {
                    return false;
                }
                const [ids, vals] = value.args ?? [];
                if (!Array.isArray(ids) || ids.length !== 0) {
                    return false;
                }
                const stageId = vals?.stage_id ?? value.kwargs?.context?.default_stage_id;
                return stageId === stageValue;
            })
            .sort(compareReplayOrder);
    }

    /**
     * Queued activity calls of a lead: the `mail.activity` creates targeting it, plus every queued
     * `mail.activity` archive (mark done), which callers match to an activity by `args[0][0]`.
     *
     * @param {number} resId the lead id
     * @returns {QueueEntry[]} a new array, in replay order (see `compareReplayOrder`): the order
     *   the calls were made in, which is the order the framework replays them in, whatever the
     *   enumeration order of their queue keys
     */
    function pendingActivityCalls(resId) {
        return queuedEntries()
            .filter(({ value }) => {
                if (value?.model !== "mail.activity") {
                    return false;
                }
                if (value.method === "action_archive") {
                    return true;
                }
                const vals = value.args?.[1];
                return (
                    value.method === "web_save" &&
                    vals?.res_model === "crm.lead" &&
                    vals.res_id === resId
                );
            })
            .sort(compareReplayOrder);
    }

    /**
     * The queued `crm.lead` write of `stage_id` for a lead that comes last in the framework replay
     * order, hence the stage the server ends with: the greatest `extras.timeStamp`, ties resolved
     * in replay order (see `compareReplayOrder`). A parked entry (`extras.error`) counts like the
     * others. The result does not depend on the order of `entries`.
     *
     * @param {number} resId the lead id
     * @param {QueueEntry[]} [entries] defaults to the live queue; a frozen array is indexed once
     *   (see `frozenStageIndex`)
     * @returns {QueueEntry | undefined}
     */
    function latestStageWrite(resId, entries = queuedEntries()) {
        const index = frozenStageIndex(entries);
        if (index) {
            return index.latestStageWrites.get(resId);
        }
        let latest;
        for (const entry of entries) {
            const { value } = entry;
            if (value?.model !== "crm.lead" || value.method !== "web_save") {
                continue;
            }
            const [ids, vals] = value.args ?? [];
            if (!Array.isArray(ids) || !ids.includes(resId) || !vals) {
                continue;
            }
            if (!Object.hasOwn(vals, "stage_id")) {
                continue;
            }
            if (!latest || compareReplayOrder(entry, latest) > 0) {
                latest = entry;
            }
        }
        return latest;
    }

    /**
     * Runs a write online, or schedules it in the framework offline queue when the client is
     * offline or the connection drops during the online call.
     *
     * Only `web_save` (record creation) and `action_archive` may be queued: they are the families
     * the shared offline systray renders. The queued call carries the extras the systray reads:
     * the current action, the view type (overridable), a timestamp taken when the call is
     * scheduled, a display name and the display values of the changes (always an object). The
     * framework keys the entry by a hash of its value.
     *
     * A `NonSecureContextError` raised by the framework (offline features need a secure context)
     * propagates, as it does for framework record saves.
     *
     * @example
     * await crmOffline.runOrQueue({
     *     online: () => crmOffline.orm.call("mail.activity", "action_done", [[id]]),
     *     queue: { model: "mail.activity", method: "action_archive", args: [[id]], kwargs: {},
     *              extras: { displayName, changes: {} } },
     * });
     *
     * @param {Object} params
     * @param {() => Promise<any>} params.online the live call
     * @param {Object} params.queue the call to schedule instead
     * @param {string} params.queue.model
     * @param {"web_save" | "action_archive"} params.queue.method
     * @param {any[]} params.queue.args
     * @param {Object} [params.queue.kwargs]
     * @param {{ viewType?: string, displayName?: string, changes?: Object }} [params.queue.extras]
     * @returns {Promise<{ queued: true, key: string | number } | { queued: false, result: any }>}
     */
    async function runOrQueue({ online, queue }) {
        if (typeof online !== "function") {
            throw new Error("runOrQueue: `online` must be a function performing the live call");
        }
        if (!queue?.model || !CRM_QUEUEABLE_METHODS.includes(queue.method)) {
            throw new Error(
                `runOrQueue: only ${CRM_QUEUEABLE_METHODS.join(" and ")} can be queued, got "${
                    queue?.method
                }"`
            );
        }
        const schedule = () => {
            const extras = {
                actionId: env.config?.actionId,
                actionName: env.config?.actionName,
                viewType: queue.extras?.viewType ?? env.config?.viewType,
                timeStamp: Date.now(),
                displayName: queue.extras?.displayName ?? "",
                changes: queue.extras?.changes ?? {},
            };
            const key = offline.scheduleORM(
                queue.model,
                queue.method,
                queue.args,
                queue.kwargs ?? {},
                { extras }
            );
            return { queued: true, key };
        };
        if (offline.isOffline()) {
            return schedule();
        }
        try {
            const result = await online();
            return { queued: false, result };
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return schedule();
            }
            throw error;
        }
    }

    return {
        orm,
        isOffline: () => offline.isOffline(),
        syncingORM: () => offline.syncingORM(),
        isSmall: () => ui.isSmall(),
        isAvailableOffline: (actionId, viewType, resId) =>
            offline.isAvailableOffline(actionId, viewType, resId),
        queuedEntries,
        isRecordPendingSync,
        pendingLeadCreates,
        pendingActivityCalls,
        latestStageWrite,
        runOrQueue,
    };
}

// -----------------------------------------------------------------------------
// DISABLE presentation
// -----------------------------------------------------------------------------

// The framework dims, while offline, every element matching one of these selectors (and re-applies
// it to elements added later). Appending the CRM selectors dims the non-button DISABLE controls
// exactly like buttons; the base selector stays first and unchanged. DISABLE anchors rendered by
// view buttons, wherever they are rendered (overlays such as the team dashboard card menu, the UTM
// campaign card), also render the same `disabled` attribute and `o_disabled_offline` class while
// offline, unless already disabled, through the `ViewButton` patch below and the same predicate as
// its click guard.
patch(OfflinePlugin, {
    SELECTORS_TO_DISABLE: [
        ...OfflinePlugin.SELECTORS_TO_DISABLE,
        ...CRM_OFFLINE_DISABLED_SELECTORS,
    ],
});

// -----------------------------------------------------------------------------
// DISABLE handler enforcement
// -----------------------------------------------------------------------------
//
// Visual disabling alone does not make a control inert: a hotkey, a keyboard selection, an overlay
// left open at disconnection or a direct call reaches the handler anyway. Each patch below returns
// before doing any work (no preventDefault, save, RPC, dialog or action), with or without a DOM
// event, while offline and only for a CRM target; in every other case it calls the original
// handler with the original arguments.

/**
 * Whether a view button is a DISABLE button: a server button (`object`/`action`) of a CRM model, a
 * listed CRM button on another model, or a footer button of a mail dialog form targeting a lead.
 *
 * @param {string | undefined} resModel the model the button acts on
 * @param {{ type?: string, name?: string } | undefined} clickParams
 * @param {RelationalRecord} [record] the record the button belongs to, if any
 * @returns {boolean}
 */
function isCrmDisabledButton(resModel, clickParams, record) {
    if (!SERVER_BUTTON_TYPES.includes(clickParams?.type)) {
        return false;
    }
    return (
        CRM_OFFLINE_MODELS.includes(resModel) ||
        CRM_FOREIGN_DISABLED_BUTTONS.some(
            ([model, name]) => model === resModel && name === clickParams.name
        ) ||
        targetsCrmLead(record)
    );
}

patch(ViewButton.prototype, {
    setup() {
        super.setup(...arguments);
        // Assigned after the base setup, which may wrap `onClick` in a debounced bound function:
        // that function calls this patched `onClick`, which reads `crmOffline` at click time.
        this.crmOffline = useCrmOffline();
    },
    /**
     * Whether this view button is a DISABLE anchor (any tag other than `<button>`) that is
     * otherwise enabled, while offline, under the same predicate as the click guard of `onClick`:
     * the anchor is rendered disabled whenever its click is inert. `<button>` tags are left to the
     * framework's offline selector. An anchor already disabled by its own state is never marked,
     * as the framework's selector skips elements that are already disabled: the framework strips
     * the `disabled` attribute from every marked element on reconnection, which would leave such
     * an anchor rendered enabled while it is still disabled. The tag, the predicate and the
     * anchor's own state are checked before the offline signal is read, so only enabled CRM
     * DISABLE anchors re-render when the connection drops or returns; that re-render also updates
     * an anchor shown in an overlay opened before the change (the team dashboard card menu).
     *
     * @returns {boolean}
     */
    get crmDisabledOffline() {
        const { record, tag } = this.props;
        if (tag === "button" || !isCrmDisabledButton(record?.resModel, this.clickParams, record)) {
            return false;
        }
        if (super.disabled) {
            return false;
        }
        return this.crmOffline ? this.crmOffline.isOffline() : isOfflineModel(record?.model);
    },
    /**
     * A DISABLE anchor renders the `disabled` attribute offline, as the framework sets it on the
     * elements its offline selectors match. Otherwise the base value is unchanged.
     */
    get disabled() {
        if (this.crmDisabledOffline) {
            return true;
        }
        return super.disabled;
    },
    /**
     * A DISABLE anchor renders the framework's `o_disabled_offline` class offline, so it is
     * dimmed like the elements the offline selectors match; the framework strips the class on
     * reconnection and the re-render leaves it out. Otherwise the base classes are unchanged.
     */
    getClassName() {
        const className = super.getClassName(...arguments);
        if (!this.crmDisabledOffline) {
            return className;
        }
        return className ? `${className} o_disabled_offline` : "o_disabled_offline";
    },
    /**
     * Form header and smart buttons, probability anchors, team dashboard anchors, wizard confirm
     * buttons (including a wizard opened before disconnection) and the footer buttons of mail
     * dialog forms targeting a lead. Checked before `props.onClick` and `handleViewButton`, which
     * would save the record first.
     */
    onClick(ev, newWindow) {
        const { record } = this.props;
        const isOffline = this.crmOffline
            ? this.crmOffline.isOffline()
            : isOfflineModel(record?.model);
        if (isOffline && isCrmDisabledButton(record?.resModel, this.clickParams, record)) {
            return;
        }
        return super.onClick(...arguments);
    },
});

patch(MultiRecordViewButton.prototype, {
    /**
     * List and kanban header buttons (mass convert, mass mail, Lost). The base method does not call
     * `super`, so it is guarded on its own, before `list.getResIds`.
     */
    async onClick(ev, newWindow) {
        const { clickParams, list } = this.props;
        const isOffline = this.crmOffline
            ? this.crmOffline.isOffline()
            : isOfflineModel(list?.model);
        if (isOffline && isCrmDisabledButton(list?.resModel, clickParams)) {
            return;
        }
        return super.onClick(...arguments);
    },
});

patch(RelationalRecord.prototype, {
    /**
     * A record of a mail dialog form model targeting a lead (see `targetsCrmLead`) never enters
     * the offline queue: whether it is saved offline or its save loses the connection, the save
     * fails (a dialog stays open with its values) instead of being queued. Lead activities are
     * written offline only through the mobile lead card. Every other record queues its save as
     * before.
     */
    _offlineSave() {
        if (targetsCrmLead(this)) {
            return false;
        }
        return super._offlineSave(...arguments);
    },
});

/**
 * @param {ActionMenus} actionMenus
 * @returns {boolean} whether the menu acts on a CRM model while offline
 */
function isCrmActionMenuOffline(actionMenus) {
    return Boolean(
        actionMenus.offlinePlugin?.isOffline() &&
            CRM_OFFLINE_MODELS.includes(actionMenus.props.resModel)
    );
}

// Inherited by `CogMenu` and its form, list and kanban variants.
patch(ActionMenus.prototype, {
    /**
     * Receives the raw action (bound or server action). Only those reach this method, because
     * static items run their own callback, so every raw action is inert: no active-id search, no
     * context, no `doAction`.
     */
    async executeAction(action) {
        if (isCrmActionMenuOffline(this)) {
            return;
        }
        return super.executeAction(...arguments);
    },
    /**
     * Receives the menu wrapper. Bound, server and print actions (`item.action`), Duplicate and
     * Export are inert, before `shouldExecuteAction`, which may save the record. Archive,
     * Unarchive and Delete carry only a callback and keep queueing through the framework.
     */
    async onItemSelected(item) {
        if (
            isCrmActionMenuOffline(this) &&
            (item?.action || SERVER_STATIC_MENU_ITEMS.includes(item?.key))
        ) {
            return;
        }
        return super.onItemSelected(...arguments);
    },
});

patch(KanbanRecord.prototype, {
    /**
     * Team dashboard card click, which calls `action_primary_channel_button` on `crm.team`.
     * Only the branch that would run the open action is inert: clicks the base method ignores or
     * handles on the client (selection toggling, Alt-click, forced global click) behave as before.
     *
     * Reading the selection filters every loaded record, so this branch reads it once. An Alt-click
     * is delegated before any read, and the base method reads it once. With a selection, the card
     * toggles it here, with the base method's cancellation and event handling, instead of calling
     * the base method, which would read it again. A direct call without an event is tolerated.
     */
    onGlobalClick(ev, newWindow) {
        const { forceGlobalClick, openAction, record } = this.props;
        if (
            !this.offlinePlugin?.isOffline() ||
            record?.resModel !== "crm.team" ||
            !openAction ||
            forceGlobalClick ||
            ev?.altKey
        ) {
            return super.onGlobalClick(...arguments);
        }
        if (this.props.getSelection().length === 0) {
            return;
        }
        if (ev?.target?.closest(this.constructor.CANCEL_GLOBAL_CLICK)) {
            return;
        }
        if (ev) {
            ev.stopPropagation();
            ev.preventDefault();
        }
        this.rootRef().focus();
        this.props.toggleSelection(this.props.record, ev?.shiftKey);
    },
});

patch(ListController.prototype, {
    /**
     * Activity report rows, which open the lead through the server method `action_open_lead`.
     * Checked before the base method saves a dirty row, and with the condition under which it
     * runs the open action.
     */
    async openRecord(record, options) {
        if (
            this.offlinePlugin?.isOffline() &&
            this.props.resModel === "crm.activity.report" &&
            this.props.allowOpenAction &&
            this.archInfo?.openAction
        ) {
            return;
        }
        return super.openRecord(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Unreachable offline
// -----------------------------------------------------------------------------

patch(RelationalModel.prototype, {
    /**
     * The forecast views (their action context sets `forecast_field`, inherited by their kanban,
     * list and form) and the activity report are never registered as available offline, so the
     * navbar, menus, view switcher and action fallback never offer them offline. Online loading
     * and rendering are unchanged.
     */
    _setAvailableOffline(config, result) {
        if (config?.context?.forecast_field || config?.resModel === "crm.activity.report") {
            return;
        }
        return super._setAvailableOffline(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Small-screen offline partner lookup
// -----------------------------------------------------------------------------

patch(Many2One.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        /**
         * Whether the field renders the autocomplete instead of the search-dialog input: offline,
         * on a small screen, in a `crm.lead` view. Memoized, so its readers (the props getter and
         * the effect below) only react when the answer changes.
         */
        this.crmOfflineLookup = computed(
            () =>
                this.crmOffline.isOffline() &&
                this.crmOffline.isSmall() &&
                this.env.model?.root?.resModel === "crm.lead"
        );
        // Switching between the search-dialog input and the autocomplete discards text typed but
        // not selected. `state.isFloating` is set through `setInputFloats` by the autocomplete's
        // input handler and is otherwise reset only by `update()`: without this reset, a
        // reconnection while typing would leave the field floating and hide its open-record
        // button. The effect runs once when created, which is not a switch; the reset runs
        // untracked, so the effect depends on `crmOfflineLookup` alone.
        let isInitialRun = true;
        useEffect(() => {
            this.crmOfflineLookup();
            if (isInitialRun) {
                isInitialRun = false;
                return;
            }
            untrack(() => {
                this.state.isFloating = false;
            });
        });
    },
    /**
     * On small screens a many2one renders a read-only input that opens a search dialog, which does
     * not consult the framework's relational-field cache. Offline, in `crm.lead` views,
     * `dropdown: false` renders the autocomplete instead (its inline mode, as the framework's
     * `KanbanMany2OneAssignPopover` does): it searches that cache, and the framework's `suggest()`
     * offers no create or search-more option offline. Online, on large screens and for every other
     * model the props are unchanged. The call is optional for subclasses whose `setup` skips this
     * one.
     *
     * @returns {Object}
     */
    get many2XAutocompleteProps() {
        const props = super.many2XAutocompleteProps;
        return this.crmOfflineLookup?.() ? { ...props, dropdown: false } : props;
    },
});
