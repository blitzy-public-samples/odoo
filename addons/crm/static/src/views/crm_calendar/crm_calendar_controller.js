import { CalendarController } from "@web/views/calendar/calendar_controller";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B82 (VAL-DIS-008): every click path that opens an event (single click via
 * the day/week/month popover, double-click, the side panel and the year
 * view) funnels through this one choke point, either a `FormViewDialog` or
 * a raw `doAction` -- neither checks whether the underlying `crm.lead` form
 * was ever visited offline before issuing its `web_read`.
 */
export class CrmCalendarController extends CalendarController {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    async editRecord(record, context = {}) {
        if (record.id) {
            if (!this.crmOffline.isRecordAvailableOffline(this.env.config.actionId, record.id)) {
                return;
            }
            // The base non-dialog branch (crm's arch never sets
            // `event_open_popup`, so `hasEditDialog` is always false here)
            // builds a brand-new, id-less `ir.actions.act_window` and hands
            // it to `doAction` unawaited. That ad hoc action shares neither
            // the calendar action's `actionId` nor its own `get_views`
            // cache, so its `web_read` misses every offline cache even for
            // a lead `isRecordAvailableOffline` just confirmed was visited.
            // Routing through `switchView` instead keeps the calendar's own
            // action identity, so the form's cache keys match the earlier
            // visit (same idiom as the crm kanban/list `openRecord`
            // overrides). Online keeps the upstream ad hoc action below.
            if (this.crmOffline.isOffline() && !this.model.hasEditDialog) {
                const resIds = Object.keys(this.model.records).map(Number);
                return this.action.switchView("form", { resId: record.id, resIds });
            }
        }
        return super.editRecord(record, context);
    }
}
