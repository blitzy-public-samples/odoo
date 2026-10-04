import { ActivityController } from "@mail/views/web/activity/activity_controller";
import { OfflineActionHelper } from "@web/views/offline_action_helper";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B81 (VAL-DIS-007): the activity view's empty-cell, "Schedule activity"
 * footer and record-row controls are plain elements with their own
 * `t-on-click` (`activity_renderer.xml`), not `<button>`s, so the
 * framework's `SELECTORS_TO_DISABLE` never reaches them.
 *
 * - `scheduleActivity`/`openActivityFormView` (empty cell + footer) each
 *   open a transient wizard (`SelectCreateDialog` / a new `mail.activity`
 *   form dialog) -- same DISABLE family as B17/B23/BR7, blocked outright
 *   offline.
 * - `openRecord` navigates to the underlying `crm.lead`'s form, which may
 *   never have been visited offline for this action -- same
 *   uncached-record-navigation reasoning as `crm_kanban_view.js`'s
 *   `openRecord` override.
 *
 * `static template = "crm.ActivityView"` primary-inherits
 * `mail.ActivityController` (`crm_activity_view.xml`) to add the
 * `couldNotLoadRootOffline` branch mail's own template lacks (unlike
 * `kanban_controller.xml`/`list_controller.xml`, which already have it);
 * every other model's activity view keeps the unmodified base template.
 */
export class CrmActivityController extends ActivityController {
    static template = "crm.ActivityView";
    static components = { ...ActivityController.components, OfflineActionHelper };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    scheduleActivity() {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.scheduleActivity();
    }

    openActivityFormView(resId, activityTypeId) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.openActivityFormView(resId, activityTypeId);
    }

    /**
     * @override
     *
     * B81 (VAL-DIS-007): the template dropdown's items are a
     * `<div t-on-click>` (`activity_renderer.xml`'s `.o_send_mail_template`),
     * not a `<button>`, so `SELECTORS_TO_DISABLE` never reaches them.
     * `sendMailTemplate` issues `crm.lead`'s `activity_send_mail` directly
     * -- same DISABLE family as `scheduleActivity`/`openActivityFormView`
     * above.
     */
    sendMailTemplate(templateID, activityTypeID) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.sendMailTemplate(templateID, activityTypeID);
    }

    async openRecord(record, options = {}) {
        if (!this.crmOffline.isLeadAvailableOffline(this.env.config.actionId, record.resId)) {
            return;
        }
        return super.openRecord(record, options);
    }
}
