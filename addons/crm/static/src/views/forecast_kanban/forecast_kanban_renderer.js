import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { useService } from "@web/core/utils/hooks";
import { ForecastKanbanColumnQuickCreate } from "@crm/views/forecast_kanban/forecast_kanban_column_quick_create";

export class ForecastKanbanRenderer extends CrmKanbanRenderer {
    static template = "crm.ForecastKanbanRenderer";
    static components = {
        ...CrmKanbanRenderer.components,
        ForecastKanbanColumnQuickCreate,
    };

    setup() {
        super.setup(...arguments);
        this.fillTemporalService = useService("fillTemporalService");
    }
    /**
     * @override
     *
     * Allow creating groups when grouping by forecast_field.
     *
     * A24/A27 (VAL-DIS-013): `isGroupedByForecastField()` doesn't read
     * offline state, so without the extra `!this.crmOffline.isOffline()`
     * check here the `||` would re-enable "add next period" even though
     * `CrmKanbanRenderer.canCreateGroup()` (the `super` call) already
     * returns false offline. Unlike B56, `addForecastColumn()` never calls
     * `name_create`: it only widens the fill-temporal window and calls
     * `list.load()` again with a domain that was never requested before,
     * so it is always an offline disk-cache miss -- an uncaught
     * `ConnectionLostError` from the click handler, the same risk as the
     * rotting badge (B91), not a chained id.
     */
    canCreateGroup() {
        return (
            super.canCreateGroup(...arguments) ||
            (!this.crmOffline.isOffline() && this.isGroupedByForecastField())
        );
    }

    isGroupedByForecastField() {
        return (
            this.props.list.context.forecast_field &&
            this.props.list.groupByField.name === this.props.list.context.forecast_field
        );
    }

    isMovableField(field) {
        return super.isMovableField(...arguments) || field.name === "date_deadline";
    }

    async addForecastColumn() {
        const { name, type, granularity } = this.props.list.groupByField;
        this.fillTemporalService
            .getFillTemporalPeriod({
                modelName: this.props.list.resModel,
                field: {
                    name,
                    type,
                },
                granularity: granularity || "month",
            })
            .expand();
        await this.props.list.load();
    }
}
