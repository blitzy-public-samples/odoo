/**
 * Mobile lead quick create, shown as a bottom sheet by the small-screen CRM pipeline.
 *
 * The sheet captures exactly six values (lead name, contact name, phone, email, expected revenue
 * and stage) and creates a `crm.lead` through `runOrQueue` from the shared CRM offline hooks:
 *
 * - online, it calls `web_save` and hands the created id, with the live group of the chosen stage,
 *   to the pipeline (`onCreated`), which adds the card to that stage exactly as the framework
 *   kanban quick create does;
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
 * - Focus: the sheet focuses its lead name input as it opens; the pipeline moves the focus back
 *   to its Add button as the sheet closes (`onClose`).
 *
 * @example
 * this.quickCreatePopover = usePopover(CrmMobileQuickCreate, {
 *     useBottomSheet: true,
 *     withScope: true,
 *     // the sheet body, so that a focus inside the closing sheet is recognised
 *     ref: this.quickCreateSheetRef,
 *     // moves a focus inside the closing sheet, or fallen to the body, back to Add
 *     onClose: () => this._focusAfterQuickCreate(),
 * });
 * this.quickCreatePopover.open(ev.currentTarget, {
 *     list: this.props.list,
 *     group: this.currentGroup,
 *     // adds the lead with `validateQuickCreate(resId, "close", group)`, or reloads the list when
 *     // `group` is undefined (its stage is gone); nothing when the lead is already loaded
 *     onCreated: (resId, group) => this.onQuickCreated(resId, group),
 * });
 */

import { Component, proxy, signal, status, t, untrack, useEffect, useProps } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useAutofocus } from "@web/core/utils/hooks";
import { isEmail } from "@web/core/utils/strings";
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
 * A valid floating-point number as HTML defines it for `<input type="number">`: an optional minus
 * sign, digits with an optional fraction (or a fraction alone), and an optional exponent. The whole
 * text must match, so a partly numeric text such as `12junk` is rejected.
 */
const R_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * @param {string} text the expected revenue as typed, trimmed
 * @param {boolean} badInput whether the revenue input holds a text the browser cannot parse: a
 *   number input then reports an empty value
 * @returns {number | null} the amount, 0 when nothing is typed; `null` when the text is not a
 *   finite number of 0 or more
 */
function toRevenue(text, badInput) {
    if (!text) {
        return badInput ? null : 0;
    }
    if (!R_FLOAT.test(text)) {
        return null;
    }
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
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
        /**
         * `(resId, group) => Promise`: adds a lead created online to its stage. `group` is the
         * live group of the stage written, resolved once the call has returned, or `undefined`
         * when that stage is no longer listed. Called even if the sheet was dismissed meanwhile.
         */
        onCreated: t.function(),
    });

    /** The expected revenue input, read for the browser's own parse failure (`badInput`). */
    revenueRef = signal.ref();

    /** The lead name input, the sheet's first field. */
    nameRef = signal.ref();

    setup() {
        // The sheet is modal: as it opens, the focus moves from the pipeline's Add button to the
        // first field, once, so later renders leave the user's focus alone. `mobile` focuses it
        // on touch screens too, where the sheet is shown.
        useAutofocus({ ref: this.nameRef, mobile: true });
        this.crmOffline = useCrmOffline();
        this.state = proxy({
            name: "",
            contact_name: "",
            phone: "",
            email_from: "",
            expected_revenue: "",
            /** Datapoint id of the selected stage group (the stage `<select>` value). */
            stageGroupId: this.props.group.id,
            /** Inline error of each validated field, empty when the field is valid. */
            errors: { name: "", email_from: "", expected_revenue: "" },
            saving: false,
        });

        /**
         * Stage id of the selected group. A reload of the pipeline (the reconciliation that
         * follows a reconnection, for instance) rebuilds the groups with new datapoint ids, while
         * the stage ids stay the same: this one value lets the selection follow its stage across
         * any number of reloads.
         *
         * @type {number | false}
         */
        this.selectedStageValue = this.props.group.serverValue;
        // Re-syncs the selection whenever the listed groups or the selected id change. The effect
        // reads these dependencies itself and runs the sync untracked, because the sync may write
        // the selected id: `useOnChange` observes its dependencies through an intermediate
        // computed, which a write made from its own callback leaves stale, so that no later
        // change (a second reload, for instance) would reach it.
        useEffect(() => {
            const groups = this.stageGroups;
            const selectedId = this.state.stageGroupId;
            untrack(() => this.syncSelectedStage(groups, selectedId));
        });
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
        const groups = this.stageGroups;
        const initialStage = this.props.group.serverValue;
        return (
            groups.find((group) => group.id === this.state.stageGroupId) ??
            groups.find((group) => group.serverValue === this.selectedStageValue) ??
            groups.find((group) => group.serverValue === initialStage) ??
            this.props.group
        );
    }

    // -------------------------------------------------------------------------
    // Stage selection
    // -------------------------------------------------------------------------

    /**
     * Keeps the `<select>` value on a listed group when the groups are rebuilt or the selection
     * changes: the selection moves to the new group of the same stage, or to the first stage if
     * that stage is gone, and the stage of the selected group is remembered.
     *
     * @param {Object[]} groups the stage groups listed
     * @param {string} selectedId the selected group datapoint id
     */
    syncSelectedStage(groups, selectedId) {
        const group =
            groups.find((candidate) => candidate.id === selectedId) ??
            groups.find((candidate) => candidate.serverValue === this.selectedStageValue) ??
            groups[0];
        if (!group) {
            return;
        }
        this.selectedStageValue = group.serverValue;
        if (group.id !== selectedId) {
            this.state.stageGroupId = group.id;
        }
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    /**
     * Stores the expected revenue as the input reports it, without writing it back: for a text the
     * browser cannot parse (`1e`, typed on the way to `1e3`), a number input reports an empty value
     * and flags `validity.badInput`. Rendering that empty value into the input would erase the
     * text and the flag, and `save()` would then take the field for empty instead of invalid.
     *
     * @param {InputEvent} ev input in the expected revenue field
     */
    onRevenueInput(ev) {
        this.state.expected_revenue = ev.target.value;
    }

    /**
     * Creates the lead online, or queues its creation when offline or when the connection drops
     * during the call (planned entry point N1 of the offline inventory).
     * - Invalid fields (an empty name, a malformed email, an expected revenue that is not a finite
     *   number of 0 or more) each show an inline error, and nothing is sent or queued.
     * - An error of the call itself (a server validation error, `NonSecureContextError`)
     *   propagates to the framework error handling and leaves the sheet open with its values.
     * - Once the lead exists (created or queued), the sheet closes even if adding its card fails;
     *   that failure propagates after the sheet is closed.
     * - A lead created online is handed to the pipeline (`onCreated`) with the live group of its
     *   stage, even when the sheet was dismissed during the call.
     */
    async save() {
        if (this.state.saving) {
            return;
        }
        const name = toText(this.state.name);
        const email = toText(this.state.email_from);
        const revenueText = toText(this.state.expected_revenue);
        const revenue = toRevenue(revenueText, Boolean(this.revenueRef()?.validity?.badInput));
        // Checked here rather than by the inputs' native constraints, which nothing invokes (no
        // form is submitted), so that a direct call is held to the same rules. Every invalid
        // field shows its own error at once, and nothing is sent or queued.
        const errors = {
            name: name ? "" : _t("The lead name is required."),
            email_from: !email || isEmail(email) ? "" : _t("The email address is not valid."),
            expected_revenue:
                revenue === null ? _t("The expected revenue must be a number of 0 or more.") : "",
        };
        this.state.errors = errors;
        if (Object.values(errors).some(Boolean)) {
            return;
        }

        const targetGroup = this.targetGroup;
        // Exactly the six captured values. Empty chars are written as `false`, as the framework
        // serializes empty char fields; the stage is the group's stage id, which is also what the
        // pipeline matches to place a pending create.
        const vals = {
            name,
            contact_name: toText(this.state.contact_name) || false,
            phone: toText(this.state.phone) || false,
            email_from: email || false,
            expected_revenue: revenue,
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

        // Captured before the call: the sheet may be dismissed while it runs, and a reload of the
        // pipeline replaces its group datapoints. The stage is kept by its id (the value written),
        // never as a group, and the selection is not read again afterwards.
        const stageValue = targetGroup.serverValue;
        const { list, onCreated } = this.props;

        this.state.saving = true;
        let outcome;
        try {
            outcome = await this.crmOffline.runOrQueue({
                // Unscoped: the component's ORM would abort the answer if the sheet were
                // dismissed during the call, and the lead created would never reach the pipeline.
                online: () => this.crmOffline.orm.unscoped.webSave("crm.lead", [], vals, kwargs),
                queue: { model: "crm.lead", method: "web_save", args: [[], vals], kwargs, extras },
            });
        } catch (error) {
            if (status(this) !== "destroyed") {
                this.state.saving = false;
            }
            throw error;
        }
        // From here the lead exists (on the server or in the queue): the sheet closes even if
        // adding the card fails, so that a second tap cannot create it twice. A lead created
        // online reaches the pipeline even when the sheet was dismissed during the call.
        try {
            if (!outcome.queued) {
                // `web_save` answers with the saved records, not with an id.
                const resId = outcome.result?.[0]?.id;
                if (resId) {
                    // The live group of the stage written, resolved now: `undefined` when that
                    // stage is no longer listed, and the pipeline then reloads instead.
                    const liveGroup = list.groups?.find(
                        (group) => group.serverValue === stageValue
                    );
                    await onCreated(resId, liveGroup);
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
