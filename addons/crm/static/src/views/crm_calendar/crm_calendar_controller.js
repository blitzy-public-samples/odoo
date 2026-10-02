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
        if (
            record.id &&
            !this.crmOffline.isRecordAvailableOffline(this.env.config.actionId, record.id)
        ) {
            return;
        }
        return super.editRecord(record, context);
    }
}
