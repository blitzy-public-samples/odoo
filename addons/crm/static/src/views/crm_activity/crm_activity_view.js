import { activityView } from "@mail/views/web/activity/activity_view";
import { CrmActivityController } from "@crm/views/crm_activity/crm_activity_controller";
import { CrmActivityModel } from "@crm/views/crm_activity/crm_activity_model";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { registry } from "@web/core/registry";

export const crmActivityView = {
    ...activityView,
    Controller: CrmActivityController,
    Model: CrmActivityModel,
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
};

registry.category("views").add("crm_activity", crmActivityView);
