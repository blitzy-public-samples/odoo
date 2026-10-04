import { signal } from "@odoo/owl";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

export const crmListView = {
    ...listView,
    Controller: class extends listView.Controller {
        // Primary-inherits "web.ListView" (crm_list_view.xml) to add the
        // uncached-lead branch below; every other list view keeps the
        // unmodified base template.
        static template = "crm.ListView";
        static components = {
            ...listView.Controller.components,
            LeadGenerationDropdown,
        }

        // Set when an offline click opens a lead whose form was never
        // visited online (architecture.md §3.2 item 10). See
        // crm_kanban_view.js's `offlineUncachedClick` for the full
        // rationale; same mechanism, applied to the list.
        offlineUncachedClick = signal(false);

        setup() {
            super.setup();
            this.crmOffline = useCrmOffline();
        }

        /**
         * @override
         */
        async openRecord(record, options) {
            if (
                !this.crmOffline.isLeadAvailableOffline(this.env.config.actionId, record.resId)
            ) {
                this.offlineUncachedClick.set(true);
                return;
            }
            this.offlineUncachedClick.set(false);
            return super.openRecord(record, options);
        }
    },
    ControlPanel: CrmControlPanel,
    SearchModel: CrmSearchModel,
    buttonTemplate: "crm.List.Buttons",
};

registry.category("views").add("crm_list", crmListView);
