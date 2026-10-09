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
         * Answer of the recurring-revenue group probe: `null` until a probe succeeds, then the
         * server's boolean. It is kept across disconnections.
         */
        this.probedRecurringRevenue = signal(null);
        /** The probe in flight, if any (see `_probeRecurringRevenue`). */
        this._recurringRevenueProbe = null;

        // Probes while online and the answer is unknown: at creation and on each reconnect. Only
        // the two signals are tracked; the probe runs untracked and its promise is not returned,
        // because an effect's return value is its cleanup.
        useEffect(() => {
            const isOffline = this.crmOffline.isOffline();
            const probed = this.probedRecurringRevenue();
            if (!isOffline && probed === null) {
                untrack(() => {
                    this._probeRecurringRevenue();
                });
            }
        });

        // The first online render waits for the probe the effect has just started, so a mount
        // issues a single `has_group`.
        onWillStart(async () => {
            await this._probeRecurringRevenue();
        });
    }

    /**
     * Whether the recurring-revenue aggregate (and its "MRR" label) is rendered: the user has the
     * recurring-revenue group and the client is online. Offline the aggregate is hidden rather
     * than shown from values the offline client cannot refresh; it shows again on reconnect when
     * the group answer is known to be positive.
     *
     * @returns {boolean}
     */
    get showRecurringRevenue() {
        return !this.crmOffline.isOffline() && this.probedRecurringRevenue() === true;
    }

    /**
     * Asks whether the user has the recurring-revenue group when the progress bar declares a
     * recurring revenue field, the client is online and no answer is known. Callers share the
     * probe in flight (mount and effect); a call after it settles starts a new attempt. A failure
     * leaves the answer `null`, so the aggregate stays hidden and the column never fails. The
     * session group cache keeps rejected answers: after a probe that lost the connection, the
     * aggregate stays hidden until the page is reloaded.
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
                    // arrives (the offline plugin reacts to the failed response first), so it is
                    // not reported. Any other failure is reported with a warning, including the
                    // cached rejection `user.hasGroup` replays to an attempt made once back online.
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
