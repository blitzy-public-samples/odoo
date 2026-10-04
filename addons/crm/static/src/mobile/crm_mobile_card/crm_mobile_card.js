import { Component, t, useProps } from "@odoo/owl";
import { formatMonetary } from "@web/views/fields/formatters";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * VAL-MOBILE-007/008 (architecture.md §3.4): the mobile pipeline's own
 * card. `CrmKanbanRenderer`'s small-screen branch (crm_kanban_renderer.xml)
 * renders this instead of the base `web.KanbanRecord` + the kanban arch's
 * own "card" template, so its content is a fixed set of fields (name,
 * partner name, expected revenue, pending-sync badge) rather than
 * configurable through the arch -- the same "hardcoded fields" choice
 * architecture.md §3.4 makes for the quick-create sheet. The whole card
 * is the one touch target (tapping it opens the lead, exactly like the
 * base `KanbanRecord` it replaces); there is no second interactive
 * element inside it, so the ≥44x44 CSS px requirement (VAL-MOBILE-007)
 * only has to hold for the card's own root (crm_mobile_card.xml /
 * crm_mobile_card.scss).
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

    onClick() {
        return this.props.openRecord(this.record);
    }
}
