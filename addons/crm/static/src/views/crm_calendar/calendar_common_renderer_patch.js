import { CalendarCommonRenderer } from "@web/views/calendar/calendar_common/calendar_common_renderer";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B82 (VAL-DIS-008): a single click on a calendar event never reaches
 * `CrmCalendarController.editRecord` (`crm_calendar_controller.js`) --
 * `onEventClick`'s single-click branch calls `onClick` -> `openPopover`
 * directly (`calendar_common_renderer.js`), which mounts
 * `CalendarCommonPopover`/`CardPopover`. That popover's own standalone
 * `Record` issues a bare `web_read` with no offline cache of its own
 * (`card_popover.js`, `model/record.js`) -- unlike the form view's record,
 * it never succeeds offline, visited or not. Rather than duplicate
 * `editRecord`'s uncached-lead check and its visited-lead `switchView`
 * fallback here, route a single click through `editRecord` itself (the
 * same prop function the popover's own footer button would call) while
 * offline: unavailable leads get the same "do nothing" `editRecord`
 * already gives them, and visited leads open through the form instead of
 * the popover's always-failing read. Scoped to `crm.lead` so every other
 * model's calendar single-click still opens its popover offline exactly
 * as before.
 */
patch(CalendarCommonRenderer.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    openPopover(target, record) {
        if (this.props.model.resModel === "crm.lead" && record.id && this.crmOffline.isOffline()) {
            return this.props.editRecord(record);
        }
        return super.openPopover(...arguments);
    },
});
