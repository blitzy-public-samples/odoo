import { signal } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { CrmKanbanArchParser } from "@crm/views/crm_kanban/crm_kanban_arch_parser";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { rottingKanbanView } from "@mail/js/rotting_mixin/rotting_kanban_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

export const crmKanbanView = {
    ...rottingKanbanView,
    ArchParser: CrmKanbanArchParser,
    // Makes it easier to patch
    Controller: class extends rottingKanbanView.Controller {
        // Primary-inherits "web.KanbanView" (crm_kanban_view.xml) to add the
        // uncached-lead branch below; every other kanban view keeps the
        // unmodified base template.
        static template = "crm.KanbanView";
        static components = {
            ...rottingKanbanView.Controller.components,
            LeadGenerationDropdown,
        }

        // Set when an offline click opens a lead whose form was never
        // visited online: the template shows `OfflineActionHelper` instead
        // of the grid (architecture.md §3.2 item 10) instead of attempting
        // the navigation, which would throw `ConnectionLostError` and have
        // the action manager silently restore this same kanban
        // (architecture.md §2 / VAL-UNCACHED-001). Read together with
        // `crmOffline.isOffline()` so going back online reveals the grid
        // again without needing a dedicated reset.
        offlineUncachedClick = signal(false);

        setup() {
            super.setup();
            this.crmOffline = useCrmOffline();
        }

        get progressBarAggregateFields() {
            const res = super.progressBarAggregateFields;
            const progressAttributes = this.props.archInfo.progressAttributes;
            if (progressAttributes && progressAttributes.recurring_revenue_sum_field) {
                res.push(progressAttributes.recurring_revenue_sum_field);
            }
            return res;
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
    Model: CrmKanbanModel,
    Renderer: CrmKanbanRenderer,
    SearchModel: CrmSearchModel,
    buttonTemplate: "crm.Kanban.Buttons",
};

registry.category("views").add("crm_kanban", crmKanbanView);
