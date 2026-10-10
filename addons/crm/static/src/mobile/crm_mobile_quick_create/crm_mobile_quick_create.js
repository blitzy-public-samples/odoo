/**
 * Lead quick create of the small-screen CRM pipeline, shown in a bottom sheet. It creates a
 * `crm.lead` through `runOrQueue` from the shared CRM offline hooks: online, the pipeline adds the
 * created lead to its stage (`onCreated`); offline, or when the connection drops during the call,
 * the `web_save` is queued and the pipeline renders the pending card from the queue. A lead the
 * server created but the pipeline could not show because the connection was lost afterwards is
 * announced by a notification: it was saved, and shows once the connection is back.
 *
 * - Only `crm.lead` `web_save` is queued, a family the shared offline systray renders.
 * - `partner_id` is never sent: the contact is `contact_name` (char), so no contact is created
 *   offline. No user or assignee is sent either: the server applies the session user.
 * - It registers nothing and has no offline machinery of its own. Only the mobile pipeline opens
 *   it, with `withScope`, so the sheet shares the pipeline's plugin manager, hence its env and
 *   action config: the queued call is listed in the systray under the pipeline's action, and the
 *   stage the lead goes to becomes the pipeline's displayed stage (`env.crmMobileStage`).
 * - The sheet focuses its lead name input as it opens; the pipeline moves the focus back to its
 *   Add button as the sheet closes (`onClose`).
 * - The sheet is modal: while it is open, its content is the UI active element, so Tab and
 *   Shift+Tab cycle through its controls and the pipeline's hotkeys stay inactive behind it, and
 *   both the content and the hosting sheet are named after the "New Lead" title.
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
 *     // `group` is undefined (its stage is gone); nothing when the lead is already loaded; rejects
 *     // with a `ConnectionLostError` when the connection is lost before the lead is shown
 *     onCreated: (resId, group) => this.onQuickCreated(resId, group),
 * });
 */

import {
    Component,
    onMounted,
    proxy,
    signal,
    status,
    t,
    untrack,
    useEffect,
    usePlugin,
    useProps,
} from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { NotificationPlugin } from "@web/core/notifications/notification_plugin";
import { useActiveElement } from "@web/core/ui/ui_plugin";
import { useAutofocus } from "@web/core/utils/hooks";
import { isEmail } from "@web/core/utils/strings";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

/** Id of the sheet's "New Lead" title, which names the sheet and its content. */
const TITLE_ID = "o_crm_mobile_quick_create_title";

/**
 * View type recorded with a queued create. The offline systray opens only `form` entries, so a
 * create made from the pipeline is listed (with its values in the tooltip) but not opened.
 */
const QUEUED_VIEW_TYPE = "kanban";

/** Char values of the sheet, in the order they are written. */
const CHAR_FIELDS = ["name", "contact_name", "phone", "email_from"];

/** Fields checked before a create, in form order: a failed save focuses the first invalid one. */
const VALIDATED_FIELDS = ["name", "email_from", "expected_revenue"];

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
 * @returns {number | null} the amount as typed, negative ones included (the field takes any
 *   float), 0 when nothing is typed; `null` when the text cannot be written as a float: not a
 *   number as a whole, unparsable by the browser, or not finite
 */
function toRevenue(text, badInput) {
    if (!text) {
        return badInput ? null : 0;
    }
    if (!R_FLOAT.test(text)) {
        return null;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
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
         * Rejects with a `ConnectionLostError` when the connection was lost before the lead
         * could be shown: the sheet then tells the user the lead was saved.
         */
        onCreated: t.function(),
    });

    /** The expected revenue input, read for the browser's own parse failure (`badInput`). */
    revenueRef = signal.ref();

    /** The lead name input, the sheet's first field. */
    nameRef = signal.ref();

    /** The email input, focused when a save fails on it. */
    emailRef = signal.ref();

    /** The sheet content: the UI active element while the sheet is open. */
    rootRef = signal.ref();

    setup() {
        // The sheet is modal: as it opens, the focus moves from the pipeline's Add button to the
        // first field, once, so later renders leave the user's focus alone. `mobile` focuses it
        // on touch screens too, where the sheet is shown.
        useAutofocus({ ref: this.nameRef, mobile: true });
        // The content becomes the UI active element while it is mounted: Tab from Discard wraps
        // to the lead name and Shift+Tab from the lead name to Discard, and only the hotkeys
        // registered while it is active answer (the sheet's Escape among them), not those of the
        // pipeline behind it. The pipeline's `onClose` still decides where the focus goes next.
        useActiveElement(this.rootRef);
        onMounted(() => this.nameHostingSheet());
        this.crmOffline = useCrmOffline();
        this.notification = usePlugin(NotificationPlugin);
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
            /** True while a save runs: Save is busy and every control is disabled. */
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
        this.onFieldInput("expected_revenue");
    }

    /**
     * Re-checks a validated field as it is edited, while it shows an error: the error clears as
     * soon as the value is valid. A field without an error gets none before the next Save, so
     * typing is never interrupted. The name and email inputs call it after their `t-model`
     * handler, which Owl runs first on the same element: the state already holds the new value.
     *
     * @param {"name" | "email_from" | "expected_revenue"} fieldName
     */
    onFieldInput(fieldName) {
        if (this.state.errors[fieldName]) {
            this.state.errors[fieldName] = this.getFieldError(fieldName);
        }
    }

    /**
     * Creates the lead online, or queues its creation when offline or when the connection drops
     * during the call (planned entry point N1 of the offline inventory).
     * - Invalid fields (an empty name, a malformed email, an expected revenue that is not a finite
     *   number) each show an inline error and are marked invalid, the first of them in form order
     *   takes the focus (the browser scrolls it into view), and nothing is sent or queued. A
     *   negative revenue is written as typed, as the server takes it.
     * - While it runs (`state.saving`), Save is busy and every control of the sheet is disabled;
     *   the sheet can still be dismissed.
     * - An error of the call itself (a server validation error, `NonSecureContextError`)
     *   propagates to the framework error handling and leaves the sheet open with its values.
     * - Once the lead exists (created or queued), the sheet closes even if adding its card fails;
     *   that failure propagates after the sheet is closed.
     * - A lead created online is handed to the pipeline (`onCreated`) with the live group of its
     *   stage, even when the sheet was dismissed during the call.
     * - Once the lead is queued, or created online and handed to the pipeline, the pipeline
     *   displays its stage, as after a card move, so that the user sees the new card (pending or
     *   not); see `displayCreatedStage`. A sheet dismissed during the call, or an answer without
     *   an id, leaves the displayed stage as it is.
     * - When the pipeline could not show that lead because the connection was lost afterwards
     *   (`onCreated` rejects with a `ConnectionLostError`), nothing is queued, since the server
     *   holds the lead: a notification names it as saved, and the reload that follows the
     *   reconnection shows it. It is shown also when the sheet was dismissed during the call.
     *   The displayed stage is then left as it is, since no card was handed to the pipeline.
     */
    async save() {
        if (this.state.saving) {
            return;
        }
        // Every invalid field shows its own error at once, and nothing is sent or queued.
        const errors = Object.fromEntries(
            VALIDATED_FIELDS.map((fieldName) => [fieldName, this.getFieldError(fieldName)])
        );
        this.state.errors = errors;
        const invalidField = VALIDATED_FIELDS.find((fieldName) => errors[fieldName]);
        if (invalidField) {
            this.getFieldInput(invalidField)?.focus();
            return;
        }
        const name = toText(this.state.name);
        const email = toText(this.state.email_from);
        const revenueText = toText(this.state.expected_revenue);
        const revenue = this.getRevenue();

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
            if (outcome.queued) {
                this.displayCreatedStage(list, stageValue);
            } else {
                // `web_save` answers with the saved records, not with an id.
                const resId = outcome.result?.[0]?.id;
                if (resId) {
                    // The live group of the stage written, resolved now: `undefined` when that
                    // stage is no longer listed, and the pipeline then reloads instead.
                    const liveGroup = list.groups?.find(
                        (group) => group.serverValue === stageValue
                    );
                    try {
                        await onCreated(resId, liveGroup);
                        this.displayCreatedStage(list, stageValue);
                    } catch (error) {
                        if (!(error instanceof ConnectionLostError)) {
                            throw error;
                        }
                        // The lead exists, but its card could not be read: say it was saved, so
                        // that the user does not enter it again.
                        this.notification.add(
                            _t(
                                '"%(lead)s" was saved. It will show in the pipeline once the connection is back.',
                                { lead: name }
                            ),
                            { type: "info" }
                        );
                    }
                }
            }
        } finally {
            if (status(this) !== "destroyed") {
                this.props.close();
            }
        }
    }

    discard() {
        this.props.close();
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * Inline error of a validated field for its current value, empty when the value is valid.
     * Checked here rather than by the inputs' native constraints, which nothing invokes (no form
     * is submitted), so that a direct call of `save()` is held to the same rules.
     *
     * @param {"name" | "email_from" | "expected_revenue"} fieldName
     * @returns {string}
     */
    getFieldError(fieldName) {
        switch (fieldName) {
            case "name":
                return toText(this.state.name) ? "" : _t("The lead name is required.");
            case "email_from": {
                const email = toText(this.state.email_from);
                return !email || isEmail(email) ? "" : _t("The email address is not valid.");
            }
            case "expected_revenue":
                return this.getRevenue() === null
                    ? _t("The expected revenue must be a number.")
                    : "";
            default:
                return "";
        }
    }

    /**
     * @returns {number | null} the expected revenue to write (see `toRevenue`), read from the
     *   state and from the input's own parse failure; `null` when it cannot be written
     */
    getRevenue() {
        return toRevenue(
            toText(this.state.expected_revenue),
            Boolean(this.revenueRef()?.validity?.badInput)
        );
    }

    /**
     * Displays the stage a lead was just created or queued in, through the displayed stage the
     * pipeline controller shares in the env (`crmMobileStage`), which the sheet inherits from the
     * pipeline's scope: the same switch the pipeline makes after a card move. Only while the sheet
     * is open (a sheet dismissed during the call leaves the stage the user is on), only when the
     * pipeline shares its displayed stage, and only when a group of that stage is listed. Nothing
     * is loaded or unfolded: offline, a folded stage is never read.
     *
     * @param {Object} list the pipeline's stage list
     * @param {number | false} stageValue the stage id written
     */
    displayCreatedStage(list, stageValue) {
        const displayedStage = this.env.crmMobileStage;
        if (
            status(this) === "destroyed" ||
            !displayedStage ||
            !list.groups?.some((group) => group.serverValue === stageValue)
        ) {
            return;
        }
        displayedStage.serverValue = stageValue;
    }

    /**
     * @param {"name" | "email_from" | "expected_revenue"} fieldName
     * @returns {HTMLInputElement | null} the input of a validated field, `null` when not rendered
     */
    getFieldInput(fieldName) {
        const refs = {
            name: this.nameRef,
            email_from: this.emailRef,
            expected_revenue: this.revenueRef,
        };
        return refs[fieldName]?.() ?? null;
    }

    /**
     * Names the bottom sheet hosting the content after its "New Lead" title, and declares it
     * modal, as it is: it traps the focus and sits over a backdrop. The framework sheet renders an
     * unnamed `role="dialog"` and manages neither attribute, so they are set once on this
     * instance's own host, which is removed with it. Nothing is set outside a dialog.
     */
    nameHostingSheet() {
        const dialogEl = this.rootRef()?.closest('[role="dialog"]');
        if (!dialogEl) {
            return;
        }
        dialogEl.setAttribute("aria-labelledby", TITLE_ID);
        dialogEl.setAttribute("aria-modal", "true");
    }

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
