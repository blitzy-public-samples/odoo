/**
 * Lead card of the small-screen CRM pipeline (`CrmMobilePipeline`).
 *
 * Only the mobile pipeline renders it, so desktop never sees it. The template
 * (`crm.CrmMobileLeadCard`, sibling `.xml`) uses plain HTML only, hence no `static components`.
 *
 * The card shows one lead, either a framework record of `crm.lead` (`record`) or a queued lead
 * create that has not reached the server yet (`pendingCall`), and offers, for a persisted lead:
 * - a stage list: choosing a stage asks the pipeline to move the card through the framework
 *   kanban move (choosing the won stage is mark-won); the framework queues the stage write offline;
 * - Log call and Follow-up: `mail.activity` creates (`web_save`), queued offline;
 * - an activity list with Mark done: `action_done` online, `action_archive` (state only) offline.
 *   The pipeline loads a bounded page of activities with their total count; the count shows the
 *   total, and when the page misses some the list ends with "Show all (N)" online or "N more
 *   activities are not available offline" offline, so no activity is hidden silently.
 *
 * Offline rules:
 * - All offline state is read through `useCrmOffline()`. The card keeps no dirty flag and persists
 *   nothing: the pending-sync badge and the pending activity rows are derived from the live
 *   framework offline queue, memoized and recomputed on every queue change, so they clear when
 *   replay or a systray discard removes the entry. A pending lead create stays on screen as long
 *   as the pipeline holds it (through a sync window, until the reconciliation reload), but its
 *   badge follows the live queue: it clears as soon as its own entry has been replayed.
 * - The card queues only `mail.activity` `web_save` and `mail.activity` `action_archive`, the two
 *   families the shared offline systray renders, through `runOrQueue`.
 * - Activities need the lead's server id, so a pending lead create offers no action at all, and an
 *   activity that is itself a pending create offers no Mark done (it has no server id either).
 * - Meeting and upload activity types are never offered for creation (a meeting needs a calendar
 *   round-trip, an upload a file transfer). Marking any persisted activity done is offered whatever
 *   its category, because archiving only writes `active`.
 * - The activity owner is always the session user: no assignee picker is offered.
 * - The handlers that open the lead, toggle a panel, move the card or write an activity
 *   (`onOpenCard`, `toggleStageList`, `onChooseStage`, `onLogCall`, `toggleFollowUp`,
 *   `onSaveFollowUp`, `onMarkDone`, `toggleActivities`) re-check their own predicate first, so a
 *   direct call, without a DOM event or on a control the template renders disabled, does nothing
 *   while that predicate fails. The follow-up input handlers (`onFollowUpType`,
 *   `onFollowUpSummary`, `onFollowUpDate`) only copy their event's value into the card's local
 *   state, and need that event; `onCancelFollowUp` only resets the follow-up form.
 * - A call that completes after the card was destroyed (stage navigation, a filter, a move or a
 *   reload re-keyed or removed it) writes no card state. After an online activity write that
 *   succeeded, the card still asks the pipeline to read the lead's activities again; the pipeline
 *   reads them only while it is alive and displays the lead.
 */

import { Component, computed, proxy, status, t, useProps } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { deserializeDate, formatDate, serializeDate, today } from "@web/core/l10n/dates";
import { formatMonetary } from "@web/views/fields/formatters";
import { user } from "@web/core/user";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

/**
 * Activity categories never offered for creation: a meeting needs a calendar round-trip and an
 * upload a file transfer, neither of which can be queued.
 */
const NON_CREATABLE_CATEGORIES = ["meeting", "upload_file"];

/** Keyword arguments of every `mail.activity` `web_save` the card issues or queues. */
function activityCreateKwargs() {
    return { context: {}, specification: {} };
}

/**
 * @typedef {{ key: string | number, value: { model: string, method: string, args: any[],
 *   kwargs: Object, extras: Object } }} QueueEntry an entry of the framework offline queue,
 *   exactly as the framework stores it
 */

export class CrmMobileLeadCard extends Component {
    static template = "crm.CrmMobileLeadCard";

    props = useProps({
        /** Framework record of `crm.lead`; absent for a pending create. */
        record: t.any().optional(),
        /** Queue entry `{key, value}` of a pending `crm.lead` create; absent for a record. */
        pendingCall: t.object().optional(),
        /** The displayed stage group. */
        group: t.any(),
        /** Every group of the pipeline (folded ones included), for the stage list. */
        stages: t.array(),
        /**
         * Cached activities of the lead, a bounded page of them; `null` when not loaded and not
         * cached.
         */
        activities: t.or([t.array(), t.literal(null)]).optional(null),
        /**
         * The server's total count of the lead's activities, read with `activities`; `null` when
         * unknown. When it exceeds the page, the count shows the total and the list says so.
         */
        activityTotal: t.or([t.number(), t.literal(null)]).optional(null),
        /** `(resId) => …`: online, the pipeline reads every activity of the lead. */
        onShowAllActivities: t.function().optional(),
        /** Cached creatable activity types `{id, display_name, category}`. */
        activityTypes: t.or([t.array(), t.literal(null)]).optional(null),
        /** Whether the lead's form is unavailable offline (the card is dimmed). */
        unavailable: t.boolean().optional(false),
        /** `serverValue` (stage id) of the displayed stage. */
        displayedStageValue: t.or([t.number(), t.boolean()]),
        /** `serverValue` of the framework group holding the record. */
        frameworkStageValue: t.or([t.number(), t.boolean()]).optional(),
        /** `(record) => …`: the pipeline opens the form or shows the offline helper. */
        onOpen: t.function().optional(),
        /** `async (record, targetGroup) => …`: the pipeline moves the card. */
        onMove: t.function().optional(),
        /** `(resId) => …`: called after an online activity create or mark-done succeeded. */
        onActivitiesChanged: t.function().optional(),
    });

    setup() {
        this.crmOffline = useCrmOffline();
        this.state = proxy({
            stageListOpen: false,
            followUpOpen: false,
            activitiesOpen: false,
            typeId: null,
            summary: "",
            date: serializeDate(today()),
            // blocks double submission while a call (or a move) is in flight
            busy: false,
        });
    }

    // -------------------------------------------------------------------------
    // Getters: lead
    // -------------------------------------------------------------------------

    /** Whether the card shows a queued lead create rather than a record. */
    get isPending() {
        return !!this.props.pendingCall;
    }

    /** Whether the lead exists on the server, i.e. has an id activities can target. */
    get isPersisted() {
        return !this.isPending && !!this.props.record?.resId;
    }

    /** Values of the queued create (the quick-create values), or an empty object. */
    get pendingValues() {
        return this.props.pendingCall?.value?.args?.[1] ?? {};
    }

    get leadLabel() {
        if (this.isPending) {
            return this.pendingValues.name || "";
        }
        const data = this.props.record?.data;
        return data?.display_name || data?.name || "";
    }

    get partnerName() {
        if (this.isPending) {
            return this.pendingValues.contact_name || "";
        }
        const data = this.props.record?.data;
        return data?.partner_id?.display_name || data?.contact_name || "";
    }

    /** Formatted expected revenue, in the lead's company currency. */
    get revenue() {
        if (this.isPending) {
            const value = this.pendingValues.expected_revenue;
            if (typeof value !== "number") {
                return "";
            }
            // The quick-create values carry no currency: use the stage's leads' company currency,
            // or else the currency of the user's current company (a new lead's company default).
            const currencyId =
                this.props.group?.list?.records?.[0]?.data?.company_currency?.id ??
                user.activeCompany?.currency_id;
            return formatMonetary(value, { currencyId });
        }
        const data = this.props.record?.data;
        if (!data) {
            return "";
        }
        return formatMonetary(data.expected_revenue ?? false, {
            currencyId: data.company_currency?.id,
        });
    }

    /**
     * Whether the lead has a write the server has not received yet. Derived from the live
     * framework queue: it clears when replay or a systray discard removes the entry.
     *
     * A pending create counts only while its own key is still queued. The pipeline keeps showing a
     * replayed create from its sync-window copy until the reconciliation reload; that card stays,
     * without the badge. A create parked with an error is re-queued under the same key and keeps it.
     *
     * Memoized (as every queue projection of the card): the queue is read again only when the
     * queue signal or the props change, not on every access.
     */
    get isPendingSync() {
        return this._pendingSync();
    }

    _pendingSync = computed(() => {
        if (this.isPending) {
            // The queue is keyed by object property, so keys compare as strings (an entry the
            // framework rebuilt from its storage may carry the same key as a number or a string).
            const key = String(this.props.pendingCall.key);
            return this.crmOffline.queuedEntries().some((entry) => String(entry.key) === key);
        }
        return this.crmOffline.isRecordPendingSync(this.props.record);
    });

    // -------------------------------------------------------------------------
    // Getters: activities
    // -------------------------------------------------------------------------

    /** Cached activity types that can be created (meeting and upload types never are). */
    get creatableTypes() {
        return (this.props.activityTypes ?? []).filter(
            (type) => !NON_CREATABLE_CATEGORIES.includes(type.category)
        );
    }

    /** The first cached `phonecall` type, used by Log call. */
    get phonecallType() {
        return this.creatableTypes.find((type) => type.category === "phonecall");
    }

    get canLogCall() {
        return this.isPersisted && !!this.phonecallType && !this.state.busy;
    }

    /** Usable with any creatable type, also when no `phonecall` type is cached. */
    get canFollowUp() {
        return this.isPersisted && this.creatableTypes.length > 0 && !this.state.busy;
    }

    /**
     * Queued activity calls of the lead, as stored by the framework (never copied or mutated), in
     * replay order: the order they were made in, so the pending rows list them in that order.
     * Memoized: the queue is scanned once per queue change, whatever the number of readers.
     *
     * @returns {QueueEntry[]}
     */
    get pendingActivityEntries() {
        return this._pendingActivityEntries();
    }

    _pendingActivityEntries = computed(() =>
        this.isPersisted ? this.crmOffline.pendingActivityCalls(this.props.record.resId) : []
    );

    /** @returns {QueueEntry[]} the lead's queued activity creates, in replay order (memoized) */
    get pendingActivityCreates() {
        return this._pendingActivityCreates();
    }

    _pendingActivityCreates = computed(() =>
        this.pendingActivityEntries.filter((entry) => entry.value.method === "web_save")
    );

    /** @returns {Set<number>} ids of the activities whose mark-done is queued (memoized) */
    get pendingArchivedIds() {
        return this._pendingArchivedIds();
    }

    _pendingArchivedIds = computed(
        () =>
            new Set(
                this.pendingActivityEntries
                    .filter((entry) => entry.value.method === "action_archive")
                    .map((entry) => entry.value.args?.[0]?.[0])
            )
    );

    /** Cached activities of the lead, as read by the pipeline (a bounded page). */
    get activityRows() {
        return this.props.activities ?? [];
    }

    /** Activities of the lead the server counted but the loaded page does not hold. */
    get hiddenActivityCount() {
        const total = this.props.activityTotal;
        return typeof total === "number" ? Math.max(0, total - this.activityRows.length) : 0;
    }

    /** Every activity of the lead: its server total (or loaded rows) plus its queued creates. */
    get activityCount() {
        return (
            Math.max(this.props.activityTotal ?? 0, this.activityRows.length) +
            this.pendingActivityCreates.length
        );
    }

    get showAllActivitiesLabel() {
        return _t("Show all (%(count)s)", { count: this.props.activityTotal });
    }

    get hiddenActivitiesLabel() {
        return _t("%(count)s more activities are not available offline", {
            count: this.hiddenActivityCount,
        });
    }

    get noActivitiesLabel() {
        return this.props.activities === null && this.crmOffline.isOffline()
            ? _t("Activities are not available offline")
            : _t("No activities");
    }

    // -------------------------------------------------------------------------
    // Getters: stages
    // -------------------------------------------------------------------------

    /**
     * Stage values the card cannot move to: the displayed stage and, when a queued write placed
     * the card away from its framework group, that group's stage too. Moving into the group that
     * already holds the record only resequences it and writes no stage, so it would be a no-op.
     *
     * @returns {(number | false)[]}
     */
    get disabledStageValues() {
        const { displayedStageValue, frameworkStageValue } = this.props;
        const values = [displayedStageValue];
        if (frameworkStageValue !== undefined && frameworkStageValue !== displayedStageValue) {
            values.push(frameworkStageValue);
        }
        return values;
    }

    get stageOptions() {
        const disabledValues = this.disabledStageValues;
        return this.props.stages.map((group) => ({
            group,
            key: group.id,
            label: group.displayName,
            selected: group.serverValue === this.props.displayedStageValue,
            disabled: this.state.busy || disabledValues.includes(group.serverValue),
        }));
    }

    // -------------------------------------------------------------------------
    // Display helpers
    // -------------------------------------------------------------------------

    /**
     * @param {number} typeId
     * @returns {string} the name of a cached activity type, or an empty string
     */
    typeLabel(typeId) {
        const type = (this.props.activityTypes ?? []).find((tp) => tp.id === typeId);
        return type?.display_name || "";
    }

    /**
     * @param {QueueEntry} entry a queued activity create
     * @returns {string}
     */
    pendingCreateTypeLabel(entry) {
        return (
            entry.value.extras?.changes?.activity_type_id ||
            this.typeLabel(entry.value.args?.[1]?.activity_type_id)
        );
    }

    /**
     * @param {string | false | undefined} value a serialized date (`YYYY-MM-DD`)
     * @returns {string} the date in the user's format, or an empty string
     */
    formatDeadline(value) {
        if (!value) {
            return "";
        }
        const date = deserializeDate(value);
        return date.isValid ? formatDate(date) : "";
    }

    /**
     * @param {Object} activity a cached `mail.activity` record
     * @returns {string}
     */
    activityLabel(activity) {
        return activity.activity_type_id?.display_name || _t("Activity");
    }

    // -------------------------------------------------------------------------
    // Handlers: card and stages
    // -------------------------------------------------------------------------

    /**
     * Opens the lead (the pipeline decides between the form and the offline helper). A tap on the
     * name opens it too, as the upstream mobile main flow expects. Taps on the controls never do.
     *
     * @param {MouseEvent} [ev]
     */
    onOpenCard(ev) {
        if (this.isPending || !this.props.record) {
            return;
        }
        if (ev?.target?.closest?.(".o_crm_mobile_lead_card_controls")) {
            return;
        }
        this.props.onOpen?.(this.props.record);
    }

    toggleStageList() {
        if (this.isPending || !this.props.record) {
            return;
        }
        const open = !this.state.stageListOpen;
        this._closePanels();
        this.state.stageListOpen = open;
    }

    /**
     * Moves the card to a stage through the pipeline (framework kanban move, queued offline).
     * Choosing the won stage is mark-won: the server turns that stage write into won, and the CRM
     * kanban model shows the rainbowman online only.
     *
     * @param {Object} group the target stage group
     */
    async onChooseStage(group) {
        if (this.isPending || !this.props.record || this.state.busy || !group) {
            return;
        }
        if (this.disabledStageValues.includes(group.serverValue)) {
            return;
        }
        this.state.stageListOpen = false;
        this.state.busy = true;
        try {
            await this.props.onMove?.(this.props.record, group);
        } finally {
            // A move re-keys or removes the card: a destroyed card gets no state write.
            if (status(this) !== "destroyed") {
                this.state.busy = false;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Handlers: activities
    // -------------------------------------------------------------------------

    /**
     * Creates an activity on the lead for the session user, or queues the create when offline (or
     * when the connection drops during the call). The values are exactly the client-resolvable
     * ones: the server resolves `res_model_id` from `res_model` on replay.
     *
     * @private
     * @param {{ id: number, display_name: string }} type
     * @param {string} summary
     * @param {string} dateDeadline serialized date (`YYYY-MM-DD`)
     * @returns {Promise<{ queued: boolean }>}
     */
    async _createActivity(type, summary, dateDeadline) {
        const record = this.props.record;
        const vals = {
            res_model: "crm.lead",
            res_id: record.resId,
            activity_type_id: type.id,
            summary,
            date_deadline: dateDeadline,
            user_id: user.userId,
        };
        this.state.busy = true;
        try {
            const res = await this.crmOffline.runOrQueue({
                // Unscoped ORM: the ORM scoped to the card rejects a result that arrives after the
                // card was destroyed, and the completion below must still request the refresh then.
                online: () =>
                    this.crmOffline.orm.unscoped.webSave(
                        "mail.activity",
                        [],
                        { ...vals },
                        activityCreateKwargs()
                    ),
                queue: {
                    model: "mail.activity",
                    method: "web_save",
                    args: [[], vals],
                    kwargs: activityCreateKwargs(),
                    extras: {
                        displayName: `${type.display_name}: ${this.leadLabel}`,
                        changes: {
                            activity_type_id: type.display_name,
                            summary,
                            date_deadline: dateDeadline,
                        },
                    },
                },
            });
            if (!res.queued) {
                // Requested even when this card was destroyed meanwhile: a reload re-keys the card
                // of a lead that stays displayed, and its new card would keep the activities read
                // before this write. The pipeline drops the request when it was destroyed itself
                // or no longer displays the lead, so no read starts for a lead nobody shows.
                this.props.onActivitiesChanged?.(record.resId);
            }
            return res;
        } finally {
            if (status(this) !== "destroyed") {
                this.state.busy = false;
            }
        }
    }

    /** Logs a call for today with the first cached `phonecall` type. */
    async onLogCall() {
        if (!this.canLogCall) {
            return;
        }
        const type = this.phonecallType;
        return this._createActivity(type, type.display_name, serializeDate(today()));
    }

    toggleFollowUp() {
        if (!this.canFollowUp) {
            return;
        }
        const open = !this.state.followUpOpen;
        this._closePanels();
        if (open) {
            const types = this.creatableTypes;
            if (!types.some((type) => type.id === this.state.typeId)) {
                this.state.typeId = types[0].id;
            }
            this.state.summary = "";
            this.state.date = serializeDate(today());
        }
        this.state.followUpOpen = open;
    }

    /** Schedules the follow-up entered in the inline form, then closes the form. */
    async onSaveFollowUp() {
        if (!this.canFollowUp) {
            return;
        }
        const type = this.creatableTypes.find((tp) => tp.id === Number(this.state.typeId));
        if (!type) {
            return;
        }
        await this._createActivity(type, this.state.summary.trim(), this._followUpDeadline());
        if (status(this) !== "destroyed") {
            this.onCancelFollowUp();
        }
    }

    onCancelFollowUp() {
        this.state.followUpOpen = false;
        this.state.summary = "";
        this.state.date = serializeDate(today());
    }

    /** @param {Event} ev change of the activity type `<select>` */
    onFollowUpType(ev) {
        this.state.typeId = Number(ev.target.value);
    }

    /** @param {InputEvent} ev input in the summary field */
    onFollowUpSummary(ev) {
        this.state.summary = ev.target.value;
    }

    /** @param {InputEvent} ev input in the date field (`YYYY-MM-DD`, or empty when cleared) */
    onFollowUpDate(ev) {
        this.state.date = ev.target.value;
    }

    /**
     * Marks a persisted activity done: `action_done` online; offline (or when the connection
     * drops), a queued `action_archive`, a state change only, with no feedback message, no
     * calendar event and no upload, whatever the activity's category.
     *
     * @param {Object} activity a cached `mail.activity` record
     */
    async onMarkDone(activity) {
        if (!this.isPersisted || !activity?.id || this.state.busy) {
            return;
        }
        if (this.pendingArchivedIds.has(activity.id)) {
            return;
        }
        const resId = this.props.record.resId;
        this.state.busy = true;
        try {
            const res = await this.crmOffline.runOrQueue({
                // Unscoped ORM, as in `_createActivity`.
                online: () =>
                    this.crmOffline.orm.unscoped.call("mail.activity", "action_done", [
                        [activity.id],
                    ]),
                queue: {
                    model: "mail.activity",
                    method: "action_archive",
                    args: [[activity.id]],
                    kwargs: {},
                    extras: {
                        displayName: `${this.activityLabel(activity)}: ${this.leadLabel}`,
                        changes: {},
                    },
                },
            });
            if (!res.queued) {
                // Requested even when this card was destroyed meanwhile, as in `_createActivity`.
                this.props.onActivitiesChanged?.(resId);
            }
        } finally {
            if (status(this) !== "destroyed") {
                this.state.busy = false;
            }
        }
    }

    /** Shows or hides the activity list (read-only listing, always available). */
    toggleActivities() {
        if (this.isPending) {
            return;
        }
        const open = !this.state.activitiesOpen;
        this._closePanels();
        this.state.activitiesOpen = open;
    }

    /**
     * Asks the pipeline to read every activity of the lead. Online only, and only when the loaded
     * page misses some: offline the expanded read was never cached.
     */
    onShowAllActivities() {
        if (
            !this.isPersisted ||
            !this.hiddenActivityCount ||
            this.crmOffline.isOffline() ||
            !this.props.onShowAllActivities
        ) {
            return;
        }
        return this.props.onShowAllActivities(this.props.record.resId);
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /** Closes the stage list, the follow-up form and the activity list. */
    _closePanels() {
        this.state.stageListOpen = false;
        this.state.followUpOpen = false;
        this.state.activitiesOpen = false;
    }

    /**
     * @private
     * @returns {string} the follow-up deadline entered (a `YYYY-MM-DD` date input value), or
     *   today when the field was cleared or holds no valid date
     */
    _followUpDeadline() {
        const value = this.state.date;
        if (value && deserializeDate(value).isValid) {
            return value;
        }
        return serializeDate(today());
    }
}
