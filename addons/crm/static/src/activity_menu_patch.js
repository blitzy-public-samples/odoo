import { Domain } from "@web/core/domain";
import { ActivityMenu } from "@mail/core/web/activity_menu";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

patch(ActivityMenu.prototype, {
    setup() {
        super.setup();
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
        // fetch the data from the button otherwise fetch the ones from the parent (.o_ActivityMenuView_activityGroup).
        const context = {};
        if (group.model === "crm.lead") {
            if (this.crmOffline.isOffline()) {
                // architecture.md §3.2 item 7 / offline_inventory.md rows
                // A1/A2 (VAL-FIX-011, VAL-DIS-011): the group row is a
                // `<div t-custom-click>`, not a `<button>`, so the
                // framework's `SELECTORS_TO_DISABLE` never reaches it --
                // crm must guard the handler itself before any
                // `loadAction`/`doAction` call. The dropdown is left open,
                // same as any other inert control, and other models keep
                // their `super` path untouched (also offline).
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
            // Necessary because activity_ids of mail.activity.mixin has auto_join
            // So, duplicates are faking the count and "Load more" doesn't show up
            context["force_search_count"] = 1;
            this.action.loadAction("crm.crm_lead_action_my_activities").then((action) => {
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
