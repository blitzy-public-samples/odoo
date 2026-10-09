import { onWillStart, signal, untrack, useEffect } from "@odoo/owl";
import { user } from "@web/core/user";
import { RottingColumnProgress } from "@mail/js/rotting_mixin/rotting_column_progress";
import { _t } from "@web/core/l10n/translation";
import { useCrmOffline } from "@crm/mobile/crm_offline_hooks";

export class CrmColumnProgress extends RottingColumnProgress {
    static template = "crm.ColumnProgress";
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        /**
         * Answer of the recurring-revenue group probe: `null` until a probe succeeded, then the
         * boolean the server returned. The answer is kept across disconnections, so the aggregate
         * comes back on reconnect without probing again. `showRecurringRevenue` derives the
         * displayed state from it and from the connectivity signal.
         */
        this.probedRecurringRevenue = signal(null);
        /** Pending probe, shared by `onWillStart` and the reconnect effect (one probe per mount). */
        this._recurringRevenueProbe = null;

        // Probes while the answer is unknown and the client is online: at mount (the effect runs
        // as soon as it is created), and when the connection returns after a cold offline mount or
        // a probe that lost the connection. Only the two signals are tracked, so the effect re-runs
        // on connectivity changes and on the probe's answer only; the probe itself runs untracked,
        // and its promise is not returned, because an effect's return value is its cleanup.
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const probed = this.probedRecurringRevenue();
            if (!isOffline && probed === null) {
                untrack(() => {
                    this._probeRecurringRevenue();
                });
            }
        });

        // Online, the first render waits for the probe exactly as before; this awaits the probe
        // the effect above already started, so a mount issues a single `has_group`.
        onWillStart(async () => {
            await this._probeRecurringRevenue();
        });
    }

    /**
     * Whether the recurring-revenue aggregate (and its "MRR" label) is rendered: the user has the
     * recurring-revenue group and the client is online. Offline the aggregate is hidden rather
     * than shown from values the offline client cannot refresh; it shows again on reconnect.
     *
     * @returns {boolean}
     */
    get showRecurringRevenue() {
        return !this.crmOffline.isOffline() && this.probedRecurringRevenue() === true;
    }

    /**
     * Asks once whether the user has the recurring-revenue group, when the progress bar declares
     * a recurring revenue field. Never asks offline: `user.hasGroup` raises a
     * `ConnectionLostError` there unless the answer is already cached. Concurrent callers share
     * the pending probe. A probe that fails leaves the answer unknown (`null`), so the aggregate
     * stays hidden and no error escapes the column; a probe that lost the connection runs again
     * when the connection returns.
     *
     * @returns {Promise<void>}
     */
    async _probeRecurringRevenue() {
        if (!this.props.progressBarState.progressAttributes.recurring_revenue_sum_field) {
            return;
        }
        if (this.crmOffline.isOffline() || this.probedRecurringRevenue() !== null) {
            return;
        }
        if (!this._recurringRevenueProbe) {
            // `user.hasGroup` is awaited rather than chained with `.then`, so a synchronous answer
            // (as returned by patched implementations) is accepted too. The pending reference is
            // cleared in a promise reaction, which always runs after it has been stored, even when
            // `user.hasGroup` throws synchronously.
            this._recurringRevenueProbe = (async () => {
                try {
                    const hasGroup = await user.hasGroup("crm.group_use_recurring_revenues");
                    this.probedRecurringRevenue.set(Boolean(hasGroup));
                } catch (error) {
                    // A lost connection has already flipped the client offline when the rejection
                    // arrives (the offline plugin reacts to the failed RPC response first), and
                    // the effect probes again on reconnect. Any other failure only hides the
                    // aggregate instead of failing the whole kanban column; it is reported so
                    // that it is not lost.
                    if (!this.crmOffline.isOffline()) {
                        console.warn("CRM: recurring revenue group probe failed", error);
                    }
                }
            })().finally(() => {
                this._recurringRevenueProbe = null;
            });
        }
        return this._recurringRevenueProbe;
    }

    getRecurringRevenueGroupAggregate(group) {
        if (!this.showRecurringRevenue) {
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
