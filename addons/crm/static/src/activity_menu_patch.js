import { Domain } from "@web/core/domain";
import { ActivityMenu } from "@mail/core/web/activity_menu";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

patch(ActivityMenu.prototype, {
    setup() {
        super.setup(...arguments);
        // Offline state of the web client, read through the shared CRM offline hooks.
        this.crmOffline = useCrmOffline();
    },

    availableViews(group) {
        if (group.model === "crm.lead") {
            return [
                [false, "list"],
                [false, "kanban"],
                [false, "form"],
                [false, "calendar"],
                [false, "pivot"],
                [false, "graph"],
                [false, "activity"],
            ];
        }
        return super.availableViews(...arguments);
    },

    openActivityGroup(group, filter = "all", newWindow) {
        // CRM leads open the CRM activity action filtered by `filter`; others use the mail default.
        const context = {};
        if (group.model === "crm.lead") {
            // The CRM activity views cannot be loaded offline: the entry and its Late/Today/Future
            // links are inert, before any work (the dropdown stays open, no action is loaded).
            // The entry is a <div>, so its dimming comes from the selector the CRM offline hooks
            // add to the framework's offline selectors.
            if (this.crmOffline.isOffline()) {
                return;
            }
            this.dropdown.close();
            if (filter === "my" || filter === "all") {
                context["search_default_activities_overdue"] = 1;
                context["search_default_activities_today"] = 1;
            } else if (filter === "overdue") {
                context["search_default_activities_overdue"] = 1;
            } else if (filter === "today") {
                context["search_default_activities_today"] = 1;
            } else {
                context["search_default_activities_upcoming_all"] = 1;
            }
            // Force a search_count for activity-filtered results
            // even when the current page is not full.
            context["force_search_count"] = 1;
            this.action.loadAction("crm.crm_lead_action_my_activities").then((action) => {
                // The connection may have dropped while the action was loading: open nothing.
                if (this.crmOffline.isOffline()) {
                    return;
                }
                // to show lost leads in the activity
                action.domain = Domain.and([
                    action.domain || [],
                    [["active", "in", [true, false]]],
                ]).toList();
                this.action.doAction(action, {
                    newWindow,
                    additionalContext: context,
                    clearBreadcrumbs: true,
                });
            });
        } else {
            return super.openActivityGroup(...arguments);
        }
    },
});
