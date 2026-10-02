import { ActivityCell } from "@mail/views/web/activity/activity_cell";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B81 (VAL-DIS-007): a `crm_activity` cell's click opens `ActivityListPopover`
 * (schedule/edit an activity -- same transient `mail.activity` wizard family
 * as B17/B23/BR7). Opening it is not gated by anything today: as soon as it
 * mounts, its `useOnChange` on `activityIds` calls
 * `this.store.fetchStoreData("mail.activity", ...)` unconditionally
 * (`activity_list_popover.js`), a `call_kw` with no offline handling of its
 * own. `ActivityCell` is a plain `Component`, not a `<button>`, so the
 * framework's `SELECTORS_TO_DISABLE` never reaches it either.
 *
 * `ActivityCell` is shared by every model's activity view, so this is
 * scoped by the cell's own `resModel` prop to `crm.lead` -- every other
 * model's activity view (project tasks, sale orders, ...) keeps opening its
 * popover offline exactly as before.
 */
patch(ActivityCell.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    onClick() {
        if (this.props.resModel === "crm.lead" && this.crmOffline.isOffline()) {
            return;
        }
        return super.onClick();
    },
});
