/**
 * Mobile lead quick create, shown as a bottom sheet by the small-screen CRM pipeline.
 *
 * The sheet captures exactly six values (lead name, contact name, phone, email, expected revenue
 * and stage) and creates a `crm.lead` through `runOrQueue` from the shared CRM offline hooks:
 *
 * - online, it calls `web_save` and hands the created id to the pipeline (`onCreated`), which adds
 *   the card to the chosen stage exactly as the framework kanban quick create does;
 * - offline, or when the connection drops during the call, the same `web_save` is scheduled in the
 *   framework offline queue. No server id exists then, so the pipeline renders the pending card
 *   from the queue (`pendingLeadCreates`) and the framework replays the call on reconnect.
 *
 * Constraints this component keeps:
 * - It queues only `crm.lead` `web_save`, a family the shared offline systray renders.
 * - It never sends `partner_id`: the contact is captured as `contact_name` (char), so no contact is
 *   created offline. No user or assignee is chosen either: the server applies the session user.
 * - It has no offline machinery of its own and registers nothing. It is opened only by the mobile
 *   pipeline, through `usePopover(CrmMobileQuickCreate, { useBottomSheet: true, withScope: true })`.
 *   `withScope` makes the sheet share the pipeline's plugin manager, hence its env and action
 *   config: the queued call is listed in the systray under the pipeline's action.
 *
 * @example
 * this.quickCreatePopover = usePopover(CrmMobileQuickCreate, {
 *     useBottomSheet: true,
 *     withScope: true,
 * });
 * this.quickCreatePopover.open(ev.currentTarget, {
 *     list: this.props.list,
 *     group: this.currentGroup,
 *     onCreated: (resId, group) => this.validateQuickCreate(resId, "close", group),
 * });
 */

import { Component, proxy, status, t, useOnChange, useProps } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

/**
 * View type recorded with a queued create. The offline systray opens only `form` entries, so a
 * create made from the pipeline is listed (with its values in the tooltip) but not opened.
 */
const QUEUED_VIEW_TYPE = "kanban";

/** Char values of the sheet, in the order they are written. */
const CHAR_FIELDS = ["name", "contact_name", "phone", "email_from"];

/**
 * @param {unknown} value an input value bound to the sheet state
 * @returns {string} the trimmed text, empty for a missing value
 */
function toText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim();
}

/**
 * Detached, JSON-safe copy of a group context. The framework queue keeps the scheduled value in
 * memory by reference and persists it as JSON, so the queued call must not share objects with the
 * reactive model: a later change of the group config cannot alter a call already queued.
 *
 * @param {Object | undefined} context
 * @returns {Object}
 */
function toPlainContext(context) {
    return context ? JSON.parse(JSON.stringify(context)) : {};
}

/**
 * Same order as the kanban renderer (`KanbanRenderer.getGroupsOrRecords`), hence as the pipeline's
 * stage navigation: the group without a value first, then the groups in server order.
 *
 * @param {Object} a a stage group
 * @param {Object} b a stage group
 * @returns {number}
 */
function compareStageGroups(a, b) {
    if (a.value && !b.value) {
        return 1;
    }
    if (!a.value && b.value) {
        return -1;
    }
    return 0;
}

export class CrmMobileQuickCreate extends Component {
    static template = "crm.CrmMobileQuickCreate";

    props = useProps({
        /** The pipeline's `DynamicGroupList`, grouped by `stage_id`. */
        list: t.object(),
        /** The stage group selected when the sheet opens (the displayed stage). */
        group: t.object(),
        /** Injected by the bottom sheet: removes the sheet. */
        close: t.function(),
        /** `(resId, group) => Promise`: adds a lead created online to its stage group. */
        onCreated: t.function(),
    });

    setup() {
        this.crmOffline = useCrmOffline();
        this.state = proxy({
            name: "",
            contact_name: "",
            phone: "",
            email_from: "",
            expected_revenue: "",
            /** Datapoint id of the selected stage group (the stage `<select>` value). */
            stageGroupId: this.props.group.id,
            error: "",
            saving: false,
        });

        /**
         * Stage id of every group datapoint id the sheet has listed. A reload of the pipeline
         * (the reconciliation that follows a reconnection, for instance) rebuilds the groups
         * with new datapoint ids, while the stage ids stay the same: this map lets the selection
         * follow its stage across reloads.
         *
         * @type {Map<string, number | false>}
         */
        this.stageValueById = new Map();
        this.rememberStageGroups();
        useOnChange(
            () => [this.stageGroups.map((group) => group.id).join(","), this.state.stageGroupId],
            () => this.syncSelectedStage()
        );
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    /**
     * Stage groups offered by the stage `<select>`, in pipeline order.
     *
     * @returns {Object[]}
     */
    get stageGroups() {
        return [...(this.props.list.groups ?? [])].sort(compareStageGroups);
    }

    /**
     * The live stage group the lead is created in: the selected group, else the live group of the
     * selected stage after a reload, else the live group of the initial stage, else the initial
     * group itself.
     *
     * @returns {Object}
     */
    get targetGroup() {
        const initialStage = this.props.group.serverValue;
        return (
            this.resolveStageGroup(this.state.stageGroupId) ??
            this.stageGroups.find((group) => group.serverValue === initialStage) ??
            this.props.group
        );
    }

    // -------------------------------------------------------------------------
    // Stage selection
    // -------------------------------------------------------------------------

    /** Records the stage id of every group currently listed. */
    rememberStageGroups() {
        for (const group of this.stageGroups) {
            this.stageValueById.set(group.id, group.serverValue);
        }
    }

    /**
     * @param {string} groupId a group datapoint id, current or from before a reload
     * @returns {Object | undefined} the live group with that id, or else the live group of the
     *   stage that id stood for
     */
    resolveStageGroup(groupId) {
        const groups = this.stageGroups;
        const group = groups.find((candidate) => candidate.id === groupId);
        if (group || !this.stageValueById.has(groupId)) {
            return group;
        }
        const stageValue = this.stageValueById.get(groupId);
        return groups.find((candidate) => candidate.serverValue === stageValue);
    }

    /**
     * Keeps the `<select>` value on a listed group when the groups are rebuilt: the selection
     * moves to the new group of the same stage, or to the first stage if that stage is gone.
     */
    syncSelectedStage() {
        this.rememberStageGroups();
        const selectedId = this.state.stageGroupId;
        const group = this.resolveStageGroup(selectedId) ?? this.stageGroups[0];
        if (group && group.id !== selectedId) {
            this.state.stageGroupId = group.id;
        }
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /**
     * Creates the lead online, or queues its creation when offline or when the connection drops
     * during the call (planned entry point N1 of the offline inventory). An empty name shows an
     * inline error and sends nothing. Any other error (e.g. a server validation error) propagates
     * to the framework error handling and leaves the sheet open with its values.
     */
    async save() {
        if (this.state.saving) {
            return;
        }
        const name = toText(this.state.name);
        if (!name) {
            this.state.error = _t("The lead name is required.");
            return;
        }
        this.state.error = "";

        const targetGroup = this.targetGroup;
        const revenueText = toText(this.state.expected_revenue);
        const revenue = Number.parseFloat(revenueText);
        // Exactly the six captured values. Empty chars are written as `false`, as the framework
        // serializes empty char fields; the stage is the group's stage id, which is also what the
        // pipeline matches to place a pending create.
        const vals = {
            name,
            contact_name: toText(this.state.contact_name) || false,
            phone: toText(this.state.phone) || false,
            email_from: toText(this.state.email_from) || false,
            expected_revenue: Number.isFinite(revenue) ? revenue : 0,
            stage_id: targetGroup.serverValue,
        };
        // The group context carries the defaults of the framework quick create (`default_type`,
        // `default_team_id`, `default_stage_id`).
        const kwargs = { context: toPlainContext(targetGroup.context), specification: {} };
        const extras = {
            viewType: QUEUED_VIEW_TYPE,
            displayName: name,
            changes: this.getQueuedChanges(vals, targetGroup, revenueText),
        };

        this.state.saving = true;
        let outcome;
        try {
            outcome = await this.crmOffline.runOrQueue({
                online: () => this.crmOffline.orm.webSave("crm.lead", [], vals, kwargs),
                queue: { model: "crm.lead", method: "web_save", args: [[], vals], kwargs, extras },
            });
        } catch (error) {
            if (status(this) !== "destroyed") {
                this.state.saving = false;
            }
            throw error;
        }
        if (status(this) === "destroyed") {
            return;
        }
        // From here the lead exists (on the server or in the queue): the sheet closes even if
        // adding the card fails, so that a second tap cannot create it twice.
        try {
            if (!outcome.queued) {
                // `web_save` answers with the saved records, not with an id.
                const resId = outcome.result?.[0]?.id;
                if (resId) {
                    await this.props.onCreated(resId, targetGroup);
                }
            }
        } finally {
            if (status(this) !== "destroyed") {
                this.props.close();
            }
        }
    }

    /** Closes the sheet; nothing is saved or queued. */
    discard() {
        this.props.close();
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * Display values of a queued create, shown in the offline systray tooltip: the filled values
     * only, the stage as `{id, display_name}`. Every value is JSON-safe, since the queue persists
     * its entries as JSON.
     *
     * @param {Object} vals the values written
     * @param {Object} targetGroup the stage group the lead is created in
     * @param {string} revenueText the expected revenue as typed
     * @returns {Object}
     */
    getQueuedChanges(vals, targetGroup, revenueText) {
        const changes = {};
        for (const fieldName of CHAR_FIELDS) {
            if (vals[fieldName]) {
                changes[fieldName] = vals[fieldName];
            }
        }
        if (revenueText) {
            changes.expected_revenue = vals.expected_revenue;
        }
        changes.stage_id = {
            id: targetGroup.serverValue,
            display_name: toText(targetGroup.displayName),
        };
        return changes;
    }
}
