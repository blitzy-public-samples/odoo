import { Component, onWillStart, signal, useProps } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { ConnectionLostError } from "@web/core/network/rpc";
import { formatDate, today } from "@web/core/l10n/dates";
import { user } from "@web/core/user";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

// architecture.md §3.3 "Offline activity panel": meeting-category types
// open the calendar-event flow (`action_create_calendar_event`), which has
// no offline equivalent (VAL-DATA-012); upload-category types expect a
// file attachment to auto-mark themselves done, which this panel's single
// "Done" control doesn't model. Both are excluded from every selector this
// panel offers, for Schedule and for Log a call alike.
const EXCLUDED_ACTIVITY_TYPE_CATEGORIES = ["meeting", "upload_file"];

// The domain mirrors `mail.activity.activity_type_id`'s own domain
// (addons/mail/models/mail_activity.py): generic types, plus types scoped
// to crm.lead specifically.
const ACTIVITY_TYPE_DOMAIN = ["|", ["res_model", "=", false], ["res_model", "=", "crm.lead"]];

/**
 * Offline activity panel on the lead form (architecture.md §3.3,
 * VAL-DATA-008..016). Renders only while offline (`crmOffline.isOffline()`
 * -- online, the template produces no DOM at all, so the desktop online
 * look is unchanged, VAL-DATA-009): it lists the lead's server activities
 * (loaded via the sibling `activity_ids` field the inheriting view adds)
 * together with everything already queued for this lead, each marked
 * "pending sync", and offers three producers:
 *  - Schedule: queues a client-resolved `mail.activity.create` (one call,
 *    no onchange, no `mail.activity.schedule` wizard, no `name_create`).
 *  - Done (on a server activity only): queues `action_done([[id]])` and
 *    nothing else -- no feedback dialog, no "Done & Schedule Next".
 *  - Log a call: queues one `crm.lead.action_log_call` call.
 * All three are plain `scheduleORM` calls through `useCrmOffline()`,
 * exactly like `CrmFormController`'s existing Won/Restore producers --
 * no new queue, store or cache. Local UI state uses OWL's `signal`
 * primitives (this OWL build has no `useState`, AGENTS.md section 2's
 * "state lives in signal/signal.Object/computed"); `t-model` in the
 * template binds straight to a signal (owl.js's own `t-model` compiler
 * expects "a function with a 'set' method", which is exactly a signal's
 * shape).
 */
export class CrmLeadActivityPanel extends Component {
    static template = "crm.CrmLeadActivityPanel";
    props = useProps(standardWidgetProps);

    types = signal.Array([]);
    scheduleTypeId = signal(null);
    scheduleSummary = signal("");
    scheduleDeadline = signal(today().toISODate());
    logCallTypeId = signal(null);
    logCallSummary = signal("");
    logCallNote = signal("");

    setup() {
        this.orm = useService("orm");
        this.user = user;
        this.crmOffline = useCrmOffline();

        onWillStart(() => this._loadActivityTypes());
    }

    /**
     * Fetches the activity types usable offline through the framework's
     * own RPC disk cache (`orm.cache({type: "disk"})`), exactly like
     * `CrmSearchModel._initSwitcher`'s team-switcher fetch
     * (architecture.md §3.2 item 3): the call's args/kwargs never change
     * between online and offline runs, so a later offline run with an
     * identical request hits the same disk entry. Unlike the many2x cache
     * (`cacheMany2XSearch`), which keeps only `id`/`display_name`, the RPC
     * disk cache keeps the whole result -- the only way this panel can
     * know a cached type's `category` offline, which it needs to exclude
     * meeting/upload types (VAL-DATA-012). A true cache miss (this device
     * never loaded this exact request online) rejects with
     * `ConnectionLostError` while offline: `types` stays empty, and every
     * control below that needs a type is disabled (VAL-DATA-011). Called
     * unconditionally in `onWillStart`, online or offline, so a form
     * visited online always warms the cache for a later offline session
     * -- the panel itself just never renders anything while online (see
     * the template).
     */
    async _loadActivityTypes() {
        let types;
        try {
            types = await this.orm
                .cache({ type: "disk", update: "always" })
                .searchRead("mail.activity.type", ACTIVITY_TYPE_DOMAIN, ["name", "category"]);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            types = [];
        }
        types = types.filter((type) => !EXCLUDED_ACTIVITY_TYPE_CATEGORIES.includes(type.category));
        this.types.set(types);
        if (types.length) {
            this.scheduleTypeId.set(types[0].id);
            this.logCallTypeId.set(types[0].id);
        }
    }

    get record() {
        return this.props.record;
    }

    /** VAL-DATA-008: a lead created offline has no server id yet. */
    get isLeadSynced() {
        return !!this.record.resId;
    }

    get canSchedule() {
        return this.isLeadSynced && this.types().length > 0;
    }

    get canLogCall() {
        return this.isLeadSynced && this.types().length > 0;
    }

    _typeName(typeId) {
        return this.types().find((type) => type.id === typeId)?.name || "";
    }

    formatDeadline(deadline) {
        if (!deadline) {
            return "";
        }
        // A server activity's `date_deadline` comes back from
        // `record.data` as a Luxon `DateTime`; a still-queued create's own
        // vals (built by this panel, see `onClickSchedule`) keep the plain
        // "YYYY-MM-DD" string the date input produced.
        return typeof deadline === "string" ? deadline : formatDate(deadline);
    }

    get serverActivityIds() {
        const activityIds = this.record.data.activity_ids;
        return activityIds ? activityIds.records.map((r) => r.resId) : [];
    }

    get pendingEntries() {
        return this.crmOffline.pendingActivities(this.record.resId, this.serverActivityIds);
    }

    /** Rows to render: the lead's server activities, plus everything already queued for it. */
    get rows() {
        const pending = this.pendingEntries;
        const pendingDoneIds = new Set(
            pending.filter((entry) => entry.kind === "done").map((entry) => entry.value.args[0][0])
        );
        const activityIds = this.record.data.activity_ids;
        const serverRows = (activityIds ? activityIds.records : []).map((activity) => ({
            key: `server-${activity.resId}`,
            activityId: activity.resId,
            type: activity.data.activity_type_id?.display_name || "",
            summary: activity.data.summary || "",
            deadline: this.formatDeadline(activity.data.date_deadline),
            user: activity.data.user_id?.display_name || "",
            pendingSync: pendingDoneIds.has(activity.resId),
            canMarkDone: !pendingDoneIds.has(activity.resId),
            isLogCall: false,
        }));
        const createRows = pending
            .filter((entry) => entry.kind === "create")
            .map((entry) => {
                const vals = entry.value.args[0][0];
                return {
                    key: `create-${entry.key}`,
                    activityId: false,
                    type: this._typeName(vals.activity_type_id),
                    summary: vals.summary || "",
                    deadline: this.formatDeadline(vals.date_deadline),
                    user: vals.user_id === this.user.userId ? this.user.name : "",
                    pendingSync: true,
                    canMarkDone: false, // VAL-DATA-014: not usable until it syncs
                    isLogCall: false,
                };
            });
        const logCallRows = pending
            .filter((entry) => entry.kind === "log_call")
            .map((entry) => {
                const [, activityTypeId, summary, , userId] = entry.value.args;
                return {
                    key: `log-call-${entry.key}`,
                    activityId: false,
                    type: this._typeName(activityTypeId),
                    summary: summary || "",
                    deadline: "",
                    user: userId === this.user.userId ? this.user.name : "",
                    pendingSync: true,
                    canMarkDone: false,
                    isLogCall: true,
                };
            });
        return [...serverRows, ...createRows, ...logCallRows];
    }

    _extras() {
        return getScheduleORMExtras(this.record.model, [this.record]);
    }

    /** VAL-DATA-013: queues `action_done([[id]])` only, nothing else. */
    onClickDone(activityId) {
        if (!this.crmOffline.isOffline()) {
            return;
        }
        this.crmOffline.queueCall(
            "mail.activity",
            "action_done",
            [[activityId]],
            {},
            this._extras()
        );
    }

    /** VAL-DATA-010: one client-resolved `mail.activity.create`. */
    onClickSchedule() {
        if (!this.crmOffline.isOffline() || !this.canSchedule) {
            return;
        }
        const vals = {
            res_model: "crm.lead",
            res_id: this.record.resId,
            activity_type_id: this.scheduleTypeId(),
            summary: this.scheduleSummary() || false,
            date_deadline: this.scheduleDeadline(),
            user_id: this.user.userId,
        };
        this.crmOffline.queueCall("mail.activity", "create", [[vals]], {}, this._extras());
        this.scheduleSummary.set("");
    }

    /** VAL-DATA-015: one queued `crm.lead.action_log_call`, nothing else. */
    onClickLogCall() {
        if (!this.crmOffline.isOffline() || !this.canLogCall) {
            return;
        }
        this.crmOffline.queueCall(
            "crm.lead",
            "action_log_call",
            [
                [this.record.resId],
                this.logCallTypeId(),
                this.logCallSummary() || false,
                this.logCallNote() || false,
                this.user.userId,
            ],
            {},
            this._extras()
        );
        this.logCallSummary.set("");
        this.logCallNote.set("");
    }
}

registry.category("view_widgets").add("crm_lead_activity_panel", {
    component: CrmLeadActivityPanel,
});
