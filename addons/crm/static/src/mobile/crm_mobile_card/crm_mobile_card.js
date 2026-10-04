import { Component, t, useProps } from "@odoo/owl";
import { formatMonetary } from "@web/views/fields/formatters";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * VAL-MOBILE-007/008 (architecture.md §3.4): the mobile pipeline's own
 * card. `CrmKanbanRenderer`'s small-screen branch (crm_kanban_renderer.xml)
 * renders this instead of the base `web.KanbanRecord` + the kanban arch's
 * own "card" template, so its content is a fixed set of fields (name,
 * partner name, expected revenue, pending-sync badge, priority stars)
 * rather than configurable through the arch -- the same "hardcoded
 * fields" choice architecture.md §3.4 makes for the quick-create sheet.
 * The card body is the touch target that opens the lead (tapping it,
 * exactly like the base `KanbanRecord` it replaces); the priority stars
 * (orchestrator-triage.md round-1 blocker 7, VAL-MOBILE-017) are the one
 * other interactive element, each its own ≥44x44 CSS px target with
 * `t-on-click.stop` so tapping a star updates the priority instead of
 * opening the form (crm_mobile_card.xml / crm_mobile_card.scss).
 */
export class CrmMobileCard extends Component {
    static template = "crm.CrmMobileCard";
    props = useProps({
        record: t.object(),
        openRecord: t.function(),
    });

    setup() {
        // VAL-MOBILE-002: every mobile component reads the framework
        // through this hook, never `usePlugin(OfflinePlugin)` directly.
        this.crmOffline = useCrmOffline();
    }

    get record() {
        return this.props.record;
    }

    get partnerName() {
        return this.record.data.partner_id?.display_name || "";
    }

    get expectedRevenueText() {
        const value = this.record.data.expected_revenue;
        if (typeof value !== "number") {
            // Not every caller's arch fetches this field (e.g. a unit
            // test arch that never references it, same reasoning as
            // `CrmMobilePipeline.groupAggregate`'s own `isReady` guard) --
            // render nothing rather than "false"/"NaN"
            // (`formatMonetary`'s own `false` guard only covers the
            // literal boolean, not `undefined`).
            return "";
        }
        return formatMonetary(value, {
            data: this.record.data,
            currencyField: "company_currency",
        });
    }

    /**
     * VAL-MOBILE-008: pending if any queued `crm.lead` call (or
     * `mail.activity` create) names this lead (`pendingForLead`), or --
     * when the card's own record data loaded `activity_ids` (the real
     * pipeline arch always does; some unit-test archs don't need to) --
     * a queued `mail.activity.action_done` targets one of them.
     * `action_done([[id]])` carries only the activity id, never the
     * lead id, so `pendingForLead` alone can't see it
     * (offline_hooks.js's own doc on that function); combining both
     * here is what makes a queued "mark done" show the badge too.
     */
    get isPendingSync() {
        const leadId = this.record.resId;
        if (!leadId) {
            return false;
        }
        if (this.crmOffline.pendingForLead(leadId).length) {
            return true;
        }
        const activityIds = this.record.data.activity_ids;
        const ids = activityIds ? activityIds.records.map((r) => r.resId) : [];
        return Boolean(ids.length) && this.crmOffline.pendingActivities(leadId, ids).length > 0;
    }

    /**
     * orchestrator-triage.md blocker 7 (VAL-MOBILE-017): a priority
     * control on the card itself, not only reachable from the form. The
     * `priority` field is declared on `crm_case_kanban_view_leads` with
     * `groups="base.group_user"` (crm_lead_views.xml), so it is only in
     * `activeFields` -- and therefore only in `record.data` -- for users
     * in that group; render nothing for a caller whose arch never
     * requested it either (same reasoning as `expectedRevenueText`
     * above). `record.fields.priority.selection` is still present even
     * when the field isn't active, so gate on `activeFields`, not on
     * `fields`.
     */
    get hasPriority() {
        return "priority" in this.record.activeFields;
    }

    /**
     * `AVAILABLE_PRIORITIES` is `[['0','Low'], ['1','Medium'], ['2',
     * 'High'], ['3','Very High']] (crm_stage.py). One star per option
     * except the first: clicking the current top star resets to that
     * first value, the same toggle `web.PriorityField` uses
     * (priority_field.js `onStarClicked`) -- stars, not a 4-state
     * picker including "no priority" as its own star.
     */
    get priorityStars() {
        if (!this.hasPriority) {
            return [];
        }
        const options = this.record.fields.priority.selection;
        const current = this.record.data.priority;
        const currentIndex = options.findIndex(([value]) => value === current);
        return options
            .slice(1)
            .map(([value, label], index) => ({
                value,
                label,
                // `active` (filled) is cumulative, like the star rating
                // it renders; `checked` is the single star matching the
                // record's actual value, which is what a `role="radio"`
                // in a `radiogroup` must report (`web.PriorityField`'s
                // own `t-att-aria-checked="value_index === this.index"`)
                // -- the group has exactly one selected value even
                // though several stars render filled.
                active: index + 1 <= currentIndex,
                checked: index + 1 === currentIndex,
            }));
    }

    /**
     * `record.update()` auto-saves a kanban record that isn't already in
     * edition (`Record.update`, `canSaveOnUpdate`), so this reaches the
     * framework's normal save path -- `web_save` online, the same call
     * queued through `_offlineSave` on a `ConnectionLostError` offline --
     * exactly like `web.PriorityField`'s own `updateRecord`. No
     * `queueCall`/`scheduleORM` here: the framework already queues a
     * record save, and calling `scheduleORM` directly as well would
     * double-queue the write.
     */
    onPriorityClick(value) {
        const options = this.record.fields.priority.selection;
        const next = this.record.data.priority === value ? options[0][0] : value;
        return this.record.update({ priority: next });
    }

    onClick() {
        return this.props.openRecord(this.record);
    }
}
