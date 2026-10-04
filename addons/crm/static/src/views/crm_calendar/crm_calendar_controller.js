import { CalendarController } from "@web/views/calendar/calendar_controller";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B82 (VAL-DIS-008): double-click, the side panel and the year view all
 * open an event through `editRecord`, either a `FormViewDialog` or a raw
 * `doAction` -- neither checks whether the underlying `crm.lead` form was
 * ever visited offline before issuing its `web_read`, so this guards the
 * one choke point they share.
 *
 * A single click is a *different* path: online, `CalendarCommonRenderer.
 * onClick` calls `openPopover` directly, never `editRecord`, and that
 * popover's own `Record` issues its own uncached `web_read`.
 * `calendar_common_renderer_patch.js` patches `openPopover` to route a
 * single click through this controller's own (guarded) `editRecord`
 * while offline instead, rather than duplicate the uncached-lead check
 * and the visited-lead fallback for a second, always-failing read.
 */
export class CrmCalendarController extends CalendarController {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    async editRecord(record, context = {}) {
        if (record.id) {
            if (!this.crmOffline.isLeadAvailableOffline(this.env.config.actionId, record.id)) {
                return;
            }
            // The base non-dialog branch (crm's arch never sets
            // `event_open_popup`, so `hasEditDialog` is always false here)
            // builds a brand-new, id-less `ir.actions.act_window` and hands
            // it to `doAction` unawaited. That ad hoc action shares neither
            // the calendar action's `actionId` nor its own `get_views`
            // cache, so its `web_read` misses every offline cache even for
            // a lead `isLeadAvailableOffline` just confirmed was visited.
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
