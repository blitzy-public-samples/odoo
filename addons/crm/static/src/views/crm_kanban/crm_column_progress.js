import { onWillStart } from "@odoo/owl";
import { user } from "@web/core/user";
import { RottingColumnProgress } from "@mail/js/rotting_mixin/rotting_column_progress";
import { _t } from "@web/core/l10n/translation";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

export class CrmColumnProgress extends RottingColumnProgress {
    static template = "crm.ColumnProgress";
    setup() {
        super.setup();
        this.showRecurringRevenue = false;
        this.crmOffline = useCrmOffline();

        onWillStart(async () => {
            // `user.hasGroup` is a disk-cached probe (architecture.md §2):
            // an uncached call issued offline would reject and that
            // rejection is never evicted, even once the connection
            // returns. Skip it entirely while offline instead of catching
            // it, and leave `showRecurringRevenue` at its `false` default
            // so the MRR line is simply absent (not shown as "0") until
            // the next online load.
            if (
                this.props.progressBarState.progressAttributes.recurring_revenue_sum_field &&
                !this.crmOffline.isOffline()
            ) {
                this.showRecurringRevenue = await user.hasGroup("crm.group_use_recurring_revenues");
            }
        });
    }

    getRecurringRevenueGroupAggregate(group) {
        // Scrutiny finding 5 (VAL-FIX-009): `showRecurringRevenue` is only
        // computed once, in `onWillStart`, so a column mounted online and
        // then taken offline would otherwise keep returning the real
        // aggregate here (and the template would keep rendering it) for
        // the rest of this component's life. Re-check `isOffline()`
        // reactively on every read instead, so the aggregate disappears
        // immediately on going offline and comes back as soon as the
        // connection returns, with no need to remount.
        if (!this.showRecurringRevenue || this.crmOffline.isOffline()) {
            return {};
        }
        const rrField = this.props.progressBarState.progressAttributes.recurring_revenue_sum_field;
        return this.props.progressBarState.getAggregateValue(group, rrField);
    }

    getColumnProgressTooltip(bar) {
        const barString = typeof bar.value === 'symbol' ? _t('Without activities scheduled') : bar.string;
        return `${bar.count} ${barString}`;
    }
}
